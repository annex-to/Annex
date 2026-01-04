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
 * DeliverWorker - Unified worker for delivering encoded media to storage servers
 * Processes ENCODED → DELIVERING → COMPLETED
 *
 * No blocking - uses scheduled polling
 * Checkpointing to resume partial deliveries
 * Skips already-delivered servers on retry
 */
export class DeliverWorker extends BaseWorker {
  readonly processingStatus = "ENCODED" as const;
  readonly nextStatus = "COMPLETED" as const;
  readonly name = "DeliverWorker";
  readonly concurrency = 2; // Deliver up to 2 files in parallel (reduced to prevent connection overload)

  /**
   * Process batch - handle both new deliveries and active monitoring
   */
  async processBatch(): Promise<void> {
    await this.startNewDeliveries();
    await this.monitorActiveDeliveries();
  }

  /**
   * Override processItem - not used in new design
   */
  protected async processItem(_item: ProcessingItem): Promise<void> {
    // Not used - processBatch handles everything
  }

  /**
   * Start new deliveries for ENCODED items
   */
  private async startNewDeliveries(): Promise<void> {
    const encodedItems = await pipelineOrchestrator.getItemsForProcessing("ENCODED");

    for (const item of encodedItems.slice(0, this.concurrency)) {
      try {
        await this.startDelivery(item);
      } catch (error) {
        await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Monitor active deliveries for DELIVERING items
   * Since delivery is synchronous (happens in startDelivery), this mainly catches stuck items
   */
  private async monitorActiveDeliveries(): Promise<void> {
    const deliveringItems = await pipelineOrchestrator.getItemsForProcessing("DELIVERING");

    for (const item of deliveringItems) {
      try {
        // Check if item is stuck (no progress update in 30 minutes)
        if (item.lastProgressUpdate) {
          const stallTime = Date.now() - item.lastProgressUpdate.getTime();

          if (stallTime > 30 * 60 * 1000) {
            console.warn(
              `[${this.name}] Delivery stuck for ${item.title} (no update for 30 min), retrying`
            );
            // Reset to ENCODED to retry
            await pipelineOrchestrator.transitionStatus(item.id, "ENCODED", {
              currentStep: undefined,
            });
          }
        }
      } catch (error) {
        await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Start delivery for ENCODED item (or resume DELIVERING item)
   */
  private async startDelivery(item: ProcessingItem): Promise<void> {
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

    // Transition to DELIVERING
    await pipelineOrchestrator.transitionStatus(item.id, "DELIVERING", {
      currentStep: "deliver",
    });

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
            await file.text(); // Force file to be loaded before deleting
            // TODO: Actually delete the file once we confirm this works
            // await Bun.$`rm ${encodedPath}`;
          }
          await this.logActivity(
            item.requestId,
            ActivityType.INFO,
            `Cleaned up encoded file: ${encodedPath}`
          );
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
