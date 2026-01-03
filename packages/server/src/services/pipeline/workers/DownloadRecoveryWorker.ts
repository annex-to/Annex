import type { ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDownloadService } from "../../download.js";
import { parseTorrentName } from "../../downloadManager.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { BaseWorker } from "./BaseWorker";
import { findMainVideoFile } from "./fileUtils.js";

/**
 * DownloadRecoveryWorker - Recovers ProcessingItems stuck in DOWNLOADING status
 *
 * Root cause: When the server crashes or restarts while DownloadStep is waiting
 * for completion, ProcessingItems are left in DOWNLOADING status with no downloadId.
 *
 * This worker:
 * 1. Finds ProcessingItems in DOWNLOADING status
 * 2. Checks if their torrents are complete in qBittorrent
 * 3. Transitions them to DOWNLOADED with proper download context
 */
export class DownloadRecoveryWorker extends BaseWorker {
  readonly processingStatus = "DOWNLOADING" as const;
  readonly nextStatus = "DOWNLOADED" as const;
  readonly name = "DownloadRecoveryWorker";

  protected async processItem(item: ProcessingItem): Promise<void> {
    // Get the search context to find the release info
    const stepContext = item.stepContext as Record<string, unknown>;

    // Check both locations: stepContext.search.selectedRelease and stepContext.selectedRelease
    const searchData = stepContext.search as PipelineContext["search"];
    const selectedRelease =
      searchData?.selectedRelease ||
      (stepContext.selectedRelease as Record<string, unknown> | undefined);
    const selectedPacks = searchData?.selectedPacks;

    // For season packs, use the first pack's title
    let releaseName: string | undefined;
    if (selectedPacks && Array.isArray(selectedPacks) && selectedPacks.length > 0) {
      const firstPack = selectedPacks[0] as Record<string, unknown>;
      releaseName = firstPack?.title as string;
    } else if (selectedRelease && typeof selectedRelease.title === "string") {
      releaseName = selectedRelease.title as string;
    }

    if (!releaseName) {
      return;
    }

    // Search qBittorrent for a matching torrent using proper parsing
    const qb = getDownloadService();
    const torrents = await qb.getAllTorrents();

    // Parse the selected release to extract structured data
    const parsedRelease = parseTorrentName(releaseName);

    // Find matching torrent by comparing parsed metadata
    const matchingTorrent = torrents.find((t) => {
      const parsedTorrent = parseTorrentName(t.name);

      // Title must match (normalized)
      const releaseTitle = (parsedRelease.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const torrentTitle = (parsedTorrent.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (releaseTitle !== torrentTitle) {
        return false;
      }

      // For movies, year must match to avoid matching sequels
      if (item.type === "MOVIE") {
        // Use item.year as source of truth (from TMDB), compare with parsed year
        if (item.year && parsedTorrent.year && item.year !== parsedTorrent.year) {
          return false;
        }
      }

      // For TV, season must match
      if (item.type === "EPISODE" && item.season !== null) {
        if (parsedTorrent.season && parsedTorrent.season !== item.season) {
          return false;
        }
      }

      return true;
    });

    if (!matchingTorrent) {
      return;
    }

    // Only recover if torrent is complete
    if (!matchingTorrent.isComplete || matchingTorrent.progress < 100) {
      return;
    }

    // Torrent is complete - proceed with recovery
    console.log(`[${this.name}] Recovering ${item.type} ${item.title}`);
    console.log(`[${this.name}]   Torrent: ${matchingTorrent.name}`);
    console.log(`[${this.name}]   Hash: ${matchingTorrent.hash}`);

    // Get the video file path
    let sourceFilePath = matchingTorrent.contentPath;

    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      // For TV episodes, find the specific episode file in the season pack
      const episodeFile = await this.findEpisodeFile(
        matchingTorrent.contentPath,
        item.season,
        item.episode
      );

      if (episodeFile) {
        sourceFilePath = episodeFile;
        console.log(`[${this.name}] Found episode file: ${episodeFile}`);
      } else {
        throw new Error(
          `Could not find S${item.season}E${item.episode} in season pack ${matchingTorrent.contentPath}`
        );
      }
    } else if (item.type === "MOVIE") {
      // For movies, find the main video file if path is a directory
      const mainVideoFile = await findMainVideoFile(matchingTorrent.contentPath);
      if (mainVideoFile) {
        sourceFilePath = mainVideoFile;
        console.log(`[${this.name}] Found main video file: ${mainVideoFile}`);
      } else {
        throw new Error(`Could not find video file in ${matchingTorrent.contentPath}`);
      }
    }

    // Build download context
    const downloadContext: PipelineContext["download"] = {
      torrentHash: matchingTorrent.hash,
      sourceFilePath,
    };

    const newStepContext = {
      ...stepContext,
      download: downloadContext,
    };

    // Get request to determine mediaType
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Find or create Download record for tracking
    let download = await prisma.download.findUnique({
      where: { torrentHash: matchingTorrent.hash },
    });

    if (!download) {
      download = await prisma.download.create({
        data: {
          id: matchingTorrent.hash, // Use hash as ID for idempotency
          requestId: item.requestId,
          mediaType: request.type as "MOVIE" | "TV",
          torrentHash: matchingTorrent.hash,
          torrentName: matchingTorrent.name,
          status: "COMPLETED",
          progress: 100,
          completedAt: new Date(),
          savePath: matchingTorrent.savePath,
          contentPath: matchingTorrent.contentPath,
        },
      });
    }

    // Transition to DOWNLOADED
    await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
      currentStep: "download_complete",
      stepContext: newStepContext,
      downloadId: download.id,
    });

    console.log(`[${this.name}] ✓ Recovered ${item.title} - transitioned to DOWNLOADED`);
  }

  /**
   * Find the specific episode file within a season pack directory
   */
  private async findEpisodeFile(
    directoryPath: string,
    season: number,
    episode: number
  ): Promise<string | null> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

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

export const downloadRecoveryWorker = new DownloadRecoveryWorker();
