import fs from "node:fs/promises";
import path from "node:path";
import type { MediaType, ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { detectRarArchive, extractRar } from "../../archive.js";
import { getDownloadService } from "../../download.js";
import { circuitBreakerService } from "../CircuitBreakerService.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { BaseWorker } from "./BaseWorker";
import { findMainVideoFile } from "./fileUtils.js";

/**
 * DownloadWorker - Unified worker for starting and monitoring downloads
 * Processes FOUND → DOWNLOADING → DOWNLOADED
 *
 * No while loops - uses scheduled polling
 * Progress-based stall detection
 * Circuit breaker integration for qBittorrent health
 */
export class DownloadWorker extends BaseWorker {
  readonly processingStatus = "FOUND" as const;
  readonly nextStatus = "DOWNLOADED" as const;
  readonly name = "DownloadWorker";
  readonly concurrency = 20;

  /**
   * Process batch - handle both new downloads and active monitoring
   */
  async processBatch(): Promise<void> {
    await this.startNewDownloads();
    await this.monitorActiveDownloads();
  }

  /**
   * Override processItem - not used in new design
   */
  protected async processItem(_item: ProcessingItem): Promise<void> {
    // Not used - processBatch handles everything
  }

  /**
   * Start new downloads for FOUND items
   */
  private async startNewDownloads(): Promise<void> {
    const foundItems = await pipelineOrchestrator.getItemsForProcessing("FOUND");

    for (const item of foundItems.slice(0, this.concurrency)) {
      try {
        await this.createDownload(item);
      } catch (error) {
        await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Monitor active downloads for DOWNLOADING items
   */
  private async monitorActiveDownloads(): Promise<void> {
    const downloadingItems = await pipelineOrchestrator.getItemsForProcessing("DOWNLOADING");

    for (const item of downloadingItems) {
      try {
        await this.checkDownloadProgress(item);
      } catch (error) {
        await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Create a new download from FOUND item
   */
  private async createDownload(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Creating download for ${item.title}`);

    // Early exit: if item already has a completed download, skip to DOWNLOADED
    if (item.downloadId) {
      const download = await prisma.download.findUnique({
        where: { id: item.downloadId },
      });

      if (download && download.progress >= 100) {
        console.log(
          `[${this.name}] Early exit: ${item.title} download already complete, promoting to DOWNLOADED`
        );
        // Get torrent details for file path
        const qb = getDownloadService();
        const torrent = await qb.getProgress(download.torrentHash);
        if (torrent) {
          await this.handleCompletedDownload(item, download, torrent);
        }
        return;
      }
    }

    // Check circuit breaker for qBittorrent
    const qbHealthy = await circuitBreakerService.isAvailable("qbittorrent");
    if (!qbHealthy) {
      console.warn(`[${this.name}] qBittorrent circuit open, skipping ${item.title}`);
      await prisma.processingItem.update({
        where: { id: item.id },
        data: { skipUntil: new Date(Date.now() + 5 * 60 * 1000) }, // Skip for 5 minutes
      });
      return;
    }

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Extract search results from stepContext
    const stepContext = item.stepContext as Record<string, unknown>;
    const searchData = stepContext as PipelineContext["search"];

    // Skip items waiting for user to accept lower quality
    if (
      searchData?.qualityMet === false &&
      searchData?.alternativeReleases &&
      searchData.alternativeReleases.length > 0
    ) {
      console.log(
        `[${this.name}] Skipping ${item.title} - waiting for user to accept lower quality (${searchData.alternativeReleases.length} alternatives available)`
      );
      return;
    }

    // Check if this is an existing download
    if (searchData?.existingDownload) {
      console.log(`[${this.name}] Found existing download for ${item.title}`);
      await this.handleExistingDownload(item, request, searchData);
      return;
    }

    // Require either a selected release or season packs
    if (!searchData?.selectedRelease && !searchData?.selectedPacks) {
      throw new Error("No release or season packs found in item context");
    }

    // Create download via qBittorrent
    const qb = getDownloadService();
    const release = searchData.selectedRelease;

    if (!release || (!release.magnetUri && !release.downloadUrl)) {
      console.error(`[${this.name}] Release validation failed for ${item.title}:`);
      console.error(`[${this.name}]   release exists: ${!!release}`);
      if (release) {
        console.error(`[${this.name}]   magnetUri: ${release.magnetUri || "undefined"}`);
        console.error(`[${this.name}]   downloadUrl: ${release.downloadUrl || "undefined"}`);
        console.error(`[${this.name}]   release fields: ${Object.keys(release).join(", ")}`);
      }
      throw new Error("No magnet URI or download URL in selected release");
    }

    try {
      let result: { success: boolean; hash?: string; error?: string };

      if (release.magnetUri) {
        // Use magnet link
        console.log(`[${this.name}] Adding torrent via magnet link: ${release.title}`);
        result = await qb.addTorrentUrl(release.magnetUri);
      } else if (release.downloadUrl) {
        // Download torrent file first, then add it
        console.log(`[${this.name}] Downloading torrent file from: ${release.downloadUrl}`);

        const headers: Record<string, string> = {};
        if (release.downloadHeaders) {
          Object.assign(headers, release.downloadHeaders);
        }

        const response = await fetch(release.downloadUrl, { headers });

        if (!response.ok) {
          throw new Error(
            `Failed to download torrent file: HTTP ${response.status} ${response.statusText}`
          );
        }

        const torrentData = await response.arrayBuffer();
        const filename = `${release.title}.torrent`;
        const tag = `annex-${item.id}`;

        console.log(`[${this.name}] Adding torrent file to qBittorrent: ${filename}`);
        result = await qb.addTorrentFile(torrentData, filename, { tags: [tag] });

        if (!result.success) {
          throw new Error(result.error || "Failed to add torrent to qBittorrent");
        }

        // Use tag to find the torrent (qBittorrent doesn't return hash for file uploads)
        console.log(`[${this.name}] Finding torrent by tag: ${tag}`);
        const torrent = await qb.findTorrentByTag(tag, 10000);

        if (!torrent) {
          throw new Error("Torrent added but could not be found by tag");
        }

        result.hash = torrent.hash;
        console.log(`[${this.name}] Found torrent hash via tag: ${torrent.hash}`);
      } else {
        throw new Error("No valid download method available");
      }

      if (!result.success) {
        throw new Error(result.error || "Failed to add torrent to qBittorrent");
      }

      const torrentHash = result.hash;

      if (!torrentHash) {
        throw new Error("Failed to get torrent hash");
      }

      // Create Download record
      const download = await prisma.download.create({
        data: {
          id: torrentHash,
          requestId: item.requestId,
          mediaType: request.type as MediaType,
          torrentHash,
          torrentName: release.title,
          status: "DOWNLOADING",
          progress: 0,
          indexerName: release.indexerName || release.indexer || null,
          resolution: release.resolution || null,
          source: release.source || null,
          codec: release.codec || null,
          qualityScore: (release as { score?: number }).score || null,
          publishDate: release.publishDate ? new Date(release.publishDate) : null,
          seedCount: release.seeders || null,
          peerCount: release.leechers || null,
        },
      });

      // For season packs, link all episodes in this season
      if (item.type === "EPISODE" && item.season !== null && searchData?.selectedPacks) {
        await this.linkAllSeasonEpisodesToDownload(item.requestId, item.season, download.id);
      }

      // Transition to DOWNLOADING with progress tracking
      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
        currentStep: "download",
        downloadId: download.id,
      });

      // Initialize progress tracking
      await pipelineOrchestrator.updateProgress(item.id, 0, {
        lastProgressUpdate: new Date(),
        lastProgressValue: 0,
      });

      // Record success in circuit breaker
      await circuitBreakerService.recordSuccess("qbittorrent");

      console.log(`[${this.name}] Started download for ${item.title}`);
    } catch (error) {
      // Record failure in circuit breaker
      await circuitBreakerService.recordFailure(
        "qbittorrent",
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Check progress of active download
   */
  private async checkDownloadProgress(item: ProcessingItem): Promise<void> {
    if (!item.downloadId) {
      console.warn(`[${this.name}] No downloadId for ${item.title}, resetting to FOUND`);
      await pipelineOrchestrator.transitionStatus(item.id, "FOUND", {
        currentStep: undefined,
      });
      return;
    }

    // Get download record
    const download = await prisma.download.findUnique({
      where: { id: item.downloadId },
    });

    if (!download) {
      throw new Error(`Download ${item.downloadId} not found`);
    }

    // Check circuit breaker
    const qbHealthy = await circuitBreakerService.isAvailable("qbittorrent");
    if (!qbHealthy) {
      console.warn(
        `[${this.name}] qBittorrent circuit open, skipping progress check for ${item.title}`
      );
      return; // Will retry next poll cycle
    }

    try {
      // Get torrent status from qBittorrent
      const qb = getDownloadService();
      const torrent = await qb.getProgress(download.torrentHash);

      if (!torrent) {
        throw new Error(`Torrent ${download.torrentHash} not found in qBittorrent`);
      }

      // Stall detection: Compare progress to last known value
      const progressChanged = torrent.progress !== item.lastProgressValue;

      if (!progressChanged && item.lastProgressUpdate) {
        const stallTime = Date.now() - item.lastProgressUpdate.getTime();

        if (stallTime > 30 * 60 * 1000) {
          // Stalled for >30 minutes
          console.warn(
            `[${this.name}] Download stalled for ${item.title} (no progress for 30 min)`
          );

          // Check qBittorrent state
          if (torrent.state === "stalled" || torrent.state === "error") {
            throw new Error(`Download stalled: ${torrent.state}`);
          }
        }
      }

      // Update progress if changed
      if (progressChanged) {
        await pipelineOrchestrator.updateProgress(item.id, torrent.progress, {
          lastProgressUpdate: new Date(),
          lastProgressValue: torrent.progress,
        });

        // Update download record
        await prisma.download.update({
          where: { id: download.id },
          data: {
            progress: torrent.progress,
            savePath: torrent.savePath,
            contentPath: torrent.contentPath,
          },
        });
      }

      // Check if complete
      if (torrent.isComplete || torrent.progress >= 100) {
        await this.handleCompletedDownload(item, download, torrent);
      }

      // Record success in circuit breaker
      await circuitBreakerService.recordSuccess("qbittorrent");
    } catch (error) {
      // Record failure in circuit breaker
      await circuitBreakerService.recordFailure(
        "qbittorrent",
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Handle completed download - find video file and transition to DOWNLOADED
   */
  private async handleCompletedDownload(
    item: ProcessingItem,
    download: { id: string; torrentHash: string },
    torrent: { contentPath: string; name: string }
  ): Promise<void> {
    console.log(`[${this.name}] Download complete: ${item.title}`);

    // Extract RAR archives if present
    const archiveInfo = detectRarArchive(torrent.contentPath);

    if (archiveInfo.hasArchive && archiveInfo.archivePath) {
      console.log(`[${this.name}] Extracting RAR archive...`);

      const extractResult = await extractRar(archiveInfo.archivePath, torrent.contentPath);

      if (!extractResult.success) {
        throw new Error(`Failed to extract archive: ${extractResult.error}`);
      } else {
        console.log(
          `[${this.name}] Extracted ${extractResult.extractedFiles.length} files from archive`
        );
      }
    }

    // Find the actual video file
    let sourceFilePath = torrent.contentPath;

    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      // For TV episodes, find the specific episode file in season pack
      const episodeFile = await this.findEpisodeFile(
        torrent.contentPath,
        item.season,
        item.episode
      );

      if (episodeFile) {
        sourceFilePath = episodeFile;
        console.log(`[${this.name}] Found episode file: ${episodeFile}`);
      } else {
        throw new Error(`Could not find S${item.season}E${item.episode} in ${torrent.contentPath}`);
      }
    } else if (item.type === "MOVIE") {
      // For movies, find the main video file if path is a directory
      const mainVideoFile = await findMainVideoFile(torrent.contentPath);
      if (mainVideoFile) {
        sourceFilePath = mainVideoFile;
        console.log(`[${this.name}] Found main video file: ${mainVideoFile}`);
      } else {
        throw new Error(`Could not find video file in ${torrent.contentPath}`);
      }
    }

    // Build download context
    const downloadContext: PipelineContext["download"] = {
      torrentHash: download.torrentHash,
      sourceFilePath,
    };

    const stepContext = (item.stepContext as Record<string, unknown>) || {};
    const newStepContext = {
      ...stepContext,
      download: downloadContext,
    };

    // Update download record
    await prisma.download.update({
      where: { id: download.id },
      data: {
        status: "COMPLETED",
        progress: 100,
        contentPath: torrent.contentPath,
        completedAt: new Date(),
      },
    });

    // Transition to DOWNLOADED
    await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
      currentStep: "download_complete",
      stepContext: newStepContext,
    });

    console.log(`[${this.name}] Transitioned ${item.title} to DOWNLOADED`);
  }

  /**
   * Handle existing download found in search phase
   */
  private async handleExistingDownload(
    item: ProcessingItem,
    request: { type: string },
    searchData: PipelineContext["search"]
  ): Promise<void> {
    const existingDownload = searchData?.existingDownload;
    if (!existingDownload) {
      throw new Error("No existing download in search context");
    }

    const torrentHash = existingDownload.torrentHash;

    // Check circuit breaker
    const qbHealthy = await circuitBreakerService.isAvailable("qbittorrent");
    if (!qbHealthy) {
      console.warn(`[${this.name}] qBittorrent circuit open, skipping ${item.title}`);
      await prisma.processingItem.update({
        where: { id: item.id },
        data: { skipUntil: new Date(Date.now() + 5 * 60 * 1000) },
      });
      return;
    }

    try {
      // Get torrent details from qBittorrent
      const qb = getDownloadService();
      const torrent = await qb.getProgress(torrentHash);

      if (!torrent) {
        throw new Error(`Torrent ${torrentHash} no longer exists in qBittorrent`);
      }

      console.log(
        `[${this.name}] Existing torrent: ${torrent.name}, progress: ${torrent.progress}%`
      );

      // Find or create Download record
      let download = await prisma.download.findUnique({
        where: { torrentHash },
      });

      if (!download) {
        // Create Download record for existing torrent
        const selectedRelease = searchData?.selectedRelease;
        download = await prisma.download.create({
          data: {
            id: torrentHash,
            requestId: item.requestId,
            mediaType: request.type as MediaType,
            torrentHash,
            torrentName: torrent.name,
            status: torrent.isComplete ? "COMPLETED" : "DOWNLOADING",
            progress: torrent.progress,
            savePath: torrent.savePath,
            contentPath: torrent.contentPath,
            indexerName: selectedRelease?.indexerName || null,
            resolution: selectedRelease?.resolution || null,
            source: selectedRelease?.source || null,
            codec: selectedRelease?.codec || null,
            completedAt: torrent.isComplete ? new Date() : null,
          },
        });
      }

      // For season packs, link all episodes in this season
      if (item.type === "EPISODE" && item.season !== null) {
        await this.linkAllSeasonEpisodesToDownload(item.requestId, item.season, download.id);
      }

      // Transition to DOWNLOADING
      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
        currentStep: "download",
        downloadId: download.id,
      });

      // Initialize progress tracking
      await pipelineOrchestrator.updateProgress(item.id, torrent.progress, {
        lastProgressUpdate: new Date(),
        lastProgressValue: torrent.progress,
      });

      // If already complete, immediately transition to DOWNLOADED
      if (torrent.isComplete || torrent.progress >= 100) {
        await this.handleCompletedDownload(item, download, torrent);
      }

      // Record success in circuit breaker
      await circuitBreakerService.recordSuccess("qbittorrent");

      console.log(`[${this.name}] Linked ${item.title} to existing download`);
    } catch (error) {
      // Record failure in circuit breaker
      await circuitBreakerService.recordFailure(
        "qbittorrent",
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  /**
   * Atomically link all episodes in a season to a download
   */
  private async linkAllSeasonEpisodesToDownload(
    requestId: string,
    season: number,
    downloadId: string
  ): Promise<number> {
    const episodes = await prisma.processingItem.findMany({
      where: {
        requestId,
        season,
        type: "EPISODE",
        status: { in: ["FOUND", "SEARCHING", "PENDING"] },
      },
    });

    if (episodes.length === 0) {
      return 0;
    }

    console.log(
      `[${this.name}] Linking ${episodes.length} episodes in season ${season} to download ${downloadId}`
    );

    // Atomic batch update
    await prisma.$transaction(
      episodes.map((ep: ProcessingItem) =>
        prisma.processingItem.update({
          where: { id: ep.id },
          data: {
            downloadId,
            status: "DOWNLOADING",
            currentStep: "download",
          },
        })
      )
    );

    return episodes.length;
  }

  /**
   * Find the specific episode file within a season pack directory
   */
  private async findEpisodeFile(
    directoryPath: string,
    season: number,
    episode: number
  ): Promise<string | null> {
    try {
      const stats = await fs.stat(directoryPath);
      if (!stats.isDirectory()) {
        return directoryPath;
      }

      const files = await fs.readdir(directoryPath);

      // Format season/episode for matching
      const seasonStr = String(season).padStart(2, "0");
      const episodeStr = String(episode).padStart(2, "0");

      const patterns = [
        `S${seasonStr}E${episodeStr}`,
        `S${season}E${episode}`,
        `${season}x${episodeStr}`,
        `${season}x${episode}`,
      ];

      // Find matching file
      for (const file of files) {
        const upperFile = file.toUpperCase();
        for (const pattern of patterns) {
          if (upperFile.includes(pattern.toUpperCase())) {
            const ext = path.extname(file).toLowerCase();
            if ([".mkv", ".mp4", ".avi", ".m4v", ".ts"].includes(ext)) {
              return path.join(directoryPath, file);
            }
          }
        }
      }

      return null;
    } catch (error) {
      console.error(`[${this.name}] Error finding episode file:`, error);
      return null;
    }
  }

  /**
   * Handle error for an item
   */
  private async handleError(item: ProcessingItem, error: Error): Promise<void> {
    console.error(`[${this.name}] Error processing ${item.title}:`, error);
    await pipelineOrchestrator.handleError(item.id, error, "qbittorrent");
  }
}

export const downloadWorker = new DownloadWorker();
