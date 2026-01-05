import { ActivityType, type MediaType, type ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDeliveryService } from "../../delivery.js";
import { getNamingService } from "../../naming.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { BaseWorker } from "./BaseWorker";

/**
 * Checkpoint structure for tracking delivery progress
 */
interface DeliveryCheckpoint {
  deliveredServers: Array<{
    serverId: string;
    serverName: string;
    completedAt: string;
  }>;
  failedServers: Array<{
    serverId: string;
    serverName: string;
    error: string;
  }>;
}

/**
 * Active delivery tracking
 */
interface ActiveDelivery {
  itemId: string;
  promise: Promise<void>;
  startedAt: Date;
  settled: boolean; // Track when promise completes
}

/**
 * DeliverWorker - Unified worker for delivering encoded media to storage servers
 * Processes ENCODED → DELIVERING → COMPLETED
 *
 * Uses scheduler-style polling with true concurrency
 * Checkpointing to resume partial deliveries
 * Skips already-delivered servers on retry
 */
export class DeliverWorker extends BaseWorker {
  readonly processingStatus = "ENCODED" as const;
  readonly nextStatus = "COMPLETED" as const;
  readonly name = "DeliverWorker";
  readonly concurrency = 2; // Deliver up to 2 files in parallel (reduced to prevent connection overload)

  // Track active deliveries (non-blocking promises)
  private activeDeliveries: Map<string, ActiveDelivery> = new Map();

  /**
   * Process batch - handle both new deliveries and active monitoring
   */
  async processBatch(): Promise<void> {
    // Clean up completed deliveries
    await this.cleanupCompletedDeliveries();

    // Start new deliveries if we have capacity
    await this.startNewDeliveries();
  }

  /**
   * Override processItem - not used in new design
   */
  protected async processItem(_item: ProcessingItem): Promise<void> {
    // Not used - processBatch handles everything
  }

  /**
   * Clean up completed delivery promises
   */
  private async cleanupCompletedDeliveries(): Promise<void> {
    const completedIds: string[] = [];

    // Find settled deliveries
    for (const [itemId, delivery] of this.activeDeliveries.entries()) {
      if (delivery.settled) {
        completedIds.push(itemId);
      }
    }

    // Remove completed deliveries
    if (completedIds.length > 0) {
      for (const itemId of completedIds) {
        this.activeDeliveries.delete(itemId);
      }
      console.log(
        `[${this.name}] Cleaned up ${completedIds.length} completed deliveries, active count: ${this.activeDeliveries.size}`
      );
    }
  }

  /**
   * Start new deliveries for ENCODED items (non-blocking)
   */
  private async startNewDeliveries(): Promise<void> {
    // Check how many slots are available
    const activeCount = this.activeDeliveries.size;
    const availableSlots = this.concurrency - activeCount;

    if (availableSlots <= 0) {
      return; // No capacity
    }

    // Get ENCODED items that aren't already being delivered
    const encodedItems = await pipelineOrchestrator.getItemsForProcessing("ENCODED");
    const newItems = encodedItems.filter((item) => !this.activeDeliveries.has(item.id));

    // Start deliveries up to available slots
    for (const item of newItems.slice(0, availableSlots)) {
      console.log(
        `[${this.name}] Starting delivery for ${item.title} (active: ${this.activeDeliveries.size + 1}/${this.concurrency})`
      );

      // Create tracking entry
      const activeDelivery: ActiveDelivery = {
        itemId: item.id,
        promise: Promise.resolve(), // Placeholder, will be replaced
        startedAt: new Date(),
        settled: false,
      };

      // Start delivery in background (non-blocking)
      const deliveryPromise = this.executeDelivery(item).finally(() => {
        // Mark as settled when promise completes (success or failure)
        const delivery = this.activeDeliveries.get(item.id);
        if (delivery) {
          delivery.settled = true;
        }
      });

      // Update with actual promise
      activeDelivery.promise = deliveryPromise;

      // Track active delivery
      this.activeDeliveries.set(item.id, activeDelivery);
    }
  }

  /**
   * Execute delivery for ENCODED item (runs in background, handles errors internally)
   */
  private async executeDelivery(item: ProcessingItem): Promise<void> {
    try {
      await this.performDelivery(item);
    } catch (error) {
      // Handle error internally since this runs in background
      await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Perform delivery for ENCODED item (or resume DELIVERING item)
   */
  private async performDelivery(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Starting delivery for ${item.title}`);

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Extract previous step contexts
    const stepContext = item.stepContext as Record<string, unknown>;
    const encodeData = stepContext.encode as PipelineContext["encode"];

    if (!encodeData?.encodedFiles || encodeData.encodedFiles.length === 0) {
      throw new Error("No encoded files found in item context");
    }

    // Load checkpoint (which servers have already been delivered)
    const checkpoint = (item.checkpoint as unknown as DeliveryCheckpoint) || {
      deliveredServers: [],
      failedServers: [],
    };

    // Early exit: if all servers already delivered, skip to COMPLETED
    const targetServerIds = encodeData.encodedFiles.flatMap((file) => {
      const f = file as { targetServerIds: string[] };
      return f.targetServerIds || [];
    });
    const uniqueTargetServers = [...new Set(targetServerIds)];
    const deliveredServerIds = checkpoint.deliveredServers.map((s) => s.serverId);
    const allServersDelivered = uniqueTargetServers.every((id) => deliveredServerIds.includes(id));

    if (allServersDelivered && checkpoint.deliveredServers.length > 0) {
      console.log(
        `[${this.name}] Early exit: ${item.title} already delivered to all servers, promoting to COMPLETED`
      );
      await this.handleCompletedDelivery(item, encodeData, checkpoint.deliveredServers);
      return;
    }

    // Transition to DELIVERING (only if not already there)
    if (item.status !== "DELIVERING") {
      await pipelineOrchestrator.transitionStatus(item.id, "DELIVERING", {
        currentStep: "deliver",
      });
    }

    // Initialize progress tracking
    await pipelineOrchestrator.updateProgress(item.id, 0, {
      lastProgressUpdate: new Date(),
      lastProgressValue: 0,
    });

    // Deliver files
    const deliveryService = getDeliveryService();
    const namingService = getNamingService();

    const deliveredServers: Array<{
      serverId: string;
      serverName: string;
      completedAt: string;
    }> = [...checkpoint.deliveredServers];
    const failedServers: Array<{ serverId: string; serverName: string; error: string }> = [
      ...checkpoint.failedServers,
    ];

    // Process each encoded file
    for (const encodedFile of encodeData.encodedFiles) {
      const {
        path: encodedFilePath,
        resolution,
        codec,
        targetServerIds,
        season,
        episode,
      } = encodedFile as {
        path: string;
        resolution: string;
        codec: string;
        targetServerIds: string[];
        season?: number;
        episode?: number;
      };

      const servers = await prisma.storageServer.findMany({
        where: { id: { in: targetServerIds } },
      });

      const container = encodedFilePath.split(".").pop() || "mkv";
      const totalServers = servers.length;
      let completedServers = 0;

      for (const server of servers) {
        // Skip if already delivered to this server
        if (deliveredServers.some((s) => s.serverId === server.id)) {
          console.log(
            `[${this.name}] ${item.title}: Already delivered to ${server.name}, skipping`
          );
          completedServers++;
          continue;
        }

        // Calculate remote path
        let remotePath: string;
        let displayName: string;

        if (item.type === "MOVIE") {
          remotePath = namingService.getMovieDestinationPath(server.pathMovies, {
            title: item.title,
            year: item.year || new Date().getFullYear(),
            tmdbId: item.tmdbId,
            quality: resolution,
            codec,
            container,
          });
          displayName = `${item.title} (${item.year})`;
        } else {
          // TV episode
          if (season === undefined || episode === undefined) {
            throw new Error("Missing season/episode metadata for TV delivery");
          }

          const episodeTitle = (encodedFile as { episodeTitle?: string }).episodeTitle;

          remotePath = namingService.getTvDestinationPath(server.pathTv, {
            series: request.title, // Use series title, not episode title
            year: item.year || new Date().getFullYear(),
            season,
            episode,
            episodeTitle,
            quality: resolution,
            codec,
            container,
          });
          displayName = `${request.title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
        }

        await this.logActivity(
          item.requestId,
          ActivityType.INFO,
          `Delivering ${displayName} to ${server.name}: ${remotePath}`
        );

        // Deliver file
        try {
          const result = await deliveryService.deliver(server.id, encodedFilePath, remotePath, {
            onProgress: async (progress) => {
              const speed = `${this.formatBytes(progress.speed)}/s`;
              const eta = progress.eta > 0 ? `ETA: ${this.formatDuration(progress.eta)}` : "";
              const progressMessage = `${server.name}: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`;

              // Update progress
              const overallProgress =
                ((completedServers + progress.progress / 100) / totalServers) * 100;

              await pipelineOrchestrator.updateProgress(item.id, overallProgress, {
                lastProgressUpdate: new Date(),
                lastProgressValue: overallProgress,
              });

              // Update current step message
              await prisma.processingItem.update({
                where: { id: item.id },
                data: { currentStep: progressMessage },
              });
            },
          });

          if (result.success) {
            // Mark as delivered
            deliveredServers.push({
              serverId: server.id,
              serverName: server.name,
              completedAt: new Date().toISOString(),
            });
            completedServers++;

            await this.logActivity(
              item.requestId,
              ActivityType.SUCCESS,
              `Delivered ${displayName} to ${server.name} in ${this.formatDuration(result.duration)}`,
              {
                server: server.name,
                bytesTransferred: result.bytesTransferred,
                duration: result.duration,
                libraryScanTriggered: result.libraryScanTriggered,
              }
            );

            // Create LibraryItem record
            await prisma.libraryItem.upsert({
              where: {
                tmdbId_type_serverId: {
                  tmdbId: item.tmdbId,
                  type: request.type as MediaType,
                  serverId: server.id,
                },
              },
              create: {
                tmdbId: item.tmdbId,
                type: request.type as MediaType,
                serverId: server.id,
                quality: `${resolution} ${codec}`,
                addedAt: new Date(),
              },
              update: {
                quality: `${resolution} ${codec}`,
                syncedAt: new Date(),
              },
            });

            // Update checkpoint
            const updatedCheckpoint: DeliveryCheckpoint = {
              deliveredServers,
              failedServers,
            };

            await prisma.processingItem.update({
              where: { id: item.id },
              data: {
                checkpoint:
                  updatedCheckpoint as unknown as import("@prisma/client").Prisma.InputJsonValue,
              },
            });
          } else {
            // Mark as failed
            failedServers.push({
              serverId: server.id,
              serverName: server.name,
              error: result.error || "Unknown error",
            });

            await this.logActivity(
              item.requestId,
              ActivityType.ERROR,
              `Failed to deliver ${displayName} to ${server.name}: ${result.error}`
            );
          }
        } catch (error) {
          // Handle delivery exception
          const errorMessage = error instanceof Error ? error.message : String(error);

          failedServers.push({
            serverId: server.id,
            serverName: server.name,
            error: errorMessage,
          });

          await this.logActivity(
            item.requestId,
            ActivityType.ERROR,
            `Failed to deliver ${displayName} to ${server.name}: ${errorMessage}`
          );
        }
      }
    }

    // Determine overall success
    const allServersSucceeded = failedServers.length === 0;
    const someServersSucceeded = deliveredServers.length > 0;

    if (allServersSucceeded) {
      // Complete success
      await this.handleCompletedDelivery(item, encodeData, deliveredServers);
    } else if (someServersSucceeded) {
      // Partial success - keep checkpoint and retry failed servers
      const errorDetails = failedServers.map((f) => `${f.serverName}: ${f.error}`).join("; ");
      const error = `Delivered to ${deliveredServers.length} servers, failed ${failedServers.length} - ${errorDetails}`;

      await this.logActivity(
        item.requestId,
        ActivityType.WARNING,
        `Partial delivery success: ${deliveredServers.length} succeeded, ${failedServers.length} failed`
      );

      throw new Error(error);
    } else {
      // Total failure
      const errorDetails = failedServers.map((f) => `${f.serverName}: ${f.error}`).join("; ");
      throw new Error(`Failed to deliver to all servers - ${errorDetails}`);
    }
  }

  /**
   * Handle completed delivery - clean up files and transition to COMPLETED
   */
  private async handleCompletedDelivery(
    item: ProcessingItem,
    encodeData: PipelineContext["encode"],
    deliveredServers: Array<{ serverId: string; serverName: string; completedAt: string }>
  ): Promise<void> {
    console.log(
      `[${this.name}] Delivery complete for ${item.title} (${deliveredServers.length} servers)`
    );

    // Clean up encoded files
    if (encodeData?.encodedFiles) {
      for (const encodedFile of encodeData.encodedFiles) {
        const encodedPath = (encodedFile as { path: string }).path;
        try {
          const file = Bun.file(encodedPath);
          const exists = await file.exists();
          if (exists) {
            // TODO: Actually delete the file once we confirm delivery works
            // await Bun.$`rm ${encodedPath}`;
            await this.logActivity(
              item.requestId,
              ActivityType.INFO,
              `Encoded file ready for cleanup: ${encodedPath}`
            );
          }
        } catch (err) {
          // Log but don't fail delivery on cleanup errors
          await this.logActivity(
            item.requestId,
            ActivityType.WARNING,
            `Failed to clean up encoded file: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
      }
    }

    // Build delivery context
    const stepContext = (item.stepContext as Record<string, unknown>) || {};
    const deliverContext = {
      deliveredServers: deliveredServers.map((s) => s.serverId),
      failedServers: [],
      completedAt: new Date().toISOString(),
    };

    const newStepContext = {
      ...stepContext,
      deliver: deliverContext,
      deliveryResults: deliverContext,
      allDeliveriesComplete: true,
    };

    // Transition to COMPLETED
    await pipelineOrchestrator.transitionStatus(item.id, "COMPLETED", {
      currentStep: "deliver_complete",
      stepContext: newStepContext,
    });

    await this.logActivity(
      item.requestId,
      ActivityType.SUCCESS,
      `Completed delivery of ${item.title} to ${deliveredServers.length} servers`
    );

    console.log(`[${this.name}] Transitioned ${item.title} to COMPLETED`);
  }

  /**
   * Handle error for an item
   */
  private async handleError(item: ProcessingItem, error: Error): Promise<void> {
    console.error(`[${this.name}] Error processing ${item.title}:`, error);

    // Don't pass service parameter - delivery errors are usually network-related
    // and specific to individual servers, not a service outage
    await pipelineOrchestrator.handleError(item.id, error);
  }

  /**
   * Log activity
   */
  private async logActivity(
    requestId: string,
    type: ActivityType,
    message: string,
    details?: object
  ): Promise<void> {
    await prisma.activityLog.create({
      data: {
        requestId,
        type,
        message,
        details: details || undefined,
      },
    });
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}

export const deliverWorker = new DeliverWorker();
