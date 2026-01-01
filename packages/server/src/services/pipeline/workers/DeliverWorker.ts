import type { MediaType, ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { DeliverStep } from "../steps/DeliverStep";
import { BaseWorker } from "./BaseWorker";

/**
 * DeliverWorker - Delivers encoded media for items in ENCODED status
 * Transitions items from ENCODED → DELIVERING → COMPLETED
 */
export class DeliverWorker extends BaseWorker {
  readonly processingStatus = "ENCODED" as const;
  readonly nextStatus = "COMPLETED" as const;
  readonly name = "DeliverWorker";
  readonly concurrency = 3; // Deliver up to 3 files in parallel

  private deliverStep = new DeliverStep();

  /**
   * Override to pick up both ENCODED (new) and DELIVERING (resume/retry) items
   */
  async processBatch(): Promise<void> {
    // Get items in ENCODED (new work) and DELIVERING (resume work)
    const encodedItems = await pipelineOrchestrator.getItemsForProcessing("ENCODED");
    const deliveringItems = await pipelineOrchestrator.getItemsForProcessing("DELIVERING");
    const items = [...encodedItems, ...deliveringItems];

    if (items.length === 0) {
      return;
    }

    console.log(
      `[${this.name}] Processing ${items.length} items (${encodedItems.length} new, ${deliveringItems.length} resuming)`
    );

    // Process items in parallel (with concurrency limit)
    for (let i = 0; i < items.length; i += this.concurrency) {
      const batch = items.slice(i, i + this.concurrency);
      await Promise.allSettled(
        batch.map((item) => {
          // Call the base class's processItemSafe method
          return (this as any).processItemSafe(item);
        })
      );
    }
  }

  protected async processItem(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Processing ${item.type} ${item.title}`);

    // For items already in DELIVERING, check if another worker is processing it
    if (item.status === "DELIVERING") {
      // Re-fetch to check current state (another worker might have picked it up)
      const currentItem = await prisma.processingItem.findUnique({
        where: { id: item.id },
        select: { status: true, currentStep: true, updatedAt: true },
      });

      if (!currentItem || currentItem.status !== "DELIVERING") {
        console.log(`[${this.name}] ${item.title}: Status changed, skipping`);
        return;
      }

      // If updated very recently (within 30s), another worker is likely processing it
      const thirtySecondsAgo = new Date(Date.now() - 30000);
      if (currentItem.updatedAt > thirtySecondsAgo) {
        console.log(
          `[${this.name}] ${item.title}: Recently updated, likely being processed elsewhere, skipping`
        );
        return;
      }

      console.log(`[${this.name}] ${item.title}: Resuming delivery (stuck for >30s)`);
    } else {
      // Transition to DELIVERING for new items
      try {
        await pipelineOrchestrator.transitionStatus(item.id, "DELIVERING", {
          currentStep: "deliver",
        });
      } catch (error) {
        // If already DELIVERING (race condition), just continue
        if (error instanceof Error && error.message.includes("Cannot transition from DELIVERING to DELIVERING")) {
          console.log(`[${this.name}] ${item.title}: Already DELIVERING, continuing`);
        } else {
          throw error;
        }
      }
    }

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Extract previous step contexts
    const stepContext = item.stepContext as Record<string, unknown>;
    const searchData = stepContext.search as PipelineContext["search"];
    const downloadData = stepContext.download as PipelineContext["download"];
    const encodeData = stepContext.encode as PipelineContext["encode"];

    if (!encodeData?.encodedFiles || encodeData.encodedFiles.length === 0) {
      throw new Error("No encoded files found in item context");
    }

    // Build pipeline context
    const context: PipelineContext = {
      requestId: item.requestId,
      mediaType: request.type as MediaType,
      tmdbId: item.tmdbId,
      title: item.type === "EPISODE" ? request.title : item.title, // Use series title for episodes
      year: item.year || new Date().getFullYear(),
      targets: request.targets
        ? (request.targets as Array<{ serverId: string; encodingProfileId?: string }>)
        : [],
      search: searchData,
      download: downloadData,
      encode: encodeData,
      processingItemId: item.id, // Pass ProcessingItem ID for progress updates
    };

    // For TV episodes, add episode context
    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      context.requestedEpisodes = [{ season: item.season, episode: item.episode }];
    }

    // Set progress callback
    this.deliverStep.setProgressCallback((progress, message) => {
      this.updateProgress(item.id, progress, message);
    });

    // Execute delivery
    // Timeout: 15 minutes should be enough for most files
    // Large 2160p files (10-20GB) at 10MB/s = ~20 minutes max
    const output = await this.deliverStep.execute(context, {
      timeout: 15 * 60 * 1000, // 15 minutes
    });

    if (!output.success) {
      throw new Error(output.error || "Delivery failed");
    }

    // Extract delivery results
    const deliverContext = output.data?.deliver as PipelineContext["deliver"];
    if (!deliverContext?.deliveredServers || deliverContext.deliveredServers.length === 0) {
      throw new Error("No servers delivered to");
    }

    // Merge contexts
    const newStepContext = {
      ...stepContext,
      deliver: deliverContext,
      allDeliveriesComplete: true,
      deliveryResults: deliverContext,
    };

    // Transition to COMPLETED with results
    await this.transitionToNext(item.id, {
      currentStep: "deliver_complete",
      stepContext: newStepContext,
    });

    console.log(
      `[${this.name}] Delivered ${item.title} to ${deliverContext.deliveredServers.length} servers`
    );
  }
}

export const deliverWorker = new DeliverWorker();
