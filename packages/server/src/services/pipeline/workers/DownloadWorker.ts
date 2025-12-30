import fs from "node:fs/promises";
import path from "node:path";
import type { MediaType, ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDownloadService } from "../../download.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { DownloadStep } from "../steps/DownloadStep";
import { BaseWorker } from "./BaseWorker";

/**
 * DownloadWorker - Downloads media for items in FOUND status
 * Transitions items from FOUND → DOWNLOADING → DOWNLOADED
 */
export class DownloadWorker extends BaseWorker {
  readonly processingStatus = "FOUND" as const;
  readonly nextStatus = "DOWNLOADED" as const;
  readonly name = "DownloadWorker";

  private downloadStep = new DownloadStep();

  protected async processItem(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Processing ${item.type} ${item.title}`);

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Extract search results from stepContext
    const stepContext = item.stepContext as Record<string, unknown>;
    const searchData = stepContext as PipelineContext["search"];

    // Check if this is an existing download
    if (searchData?.existingDownload) {
      console.log(`[${this.name}] Found existing download, skipping new download`);
      await this.handleExistingDownload(item, request, searchData);
      return;
    }

    if (!searchData?.selectedRelease) {
      throw new Error("No release found in item context");
    }

    // Transition to DOWNLOADING
    await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
      currentStep: "download",
    });

    // Build pipeline context
    const context: PipelineContext = {
      requestId: item.requestId,
      mediaType: request.type as MediaType,
      tmdbId: item.tmdbId,
      // Use request.title (show title) for TV, item.title (movie title) for movies
      title: item.type === "EPISODE" ? request.title : item.title,
      year: item.year || new Date().getFullYear(),
      targets: request.targets
        ? (request.targets as Array<{ serverId: string; encodingProfileId?: string }>)
        : [],
      search: searchData,
    };

    // For TV episodes, add episode context
    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      context.requestedEpisodes = [{ season: item.season, episode: item.episode }];
    }

    // Set progress callback
    this.downloadStep.setProgressCallback((progress, message) => {
      this.updateProgress(item.id, progress, message);
    });

    // Set callback to update downloadId immediately when Download record is created
    this.downloadStep.setDownloadCreatedCallback(async (downloadId, _torrentHash) => {
      console.log(
        `[${this.name}] Download created for ${item.title}, setting downloadId=${downloadId}`
      );

      // Update ProcessingItem with downloadId immediately (before waiting for completion)
      await prisma.processingItem.update({
        where: { id: item.id },
        data: { downloadId },
      });
    });

    // Execute download
    const output = await this.downloadStep.execute(context, {
      pollInterval: 5000,
      timeout: 24 * 60 * 60 * 1000, // 24 hours
    });

    if (!output.success) {
      throw new Error(output.error || "Download failed");
    }

    // Extract download results
    const downloadContext = output.data?.download as PipelineContext["download"];
    if (!downloadContext?.sourceFilePath && !downloadContext?.episodeFiles) {
      throw new Error("No download results found");
    }

    // Merge contexts
    const newStepContext = {
      ...stepContext,
      download: downloadContext,
    };

    // Transition to DOWNLOADED with results
    await this.transitionToNext(item.id, {
      currentStep: "download_complete",
      stepContext: newStepContext,
      downloadId: downloadContext.torrentHash,
    });

    console.log(`[${this.name}] Downloaded ${item.title}`);
  }

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

    // Get torrent details from qBittorrent
    const qb = getDownloadService();
    const torrent = await qb.getProgress(torrentHash);

    if (!torrent) {
      throw new Error(`Torrent ${torrentHash} no longer exists in qBittorrent`);
    }

    console.log(`[${this.name}] Existing torrent: ${torrent.name}, progress: ${torrent.progress}%`);

    // Find or create Download record for this torrent
    let download = await prisma.download.findUnique({
      where: { torrentHash },
    });

    if (!download) {
      console.log(`[${this.name}] Creating Download record for existing torrent ${torrentHash}`);
      download = await prisma.download.create({
        data: {
          id: torrentHash,
          requestId: item.requestId,
          mediaType: request.type as "MOVIE" | "TV",
          torrentHash,
          torrentName: torrent.name,
          status: torrent.isComplete ? "COMPLETED" : "DOWNLOADING",
          progress: torrent.progress,
          savePath: torrent.savePath,
          contentPath: torrent.contentPath,
          completedAt: torrent.isComplete ? new Date() : null,
        },
      });
    }

    // If torrent is already complete, transition quickly to DOWNLOADED
    if (torrent.progress >= 100 || torrent.isComplete) {
      console.log(`[${this.name}] Torrent already complete, moving to DOWNLOADED`);

      // Transition to DOWNLOADING with downloadId set immediately
      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
        currentStep: "download",
        downloadId: download.id,
      });

      // Get file paths from torrent
      // For season packs, find the specific episode file
      let sourceFilePath = torrent.contentPath;

      if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
        // This is a season pack - find the specific episode file
        const episodeFile = await this.findEpisodeFile(
          torrent.contentPath,
          item.season,
          item.episode
        );

        if (episodeFile) {
          sourceFilePath = episodeFile;
          console.log(`[${this.name}] Found episode file: ${episodeFile}`);
        } else {
          throw new Error(
            `Could not find S${item.season}E${item.episode} in season pack ${torrent.contentPath}`
          );
        }
      }

      const downloadContext: PipelineContext["download"] = {
        torrentHash,
        sourceFilePath,
      };

      // Fetch latest item to get current stepContext
      const latestItem = await prisma.processingItem.findUnique({
        where: { id: item.id },
        select: { stepContext: true },
      });

      const stepContext = (latestItem?.stepContext as Record<string, unknown>) || {};
      const newStepContext = {
        ...stepContext,
        download: downloadContext,
      };

      // Immediately transition to DOWNLOADED
      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
        currentStep: "download_complete",
        stepContext: newStepContext,
      });
    } else {
      // Torrent is still downloading, transition to DOWNLOADING and monitor
      console.log(`[${this.name}] Torrent still downloading (${torrent.progress}%), monitoring...`);

      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
        currentStep: "download",
        downloadId: download.id,
      });

      await this.monitorExistingDownload(item, torrentHash, qb);
    }
  }

  private async monitorExistingDownload(
    item: ProcessingItem,
    torrentHash: string,
    qb: ReturnType<typeof getDownloadService>
  ): Promise<void> {
    // Poll for completion
    const maxWaitTime = 24 * 60 * 60 * 1000; // 24 hours
    const pollInterval = 5000; // 5 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitTime) {
      const torrent = await qb.getProgress(torrentHash);

      if (!torrent) {
        throw new Error(`Torrent ${torrentHash} disappeared from qBittorrent`);
      }

      // Update progress
      this.updateProgress(item.id, torrent.progress, `Downloading: ${torrent.progress}%`);

      // Check if complete
      if (torrent.progress >= 100 || torrent.isComplete) {
        console.log(`[${this.name}] Download complete: ${torrent.name}`);

        // For season packs, find the specific episode file
        let sourceFilePath = torrent.contentPath;

        if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
          const episodeFile = await this.findEpisodeFile(
            torrent.contentPath,
            item.season,
            item.episode
          );

          if (episodeFile) {
            sourceFilePath = episodeFile;
            console.log(`[${this.name}] Found episode file: ${episodeFile}`);
          } else {
            throw new Error(
              `Could not find S${item.season}E${item.episode} in season pack ${torrent.contentPath}`
            );
          }
        }

        const downloadContext: PipelineContext["download"] = {
          torrentHash,
          sourceFilePath,
        };

        const stepContext = item.stepContext as Record<string, unknown>;
        const newStepContext = {
          ...stepContext,
          download: downloadContext,
        };

        await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
          currentStep: "download_complete",
          stepContext: newStepContext,
          downloadId: torrentHash,
        });

        return;
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Download timeout after ${maxWaitTime / 1000 / 60} minutes`);
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
      // Check if path is a directory
      const stats = await fs.stat(directoryPath);
      if (!stats.isDirectory()) {
        // If it's already a file, return it
        return directoryPath;
      }

      // Read directory contents
      const files = await fs.readdir(directoryPath);

      // Format season/episode for matching (S01E01, S1E1, etc.)
      const seasonStr = String(season).padStart(2, "0");
      const episodeStr = String(episode).padStart(2, "0");

      // Pattern to match: S01E01, S1E1, 1x01, etc.
      const patterns = [
        `S${seasonStr}E${episodeStr}`,
        `S${season}E${episode}`,
        `${season}x${episodeStr}`,
        `${season}x${episode}`,
      ];

      // Find matching file
      for (const file of files) {
        const upperFile = file.toUpperCase();

        // Check if file matches any episode pattern
        for (const pattern of patterns) {
          if (upperFile.includes(pattern.toUpperCase())) {
            // Check if it's a video file
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
}

export const downloadWorker = new DownloadWorker();
