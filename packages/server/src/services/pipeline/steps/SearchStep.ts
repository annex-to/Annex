import {
  ActivityType,
  MediaType,
  type Prisma,
  ProcessingStatus,
  RequestStatus,
  StepType,
} from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDownloadService } from "../../download.js";
import { downloadManager } from "../../downloadManager.js";
import { getIndexerService, type Release } from "../../indexer.js";
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
import { getPipelineExecutor } from "../PipelineExecutor.js";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
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

    if (!requestId) {
      throw new Error("SearchStep requires requestId in context");
    }

    // Get parent execution ID for spawning branch pipelines
    const parentExecution = await prisma.pipelineExecution.findFirst({
      where: { requestId, parentExecutionId: null },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });

    if (!parentExecution) {
      throw new Error(`Parent execution not found for request ${requestId}`);
    }

    const parentExecutionId = parentExecution.id;

    // For TV shows, check if episodes are already downloaded first - skip everything if so
    if (mediaType === MediaType.TV) {
      const downloadedEpisodes = await prisma.processingItem.findMany({
        where: {
          requestId,
          type: "EPISODE",
          status: {
            in: [
              ProcessingStatus.DOWNLOADED,
              ProcessingStatus.ENCODING,
              ProcessingStatus.ENCODED,
              ProcessingStatus.DELIVERING,
              ProcessingStatus.COMPLETED,
            ],
          },
        },
        select: { id: true },
      });

      const totalEpisodes = await prisma.processingItem.count({
        where: { requestId, type: "EPISODE" },
      });

      // If most episodes are already downloaded or beyond, skip search entirely
      if (totalEpisodes > 0 && downloadedEpisodes.length > totalEpisodes / 2) {
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Skipping search - ${downloadedEpisodes.length}/${totalEpisodes} episodes already downloaded or beyond`
        );

        return {
          success: true,
          nextStep: "download",
          data: {
            search: {
              selectedRelease: null,
              qualityMet: true,
              skippedSearch: true,
            },
          },
        };
      }
    }

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
    if (cfg.checkExistingDownloads !== false) {
      console.log(`[Search] Checking qBittorrent for existing downloads: ${title}`);
      let existingMatch: {
        found: boolean;
        match?: { torrent: { hash: string; name: string } };
        isComplete?: boolean;
      } | null = null;

      if (mediaType === MediaType.MOVIE) {
        console.log(`[Search] Checking for existing movie download`);
        existingMatch = await downloadManager.findExistingMovieDownload(title, year);
      } else if (mediaType === MediaType.TV) {
        // Check for existing TV downloads (season or episode)
        const requestedEpisodes = context.requestedEpisodes;
        if (requestedEpisodes && requestedEpisodes.length === 1) {
          // Single episode - check BOTH individual episode AND season pack
          const ep = requestedEpisodes[0];

          // First check for individual episode download (S01E01)
          console.log(
            `[Search] Checking for existing episode download: S${ep.season}E${ep.episode}`
          );
          existingMatch = await downloadManager.findExistingEpisodeDownload(
            title,
            ep.season,
            ep.episode
          );
          console.log(
            `[Search] Episode check result:`,
            existingMatch?.found ? `Found: ${existingMatch.match?.torrent.name}` : "Not found"
          );

          // If not found, check for season pack that contains this episode (S01)
          if (!existingMatch?.found) {
            console.log(`[Search] Checking for existing season pack: S${ep.season}`);
            const seasonMatch = await downloadManager.findExistingSeasonDownload(title, ep.season);
            console.log(
              `[Search] Season pack check result:`,
              seasonMatch?.found ? `Found: ${seasonMatch.match?.torrent.name}` : "Not found"
            );
            if (seasonMatch?.found) {
              existingMatch = seasonMatch;
            }
          }
        } else if (requestedEpisodes && requestedEpisodes.length > 1) {
          // Multiple episodes - check for season pack
          const seasons = [...new Set(requestedEpisodes.map((ep) => ep.season))];
          if (seasons.length === 1) {
            console.log(`[Search] Checking for existing season pack: S${seasons[0]}`);
            existingMatch = await downloadManager.findExistingSeasonDownload(title, seasons[0]);
          }
        }
      }

      if (existingMatch?.found && existingMatch.match) {
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
          console.log(
            `[Search] Quality check: torrent="${torrentName}", required="${requiredResolution}", meetsQuality=${meetsQuality}`
          );

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

    // For TV shows, determine which seasons need searching
    let seasonsToSearch: number[] = [];
    if (mediaType === MediaType.TV) {
      // Get all episodes for this request and their statuses
      const allEpisodes = await prisma.processingItem.findMany({
        where: { requestId, type: "EPISODE" },
        select: { id: true, season: true, episode: true, status: true },
      });

      const completedStatuses = new Set<ProcessingStatus>([
        ProcessingStatus.DOWNLOADED,
        ProcessingStatus.ENCODING,
        ProcessingStatus.ENCODED,
        ProcessingStatus.DELIVERING,
        ProcessingStatus.COMPLETED,
        ProcessingStatus.CANCELLED,
      ]);

      const neededEpisodes = allEpisodes.filter(
        (ep: { status: ProcessingStatus; season: number | null }) =>
          !completedStatuses.has(ep.status) && ep.season !== null
      );

      // Get unique seasons from needed episodes (season is guaranteed non-null after filter)
      seasonsToSearch = (
        [...new Set(neededEpisodes.map((ep: { season: number }) => ep.season))] as number[]
      ).sort();

      // If no ProcessingItems exist yet, fall back to first requestedSeason from context
      // This handles cases where SearchStep runs before ProcessingItems are created
      // We only search for the first season - subsequent seasons will be handled
      // in subsequent pipeline executions as episodes complete
      if (
        seasonsToSearch.length === 0 &&
        context.requestedSeasons &&
        context.requestedSeasons.length > 0
      ) {
        seasonsToSearch = [context.requestedSeasons[0]];
      }

      console.log(`[Search] Seasons to search: ${seasonsToSearch.join(", ")}`);
    }

    // Perform searches
    let searchResult: {
      releases: Release[];
      indexersQueried: number;
      indexersFailed: number;
    };

    if (mediaType === MediaType.MOVIE) {
      searchResult = await indexer.searchMovie({
        tmdbId,
        imdbId,
        title,
        year,
      });
    } else {
      // TV show - search each season separately and combine results
      const allReleases: Release[] = [];
      let totalIndexersQueried = 0;
      let totalIndexersFailed = 0;

      for (const season of seasonsToSearch) {
        await this.logActivity(requestId, ActivityType.INFO, `Searching for Season ${season}...`);
        console.log(`[Search] Searching for ${title} Season ${season}`);

        const seasonResult = await indexer.searchTvSeason({
          tmdbId,
          imdbId,
          title,
          year,
          season,
        });

        allReleases.push(...seasonResult.releases);
        totalIndexersQueried = Math.max(totalIndexersQueried, seasonResult.indexersQueried);
        totalIndexersFailed = Math.max(totalIndexersFailed, seasonResult.indexersFailed);

        console.log(`[Search] Season ${season}: Found ${seasonResult.releases.length} releases`);
      }

      searchResult = {
        releases: allReleases,
        indexersQueried: totalIndexersQueried,
        indexersFailed: totalIndexersFailed,
      };
    }

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
      const allEpisodes = await prisma.processingItem.findMany({
        where: { requestId, type: "EPISODE" },
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
        episodeServerMap.get(key)?.add(lib.serverId);
      }

      // Mark episodes as CANCELLED if they're on all target servers
      for (const ep of allEpisodes) {
        // Skip episodes with null season/episode (shouldn't happen but be defensive)
        if (ep.season === null || ep.episode === null) continue;

        const key = `S${ep.season}E${ep.episode}`;
        const serversWithEpisode = episodeServerMap.get(key);

        if (
          serversWithEpisode &&
          serversWithEpisode.size === targetServerIds.length &&
          ep.status === ProcessingStatus.PENDING
        ) {
          // Episode is already on all target servers - mark as CANCELLED
          await pipelineOrchestrator.transitionStatus(ep.id, ProcessingStatus.CANCELLED, {
            currentStep: "already_in_library",
          });
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `Skipped S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")} - already in library on all target servers`
          );
          console.log(`[Search] Marked ${key} as CANCELLED - already in library`);
          ep.status = ProcessingStatus.CANCELLED; // Update local object
        }
      }

      const completedStatuses = new Set<ProcessingStatus>([
        ProcessingStatus.DOWNLOADED,
        ProcessingStatus.ENCODING,
        ProcessingStatus.ENCODED,
        ProcessingStatus.DELIVERING,
        ProcessingStatus.COMPLETED,
        ProcessingStatus.CANCELLED,
      ]);

      const neededEpisodes = allEpisodes.filter(
        (ep: { status: ProcessingStatus }) => !completedStatuses.has(ep.status)
      );

      // Mark needed episodes as SEARCHING
      for (const ep of neededEpisodes) {
        if (ep.status === ProcessingStatus.PENDING) {
          await pipelineOrchestrator.transitionStatus(ep.id, ProcessingStatus.SEARCHING, {
            currentStep: "searching",
          });
        }
      }

      const neededSet = new Set(
        neededEpisodes.map(
          (ep: { season: number | null; episode: number | null }) => `S${ep.season}E${ep.episode}`
        )
      );

      if (neededEpisodes.length === 0) {
        // All episodes are already downloaded or beyond - skip search and continue pipeline
        const downloadedOrBeyond = allEpisodes.filter((ep: { status: ProcessingStatus }) =>
          completedStatuses.has(ep.status)
        );

        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Skipping search - ${downloadedOrBeyond.length} episodes already downloaded or complete`
        );

        return {
          success: true,
          nextStep: "download", // Continue to download step which will handle downloaded episodes
          data: {
            search: {
              selectedRelease: null,
              qualityMet: true,
              skippedSearch: true,
            },
          },
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
        allEpisodes
          .map(
            (ep: { season: number | null; episode: number | null; status: ProcessingStatus }) =>
              `S${ep.season}E${ep.episode}=${ep.status}`
          )
          .join(", ")
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

      // Strategy 1: Prefer season packs - download multiple seasons in parallel
      if (seasonPacks.length > 0) {
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Found ${seasonPacks.length} season pack(s) - selecting best pack for each season`
        );

        // Parse season number from each pack and group by season
        const packsBySeason = new Map<number, typeof searchResult.releases>();

        for (const pack of seasonPacks) {
          // Match season number like "S01", "S02", "Season 1", etc.
          const seasonMatch = pack.title.match(/(?:S|Season\s*)(\d{1,2})(?:\D|$)/i);
          if (seasonMatch) {
            const season = Number.parseInt(seasonMatch[1], 10);
            if (!packsBySeason.has(season)) {
              packsBySeason.set(season, []);
            }
            packsBySeason.get(season)?.push(pack);
          }
        }

        console.log(
          `[Search] Grouped season packs: ${Array.from(packsBySeason.keys())
            .sort()
            .map((s) => `S${s}: ${packsBySeason.get(s)?.length} packs`)
            .join(", ")}`
        );

        // Determine which seasons we need
        const neededSeasons = new Set<number>();
        for (const ep of neededEpisodes) {
          neededSeasons.add(ep.season);
        }

        console.log(
          `[Search] Need ${neededSeasons.size} season(s): ${Array.from(neededSeasons).sort().join(", ")}`
        );

        // Select best pack for each needed season and spawn episode branch pipelines
        const spawnedBranches = 0;
        const selectedPacks: Array<{ season: number; release: unknown }> = [];

        for (const season of Array.from(neededSeasons).sort()) {
          const packsForSeason = packsBySeason.get(season);

          if (packsForSeason && packsForSeason.length > 0) {
            // Rank and select best pack for this season
            const { matching: ranked } = rankReleasesWithQualityFilter(
              packsForSeason,
              requiredResolution,
              1
            );

            if (ranked.length > 0) {
              const bestPack = ranked[0].release;
              selectedPacks.push({ season, release: bestPack });

              // DON'T spawn branch pipelines yet - season pack needs to download and extract first
              // The download monitor will spawn branches after extraction completes
              const episodesInSeason = neededEpisodes.filter(
                (ep: { season: number | null }) => ep.season === season
              );

              await this.logActivity(
                requestId,
                ActivityType.INFO,
                `Found season pack for Season ${season}: ${bestPack.title} (${episodesInSeason.length} episodes)`,
                {
                  season,
                  episodes: episodesInSeason.length,
                  seeders: bestPack.seeders,
                }
              );
            }
          }
        }

        // If we found season packs, create downloads for all of them and continue to download step
        if (selectedPacks.length > 0) {
          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Selected ${selectedPacks.length} season pack(s) - downloads will process in parallel`
          );

          // Store all selected season packs for the Download step to create bulk downloads
          return {
            success: true,
            nextStep: "download",
            data: {
              search: {
                selectedPacks, // Array of {season, release}
                bulkDownloadsForSeasonPacks: true,
                qualityMet: true,
              },
            },
          };
        }

        if (spawnedBranches > 0) {
          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Spawned ${spawnedBranches} episode branch pipeline(s) - processing in parallel`
          );

          // Update request to show branches are running
          await prisma.mediaRequest.update({
            where: { id: requestId },
            data: {
              status: RequestStatus.DOWNLOADING,
              progress: 20,
              currentStep: `Processing ${spawnedBranches} episode(s) in parallel`,
              currentStepStartedAt: new Date(),
            },
          });

          // Return success - branches are now running independently
          return {
            success: true,
            nextStep: null, // No next step - branches handle everything
            data: {
              search: {
                branchesSpawned: true,
                branchCount: spawnedBranches,
                selectedPacks,
              },
            },
          };
        }

        // No quality packs found, fall through to normal selection
        filteredReleases = seasonPacks;
      } else if (individualEpisodes.length > 0) {
        // Strategy 2: For individual episodes
        // If processing a SINGLE episode (Worker-based system), select and return the best release
        // If processing MULTIPLE episodes (OLD pipeline system), spawn branch pipelines
        const isSingleEpisode = context.requestedEpisodes && context.requestedEpisodes.length === 1;

        if (isSingleEpisode) {
          // NEW Worker-based system: Processing a single episode as a ProcessingItem
          // Just select the best release and return it
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `Selecting best release for this episode`
          );

          // Filter releases for this specific episode
          const ep = context.requestedEpisodes?.[0];
          if (!ep) {
            throw new Error("No episode specified in context.requestedEpisodes");
          }
          const key = `S${ep.season}E${ep.episode}`;

          const releasesForEp = individualEpisodes.filter((release) => {
            const episodeMatches = release.title.matchAll(/S(\d{1,2})E(\d{1,2})/gi);
            const releaseEpisodes = Array.from(episodeMatches, (match) => {
              const season = Number.parseInt(match[1], 10);
              const episode = Number.parseInt(match[2], 10);
              return `S${season}E${episode}`;
            });
            return releaseEpisodes.includes(key);
          });

          if (releasesForEp.length === 0) {
            await this.logActivity(requestId, ActivityType.WARNING, `No releases found for ${key}`);
            filteredReleases = [];
          } else {
            // Use the episode releases for normal ranking/selection below
            filteredReleases = releasesForEp;
          }
        } else {
          // OLD pipeline system: Processing multiple episodes, spawn branches
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `No season packs found - selecting releases for ${neededEpisodes.length} individual episodes`
          );

          // Group releases by episode
          const releasesByEpisode = new Map<string, typeof searchResult.releases>();
          for (const release of individualEpisodes) {
            const episodeMatches = release.title.matchAll(/S(\d{1,2})E(\d{1,2})/gi);
            const releaseEpisodes = Array.from(episodeMatches, (match) => {
              const season = Number.parseInt(match[1], 10);
              const episode = Number.parseInt(match[2], 10);
              return `S${season}E${episode}`;
            });

            for (const ep of releaseEpisodes) {
              if (neededSet.has(ep)) {
                if (!releasesByEpisode.has(ep)) {
                  releasesByEpisode.set(ep, []);
                }
                releasesByEpisode.get(ep)?.push(release);
              }
            }
          }

          // Select best release for each needed episode and spawn branch pipelines
          const executor = getPipelineExecutor();
          let spawnedBranches = 0;

          for (const ep of neededEpisodes) {
            const key = `S${ep.season}E${ep.episode}`;
            const releasesForEp = releasesByEpisode.get(key);

            if (releasesForEp && releasesForEp.length > 0) {
              // Rank releases for this episode and pick the best
              const { matching: ranked } = rankReleasesWithQualityFilter(
                releasesForEp,
                requiredResolution,
                1
              );

              if (ranked.length > 0) {
                const bestRelease = ranked[0].release;

                // Spawn branch pipeline for this episode
                const branchId = await executor.spawnBranchExecution(
                  parentExecutionId,
                  requestId,
                  ep.id,
                  "episode-branch-pipeline",
                  {
                    search: {
                      selectedRelease: bestRelease,
                      qualityMet: true,
                    },
                    season: ep.season,
                    episode: ep.episode,
                  } as Partial<PipelineContext>
                );

                spawnedBranches++;

                // Mark episode as DOWNLOADING (branch will handle it)
                await pipelineOrchestrator.transitionStatus(ep.id, ProcessingStatus.DOWNLOADING, {
                  currentStep: "downloading",
                });

                await this.logActivity(
                  requestId,
                  ActivityType.INFO,
                  `Spawned branch for ${key}: ${bestRelease.title}`,
                  { episode: key, seeders: bestRelease.seeders }
                );

                console.log(
                  `[Search] Spawned branch ${branchId} for ${key} using ${bestRelease.title}`
                );
              }
            }
          }

          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Spawned ${spawnedBranches} episode branch pipeline(s) - processing in parallel`
          );

          // Return success - branches are now running independently
          return {
            success: true,
            nextStep: null, // No next step - branches handle everything
            data: {
              search: {
                branchesSpawned: true,
                branchCount: spawnedBranches,
              },
            },
          };
        }
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
      // For TV shows, check if we have DOWNLOADED episodes that can proceed to encoding
      // even though we didn't find new releases for remaining episodes
      if (mediaType === MediaType.TV) {
        const allEpisodes = await prisma.processingItem.findMany({
          where: { requestId, type: "EPISODE" },
          select: { id: true, season: true, episode: true, status: true },
        });

        const downloadedEpisodes = allEpisodes.filter(
          (ep: { status: ProcessingStatus }) => ep.status === ProcessingStatus.DOWNLOADED
        );

        if (downloadedEpisodes.length > 0) {
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `No new releases found, but ${downloadedEpisodes.length} episodes already downloaded - proceeding to encoding`
          );

          console.log(
            `[Search] ${downloadedEpisodes.length} episodes DOWNLOADED, continuing to encode them`
          );

          // Continue to download step which will handle these downloaded episodes
          return {
            success: true,
            nextStep: "download",
            data: {
              search: {
                selectedRelease: null,
                qualityMet: true,
                skippedSearch: true,
              },
            },
          };
        }
      }

      // No downloaded episodes to process, mark as awaiting
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
    const { matching: rankedMatching, rejected } = rankReleasesWithQualityFilter(
      matching,
      requiredResolution,
      maxResults
    );

    // Log rejected releases with reasons
    if (rejected.length > 0) {
      const rejectionSummary = rejected
        .map((r) => `${r.release.title.substring(0, 60)}: ${r.rejectionReason}`)
        .join("; ");
      await this.logActivity(
        requestId,
        ActivityType.WARNING,
        `${rejected.length} release(s) rejected by quality profile: ${rejectionSummary}`,
        {
          rejectedCount: rejected.length,
          rejections: rejected.map((r) => ({
            title: r.release.title,
            reason: r.rejectionReason,
            size: r.release.size,
            resolution: r.release.resolution,
          })),
        }
      );
    }

    if (rankedMatching.length === 0) {
      const errorMsg =
        rejected.length > 0
          ? `All ${rejected.length} release(s) rejected by quality profile`
          : "No suitable release found within quality constraints";
      return {
        success: false,
        shouldRetry: false,
        nextStep: null,
        error: errorMsg,
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
