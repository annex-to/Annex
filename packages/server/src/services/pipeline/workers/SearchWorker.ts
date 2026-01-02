import type { MediaType, ProcessingItem } from "@prisma/client";
import type { PipelineContext } from "../PipelineContext";
import { SearchStep } from "../steps/SearchStep";
import { BaseWorker } from "./BaseWorker";

/**
 * SearchWorker - Searches for releases for items in PENDING status
 * Transitions items from PENDING → SEARCHING → FOUND
 */
export class SearchWorker extends BaseWorker {
  readonly processingStatus = "PENDING" as const;
  readonly nextStatus = "FOUND" as const;
  readonly name = "SearchWorker";

  protected async processItem(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Processing ${item.type} ${item.title}`);

    // Skip if not in PENDING status (race condition or stale data)
    if (item.status !== "PENDING") {
      console.log(`[${this.name}] Skipping ${item.title}: already in ${item.status} status`);
      return;
    }

    // Transition to SEARCHING first
    const { pipelineOrchestrator } = await import("../PipelineOrchestrator");
    await pipelineOrchestrator.transitionStatus(item.id, "SEARCHING", { currentStep: "search" });

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Build pipeline context
    const context: PipelineContext = {
      requestId: item.requestId,
      mediaType: request.type as MediaType,
      tmdbId: item.tmdbId,
      // Use request.title (show title) for TV, item.title (movie title) for movies
      title: item.type === "EPISODE" ? request.title : item.title,
      year: item.year || new Date().getFullYear(),
      targets: request.targets
        ? (request.targets as Array<{ serverId: string; encodingProfileId?: string }>)
        : [],
    };

    // For TV episodes, add episode context
    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      context.requestedEpisodes = [{ season: item.season, episode: item.episode }];
    }

    // Create fresh SearchStep instance per item to avoid race conditions with parallel processing
    const searchStep = new SearchStep();

    // Set progress callback
    searchStep.setProgressCallback((progress, message) => {
      this.updateProgress(item.id, progress, message);
    });

    // Execute search
    const output = await searchStep.execute(context, {
      checkExistingDownloads: true,
      maxResults: 50,
    });

    if (!output.success) {
      throw new Error(output.error || "Search failed");
    }

    // Extract search results
    const searchContext = output.data?.search as PipelineContext["search"];

    // Either a new release or existing download must be found
    if (!searchContext?.selectedRelease && !searchContext?.existingDownload) {
      throw new Error("No release found for this item");
    }

    // Store search results in stepContext
    const stepContext = {
      selectedRelease: searchContext.selectedRelease,
      alternativeReleases: searchContext.alternativeReleases || [],
      qualityMet: searchContext.qualityMet,
      existingDownload: searchContext.existingDownload,
    };

    console.log(
      `[${this.name}] Found ${searchContext.existingDownload ? "existing download" : "new release"} for ${request.title}`
    );

    // Transition to FOUND with search results
    await this.transitionToNext(item.id, {
      currentStep: "search_complete",
      stepContext,
    });
  }
}

export const searchWorker = new SearchWorker();
