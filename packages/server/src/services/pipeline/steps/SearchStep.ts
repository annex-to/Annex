import { BaseStep, type StepOutput } from "./BaseStep.js";
import type { PipelineContext } from "../PipelineContext.js";
import { StepType, RequestStatus, ActivityType, MediaType, Prisma } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getIndexerService } from "../../indexer.js";
import { getTraktService } from "../../trakt.js";
import { downloadManager } from "../../downloadManager.js";
import {
  deriveRequiredResolution,
  filterReleasesByQuality,
  rankReleasesWithQualityFilter,
  releasesToStorageFormat,
  getBestAvailableResolution,
  getResolutionLabel,
  resolutionMeetsRequirement,
  type RequestTarget,
} from "../../qualityService.js";

interface SearchStepConfig {
  checkExistingDownloads?: boolean;
  maxResults?: number;
}

/**
 * Search Step - Find releases from indexers with quality filtering
 *
 * Inputs:
 * - requestId, mediaType, tmdbId, title, year, targets
 *
 * Outputs:
 * - search.selectedRelease: The best release found
 * - search.alternativeReleases: Alternative releases for retry
 * - search.qualityMet: Whether quality requirements were met
 *
 * Side effects:
 * - Updates MediaRequest status and progress
 * - Creates ActivityLog entries
 * - Checks qBittorrent for existing downloads
 * - Searches indexers for new releases
 */
export class SearchStep extends BaseStep {
  readonly type = StepType.SEARCH;

  validateConfig(config: unknown): void {
    if (config !== undefined && typeof config !== "object") {
      throw new Error("SearchStep config must be an object");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as SearchStepConfig | undefined) || {};

    const { requestId, mediaType, tmdbId, title, year, targets } = context;

    // Update request status
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.SEARCHING,
        progress: 5,
        currentStep: "Checking for existing downloads...",
      },
    });

    await this.logActivity(requestId, ActivityType.INFO, "Starting search");

    // Derive quality requirements from targets
    const requiredResolution = await deriveRequiredResolution(targets as RequestTarget[]);
    const resolutionLabel = getResolutionLabel(requiredResolution);

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { requiredResolution },
    });

    await this.logActivity(
      requestId,
      ActivityType.INFO,
      `Quality requirement: ${resolutionLabel} or better (derived from target servers)`
    );

    // Check qBittorrent for existing downloads (if enabled)
    if (cfg.checkExistingDownloads !== false && mediaType === MediaType.MOVIE) {
      const existingMatch = await downloadManager.findExistingMovieDownload(title, year);

      if (existingMatch.found && existingMatch.match) {
        const torrentName = existingMatch.match.torrent.name;
        const meetsQuality = resolutionMeetsRequirement(torrentName, requiredResolution);

        if (meetsQuality) {
          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Found existing download in qBittorrent: ${torrentName}`
          );

          // Return early with existing download info
          return {
            success: true,
            nextStep: "download",
            data: {
              existingDownload: {
                torrentHash: existingMatch.match.torrent.hash,
                isComplete: existingMatch.isComplete,
              },
            },
          };
        } else {
          await this.logActivity(
            requestId,
            ActivityType.WARNING,
            `Found existing download but quality too low: ${torrentName} (need ${resolutionLabel})`
          );
        }
      }
    }

    // Search indexers
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        progress: 10,
        currentStep: "Searching indexers...",
      },
    });

    // Get IMDb ID from cache or Trakt
    let imdbId: string | undefined;
    const mediaItemId = `tmdb-${mediaType === MediaType.MOVIE ? "movie" : "tv"}-${tmdbId}`;
    const cached = await prisma.mediaItem.findUnique({
      where: { id: mediaItemId },
      select: { imdbId: true },
    });

    if (cached?.imdbId) {
      imdbId = cached.imdbId;
    } else {
      const trakt = getTraktService();
      try {
        const details =
          mediaType === MediaType.MOVIE
            ? await trakt.getMovieDetails(tmdbId)
            : await trakt.getTvShowDetails(tmdbId);
        imdbId = details.ids.imdb ?? undefined;
      } catch {
        // Continue without IMDb ID
      }
    }

    const indexer = getIndexerService();
    const searchResult =
      mediaType === MediaType.MOVIE
        ? await indexer.searchMovie({
            tmdbId,
            imdbId,
            title,
            year,
          })
        : await indexer.searchTvSeason({
            tmdbId,
            imdbId,
            title,
            year,
            season: context.requestedSeasons?.[0] || 1,
          });

    await this.logActivity(
      requestId,
      ActivityType.INFO,
      `Found ${searchResult.releases.length} releases from ${searchResult.indexersQueried} indexers`,
      {
        releasesFound: searchResult.releases.length,
        indexersQueried: searchResult.indexersQueried,
        indexersFailed: searchResult.indexersFailed,
      }
    );

    // Filter and rank releases by quality
    if (searchResult.releases.length === 0) {
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.AWAITING,
          progress: 0,
          currentStep: "Waiting for release availability",
          error: null,
        },
      });
      await this.logActivity(requestId, ActivityType.WARNING, "No releases found - will retry automatically");

      return {
        success: false,
        shouldRetry: true,
        nextStep: null,
        error: "No releases found",
      };
    }

    const { matching, belowQuality } = filterReleasesByQuality(searchResult.releases, requiredResolution);

    await this.logActivity(
      requestId,
      ActivityType.INFO,
      `Quality filter: ${matching.length} releases meet ${resolutionLabel} requirement, ${belowQuality.length} below threshold`
    );

    // No releases meet quality
    if (matching.length === 0) {
      if (belowQuality.length > 0) {
        const bestAvailable = getBestAvailableResolution(belowQuality);
        const storedAlternatives = releasesToStorageFormat(belowQuality.slice(0, 10));

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: RequestStatus.QUALITY_UNAVAILABLE,
            availableReleases: storedAlternatives as unknown as Prisma.InputJsonValue,
            qualitySearchedAt: new Date(),
            progress: 0,
            currentStep: `No ${resolutionLabel} releases found (best: ${bestAvailable})`,
            error: null,
          },
        });

        await this.logActivity(
          requestId,
          ActivityType.WARNING,
          `Quality unavailable: wanted ${resolutionLabel}, best available is ${bestAvailable}. ${belowQuality.length} alternative(s) stored.`,
          {
            requiredResolution,
            bestAvailable,
            alternativesCount: belowQuality.length,
          }
        );

        return {
          success: false,
          shouldRetry: false,
          nextStep: null,
          error: `No ${resolutionLabel} releases available`,
          data: {
            qualityMet: false,
            alternativeReleases: belowQuality.slice(0, 10),
          },
        };
      }

      // No releases at all
      return {
        success: false,
        shouldRetry: true,
        nextStep: null,
        error: "No releases found",
      };
    }

    // Rank matching releases
    const maxResults = cfg.maxResults || 5;
    const { matching: rankedMatching } = rankReleasesWithQualityFilter(matching, requiredResolution, maxResults);

    if (rankedMatching.length === 0) {
      return {
        success: false,
        shouldRetry: false,
        nextStep: null,
        error: "No suitable release found within quality constraints",
      };
    }

    const bestRelease = rankedMatching[0].release;
    const alternatives = rankedMatching.slice(1).map((r) => r.release);

    await this.logActivity(requestId, ActivityType.SUCCESS, `Selected release: ${bestRelease.title}`, {
      release: {
        title: bestRelease.title,
        resolution: bestRelease.resolution,
        source: bestRelease.source,
        codec: bestRelease.codec,
        size: bestRelease.size,
        seeders: bestRelease.seeders,
        score: rankedMatching[0].score,
      },
    });

    // Save selected release to request
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        selectedRelease: bestRelease as unknown as Prisma.JsonObject,
        status: RequestStatus.SEARCHING,
        progress: 15,
        currentStep: `Selected: ${bestRelease.title}`,
      },
    });

    return {
      success: true,
      nextStep: "download",
      data: {
        selectedRelease: bestRelease,
        alternativeReleases: alternatives,
        qualityMet: true,
      },
    };
  }

  private async logActivity(requestId: string, type: ActivityType, message: string, details?: object): Promise<void> {
    await prisma.activityLog.create({
      data: {
        requestId,
        type,
        message,
        details: details || undefined,
      },
    });
  }
}
