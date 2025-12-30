import type { ProcessingItem, ProcessingStatus } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { processingItemRepository } from "./ProcessingItemRepository";
import { retryStrategy } from "./RetryStrategy";
import { StateTransitionError, stateMachine } from "./StateMachine";
import { ValidationError, validationFramework } from "./ValidationFramework";

export class PipelineOrchestratorError extends Error {
  constructor(
    message: string,
    public readonly itemId?: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "PipelineOrchestratorError";
  }
}

/**
 * Central orchestrator for the new pipeline system
 * Coordinates ProcessingItems through their lifecycle
 */
export class PipelineOrchestrator {
  /**
   * Create a new request with ProcessingItems
   */
  async createRequest(params: {
    type: "movie" | "tv";
    tmdbId: number;
    title: string;
    year?: number;
    episodes?: Array<{ season: number; episode: number; title: string }>;
    targetServers: string[];
  }): Promise<{ requestId: string; items: ProcessingItem[] }> {
    const requestId = crypto.randomUUID();

    try {
      // Create MediaRequest
      await prisma.mediaRequest.create({
        data: {
          id: requestId,
          type: params.type.toUpperCase() as "MOVIE" | "TV",
          tmdbId: params.tmdbId,
          title: params.title,
          year: params.year ?? new Date().getFullYear(),
          status: "PENDING",
          targets: params.targetServers,
        },
      });

      // Create PipelineExecution for compatibility with existing Steps
      const templateId = params.type === "movie" ? "default-movie-pipeline" : "default-tv-pipeline";

      // Load template to get steps configuration
      const template = await prisma.pipelineTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new PipelineOrchestratorError(`Pipeline template ${templateId} not found`, requestId);
      }

      await prisma.pipelineExecution.create({
        data: {
          requestId,
          templateId,
          status: "RUNNING",
          steps: template.steps as import("@prisma/client").Prisma.InputJsonValue,
          context: {},
        },
      });

      // Create ProcessingItems
      const items: ProcessingItem[] = [];

      if (params.type === "movie") {
        // Single ProcessingItem for movie
        const item = await processingItemRepository.create({
          requestId,
          type: "MOVIE",
          tmdbId: params.tmdbId,
          title: params.title,
          year: params.year,
        });
        items.push(item);
      } else {
        // Multiple ProcessingItems for TV episodes
        if (!params.episodes || params.episodes.length === 0) {
          throw new PipelineOrchestratorError("TV show requests must include episodes");
        }

        for (const ep of params.episodes) {
          const item = await processingItemRepository.create({
            requestId,
            type: "EPISODE",
            tmdbId: params.tmdbId,
            title: ep.title,
            year: params.year,
            season: ep.season,
            episode: ep.episode,
          });
          items.push(item);

          // Create TvEpisode record for UI display
          await prisma.tvEpisode.create({
            data: {
              id: crypto.randomUUID(),
              requestId,
              season: ep.season,
              episode: ep.episode,
              title: ep.title,
              status: "PENDING",
            },
          });
        }
      }

      // Update request aggregate stats
      await processingItemRepository.updateRequestAggregates(requestId);

      return { requestId, items };
    } catch (error) {
      // Rollback: delete request if item creation fails
      await prisma.mediaRequest.delete({ where: { id: requestId } }).catch(() => {});
      throw new PipelineOrchestratorError(
        `Failed to create request: ${error instanceof Error ? error.message : String(error)}`,
        requestId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Transition a ProcessingItem to a new status with validation
   */
  async transitionStatus(
    itemId: string,
    toStatus: ProcessingStatus,
    context?: {
      currentStep?: string;
      stepContext?: Record<string, unknown>;
      progress?: number;
      error?: string;
      downloadId?: string;
      encodingJobId?: string;
    }
  ): Promise<ProcessingItem> {
    const item = await processingItemRepository.findById(itemId);
    if (!item) {
      throw new PipelineOrchestratorError(`ProcessingItem ${itemId} not found`, itemId);
    }

    const fromStatus = item.status;

    try {
      // Validate state transition is allowed
      stateMachine.transition(fromStatus, toStatus);

      // Validate transition conditions (with new context fields if provided)
      const validation = await validationFramework.validateTransition(item, fromStatus, toStatus, {
        stepContext: context?.stepContext,
        downloadId: context?.downloadId,
        encodingJobId: context?.encodingJobId,
      });
      if (!validation.valid) {
        throw new ValidationError(itemId, toStatus, "entry", validation.errors.join(", "));
      }

      // Update status
      const updatedItem = await processingItemRepository.updateStatus(itemId, toStatus, {
        currentStep: context?.currentStep,
        stepContext: context?.stepContext as import("@prisma/client").Prisma.InputJsonValue,
        progress: context?.progress,
        lastError: context?.error,
        downloadId: context?.downloadId,
        encodingJobId: context?.encodingJobId,
      });

      // Sync TvEpisode status for UI display (if this is an episode)
      if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
        await this.syncTvEpisodeStatus(item.requestId, item.season, item.episode, toStatus);
      }

      // Update request aggregates
      await processingItemRepository.updateRequestAggregates(item.requestId);

      return updatedItem;
    } catch (error) {
      if (error instanceof StateTransitionError || error instanceof ValidationError) {
        throw error;
      }

      throw new PipelineOrchestratorError(
        `Failed to transition ${itemId} from ${fromStatus} to ${toStatus}: ${error instanceof Error ? error.message : String(error)}`,
        itemId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Handle error and determine retry strategy
   */
  async handleError(itemId: string, error: Error | string): Promise<ProcessingItem> {
    const item = await processingItemRepository.findById(itemId);
    if (!item) {
      throw new PipelineOrchestratorError(`ProcessingItem ${itemId} not found`, itemId);
    }

    const shouldRetry = retryStrategy.shouldRetry(error, item.attempts, item.maxAttempts);

    if (shouldRetry) {
      // Calculate next retry time
      const nextRetryAt = retryStrategy.calculateRetryTime(error, item.attempts);

      // Increment attempts and set retry time
      const updatedItem = await processingItemRepository.incrementAttempts(
        itemId,
        nextRetryAt || undefined
      );

      // Update error message
      await processingItemRepository.updateStatus(itemId, item.status, {
        lastError: retryStrategy.formatError(error),
      });

      return updatedItem;
    } else {
      // Mark as failed
      const errorMessage = retryStrategy.formatError(error);
      const failedItem = await this.transitionStatus(itemId, "FAILED", {
        error: errorMessage,
      });

      // Update request aggregates
      await processingItemRepository.updateRequestAggregates(item.requestId);

      return failedItem;
    }
  }

  /**
   * Cancel a ProcessingItem
   */
  async cancel(itemId: string): Promise<ProcessingItem> {
    const item = await processingItemRepository.findById(itemId);
    if (!item) {
      throw new PipelineOrchestratorError(`ProcessingItem ${itemId} not found`, itemId);
    }

    if (stateMachine.isTerminal(item.status)) {
      throw new PipelineOrchestratorError(
        `Cannot cancel ProcessingItem ${itemId} in terminal status ${item.status}`,
        itemId
      );
    }

    return await this.transitionStatus(itemId, "CANCELLED");
  }

  /**
   * Retry a failed ProcessingItem
   */
  async retry(itemId: string): Promise<ProcessingItem> {
    const item = await processingItemRepository.findById(itemId);
    if (!item) {
      throw new PipelineOrchestratorError(`ProcessingItem ${itemId} not found`, itemId);
    }

    if (item.status !== "FAILED") {
      throw new PipelineOrchestratorError(
        `Cannot retry ProcessingItem ${itemId} with status ${item.status}`,
        itemId
      );
    }

    // Reset to PENDING to restart pipeline
    await prisma.processingItem.update({
      where: { id: itemId },
      data: {
        status: "PENDING",
        attempts: 0,
        lastError: null,
        nextRetryAt: null,
        progress: 0,
        updatedAt: new Date(),
      },
    });

    const updated = await processingItemRepository.findById(itemId);
    if (!updated) {
      throw new PipelineOrchestratorError(
        `ProcessingItem ${itemId} not found after update`,
        itemId
      );
    }
    return updated;
  }

  /**
   * Get all ProcessingItems for a request
   */
  async getRequestItems(requestId: string): Promise<ProcessingItem[]> {
    return await processingItemRepository.findByRequestId(requestId);
  }

  /**
   * Get request statistics
   */
  async getRequestStats(requestId: string) {
    return await processingItemRepository.getRequestStats(requestId);
  }

  /**
   * Get items ready to be processed for a given status
   */
  async getItemsForProcessing(status: ProcessingStatus): Promise<ProcessingItem[]> {
    const now = new Date();
    const items = await processingItemRepository.findByStatus(status);

    // Filter items that are ready (no retry delay or retry time passed)
    return items.filter((item) => !item.nextRetryAt || item.nextRetryAt <= now);
  }

  /**
   * Update progress for a ProcessingItem
   */
  async updateProgress(itemId: string, progress: number): Promise<ProcessingItem> {
    return await processingItemRepository.updateProgress(itemId, progress);
  }

  /**
   * Update step context for a ProcessingItem
   */
  async updateContext(itemId: string, context: Record<string, unknown>): Promise<ProcessingItem> {
    return await processingItemRepository.updateStepContext(itemId, context);
  }

  /**
   * Sync TvEpisode status with ProcessingItem status for UI display
   */
  private async syncTvEpisodeStatus(
    requestId: string,
    season: number,
    episode: number,
    processingStatus: ProcessingStatus
  ): Promise<void> {
    // Map ProcessingItem status to TvEpisode status
    const statusMap: Record<ProcessingStatus, import("@prisma/client").TvEpisodeStatus> = {
      PENDING: "PENDING",
      SEARCHING: "SEARCHING",
      FOUND: "SEARCHING",
      DOWNLOADING: "DOWNLOADING",
      DOWNLOADED: "DOWNLOADED",
      ENCODING: "ENCODING",
      ENCODED: "ENCODED",
      DELIVERING: "DELIVERING",
      COMPLETED: "COMPLETED",
      FAILED: "FAILED",
      CANCELLED: "SKIPPED",
    };

    const tvEpisodeStatus = statusMap[processingStatus];

    try {
      await prisma.tvEpisode.updateMany({
        where: {
          requestId,
          season,
          episode,
        },
        data: {
          status: tvEpisodeStatus,
        },
      });
    } catch (error) {
      // Don't fail the transition if TvEpisode update fails (it's just for UI)
      console.error(
        `[PipelineOrchestrator] Failed to sync TvEpisode status for S${season}E${episode}:`,
        error
      );
    }
  }
}

export const pipelineOrchestrator = new PipelineOrchestrator();
