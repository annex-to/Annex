import type { MediaType, ProcessingItem } from "@prisma/client";
import type { PipelineContext } from "../PipelineContext";
import { DownloadStep } from "../steps/DownloadStep";
import { BaseWorker } from "./BaseWorker";

/**
 * DownloadWorker - Downloads media for items in FOUND status
 * Transitions items from FOUND → DOWNLOADING → DOWNLOADED
 */
export class DownloadWorker extends BaseWorker {
  readonly processingStatus = "FOUND" as const;
  readonly nextStatus = "DOWNLOADED" as const;
  readonly name = "DownloadWorker";

  private downloadStep = new DownloadStep();

  protected async processItem(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Processing ${item.type} ${item.title}`);

    // Transition to DOWNLOADING
    const { pipelineOrchestrator } = await import("../PipelineOrchestrator");
    await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADING", {
      currentStep: "download",
    });

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // Extract search results from stepContext
    const stepContext = item.stepContext as Record<string, unknown>;
    const searchData = stepContext as PipelineContext["search"];

    if (!searchData?.selectedRelease) {
      throw new Error("No release found in item context");
    }

    // Build pipeline context
    const context: PipelineContext = {
      requestId: item.requestId,
      mediaType: request.type as MediaType,
      tmdbId: item.tmdbId,
      title: item.title,
      year: item.year || new Date().getFullYear(),
      targets: request.targets
        ? (request.targets as Array<{ serverId: string; encodingProfileId?: string }>)
        : [],
      search: searchData,
    };

    // For TV episodes, add episode context
    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      context.requestedEpisodes = [{ season: item.season, episode: item.episode }];
    }

    // Set progress callback
    this.downloadStep.setProgressCallback((progress, message) => {
      this.updateProgress(item.id, progress, message);
    });

    // Execute download
    const output = await this.downloadStep.execute(context, {
      pollInterval: 5000,
      timeout: 24 * 60 * 60 * 1000, // 24 hours
    });

    if (!output.success) {
      throw new Error(output.error || "Download failed");
    }

    // Extract download results
    const downloadContext = output.data?.download as PipelineContext["download"];
    if (!downloadContext?.sourceFilePath && !downloadContext?.episodeFiles) {
      throw new Error("No download results found");
    }

    // Merge contexts
    const newStepContext = {
      ...stepContext,
      download: downloadContext,
    };

    // Transition to DOWNLOADED with results
    await this.transitionToNext(item.id, {
      currentStep: "download_complete",
      stepContext: newStepContext,
      downloadId: downloadContext.torrentHash,
    });

    console.log(`[${this.name}] Downloaded ${item.title}`);
  }
}

export const downloadWorker = new DownloadWorker();
