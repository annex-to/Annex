import type { MediaType, ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import type { PipelineContext } from "../PipelineContext";
import { SearchStep } from "../steps/SearchStep";
import { BaseWorker } from "./BaseWorker";

/**
 * SearchWorker - Searches for releases for items in PENDING status
 * Transitions items from PENDING → SEARCHING → DISCOVERED (or FOUND if quality unavailable)
 */
export class SearchWorker extends BaseWorker {
  readonly processingStatus = "PENDING" as const;
  readonly nextStatus = "DISCOVERED" as const;
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

    // Early exit: if item has selectedRelease in stepContext (from acceptLowerQuality), skip search
    const existingContext = item.stepContext as Record<string, unknown> | null;
    if (existingContext?.selectedRelease && existingContext?.qualityMet === true) {
      console.log(
        `[${this.name}] Early exit: ${item.title} has accepted lower quality release, promoting to DISCOVERED`
      );

      // Transition to SEARCHING first (required by state machine)
      await pipelineOrchestrator.transitionStatus(item.id, "SEARCHING", { currentStep: "search" });

      // Use existing cooldown if set (from override), otherwise use default 5min
      const now = new Date();
      let cooldownEndsAt: Date;

      if (item.cooldownEndsAt && item.cooldownEndsAt > now) {
        // Preserve existing cooldown (e.g., from override with 30s)
        cooldownEndsAt = item.cooldownEndsAt;
      } else {
        // Calculate new cooldown from settings
        const cooldownSetting = await prisma.setting.findUnique({
          where: { key: "discovery.cooldownMinutes" },
        });
        const cooldownMinutes = cooldownSetting ? (JSON.parse(cooldownSetting.value) as number) : 5;
        cooldownEndsAt = new Date(now.getTime() + cooldownMinutes * 60 * 1000);
      }

      // Transition to DISCOVERED with cooldown
      await pipelineOrchestrator.transitionStatus(item.id, "DISCOVERED", {
        currentStep: "discovery_cooldown",
        stepContext: existingContext,
        discoveredAt: item.discoveredAt || now,
        cooldownEndsAt,
        allSearchResults: (existingContext.alternativeReleases as unknown[]) || [],
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

    // Determine next status based on what was found
    if (searchContext.existingDownload) {
      // Existing download: skip DISCOVERED cooldown, go directly to DOWNLOADING
      console.log(
        `[${this.name}] Existing download found for ${request.title}, skipping discovery cooldown`
      );
      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
        currentStep: "download_existing",
        stepContext,
      });
    } else if (qualityNotMet) {
      // Quality not met: skip DISCOVERED, go directly to FOUND with search_quality_unavailable
      console.log(`[${this.name}] Skipping DISCOVERED for ${request.title}: quality unavailable`);
      await pipelineOrchestrator.transitionStatus(item.id, "FOUND", {
        currentStep: "search_quality_unavailable",
        stepContext,
      });
    } else {
      // New release or packs: transition to DISCOVERED with cooldown
      const cooldownSetting = await prisma.setting.findUnique({
        where: { key: "discovery.cooldownMinutes" },
      });
      const cooldownMinutes = cooldownSetting ? (JSON.parse(cooldownSetting.value) as number) : 5;
      const now = new Date();
      const cooldownEndsAt = new Date(now.getTime() + cooldownMinutes * 60 * 1000);

      console.log(
        `[${this.name}] Transitioning ${request.title} to DISCOVERED with ${cooldownMinutes}min cooldown`
      );

      await pipelineOrchestrator.transitionStatus(item.id, "DISCOVERED", {
        currentStep: "discovery_cooldown",
        stepContext,
        discoveredAt: now,
        cooldownEndsAt,
        allSearchResults: stepContext.alternativeReleases || [],
      });
    }
  }
}

export const searchWorker = new SearchWorker();
