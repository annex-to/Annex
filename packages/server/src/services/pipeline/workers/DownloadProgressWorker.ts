import type { ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDownloadService } from "../../download.js";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { BaseWorker } from "./BaseWorker";

/**
 * DownloadProgressWorker - Syncs download progress from qBittorrent to ProcessingItems
 *
 * Monitors ProcessingItems in DOWNLOADING status and updates their progress from qBittorrent.
 * Includes debouncing to prevent excessive database writes (only updates if changed by >1%).
 *
 * When download completes, the item transitions to DOWNLOADED via normal DownloadWorker flow.
 */
export class DownloadProgressWorker extends BaseWorker {
  readonly processingStatus = "DOWNLOADING" as const;
  readonly nextStatus = "DOWNLOADED" as const;
  readonly name = "DownloadProgressWorker";
  readonly pollInterval = 5000; // 5 seconds (not 500ms!)

  // Debouncing: track last progress value for each item
  private lastProgressMap = new Map<string, number>();

  protected async processItem(item: ProcessingItem): Promise<void> {
    // Skip items without downloadId (waiting for Download record creation)
    if (!item.downloadId) {
      return;
    }

    try {
      // Get Download record to get torrentHash
      const download = await prisma.download.findUnique({
        where: { id: item.downloadId },
        select: { torrentHash: true, status: true },
      });

      if (!download) {
        console.warn(`[${this.name}] Download record ${item.downloadId} not found for item ${item.id}`);
        return;
      }

      // Skip if download is already marked as completed
      if (download.status === "COMPLETED") {
        return;
      }

      // Get current progress from qBittorrent
      const qb = getDownloadService();
      const torrentProgress = await qb.getProgress(download.torrentHash);

      if (!torrentProgress) {
        console.warn(`[${this.name}] Torrent ${download.torrentHash} not found in qBittorrent`);
        return;
      }

      // Debouncing: only update if progress changed by >1%
      if (!this.shouldUpdateProgress(item.id, torrentProgress.progress)) {
        return;
      }

      // Update ProcessingItem progress
      await prisma.processingItem.update({
        where: { id: item.id },
        data: {
          progress: Math.round(torrentProgress.progress),
          updatedAt: new Date(),
        },
      });

      console.log(
        `[${this.name}] Updated ${item.type} ${item.title} progress: ${torrentProgress.progress.toFixed(1)}%`
      );

      // If download is complete, the DownloadWorker or DownloadRecoveryWorker
      // will handle transitioning to DOWNLOADED
      // We don't transition here to avoid race conditions
    } catch (error) {
      // Log but don't throw - we don't want one failing item to stop syncing others
      console.error(`[${this.name}] Error syncing progress for item ${item.id}:`, error);
    }
  }

  /**
   * Debouncing logic: only return true if progress changed by >1%
   */
  private shouldUpdateProgress(itemId: string, newProgress: number): boolean {
    const lastProgress = this.lastProgressMap.get(itemId) ?? 0;
    const diff = Math.abs(newProgress - lastProgress);

    // Update if changed by 1% or more, or if completing (99% -> 100%)
    if (diff >= 1 || (lastProgress < 100 && newProgress >= 100)) {
      this.lastProgressMap.set(itemId, newProgress);
      return true;
    }

    return false;
  }

  /**
   * Override processBatch to handle errors gracefully
   */
  async processBatch(): Promise<void> {
    try {
      const items = await pipelineOrchestrator.getItemsForProcessing(this.processingStatus);

      if (items.length === 0) {
        return;
      }

      console.log(`[${this.name}] Syncing progress for ${items.length} downloading items`);

      // Process all items, catching individual errors
      for (const item of items) {
        await this.processItem(item).catch((err) => {
          console.error(`[${this.name}] Error processing item ${item.id}:`, err);
        });
      }
    } catch (error) {
      console.error(`[${this.name}] Error in processBatch:`, error);
    }
  }
}

export const downloadProgressWorker = new DownloadProgressWorker();
