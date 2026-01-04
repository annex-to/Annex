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

    const { pipelineOrchestrator } = await import("../PipelineOrchestrator");

    // Early exit: if item already has a downloadId, skip search and fast-forward to FOUND
    if (item.downloadId) {
      console.log(
        `[${this.name}] Early exit: ${item.title} already has download, promoting to FOUND`
      );
      await pipelineOrchestrator.transitionStatus(item.id, "FOUND", {
        currentStep: "search_complete",
      });
      return;
    }

    // Transition to SEARCHING first
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

    // Check if we found alternatives but they don't meet quality requirements
    const hasAlternatives =
      searchContext?.alternativeReleases && searchContext.alternativeReleases.length > 0;
    const qualityNotMet = searchContext?.qualityMet === false;

    // Either a new release, season packs, existing download, OR alternatives must be found
    if (
      !searchContext?.selectedRelease &&
      !searchContext?.selectedPacks &&
      !searchContext?.existingDownload &&
      !hasAlternatives
    ) {
      throw new Error("No releases found for this item");
    }

    // Store search results in stepContext
    const stepContext = {
      selectedRelease: searchContext.selectedRelease,
      selectedPacks: searchContext.selectedPacks,
      alternativeReleases: searchContext.alternativeReleases || [],
      qualityMet: searchContext.qualityMet,
      existingDownload: searchContext.existingDownload,
      bulkDownloadsForSeasonPacks: searchContext.bulkDownloadsForSeasonPacks,
      bestAvailableQuality: (output.data as { bestAvailableQuality?: string })
        ?.bestAvailableQuality,
    };

    // Determine what was found and log appropriately
    let foundType: string;
    let shouldProceed = true;

    if (searchContext.existingDownload) {
      foundType = "existing download";
    } else if (searchContext.selectedPacks) {
      foundType = `${searchContext.selectedPacks.length} season pack(s)`;
    } else if (searchContext.selectedRelease) {
      foundType = "new release";
    } else if (
      hasAlternatives &&
      qualityNotMet &&
      searchContext.alternativeReleases &&
      searchContext.alternativeReleases.length > 0
    ) {
      foundType = `${searchContext.alternativeReleases.length} alternative(s) below quality threshold`;
      shouldProceed = false;
    } else {
      foundType = "unknown";
    }

    console.log(`[${this.name}] Found ${foundType} for ${request.title}`);

    if (!shouldProceed && qualityNotMet) {
      console.log(
        `[${this.name}] Quality not met for ${request.title}, best available: ${stepContext.bestAvailableQuality}`
      );
    }

    // Transition to FOUND with search results
    // Even if qualityMet=false, we transition to FOUND so UI can show "Accept Lower Quality"
    // The stepContext contains all info the UI needs: alternativeReleases, qualityMet, bestAvailableQuality
    await this.transitionToNext(item.id, {
      currentStep: qualityNotMet ? "search_quality_unavailable" : "search_complete",
      stepContext,
    });
  }
}

export const searchWorker = new SearchWorker();
