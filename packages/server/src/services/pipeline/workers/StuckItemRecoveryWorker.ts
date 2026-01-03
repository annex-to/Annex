import type { ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { BaseWorker } from "./BaseWorker";

/**
 * StuckItemRecoveryWorker - Automatically detects and recovers stuck processing items
 *
 * Recovers three types of stuck states:
 * 1. Episodes in FOUND status with no downloadId for >5 minutes
 * 2. Episodes at 100% progress in DOWNLOADING status for >5 minutes
 * 3. Seasons where some episodes have downloadId and others don't
 *
 * Runs every minute to eliminate need for manual SQL interventions
 */
export class StuckItemRecoveryWorker extends BaseWorker {
  readonly processingStatus = "PENDING" as const;
  readonly nextStatus = "PENDING" as const; // Not used - worker handles custom recovery
  readonly name = "StuckItemRecoveryWorker";

  constructor() {
    super();
    // Override default poll interval - recovery runs less frequently
    (this as { pollInterval: number }).pollInterval = 60000; // 1 minute
  }

  /**
   * Process batch - doesn't actually process items from database query
   * Instead runs custom recovery checks
   */
  async processBatch(): Promise<void> {
    await this.recoverFoundWithoutDownloadId();
    await this.recoverCompletedDownloads();
    await this.recoverMixedSeasonDownloads();
  }

  /**
   * Override processItem - not used by this worker
   */
  protected async processItem(_item: ProcessingItem): Promise<void> {
    // Not used - processBatch handles everything
  }

  /**
   * Fix episodes stuck in FOUND with no downloadId
   * These are episodes that found an existing season pack but failed to link
   */
  private async recoverFoundWithoutDownloadId(): Promise<void> {
    const stuckItems = await prisma.processingItem.findMany({
      where: {
        status: "FOUND",
        downloadId: null,
        updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }, // Stuck for >5min
      },
    });

    if (stuckItems.length === 0) return;

    console.log(
      `[${this.name}] Found ${stuckItems.length} stuck FOUND items, resetting to PENDING`
    );

    await prisma.processingItem.updateMany({
      where: { id: { in: stuckItems.map((i: ProcessingItem) => i.id) } },
      data: { status: "PENDING", currentStep: null },
    });
  }

  /**
   * Fix downloads stuck at 100% in DOWNLOADING status
   * These episodes completed downloading but didn't transition forward
   */
  private async recoverCompletedDownloads(): Promise<void> {
    const completedItems = await prisma.processingItem.findMany({
      where: {
        status: "DOWNLOADING",
        progress: { gte: 100 },
        downloadId: { not: null },
        updatedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) }, // Stuck for >5min
      },
    });

    if (completedItems.length === 0) return;

    console.log(
      `[${this.name}] Found ${completedItems.length} completed downloads stuck in DOWNLOADING, transitioning to DOWNLOADED`
    );

    const { getDownloadService } = await import("../../download.js");
    const { pipelineOrchestrator } = await import("../PipelineOrchestrator.js");
    const { findMainVideoFile } = await import("./fileUtils.js");
    const qb = getDownloadService();

    // Process each item individually to build proper download context
    for (const item of completedItems) {
      try {
        // Get Download record (downloadId is guaranteed non-null by query)
        if (!item.downloadId) continue;

        const download = await prisma.download.findUnique({
          where: { id: item.downloadId },
        });

        if (!download) {
          console.warn(
            `[${this.name}] Download ${item.downloadId} not found for ${item.title}, resetting to PENDING`
          );
          await prisma.processingItem.update({
            where: { id: item.id },
            data: { status: "PENDING", currentStep: null, downloadId: null },
          });
          continue;
        }

        // Get torrent to find source file
        const torrent = await qb.getProgress(download.torrentHash);
        if (!torrent) {
          console.warn(
            `[${this.name}] Torrent ${download.torrentHash} not found for ${item.title}, resetting to PENDING`
          );
          await prisma.processingItem.update({
            where: { id: item.id },
            data: { status: "PENDING", currentStep: null, downloadId: null },
          });
          continue;
        }

        // Find the source file path
        let sourceFilePath = torrent.contentPath;

        if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
          // Find specific episode file
          const episodeFile = await this.findEpisodeFile(
            torrent.contentPath,
            item.season,
            item.episode
          );
          if (episodeFile) {
            sourceFilePath = episodeFile;
          } else {
            console.warn(
              `[${this.name}] Could not find episode file for ${item.title}, resetting to PENDING`
            );
            await prisma.processingItem.update({
              where: { id: item.id },
              data: { status: "PENDING", currentStep: null },
            });
            continue;
          }
        } else if (item.type === "MOVIE") {
          // Find main video file
          const mainVideoFile = await findMainVideoFile(torrent.contentPath);
          if (mainVideoFile) {
            sourceFilePath = mainVideoFile;
          } else {
            console.warn(
              `[${this.name}] Could not find video file for ${item.title}, resetting to PENDING`
            );
            await prisma.processingItem.update({
              where: { id: item.id },
              data: { status: "PENDING", currentStep: null },
            });
            continue;
          }
        }

        // Build download context
        const stepContext = (item.stepContext as Record<string, unknown>) || {};
        const downloadContext = {
          torrentHash: download.torrentHash,
          sourceFilePath,
        };

        const newStepContext = {
          ...stepContext,
          download: downloadContext,
        };

        // Transition to DOWNLOADED
        await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
          currentStep: "download_complete",
          stepContext: newStepContext,
        });

        console.log(`[${this.name}] ✓ Transitioned ${item.title} to DOWNLOADED`);
      } catch (error) {
        console.error(`[${this.name}] Error recovering ${item.title}:`, error);
      }
    }
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
        return directoryPath;
      }

      // Read directory contents
      const files = await fs.readdir(directoryPath);

      // Format season/episode for matching
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
   * Fix seasons where some episodes have downloadId and others don't
   * This happens when race conditions cause incomplete linking
   */
  private async recoverMixedSeasonDownloads(): Promise<void> {
    const mixedSeasons = await prisma.$queryRaw<
      Array<{
        requestId: string;
        season: number;
        total: bigint;
        linked: bigint;
        download_id: string;
      }>
    >`
      SELECT "requestId", season,
             COUNT(*) as total,
             COUNT("downloadId") as linked,
             MAX("downloadId") as download_id
      FROM "ProcessingItem"
      WHERE type = 'EPISODE'
        AND season IS NOT NULL
        AND status IN ('FOUND', 'DOWNLOADING', 'SEARCHING')
      GROUP BY "requestId", season
      HAVING COUNT(*) != COUNT("downloadId")
         AND COUNT("downloadId") > 0
    `;

    for (const season of mixedSeasons) {
      const total = Number(season.total);
      const linked = Number(season.linked);

      console.log(
        `[${this.name}] Fixing mixed season: ${linked}/${total} episodes linked in request ${season.requestId} season ${season.season}`
      );

      // Link unlinked episodes to the download that others have
      await prisma.processingItem.updateMany({
        where: {
          requestId: season.requestId,
          season: season.season,
          downloadId: null,
          status: { in: ["FOUND", "SEARCHING"] },
        },
        data: {
          downloadId: season.download_id,
          status: "DOWNLOADING",
          currentStep: "download",
        },
      });
    }
  }
}

export const stuckItemRecoveryWorker = new StuckItemRecoveryWorker();
