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

const MAX_CONCURRENT_DELIVERIES_PER_SERVER = 3;

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

interface ServerDeliveryJob {
  episodeId: string;
  requestId: string;
  season: number;
  episode: number;
  title: string;
  year: number;
  sourceFilePath: string;
  serverId: string;
  encodingProfileId: string;
}

// =============================================================================
// Delivery Queue Service
// =============================================================================

class DeliveryQueueService {
  private queue: DeliveryJob[] = [];
  private processing = false;
  private activeDeliveriesByServer = new Map<string, Set<string>>(); // serverId -> Set<episodeId>

  /**
   * Add an episode to the delivery queue
   */
  async enqueue(job: DeliveryJob): Promise<void> {
    // Check if already queued
    if (this.queue.some((j) => j.episodeId === job.episodeId)) {
      console.log(`[DeliveryQueue] Episode ${job.episodeId} already queued, skipping`);
      return;
    }

    // Check if currently processing this episode to any server
    const isActive = Array.from(this.activeDeliveriesByServer.values()).some((episodes) =>
      episodes.has(job.episodeId)
    );
    if (isActive) {
      console.log(`[DeliveryQueue] Episode ${job.episodeId} currently processing, skipping`);
      return;
    }

    this.queue.push(job);
    const totalActive = Array.from(this.activeDeliveriesByServer.values()).reduce(
      (sum, set) => sum + set.size,
      0
    );
    console.log(
      `[DeliveryQueue] Enqueued S${String(job.season).padStart(2, "0")}E${String(job.episode).padStart(2, "0")} for ${job.title} to ${job.targetServers.length} server(s) (queue: ${this.queue.length}, active: ${totalActive})`
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
   * Process the delivery queue with per-server concurrency
   */
  private async processQueue(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    const hasActiveDeliveries = () => {
      return Array.from(this.activeDeliveriesByServer.values()).some((set) => set.size > 0);
    };

    while (this.queue.length > 0 || hasActiveDeliveries()) {
      // Process next job if any in queue
      if (this.queue.length > 0) {
        const job = this.queue[0];

        // Try to start deliveries for this job's servers
        let startedAny = false;
        for (const target of job.targetServers) {
          const serverActive = this.activeDeliveriesByServer.get(target.serverId) || new Set();

          // Check if this server has capacity
          if (serverActive.size < MAX_CONCURRENT_DELIVERIES_PER_SERVER) {
            // Remove job from queue if this is the first server we're starting
            if (!startedAny) {
              this.queue.shift();
              startedAny = true;
            }

            // Mark as active for this server
            if (!this.activeDeliveriesByServer.has(target.serverId)) {
              this.activeDeliveriesByServer.set(target.serverId, new Set());
            }
            this.activeDeliveriesByServer.get(target.serverId)!.add(job.episodeId);

            // Start delivery to this server
            const serverJob: ServerDeliveryJob = {
              episodeId: job.episodeId,
              requestId: job.requestId,
              season: job.season,
              episode: job.episode,
              title: job.title,
              year: job.year,
              sourceFilePath: job.sourceFilePath,
              serverId: target.serverId,
              encodingProfileId: target.encodingProfileId,
            };

            this.deliverToServer(serverJob, job.targetServers.length).finally(() => {
              const serverSet = this.activeDeliveriesByServer.get(target.serverId);
              if (serverSet) {
                serverSet.delete(job.episodeId);
                if (serverSet.size === 0) {
                  this.activeDeliveriesByServer.delete(target.serverId);
                }
              }
            });
          }
        }

        // If we couldn't start any deliveries, wait before trying again
        if (!startedAny) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } else {
        // No jobs in queue, just wait for active deliveries
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    this.processing = false;
    console.log("[DeliveryQueue] Queue processing complete");
  }

  /**
   * Deliver a single episode to a single server
   */
  private async deliverToServer(
    job: ServerDeliveryJob,
    totalServers: number
  ): Promise<void> {
    const epNum = `S${String(job.season).padStart(2, "0")}E${String(job.episode).padStart(2, "0")}`;

    try {
      // Get server info
      const server = await prisma.storageServer.findUnique({
        where: { id: job.serverId },
      });

      if (!server || !server.enabled) {
        console.error(`[DeliveryQueue] ✗ ${epNum} server ${job.serverId} not found or disabled`);
        await this.checkEpisodeCompletion(job.episodeId, job.requestId, totalServers);
        return;
      }

      console.log(
        `[DeliveryQueue] Delivering ${epNum} for ${job.title} to ${server.name}`
      );

      const delivery = getDeliveryService();
      const naming = getNamingService();

      // Generate remote path
      const remotePath = naming.getTvDestinationPath(server.pathTv, {
        series: job.title,
        year: job.year,
        season: job.season,
        episode: job.episode,
        quality: "2160p",
        codec: "AV1",
        container: "mkv",
      });

      const result = await delivery.deliver(server.id, job.sourceFilePath, remotePath);

      if (result.success) {
        console.log(`[DeliveryQueue] ✓ ${epNum} delivered to ${server.name}`);
      } else {
        console.error(
          `[DeliveryQueue] ✗ ${epNum} failed to deliver to ${server.name}: ${result.error}`
        );
      }
    } catch (error) {
      console.error(
        `[DeliveryQueue] ✗ ${epNum} error delivering to server:`,
        error instanceof Error ? error.message : error
      );
    }

    // Check if episode is complete (delivered to all servers)
    await this.checkEpisodeCompletion(job.episodeId, job.requestId, totalServers);
  }

  /**
   * Check if episode has been delivered to all target servers
   */
  private async checkEpisodeCompletion(
    episodeId: string,
    requestId: string,
    totalServers: number
  ): Promise<void> {
    // Check if episode is still active on any server
    const isStillActive = Array.from(this.activeDeliveriesByServer.values()).some((episodes) =>
      episodes.has(episodeId)
    );

    if (!isStillActive) {
      // Episode delivery is complete - check library to see if it succeeded
      const episode = await prisma.processingItem.findUnique({
        where: { id: episodeId },
        select: { season: true, episode: true },
      });

      if (!episode || episode.season === null || episode.episode === null) {
        return;
      }

      // Get request to find target servers
      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        select: { tmdbId: true, targets: true },
      });

      if (!request) {
        return;
      }

      const targets = request.targets as unknown as Array<{ serverId: string }>;
      const serverIds = targets.map((t) => t.serverId);

      // Check if episode is in library on all target servers
      const libraryItems = await prisma.episodeLibraryItem.findMany({
        where: {
          tmdbId: request.tmdbId,
          season: episode.season,
          episode: episode.episode,
          serverId: { in: serverIds },
        },
      });

      const deliveredToAll = libraryItems.length === serverIds.length;

      if (deliveredToAll) {
        await prisma.processingItem.update({
          where: { id: episodeId },
          data: {
            status: ProcessingStatus.COMPLETED,
            deliveredAt: new Date(),
            lastError: null,
          },
        });
      } else {
        await prisma.processingItem.update({
          where: { id: episodeId },
          data: {
            status: ProcessingStatus.FAILED,
            lastError: `Only delivered to ${libraryItems.length}/${serverIds.length} servers`,
          },
        });
      }

      // Update request status
      await this.updateRequestStatus(requestId);
    }
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
   * Get queue status
   */
  getStatus(): {
    queueSize: number;
    processing: boolean;
    activeDeliveries: number;
    activeDeliveriesByServer: Record<string, number>;
  } {
    const activeDeliveriesByServer: Record<string, number> = {};
    for (const [serverId, episodes] of this.activeDeliveriesByServer.entries()) {
      activeDeliveriesByServer[serverId] = episodes.size;
    }

    const totalActive = Array.from(this.activeDeliveriesByServer.values()).reduce(
      (sum, set) => sum + set.size,
      0
    );

    return {
      queueSize: this.queue.length,
      processing: this.processing,
      activeDeliveries: totalActive,
      activeDeliveriesByServer,
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
