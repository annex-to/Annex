import {
  ActivityType,
  MediaType,
  type Prisma,
  RequestStatus,
  StepType,
  TvEpisodeStatus,
} from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDownloadService } from "../../download.js";
import { downloadManager } from "../../downloadManager.js";
import { getIndexerService } from "../../indexer.js";
import {
  deriveRequiredResolution,
  filterReleasesByQuality,
  getBestAvailableResolution,
  getResolutionLabel,
  type RequestTarget,
  rankReleasesWithQualityFilter,
  releasesToStorageFormat,
  resolutionMeetsRequirement,
} from "../../qualityService.js";
import { getTraktService } from "../../trakt.js";
import type { PipelineContext } from "../PipelineContext.js";
import { BaseStep, type StepOutput } from "./BaseStep.js";

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

    // Check if a release was already selected (e.g., user accepted alternative)
    const existingRequest = await prisma.mediaRequest.findUnique({
      where: { id: requestId },
      select: { selectedRelease: true },
    });

    if (existingRequest?.selectedRelease) {
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        "Release already selected, skipping search"
      );

      // Proceed directly to download with the pre-selected release
      return {
        success: true,
        nextStep: "download",
        data: {
          search: {
            selectedRelease: existingRequest.selectedRelease,
            qualityMet: true,
          },
        },
      };
    }

    // Update request status
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.SEARCHING,
        progress: 5,
        currentStep: "Checking for existing downloads...",
        currentStepStartedAt: new Date(),
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
        const torrentHash = existingMatch.match.torrent.hash;

        // Verify torrent still exists in qBittorrent
        const qb = getDownloadService();
        const torrentExists = await qb.getProgress(torrentHash);

        if (!torrentExists) {
          await this.logActivity(
            requestId,
            ActivityType.WARNING,
            `Found download record but torrent ${torrentHash} no longer exists in qBittorrent, will search for new release`
          );
          // Fall through to indexer search
        } else {
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
                search: {
                  existingDownload: {
                    torrentHash: existingMatch.match.torrent.hash,
                    isComplete: existingMatch.isComplete,
                  },
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
    }

    // Search indexers
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        progress: 10,
        currentStep: "Searching indexers...",
        currentStepStartedAt: new Date(),
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

    // For TV shows, intelligently select between season packs and individual episodes
    let filteredReleases = searchResult.releases;
    if (mediaType === MediaType.TV) {
      // Get all episodes for this request and their statuses
      const allEpisodes = await prisma.tvEpisode.findMany({
        where: { requestId },
        select: { id: true, season: true, episode: true, status: true },
      });

      // Check library for episodes that are already on storage servers
      // Get target server IDs
      const targetServerIds = (targets as RequestTarget[]).map((t) => t.serverId);

      // Find episodes already in library on ALL target servers
      const libraryEpisodes = await prisma.episodeLibraryItem.findMany({
        where: {
          tmdbId,
          serverId: { in: targetServerIds },
        },
        select: { season: true, episode: true, serverId: true },
      });

      // Group by episode to check if it's on all target servers
      const episodeServerMap = new Map<string, Set<string>>();
      for (const lib of libraryEpisodes) {
        const key = `S${lib.season}E${lib.episode}`;
        if (!episodeServerMap.has(key)) {
          episodeServerMap.set(key, new Set());
        }
        episodeServerMap.get(key)!.add(lib.serverId);
      }

      // Mark episodes as SKIPPED if they're on all target servers
      for (const ep of allEpisodes) {
        const key = `S${ep.season}E${ep.episode}`;
        const serversWithEpisode = episodeServerMap.get(key);

        if (
          serversWithEpisode &&
          serversWithEpisode.size === targetServerIds.length &&
          ep.status === TvEpisodeStatus.PENDING
        ) {
          // Episode is already on all target servers - mark as SKIPPED
          await prisma.tvEpisode.update({
            where: { id: ep.id },
            data: { status: TvEpisodeStatus.SKIPPED },
          });
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `Skipped S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} - already in library on all target servers`
          );
          console.log(`[Search] Marked ${key} as SKIPPED - already in library`);
          ep.status = TvEpisodeStatus.SKIPPED; // Update local object
        }
      }

      const completedStatuses = new Set<TvEpisodeStatus>([
        TvEpisodeStatus.DOWNLOADED,
        TvEpisodeStatus.ENCODING,
        TvEpisodeStatus.ENCODED,
        TvEpisodeStatus.DELIVERING,
        TvEpisodeStatus.COMPLETED,
        TvEpisodeStatus.SKIPPED,
      ]);

      const neededEpisodes = allEpisodes
        .filter((ep) => !completedStatuses.has(ep.status))
        .map((ep) => ({ season: ep.season, episode: ep.episode }));

      const neededSet = new Set(neededEpisodes.map((ep) => `S${ep.season}E${ep.episode}`));

      if (neededEpisodes.length === 0) {
        await this.logActivity(requestId, ActivityType.INFO, "All episodes already downloaded");
        return {
          success: false,
          shouldRetry: false,
          nextStep: null,
          error: "All episodes already downloaded",
        };
      }

      const neededList = Array.from(neededSet).sort().join(", ");
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        `Need ${neededEpisodes.length} episode(s): ${neededList}`
      );
      console.log(`[Search] Needed episodes for request ${requestId}: ${neededList}`);
      console.log(
        `[Search] Episode statuses:`,
        allEpisodes.map((ep) => `S${ep.season}E${ep.episode}=${ep.status}`).join(", ")
      );

      // Categorize releases as season packs or individual episodes
      const seasonPacks: typeof searchResult.releases = [];
      const individualEpisodes: typeof searchResult.releases = [];

      for (const release of searchResult.releases) {
        const episodeMatches = release.title.matchAll(/S(\d{1,2})E(\d{1,2})/gi);
        const releaseEpisodes = Array.from(episodeMatches, (match) => {
          const season = Number.parseInt(match[1], 10);
          const episode = Number.parseInt(match[2], 10);
          return `S${season}E${episode}`;
        });

        // Season pack: no specific episodes in title (e.g., "Show S01")
        // or contains many episodes (5+)
        if (releaseEpisodes.length === 0 || releaseEpisodes.length >= 5) {
          seasonPacks.push(release);
        } else {
          // Individual episode release
          const hasNeededEpisode = releaseEpisodes.some((ep) => neededSet.has(ep));
          console.log(
            `[Search] Release "${release.title.substring(0, 60)}" episodes: [${releaseEpisodes.join(", ")}], needed: ${hasNeededEpisode}`
          );
          if (hasNeededEpisode) {
            individualEpisodes.push(release);
          }
        }
      }

      console.log(
        `[Search] Categorized: ${seasonPacks.length} season packs, ${individualEpisodes.length} individual episodes`
      );

      // Strategy 1: Prefer season pack if it likely covers all needed episodes
      if (seasonPacks.length > 0) {
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Found ${seasonPacks.length} season pack(s) - preferring complete season download`
        );
        filteredReleases = seasonPacks;
      } else if (individualEpisodes.length > 0) {
        // Strategy 2: Fall back to individual episodes
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `No season packs found - using ${individualEpisodes.length} individual episode release(s)`
        );
        filteredReleases = individualEpisodes;
      } else {
        await this.logActivity(
          requestId,
          ActivityType.WARNING,
          "No suitable releases found for needed episodes"
        );
        filteredReleases = [];
      }
    }

    // Log all releases found for debugging
    if (filteredReleases.length > 0) {
      console.log(`[Search] Found ${filteredReleases.length} total releases:`);
      filteredReleases.slice(0, 10).forEach((release, idx) => {
        console.log(
          `[Search]   ${idx + 1}. ${release.title} | ${release.resolution || "Unknown"} | ${release.size || "Unknown"} | ${release.seeders || 0} seeders | ${release.indexerName}`
        );
      });
      if (filteredReleases.length > 10) {
        console.log(`[Search]   ... and ${filteredReleases.length - 10} more`);
      }
    }

    // Filter and rank releases by quality
    if (filteredReleases.length === 0) {
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.AWAITING,
          progress: 0,
          currentStep: "Waiting for release availability",
          currentStepStartedAt: new Date(),
          error: null,
          qualitySearchedAt: new Date(),
        },
      });
      await this.logActivity(
        requestId,
        ActivityType.WARNING,
        "No releases found - will retry automatically"
      );

      return {
        success: false,
        shouldRetry: true,
        nextStep: null,
        error: "No releases found",
      };
    }

    const { matching, belowQuality } = filterReleasesByQuality(
      filteredReleases,
      requiredResolution
    );

    await this.logActivity(
      requestId,
      ActivityType.INFO,
      `Quality filter: ${matching.length} releases meet ${resolutionLabel} requirement, ${belowQuality.length} below threshold`
    );

    // Log filtering results
    console.log(
      `[Search] Quality filter results: ${matching.length} matching ${resolutionLabel}, ${belowQuality.length} below quality`
    );
    if (matching.length > 0) {
      console.log(`[Search] Releases meeting quality (${resolutionLabel}):`);
      matching.slice(0, 5).forEach((release, idx) => {
        console.log(
          `[Search]   ✓ ${idx + 1}. ${release.title} | ${release.resolution} | ${release.seeders} seeders`
        );
      });
    }
    if (belowQuality.length > 0) {
      console.log(`[Search] Releases below quality threshold:`);
      belowQuality.slice(0, 5).forEach((release, idx) => {
        console.log(
          `[Search]   ✗ ${idx + 1}. ${release.title} | ${release.resolution || "Unknown"} (need ${resolutionLabel})`
        );
      });
    }

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
            currentStepStartedAt: new Date(),
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

        // Return success=true because we successfully found releases and stored alternatives
        // The user can manually select a lower quality from the UI
        return {
          success: true,
          nextStep: null, // Stop pipeline here, don't proceed to download
          data: {
            qualityMet: false,
            bestAvailableQuality: bestAvailable,
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
    const { matching: rankedMatching } = rankReleasesWithQualityFilter(
      matching,
      requiredResolution,
      maxResults
    );

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

    await this.logActivity(
      requestId,
      ActivityType.SUCCESS,
      `Selected release: ${bestRelease.title}`,
      {
        release: {
          title: bestRelease.title,
          resolution: bestRelease.resolution,
          source: bestRelease.source,
          codec: bestRelease.codec,
          size: bestRelease.size,
          seeders: bestRelease.seeders,
          score: rankedMatching[0].score,
        },
      }
    );

    // Save selected release to request
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        selectedRelease: bestRelease as unknown as Prisma.JsonObject,
        // Capture initial torrent metadata
        releaseFileSize: BigInt(bestRelease.size),
        releaseIndexerName: bestRelease.indexerName,
        releaseSeeders: bestRelease.seeders,
        releaseLeechers: bestRelease.leechers,
        releaseResolution: bestRelease.resolution,
        releaseSource: bestRelease.source,
        releaseCodec: bestRelease.codec,
        releaseScore: rankedMatching[0].score,
        releasePublishDate: bestRelease.publishDate,
        releaseName: bestRelease.title,
        status: RequestStatus.SEARCHING,
        progress: 15,
        currentStep: `Selected: ${bestRelease.title}`,
        currentStepStartedAt: new Date(),
      },
    });

    return {
      success: true,
      nextStep: "download",
      data: {
        search: {
          selectedRelease: bestRelease,
          alternativeReleases: alternatives,
          qualityMet: true,
        },
      },
    };
  }

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
}
