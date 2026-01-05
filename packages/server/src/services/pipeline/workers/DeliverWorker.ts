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
 * Active delivery tracking (per item-server pair)
 */
interface ActiveDelivery {
  itemId: string;
  serverId: string;
  serverName: string;
  promise: Promise<void>;
  startedAt: Date;
  settled: boolean; // Track when promise completes
}

/**
 * DeliverWorker - Unified worker for delivering encoded media to storage servers
 * Processes ENCODED → DELIVERING → COMPLETED
 *
 * Uses scheduler-style polling with true concurrency
 * Per-server concurrency limits (3 per server)
 * Checkpointing to resume partial deliveries
 * Skips already-delivered servers on retry
 */
export class DeliverWorker extends BaseWorker {
  readonly processingStatus = "ENCODED" as const;
  readonly nextStatus = "COMPLETED" as const;
  readonly name = "DeliverWorker";
  readonly concurrencyPerServer = 3; // Max 3 concurrent deliveries per storage server

  // Track active deliveries by server (serverId -> Set of delivery keys)
  private activeDeliveriesByServer: Map<string, Set<string>> = new Map();
  // Track delivery details by key (itemId:serverId -> ActiveDelivery)
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
    const completedKeys: string[] = [];

    // Find settled deliveries
    for (const [deliveryKey, delivery] of this.activeDeliveries.entries()) {
      if (delivery.settled) {
        completedKeys.push(deliveryKey);
      }
    }

    // Remove completed deliveries
    if (completedKeys.length > 0) {
      for (const deliveryKey of completedKeys) {
        const delivery = this.activeDeliveries.get(deliveryKey);
        if (delivery) {
          // Remove from server tracking
          const serverSet = this.activeDeliveriesByServer.get(delivery.serverId);
          if (serverSet) {
            serverSet.delete(deliveryKey);
            if (serverSet.size === 0) {
              this.activeDeliveriesByServer.delete(delivery.serverId);
            }
          }
        }
        // Remove from main tracking
        this.activeDeliveries.delete(deliveryKey);
      }

      // Log cleanup with per-server breakdown
      const serverCounts = new Map<string, number>();
      for (const delivery of this.activeDeliveries.values()) {
        serverCounts.set(delivery.serverName, (serverCounts.get(delivery.serverName) || 0) + 1);
      }
      const breakdown = Array.from(serverCounts.entries())
        .map(([name, count]) => `${name}: ${count}`)
        .join(", ");

      console.log(
        `[${this.name}] Cleaned up ${completedKeys.length} deliveries, active: ${this.activeDeliveries.size} total (${breakdown || "none"})`
      );
    }
  }

  /**
   * Start new deliveries for ENCODED items (non-blocking, per-server concurrency)
   */
  private async startNewDeliveries(): Promise<void> {
    // Get ENCODED items
    const encodedItems = await pipelineOrchestrator.getItemsForProcessing("ENCODED");

    for (const item of encodedItems) {
      // Get step context
      const stepContext = item.stepContext as Record<string, unknown>;
      const encodeData = stepContext.encode as PipelineContext["encode"];

      if (!encodeData?.encodedFiles || encodeData.encodedFiles.length === 0) {
        continue; // Skip items without encoded files
      }

      // Load checkpoint to see which servers already delivered
      const checkpoint = (item.checkpoint as unknown as DeliveryCheckpoint) || {
        deliveredServers: [],
        failedServers: [],
      };
      const deliveredServerIds = checkpoint.deliveredServers.map((s) => s.serverId);

      // Get target servers for this item
      const targetServerIds = encodeData.encodedFiles.flatMap((file) => {
        const f = file as { targetServerIds: string[] };
        return f.targetServerIds || [];
      });
      const uniqueTargetServers = [...new Set(targetServerIds)];

      // Get server details
      const servers = await prisma.storageServer.findMany({
        where: { id: { in: uniqueTargetServers } },
        select: { id: true, name: true },
      });

      // For each server, check if we can start a delivery
      for (const server of servers) {
        // Skip if already delivered to this server
        if (deliveredServerIds.includes(server.id)) {
          continue;
        }

        // Check server capacity
        const serverActiveSet = this.activeDeliveriesByServer.get(server.id);
        const serverActiveCount = serverActiveSet?.size || 0;

        if (serverActiveCount >= this.concurrencyPerServer) {
          continue; // Server at capacity
        }

        // Check if this (item, server) pair is already being delivered
        const deliveryKey = `${item.id}:${server.id}`;
        if (this.activeDeliveries.has(deliveryKey)) {
          continue; // Already delivering
        }

        // Start delivery for this (item, server) pair
        console.log(
          `[${this.name}] Starting delivery: ${item.title} → ${server.name} (server: ${serverActiveCount + 1}/${this.concurrencyPerServer})`
        );

        // Create tracking entry
        const activeDelivery: ActiveDelivery = {
          itemId: item.id,
          serverId: server.id,
          serverName: server.name,
          promise: Promise.resolve(), // Placeholder
          startedAt: new Date(),
          settled: false,
        };

        // Start delivery in background
        const deliveryPromise = this.executeDeliveryToServer(item, server.id, server.name).finally(
          () => {
            const delivery = this.activeDeliveries.get(deliveryKey);
            if (delivery) {
              delivery.settled = true;
            }
          }
        );

        activeDelivery.promise = deliveryPromise;

        // Track active delivery
        this.activeDeliveries.set(deliveryKey, activeDelivery);

        // Track by server
        if (!this.activeDeliveriesByServer.has(server.id)) {
          this.activeDeliveriesByServer.set(server.id, new Set());
        }
        this.activeDeliveriesByServer.get(server.id)?.add(deliveryKey);
      }
    }
  }

  /**
   * Execute delivery for one item to one server (runs in background, handles errors internally)
   */
  private async executeDeliveryToServer(
    item: ProcessingItem,
    serverId: string,
    serverName: string
  ): Promise<void> {
    try {
      await this.performDeliveryToServer(item, serverId, serverName);
    } catch (error) {
      console.error(
        `[${this.name}] Error delivering ${item.title} to ${serverName}:`,
        error instanceof Error ? error.message : error
      );
      // Don't call handleError - partial delivery failures are tracked in checkpoints
      // Item will retry failed servers on next cycle
    }
  }

  /**
   * Perform delivery for one item to one server
   */
  private async performDeliveryToServer(
    item: ProcessingItem,
    serverId: string,
    serverName: string
  ): Promise<void> {
    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Extract encode context
    const stepContext = item.stepContext as Record<string, unknown>;
    const encodeData = stepContext.encode as PipelineContext["encode"];

    if (!encodeData?.encodedFiles || encodeData.encodedFiles.length === 0) {
      throw new Error("No encoded files found in item context");
    }

    // Load checkpoint
    const checkpoint = (item.checkpoint as unknown as DeliveryCheckpoint) || {
      deliveredServers: [],
      failedServers: [],
    };

    // Check if already delivered to this server
    if (checkpoint.deliveredServers.some((s) => s.serverId === serverId)) {
      console.log(`[${this.name}] ${item.title} already delivered to ${serverName}, skipping`);
      return;
    }

    // Transition to DELIVERING if needed
    if (item.status !== "DELIVERING") {
      await pipelineOrchestrator.transitionStatus(item.id, "DELIVERING", {
        currentStep: "deliver",
      });
    }

    // Get server details
    const server = await prisma.storageServer.findUnique({
      where: { id: serverId },
    });

    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }

    // Find the encoded file for this server
    const encodedFile = encodeData.encodedFiles.find((file) => {
      const f = file as { targetServerIds: string[] };
      return f.targetServerIds?.includes(serverId);
    });

    if (!encodedFile) {
      throw new Error(`No encoded file found for server ${serverId}`);
    }

    const {
      path: encodedFilePath,
      resolution,
      codec,
      season,
      episode,
    } = encodedFile as {
      path: string;
      resolution: string;
      codec: string;
      season?: number;
      episode?: number;
    };

    const container = encodedFilePath.split(".").pop() || "mkv";
    const deliveryService = getDeliveryService();
    const namingService = getNamingService();

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
        series: request.title,
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

    // Deliver file
    const result = await deliveryService.deliver(server.id, encodedFilePath, remotePath, {
      onProgress: async (progress) => {
        const speed = `${this.formatBytes(progress.speed)}/s`;
        const eta = progress.eta > 0 ? `ETA: ${this.formatDuration(progress.eta)}` : "";
        const progressMessage = `${server.name}: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`;

        await prisma.processingItem.update({
          where: { id: item.id },
          data: { currentStep: progressMessage },
        });
      },
    });

    if (!result.success) {
      // Update checkpoint with failure
      const updatedCheckpoint: DeliveryCheckpoint = {
        ...checkpoint,
        failedServers: [
          ...checkpoint.failedServers.filter((s) => s.serverId !== serverId),
          {
            serverId: server.id,
            serverName: server.name,
            error: result.error || "Unknown error",
          },
        ],
      };

      await prisma.processingItem.update({
        where: { id: item.id },
        data: {
          checkpoint:
            updatedCheckpoint as unknown as import("@prisma/client").Prisma.InputJsonValue,
        },
      });

      throw new Error(`Delivery failed: ${result.error}`);
    }

    // Success - update checkpoint
    const updatedCheckpoint: DeliveryCheckpoint = {
      deliveredServers: [
        ...checkpoint.deliveredServers,
        {
          serverId: server.id,
          serverName: server.name,
          completedAt: new Date().toISOString(),
        },
      ],
      failedServers: checkpoint.failedServers.filter((s) => s.serverId !== serverId),
    };

    await prisma.processingItem.update({
      where: { id: item.id },
      data: {
        checkpoint: updatedCheckpoint as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
    });

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

    await this.logActivity(
      item.requestId,
      ActivityType.SUCCESS,
      `Delivered ${displayName} to ${server.name} in ${this.formatDuration(result.duration)}`
    );

    // Check if all servers complete
    await this.checkItemCompletion(item);
  }

  /**
   * Check if item has been delivered to all target servers and transition to COMPLETED if so
   */
  private async checkItemCompletion(item: ProcessingItem): Promise<void> {
    // Reload item to get latest checkpoint
    const currentItem = await prisma.processingItem.findUnique({
      where: { id: item.id },
      select: { stepContext: true, checkpoint: true },
    });

    if (!currentItem) return;

    const stepContext = currentItem.stepContext as Record<string, unknown>;
    const encodeData = stepContext.encode as PipelineContext["encode"];

    if (!encodeData?.encodedFiles) return;

    const checkpoint = (currentItem.checkpoint as unknown as DeliveryCheckpoint) || {
      deliveredServers: [],
      failedServers: [],
    };

    // Get all target servers
    const targetServerIds = encodeData.encodedFiles.flatMap((file) => {
      const f = file as { targetServerIds: string[] };
      return f.targetServerIds || [];
    });
    const uniqueTargetServers = [...new Set(targetServerIds)];

    // Check if all delivered
    const deliveredServerIds = checkpoint.deliveredServers.map((s) => s.serverId);
    const allDelivered = uniqueTargetServers.every((id) => deliveredServerIds.includes(id));

    if (allDelivered) {
      console.log(
        `[${this.name}] ${item.title} delivered to all ${uniqueTargetServers.length} servers, transitioning to COMPLETED`
      );
      await this.handleCompletedDelivery(item, encodeData, checkpoint.deliveredServers);
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
