import type { MediaType, ProcessingItem } from "@prisma/client";
import type { PipelineContext } from "../PipelineContext";
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

  private deliverStep = new DeliverStep();

  protected async processItem(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Processing ${item.type} ${item.title}`);

    // Transition to DELIVERING
    const { pipelineOrchestrator } = await import("../PipelineOrchestrator");
    await pipelineOrchestrator.transitionStatus(item.id, "DELIVERING", {
      currentStep: "deliver",
    });

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
    const output = await this.deliverStep.execute(context, {
      timeout: 60 * 60 * 1000, // 1 hour
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
