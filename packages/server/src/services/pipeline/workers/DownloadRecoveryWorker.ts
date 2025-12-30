import type { ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDownloadService } from "../../download.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { BaseWorker } from "./BaseWorker";

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
    console.log(`[${this.name}] Checking ${item.type} ${item.title} for recovery`);

    // Get the search context to find the release info
    const stepContext = item.stepContext as Record<string, unknown>;

    // Check both locations: stepContext.search.selectedRelease and stepContext.selectedRelease
    const searchData = stepContext.search as PipelineContext["search"];
    const selectedRelease = searchData?.selectedRelease || (stepContext.selectedRelease as any);

    if (!selectedRelease) {
      console.log(`[${this.name}] No release info in context, skipping ${item.title}`);
      return;
    }
    const releaseName = selectedRelease.title;

    // Search qBittorrent for a matching torrent
    const qb = getDownloadService();
    const torrents = await qb.getAllTorrents();

    // Try to find a matching torrent by name (fuzzy match)
    const matchingTorrent = torrents.find(t => {
      // Normalize both names for comparison
      const torrentName = t.name.toLowerCase().replace(/[.\s_-]+/g, " ");
      const searchName = releaseName.toLowerCase().replace(/[.\s_-]+/g, " ");

      // Check if torrent name contains the main parts of the release name
      const releaseWords = searchName.split(" ").filter(w => w.length > 2);
      const matchCount = releaseWords.filter(word => torrentName.includes(word)).length;

      // Require at least 80% of words to match
      return matchCount / releaseWords.length >= 0.8;
    });

    if (!matchingTorrent) {
      console.log(`[${this.name}] No matching torrent found in qBittorrent for ${releaseName}`);
      return;
    }

    console.log(`[${this.name}] Found matching torrent: ${matchingTorrent.name}`);
    console.log(`[${this.name}]   Hash: ${matchingTorrent.hash}`);
    console.log(`[${this.name}]   Progress: ${matchingTorrent.progress}%`);
    console.log(`[${this.name}]   Complete: ${matchingTorrent.isComplete}`);

    // Only recover if torrent is complete
    if (!matchingTorrent.isComplete || matchingTorrent.progress < 100) {
      console.log(`[${this.name}] Torrent not yet complete, skipping recovery`);
      return;
    }

    // Get the video file path
    let sourceFilePath = matchingTorrent.contentPath;

    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      // For episodes, find the specific episode file in the season pack
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
