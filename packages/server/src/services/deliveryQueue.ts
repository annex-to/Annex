/**
 * Delivery Queue Service
 *
 * Manages sequential delivery of episodes to storage servers to avoid
 * overwhelming SFTP connections.
 *
 * Key principles:
 * - Process up to MAX_CONCURRENT_DELIVERIES at a time
 * - Queue episodes for delivery instead of spawning branch pipelines
 * - Database-backed queue for crash resilience
 */

import { ProcessingStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getDeliveryService } from "./delivery.js";
import { getNamingService } from "./naming.js";

// =============================================================================
// Constants
// =============================================================================

const MAX_CONCURRENT_DELIVERIES = 3;

// =============================================================================
// Types
// =============================================================================

interface DeliveryJob {
  episodeId: string;
  requestId: string;
  season: number;
  episode: number;
  title: string;
  year: number;
  sourceFilePath: string;
  targetServers: Array<{
    serverId: string;
    encodingProfileId: string;
  }>;
}

interface DeliveryResult {
  success: boolean;
  deliveredServers: string[];
  failedServers: string[];
  error?: string;
}

// =============================================================================
// Delivery Queue Service
// =============================================================================

class DeliveryQueueService {
  private queue: DeliveryJob[] = [];
  private processing = false;
  private activeDeliveries = new Set<string>();

  /**
   * Add an episode to the delivery queue
   */
  async enqueue(job: DeliveryJob): Promise<void> {
    // Check if already queued
    if (this.queue.some((j) => j.episodeId === job.episodeId)) {
      console.log(`[DeliveryQueue] Episode ${job.episodeId} already queued, skipping`);
      return;
    }

    // Check if currently processing this episode
    if (this.activeDeliveries.has(job.episodeId)) {
      console.log(`[DeliveryQueue] Episode ${job.episodeId} currently processing, skipping`);
      return;
    }

    this.queue.push(job);
    console.log(
      `[DeliveryQueue] Enqueued S${String(job.season).padStart(2, "0")}E${String(job.episode).padStart(2, "0")} for ${job.title} (queue: ${this.queue.length}, active: ${this.activeDeliveries.size})`
    );

    // Update episode status to DELIVERING
    await prisma.processingItem.update({
      where: { id: job.episodeId },
      data: { status: ProcessingStatus.DELIVERING },
    });

    // Start processing if not already running
    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Process the delivery queue with concurrent deliveries
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 || this.activeDeliveries.size > 0) {
      // Start new deliveries up to the concurrency limit
      while (
        this.queue.length > 0 &&
        this.activeDeliveries.size < MAX_CONCURRENT_DELIVERIES
      ) {
        const job = this.queue.shift();
        if (!job) {
          break;
        }

        // Process delivery async (don't await)
        this.activeDeliveries.add(job.episodeId);
        this.processDelivery(job).finally(() => {
          this.activeDeliveries.delete(job.episodeId);
        });
      }

      // Wait a bit before checking again
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this.processing = false;
    console.log("[DeliveryQueue] Queue processing complete");
  }

  /**
   * Process a single delivery
   */
  private async processDelivery(job: DeliveryJob): Promise<void> {
    const epNum = `S${String(job.season).padStart(2, "0")}E${String(job.episode).padStart(2, "0")}`;
    console.log(
      `[DeliveryQueue] Processing ${epNum} for ${job.title} (queue: ${this.queue.length}, active: ${this.activeDeliveries.size})`
    );

    try {
      const result = await this.deliverEpisode(job);

      if (result.success) {
        console.log(
          `[DeliveryQueue] ✓ ${epNum} delivered to ${result.deliveredServers.length} server(s)`
        );

        await prisma.processingItem.update({
          where: { id: job.episodeId },
          data: {
            status: ProcessingStatus.COMPLETED,
            deliveredAt: new Date(),
            lastError: null,
          },
        });
      } else {
        console.error(`[DeliveryQueue] ✗ ${epNum} failed: ${result.error}`);

        await prisma.processingItem.update({
          where: { id: job.episodeId },
          data: {
            status: ProcessingStatus.FAILED,
            lastError: result.error,
          },
        });
      }
    } catch (error) {
      console.error(
        `[DeliveryQueue] ✗ ${epNum} error:`,
        error instanceof Error ? error.message : error
      );

      await prisma.processingItem.update({
        where: { id: job.episodeId },
        data: {
          status: ProcessingStatus.FAILED,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }

    // Check if all episodes for this request are complete
    await this.updateRequestStatus(job.requestId);
  }

  /**
   * Update request status based on episode completion
   */
  private async updateRequestStatus(requestId: string): Promise<void> {
    const episodes = await prisma.processingItem.findMany({
      where: { requestId, type: "EPISODE" },
      select: { status: true },
    });

    if (episodes.length === 0) {
      return;
    }

    const statusCounts = episodes.reduce(
      (acc: Record<string, number>, ep: { status: ProcessingStatus }) => {
        acc[ep.status] = (acc[ep.status] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const completed = statusCounts.COMPLETED || 0;
    const failed = statusCounts.FAILED || 0;
    const cancelled = statusCounts.CANCELLED || 0;
    const delivering = statusCounts.DELIVERING || 0;
    const total = episodes.length;

    // All episodes done (completed, failed, or cancelled)
    if (completed + failed + cancelled === total) {
      if (completed > 0) {
        // At least some episodes succeeded
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: "COMPLETED",
            progress: 100,
            currentStep: `Delivered ${completed} episode(s)`,
            completedAt: new Date(),
          },
        });
        console.log(
          `[DeliveryQueue] Request ${requestId} completed: ${completed} delivered, ${failed} failed, ${cancelled} cancelled`
        );
      } else {
        // All episodes failed or skipped
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: "FAILED",
            progress: 0,
            currentStep: "All episodes failed delivery",
            error: "All episodes failed or were cancelled",
          },
        });
        console.log(
          `[DeliveryQueue] Request ${requestId} failed: ${failed} failed, ${cancelled} cancelled`
        );
      }
    } else {
      // Still delivering - update progress
      const progress = Math.floor(((completed + failed + cancelled) / total) * 100);
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: "DELIVERING",
          progress,
          currentStep: `Delivered ${completed}/${total} episodes (${delivering} in queue)`,
        },
      });
    }
  }

  /**
   * Deliver an episode to target servers
   */
  private async deliverEpisode(job: DeliveryJob): Promise<DeliveryResult> {
    const deliveredServers: string[] = [];
    const failedServers: string[] = [];

    // Get target servers
    const servers = await prisma.storageServer.findMany({
      where: {
        id: { in: job.targetServers.map((t) => t.serverId) },
        enabled: true,
      },
    });

    if (servers.length === 0) {
      return {
        success: false,
        deliveredServers: [],
        failedServers: job.targetServers.map((t) => t.serverId),
        error: "No enabled target servers found",
      };
    }

    const delivery = getDeliveryService();
    const naming = getNamingService();

    // Deliver to each server
    for (const server of servers) {
      try {
        // Generate remote path for this server
        const remotePath = naming.getTvDestinationPath(server.pathTv, {
          series: job.title,
          year: job.year,
          season: job.season,
          episode: job.episode,
          quality: "2160p", // Hardcoded for now, should come from encoding profile
          codec: "AV1",
          container: "mkv",
        });

        const result = await delivery.deliver(server.id, job.sourceFilePath, remotePath);

        if (result.success) {
          deliveredServers.push(server.id);
        } else {
          failedServers.push(server.id);
          console.error(`[DeliveryQueue] Failed to deliver to ${server.name}: ${result.error}`);
        }
      } catch (error) {
        failedServers.push(server.id);
        console.error(`[DeliveryQueue] Error delivering to ${server.name}:`, error);
      }
    }

    const success = deliveredServers.length > 0;
    const error = !success
      ? `Failed to deliver to all ${servers.length} server(s)`
      : failedServers.length > 0
        ? `Failed to deliver to ${failedServers.length} server(s)`
        : undefined;

    return {
      success,
      deliveredServers,
      failedServers,
      error,
    };
  }

  /**
   * Get queue status
   */
  getStatus(): {
    queueSize: number;
    processing: boolean;
    activeDeliveries: number;
  } {
    return {
      queueSize: this.queue.length,
      processing: this.processing,
      activeDeliveries: this.activeDeliveries.size,
    };
  }

  /**
   * Clear the queue (for testing/recovery)
   */
  clear(): void {
    this.queue = [];
    console.log("[DeliveryQueue] Queue cleared");
  }
}

// =============================================================================
// Singleton
// =============================================================================

let deliveryQueueService: DeliveryQueueService | null = null;

export function getDeliveryQueue(): DeliveryQueueService {
  if (!deliveryQueueService) {
    deliveryQueueService = new DeliveryQueueService();
  }
  return deliveryQueueService;
}
