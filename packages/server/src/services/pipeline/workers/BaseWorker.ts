import type { ProcessingItem, ProcessingStatus } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { pipelineOrchestrator } from "../PipelineOrchestrator";

/**
 * Base Worker class for processing items through pipeline stages
 * Workers are invoked by the scheduler to process items at specific statuses
 */
export abstract class BaseWorker {
  readonly pollInterval = 5000; // 5 seconds - used by scheduler
  concurrency = 3; // Process up to 3 items in parallel (can be overridden by subclasses)

  /**
   * The status this worker processes
   */
  abstract readonly processingStatus: ProcessingStatus;

  /**
   * The next status to transition to on success
   */
  abstract readonly nextStatus: ProcessingStatus;

  /**
   * Worker name for logging
   */
  abstract readonly name: string;

  /**
   * Process a single item
   */
  protected abstract processItem(item: ProcessingItem): Promise<void>;

  /**
   * Process a batch of items (called by scheduler)
   */
  async processBatch(): Promise<void> {
    const items = await pipelineOrchestrator.getItemsForProcessing(this.processingStatus);

    if (items.length === 0) {
      return;
    }

    console.log(`[${this.name}] Processing ${items.length} items`);

    // Process items in parallel (with concurrency limit)
    for (let i = 0; i < items.length; i += this.concurrency) {
      const batch = items.slice(i, i + this.concurrency);
      await Promise.allSettled(batch.map((item) => this.processItemSafe(item)));
    }
  }

  /**
   * Safely process an item with error handling
   */
  private async processItemSafe(item: ProcessingItem): Promise<void> {
    try {
      await this.processItem(item);
    } catch (error) {
      console.error(`[${this.name}] Error processing item ${item.id}:`, error);
      await pipelineOrchestrator.handleError(
        item.id,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Update item progress
   */
  protected async updateProgress(
    itemId: string,
    progress: number,
    message?: string
  ): Promise<void> {
    await pipelineOrchestrator.updateProgress(itemId, progress);
    if (message) {
      console.log(`[${this.name}] ${itemId}: ${message} (${progress}%)`);
    }
  }

  /**
   * Update item context
   */
  protected async updateContext(itemId: string, context: Record<string, unknown>): Promise<void> {
    await pipelineOrchestrator.updateContext(itemId, context);
  }

  /**
   * Transition item to next status
   */
  protected async transitionToNext(
    itemId: string,
    context?: {
      currentStep?: string;
      stepContext?: Record<string, unknown>;
      downloadId?: string;
      encodingJobId?: string;
    }
  ): Promise<void> {
    await pipelineOrchestrator.transitionStatus(itemId, this.nextStatus, context);
  }

  /**
   * Transition item to FAILED status
   */
  protected async transitionToFailed(itemId: string, error: string): Promise<void> {
    await pipelineOrchestrator.transitionStatus(itemId, "FAILED", { error });
  }

  /**
   * Get request details for an item
   */
  protected async getRequest(requestId: string) {
    return await prisma.mediaRequest.findUnique({
      where: { id: requestId },
      include: {
        processingItems: true,
      },
    });
  }
}
