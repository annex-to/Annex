/**
 * TV Show Pipeline Service
 *
 * Handles TV show acquisition with:
 * - qBittorrent matching to reuse existing downloads
 * - Season pack preference (download whole seasons when available)
 * - Episode-by-episode fallback when packs unavailable
 * - Robust retry and recovery logic
 * - Per-episode status tracking via TvEpisode model
 */

import { prisma } from "../db/client.js";
import { getJobQueueService, type JobType } from "./jobQueue.js";
import { getIndexerService, type Release } from "./indexer.js";
import { getDownloadService } from "./download.js";
import { getEncodingService } from "./encoding.js";
import { getDeliveryService } from "./delivery.js";
import { getEncoderDispatchService } from "./encoderDispatch.js";
import { getNamingService } from "./naming.js";
import { getTMDBService } from "./tmdb.js";
import {
  downloadManager,
  normalizeTitle,
  parseTorrentName,
  rankReleases,
} from "./downloadManager.js";
import {
  deriveRequiredResolution,
  filterReleasesByQuality,
  rankReleasesWithQualityFilter,
  releasesToStorageFormat,
  getBestAvailableResolution,
  getResolutionLabel,
  resolutionMeetsRequirement,
  type RequestTarget,
} from "./qualityService.js";
import {
  detectRarArchive,
  extractRar,
  isSampleFile,
} from "./archive.js";
import {
  RequestStatus,
  TvEpisodeStatus,
  DownloadStatus,
  ActivityType,
  MediaType,
  Prisma,
  type MediaRequest,
  type TvEpisode,
  type Download,
  type StorageServer,
  type EncodingProfile,
} from "@prisma/client";

// =============================================================================
// Types
// =============================================================================

export interface TvSearchPayload {
  requestId: string;
}

export interface TvDownloadPayload {
  requestId: string;
  downloadId: string;
}

export interface TvMapFilesPayload {
  requestId: string;
  downloadId: string;
}

export interface TvEncodePayload {
  requestId: string;
  episodeId: string;
}

export interface TvDeliverPayload {
  requestId: string;
  episodeId: string;
  encodedFilePath: string;
  profileId: string;
  resolution: string;
  codec: string;
  targetServerIds: string[];
}

interface SeasonInfo {
  seasonNumber: number;
  episodeCount: number;
  episodes: Array<{
    episodeNumber: number;
    name: string | null;
    airDate: string | null;
  }>;
}

// =============================================================================
// Activity Logging
// =============================================================================

async function logActivity(
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

// =============================================================================
// Helper Functions
// =============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatEpisode(season: number, episode: number): string {
  return `S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}`;
}

function getRequestTargets(request: MediaRequest): RequestTarget[] {
  const targets = request.targets as unknown;
  if (!Array.isArray(targets)) return [];
  return targets as RequestTarget[];
}

async function updateOverallProgress(requestId: string): Promise<void> {
  const progress = await getEpisodeProgress(requestId);
  const overallProgress = progress.total > 0
    ? ((progress.completed + progress.downloading * 0.5) / progress.total) * 100
    : 0;

  let status: RequestStatus = RequestStatus.DOWNLOADING;
  let currentStep = `${progress.completed}/${progress.total} episodes completed`;

  if (progress.completed === progress.total) {
    status = RequestStatus.COMPLETED;
    currentStep = "All episodes completed";
  } else if (progress.downloading === 0 && progress.pending === 0) {
    // No episodes actively downloading or pending
    if (progress.qualityUnavailable > 0 && progress.awaiting === 0 && progress.failed === 0) {
      // All remaining episodes are quality unavailable
      status = RequestStatus.QUALITY_UNAVAILABLE;
      currentStep = `${progress.qualityUnavailable} episode(s) missing required quality`;
    } else if (progress.awaiting > 0) {
      status = RequestStatus.AWAITING;
      currentStep = `Waiting for ${progress.awaiting} episodes`;
    } else if (progress.qualityUnavailable > 0) {
      // Mix of quality unavailable and other issues
      status = RequestStatus.QUALITY_UNAVAILABLE;
      currentStep = `${progress.qualityUnavailable} episode(s) missing required quality`;
    } else if (progress.failed > 0) {
      status = RequestStatus.FAILED;
      currentStep = `${progress.failed} episodes failed`;
    }
  }

  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status,
      progress: overallProgress,
      currentStep,
      completedAt: status === RequestStatus.COMPLETED ? new Date() : undefined,
    },
  });
}

// =============================================================================
// Episode Status Management
// =============================================================================

/**
 * Initialize TvEpisode records for a TV request based on TMDB data
 * Also checks library availability and marks episodes as SKIPPED if already in library
 */
export async function initializeTvEpisodes(requestId: string): Promise<number> {
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  const tmdb = getTMDBService();
  const showDetails = await tmdb.getTvShowDetails(request.tmdbId);

  if (!showDetails) {
    throw new Error(`Could not fetch TV show details for TMDB ID ${request.tmdbId}`);
  }

  // Get target server IDs from the request
  const targets = getRequestTargets(request);
  const serverIds = targets.map((t) => t.serverId);

  // Get library availability for episodes on target servers
  const libraryEpisodes = await prisma.episodeLibraryItem.findMany({
    where: {
      tmdbId: request.tmdbId,
      serverId: { in: serverIds },
    },
    select: {
      season: true,
      episode: true,
      serverId: true,
    },
  });

  // Create a map of available episodes: "season-episode" -> set of server IDs
  const availableMap = new Map<string, Set<string>>();
  for (const ep of libraryEpisodes) {
    const key = `${ep.season}-${ep.episode}`;
    if (!availableMap.has(key)) {
      availableMap.set(key, new Set());
    }
    availableMap.get(key)!.add(ep.serverId);
  }

  // Get all seasons info
  const seasons: SeasonInfo[] = [];
  const requestedSeasons = request.requestedSeasons;
  const totalSeasons = showDetails.numberOfSeasons;

  for (let seasonNum = 1; seasonNum <= totalSeasons; seasonNum++) {
    // If specific seasons requested, only include those
    if (requestedSeasons.length > 0 && !requestedSeasons.includes(seasonNum)) {
      continue;
    }

    const seasonDetails = await tmdb.getSeason(request.tmdbId, seasonNum);
    if (seasonDetails && seasonDetails.episodes) {
      seasons.push({
        seasonNumber: seasonNum,
        episodeCount: seasonDetails.episodes.length,
        episodes: seasonDetails.episodes.map((ep) => ({
          episodeNumber: ep.episodeNumber,
          name: ep.name || null,
          airDate: ep.airDate,
        })),
      });
    }
  }

  // Create TvEpisode records
  const now = new Date();
  let episodeCount = 0;
  let skippedCount = 0;

  for (const season of seasons) {
    for (const episode of season.episodes) {
      const airDate = episode.airDate ? new Date(episode.airDate) : null;
      const hasAired = airDate ? airDate <= now : false;

      // Check if this episode is available on all target servers
      const key = `${season.seasonNumber}-${episode.episodeNumber}`;
      const availableOnServers = availableMap.get(key);
      const isAvailableOnAllTargets = availableOnServers?.size === serverIds.length;

      // Determine initial status
      let status: TvEpisodeStatus;
      if (isAvailableOnAllTargets) {
        status = TvEpisodeStatus.SKIPPED;
        skippedCount++;
      } else if (hasAired) {
        status = TvEpisodeStatus.PENDING;
      } else {
        status = TvEpisodeStatus.AWAITING;
      }

      await prisma.tvEpisode.upsert({
        where: {
          requestId_season_episode: {
            requestId,
            season: season.seasonNumber,
            episode: episode.episodeNumber,
          },
        },
        create: {
          requestId,
          season: season.seasonNumber,
          episode: episode.episodeNumber,
          title: episode.name,
          status,
          airDate,
        },
        update: {
          title: episode.name,
          airDate,
          // Don't override status if already in progress, but update to SKIPPED if now available
          ...(isAvailableOnAllTargets ? { status: TvEpisodeStatus.SKIPPED } : {}),
        },
      });

      episodeCount++;
    }
  }

  const message = skippedCount > 0
    ? `Initialized ${episodeCount} episodes across ${seasons.length} seasons (${skippedCount} already in library)`
    : `Initialized ${episodeCount} episodes across ${seasons.length} seasons`;
  await logActivity(requestId, ActivityType.INFO, message);

  return episodeCount;
}

/**
 * Get episode download progress for a request
 */
export async function getEpisodeProgress(requestId: string): Promise<{
  total: number;
  pending: number;
  awaiting: number;
  qualityUnavailable: number;
  downloading: number;
  completed: number;
  skipped: number;
  failed: number;
}> {
  const statuses = await prisma.tvEpisode.groupBy({
    by: ["status"],
    where: { requestId },
    _count: true,
  });

  const counts = {
    total: 0,
    pending: 0,
    awaiting: 0,
    qualityUnavailable: 0,
    downloading: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
  };

  for (const s of statuses) {
    counts.total += s._count;
    switch (s.status) {
      case TvEpisodeStatus.PENDING:
        counts.pending += s._count;
        break;
      case TvEpisodeStatus.AWAITING:
        counts.awaiting += s._count;
        break;
      case TvEpisodeStatus.QUALITY_UNAVAILABLE:
        counts.qualityUnavailable += s._count;
        break;
      case TvEpisodeStatus.SEARCHING:
      case TvEpisodeStatus.DOWNLOADING:
      case TvEpisodeStatus.DOWNLOADED:
      case TvEpisodeStatus.ENCODING:
      case TvEpisodeStatus.ENCODED:
      case TvEpisodeStatus.DELIVERING:
        counts.downloading += s._count;
        break;
      case TvEpisodeStatus.COMPLETED:
        counts.completed += s._count;
        break;
      case TvEpisodeStatus.SKIPPED:
        counts.skipped += s._count;
        counts.completed += s._count; // Count towards completed for progress
        break;
      case TvEpisodeStatus.FAILED:
        counts.failed += s._count;
        break;
    }
  }

  return counts;
}

// =============================================================================
// TV Search Handler
// =============================================================================

/**
 * Handle TV show search - checks qBittorrent first, then indexers
 */
export async function handleTvSearch(payload: TvSearchPayload, jobId: string): Promise<void> {
  const { requestId } = payload;
  const jobQueue = getJobQueueService();

  if (jobQueue.isCancelled(jobId)) {
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { status: RequestStatus.FAILED, error: "Cancelled" },
    });
    return;
  }

  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    include: { tvEpisodes: true },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.SEARCHING,
      progress: 5,
      currentStep: "Initializing episode list...",
    },
  });

  // Initialize episodes if not already done
  if (request.tvEpisodes.length === 0) {
    await initializeTvEpisodes(requestId);
  }

  // Get pending episodes grouped by season
  const pendingEpisodes = await prisma.tvEpisode.findMany({
    where: {
      requestId,
      status: TvEpisodeStatus.PENDING,
    },
    orderBy: [{ season: "asc" }, { episode: "asc" }],
  });

  if (pendingEpisodes.length === 0) {
    const progress = await getEpisodeProgress(requestId);

    if (progress.completed === progress.total) {
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.COMPLETED,
          progress: 100,
          currentStep: null,
          completedAt: new Date(),
        },
      });
      await logActivity(requestId, ActivityType.SUCCESS, "All episodes completed");
      return;
    }

    if (progress.awaiting > 0) {
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.AWAITING,
          currentStep: `Waiting for ${progress.awaiting} episodes to air`,
        },
      });
      await logActivity(requestId, ActivityType.INFO, `${progress.awaiting} episodes not yet aired`);
      return;
    }

    return;
  }

  // Group pending episodes by season
  const seasonEpisodes = new Map<number, TvEpisode[]>();
  for (const ep of pendingEpisodes) {
    if (!seasonEpisodes.has(ep.season)) {
      seasonEpisodes.set(ep.season, []);
    }
    seasonEpisodes.get(ep.season)!.push(ep);
  }

  await logActivity(requestId, ActivityType.INFO, `Searching for ${pendingEpisodes.length} episodes across ${seasonEpisodes.size} seasons`);

  const tmdb = getTMDBService();
  const showDetails = await tmdb.getTvShowDetails(request.tmdbId);
  const imdbId = showDetails?.imdbId ?? undefined;
  const indexer = getIndexerService();

  // Derive quality requirements from target servers
  const targets = (request.targets as unknown as RequestTarget[]) || [];
  const requiredResolution = await deriveRequiredResolution(targets);
  const resolutionLabel = getResolutionLabel(requiredResolution);

  // Save required resolution to request
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: { requiredResolution },
  });

  await logActivity(requestId, ActivityType.INFO, `Quality requirement: ${resolutionLabel} or better (derived from target servers)`);

  // Process each season
  for (const [seasonNumber, episodes] of seasonEpisodes) {
    if (jobQueue.isCancelled(jobId)) {
      return;
    }

    const episodeNumbers = episodes.map((e) => e.episode);
    const episodeIds = episodes.map((e) => e.id);

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { currentStep: `Searching Season ${seasonNumber}...` },
    });

    // Mark episodes as searching
    await prisma.tvEpisode.updateMany({
      where: { id: { in: episodeIds } },
      data: { status: TvEpisodeStatus.SEARCHING },
    });

    // =========================================================================
    // STEP 1: Check qBittorrent for existing season pack
    // =========================================================================
    const existingSeasonMatch = await downloadManager.findExistingSeasonDownload(
      request.title,
      seasonNumber
    );

    if (existingSeasonMatch.found && existingSeasonMatch.match) {
      // Check if existing download meets quality requirements
      const torrentName = existingSeasonMatch.match.torrent.name;
      const meetsQuality = resolutionMeetsRequirement(torrentName, requiredResolution);

      if (meetsQuality) {
        await logActivity(requestId, ActivityType.SUCCESS, `Found existing Season ${seasonNumber} in qBittorrent: ${torrentName}`);

        // Create Download record from existing torrent
        const download = await downloadManager.createDownloadFromExisting(
          requestId,
          MediaType.TV,
          existingSeasonMatch.match,
          {
            isSeasonPack: true,
            season: seasonNumber,
            episodeIds,
            isComplete: existingSeasonMatch.isComplete,
          }
        );

        if (existingSeasonMatch.isComplete) {
          // Already complete - queue file mapping
          await jobQueue.addJob("tv:map-files" as JobType, {
            requestId,
            downloadId: download.id,
          } as TvMapFilesPayload, { priority: 5, maxAttempts: 3 });
        } else {
          // In progress - queue download monitoring
          await jobQueue.addJob("tv:download" as JobType, {
            requestId,
            downloadId: download.id,
          } as TvDownloadPayload, { priority: 5, maxAttempts: 3 });
        }

        continue; // Move to next season
      } else {
        // Existing download doesn't meet quality - log and continue searching
        await logActivity(
          requestId,
          ActivityType.WARNING,
          `Found existing Season ${seasonNumber} in qBittorrent but quality too low: ${torrentName} (need ${resolutionLabel})`
        );
      }
    }

    // =========================================================================
    // STEP 2: Search indexers for season pack
    // =========================================================================
    const seasonPackResult = await indexer.searchTvSeason({
      tmdbId: request.tmdbId,
      imdbId,
      title: request.title,
      year: request.year,
      season: seasonNumber,
    });

    console.log(`[TvPipeline] ─────────────────────────────────────────────────`);
    console.log(`[TvPipeline] Season ${seasonNumber} search returned ${seasonPackResult.releases.length} releases`);

    // Log all releases found for debugging
    if (seasonPackResult.releases.length > 0) {
      console.log(`[TvPipeline] All releases found:`);
      for (const r of seasonPackResult.releases.slice(0, 15)) {
        const parsed = parseTorrentName(r.title);
        console.log(`[TvPipeline]   • ${r.title}`);
        console.log(`[TvPipeline]     parsed: title="${parsed.title}" S${parsed.season ?? "?"}E${parsed.episode ?? "?"} res=${parsed.resolution || "?"} src=${parsed.source || "?"}`);
        console.log(`[TvPipeline]     size=${r.size ? Math.round(r.size / 1024 / 1024 / 1024 * 10) / 10 + "GB" : "?"} seeds=${r.seeders ?? "?"} indexer=${r.indexerName || "?"}`);
      }
      if (seasonPackResult.releases.length > 15) {
        console.log(`[TvPipeline]   ... and ${seasonPackResult.releases.length - 15} more`);
      }
    }

    // Normalize request title for comparison
    const normalizedRequestTitle = normalizeTitle(request.title);
    console.log(`[TvPipeline] Filtering for show: "${request.title}" (normalized: "${normalizedRequestTitle}")`);

    // Filter for actual season packs (not individual episodes) that match our show
    const seasonPacks = seasonPackResult.releases.filter((r) => {
      const title = r.title.toUpperCase();
      const parsed = parseTorrentName(r.title);

      // Must have season, must NOT have episode
      if (parsed.season !== seasonNumber) {
        return false;
      }
      if (parsed.episode !== undefined) {
        return false;
      }

      // Double check with regex patterns
      if (/S\d{1,2}E\d{1,2}/i.test(title)) {
        return false;
      }

      // CRITICAL: Verify the show title matches our request
      // This prevents "The Terminal List Dark Wolf" from matching "The Terminal List"
      if (parsed.title) {
        const normalizedReleaseTitle = normalizeTitle(parsed.title);
        if (normalizedReleaseTitle !== normalizedRequestTitle) {
          console.log(`[TvPipeline] ✗ REJECTED (title mismatch): "${parsed.title}" ≠ "${request.title}"`);
          return false;
        }
      }

      console.log(`[TvPipeline] ✓ ACCEPTED season pack: ${r.title}`);
      return true;
    });

    console.log(`[TvPipeline] Filtered to ${seasonPacks.length} valid season packs`);

    if (seasonPacks.length > 0) {
      // Filter season packs by quality requirement
      const { matching: matchingPacks, belowQuality: belowQualityPacks } = filterReleasesByQuality(
        seasonPacks,
        requiredResolution
      );

      console.log(`[TvPipeline] Quality filter (need ${resolutionLabel}+): ${matchingPacks.length} meet requirement, ${belowQualityPacks.length} below`);

      if (matchingPacks.length > 0) {
        console.log(`[TvPipeline] Quality-matching packs:`);
        for (const r of matchingPacks) {
          console.log(`[TvPipeline]   ✓ ${r.resolution || "?"} - ${r.title}`);
        }
      }
      if (belowQualityPacks.length > 0) {
        console.log(`[TvPipeline] Below-quality packs (alternatives):`);
        for (const r of belowQualityPacks.slice(0, 5)) {
          console.log(`[TvPipeline]   ✗ ${r.resolution || "?"} - ${r.title}`);
        }
      }

      if (matchingPacks.length > 0) {
        // Rank matching releases
        const { matching: rankedMatching } = rankReleasesWithQualityFilter(
          matchingPacks,
          requiredResolution,
          5
        );

        console.log(`[TvPipeline] Ranked releases (by score):`);
        for (const r of rankedMatching) {
          console.log(`[TvPipeline]   #${rankedMatching.indexOf(r) + 1} score=${r.score.toFixed(1)} - ${r.release.title}`);
          console.log(`[TvPipeline]      res=${r.parsed.resolution || "?"} src=${r.parsed.source || "?"} codec=${r.parsed.codec || "?"} seeds=${r.release.seeders ?? "?"}`);
        }

        if (rankedMatching.length > 0) {
          const bestRelease = rankedMatching[0].release;
          const alternatives = rankedMatching.slice(1).map((r) => r.release);

          console.log(`[TvPipeline] ★ SELECTED: ${bestRelease.title} (score=${rankedMatching[0].score.toFixed(1)})`);
          console.log(`[TvPipeline]   ${alternatives.length} alternatives available for retry`);

          await logActivity(requestId, ActivityType.SUCCESS, `Found season pack: ${bestRelease.title}`, {
            season: seasonNumber,
            episodes: episodeNumbers.length,
            release: bestRelease.title,
            score: rankedMatching[0].score,
          });

          // Mark episodes as quality met
          await prisma.tvEpisode.updateMany({
            where: { id: { in: episodeIds } },
            data: { qualityMet: true },
          });

          // Create Download with alternatives for retry
          const download = await downloadManager.createDownload({
            requestId,
            mediaType: MediaType.TV,
            release: bestRelease,
            alternativeReleases: alternatives,
            isSeasonPack: true,
            season: seasonNumber,
            episodeIds,
          });

          if (download) {
            await jobQueue.addJob("tv:download" as JobType, {
              requestId,
              downloadId: download.id,
            } as TvDownloadPayload, { priority: 5, maxAttempts: 3 });
            continue; // Move to next season
          } else {
            // Download creation failed - log error and mark episodes as failed
            await logActivity(
              requestId,
              ActivityType.ERROR,
              `Failed to create download for season ${seasonNumber} pack: ${bestRelease.title}`
            );
            await prisma.tvEpisode.updateMany({
              where: { id: { in: episodeIds } },
              data: {
                status: TvEpisodeStatus.FAILED,
                error: "Failed to create download - no valid download URL",
              },
            });
            continue; // Move to next season
          }
        }
      }

      // No matching quality packs - store alternatives and mark as quality unavailable
      if (belowQualityPacks.length > 0) {
        const bestAvailable = getBestAvailableResolution(belowQualityPacks);
        const storedAlternatives = releasesToStorageFormat(belowQualityPacks.slice(0, 5));

        await prisma.tvEpisode.updateMany({
          where: { id: { in: episodeIds } },
          data: {
            status: TvEpisodeStatus.QUALITY_UNAVAILABLE,
            qualityMet: false,
            availableReleases: storedAlternatives as unknown as Prisma.InputJsonValue,
          },
        });

        await logActivity(
          requestId,
          ActivityType.WARNING,
          `Season ${seasonNumber} pack: wanted ${resolutionLabel}, best available is ${bestAvailable}. Trying individual episodes...`,
          { season: seasonNumber, bestAvailable }
        );

        // Continue to individual episode search - some episodes might have quality releases
      }
    }

    // =========================================================================
    // STEP 3: No season pack - search for individual episodes
    // =========================================================================
    await logActivity(requestId, ActivityType.INFO, `No season pack for S${seasonNumber.toString().padStart(2, "0")}, searching individual episodes`);

    for (const ep of episodes) {
      if (jobQueue.isCancelled(jobId)) {
        return;
      }

      // Check qBittorrent for existing episode
      const existingEpMatch = await downloadManager.findExistingEpisodeDownload(
        request.title,
        seasonNumber,
        ep.episode
      );

      if (existingEpMatch.found && existingEpMatch.match) {
        // Check if existing download meets quality requirements
        const torrentName = existingEpMatch.match.torrent.name;
        const meetsQuality = resolutionMeetsRequirement(torrentName, requiredResolution);

        if (meetsQuality) {
          await logActivity(requestId, ActivityType.SUCCESS, `Found existing ${formatEpisode(seasonNumber, ep.episode)} in qBittorrent`);

          const download = await downloadManager.createDownloadFromExisting(
            requestId,
            MediaType.TV,
            existingEpMatch.match,
            { episodeIds: [ep.id], isComplete: existingEpMatch.isComplete }
          );

          if (existingEpMatch.isComplete) {
            await jobQueue.addJob("tv:map-files" as JobType, {
              requestId,
              downloadId: download.id,
            } as TvMapFilesPayload, { priority: 5, maxAttempts: 3 });
          } else {
            await jobQueue.addJob("tv:download" as JobType, {
              requestId,
              downloadId: download.id,
            } as TvDownloadPayload, { priority: 5, maxAttempts: 3 });
          }

          continue;
        } else {
          // Existing download doesn't meet quality - log and continue searching
          await logActivity(
            requestId,
            ActivityType.WARNING,
            `Found existing ${formatEpisode(seasonNumber, ep.episode)} in qBittorrent but quality too low: ${torrentName} (need ${resolutionLabel})`
          );
        }
      }

      // Search indexers for episode
      console.log(`[TvPipeline] ─────────────────────────────────────────────────`);
      console.log(`[TvPipeline] Searching for ${formatEpisode(seasonNumber, ep.episode)}`);

      const episodeResult = await indexer.searchTvEpisode({
        tmdbId: request.tmdbId,
        imdbId,
        title: request.title,
        season: seasonNumber,
        episode: ep.episode,
      });

      console.log(`[TvPipeline] Episode search returned ${episodeResult.releases.length} releases`);

      if (episodeResult.releases.length === 0) {
        console.log(`[TvPipeline] ✗ No releases found for ${formatEpisode(seasonNumber, ep.episode)}`);
        await prisma.tvEpisode.update({
          where: { id: ep.id },
          data: {
            status: TvEpisodeStatus.AWAITING,
            error: "No releases found",
          },
        });
        continue;
      }

      // Log releases found
      console.log(`[TvPipeline] Releases found for ${formatEpisode(seasonNumber, ep.episode)}:`);
      for (const r of episodeResult.releases.slice(0, 10)) {
        const parsed = parseTorrentName(r.title);
        console.log(`[TvPipeline]   • ${r.title}`);
        console.log(`[TvPipeline]     parsed="${parsed.title}" res=${parsed.resolution || "?"} seeds=${r.seeders ?? "?"}`);
      }

      // Filter releases to only those matching our show title
      const titleMatchedReleases = episodeResult.releases.filter((r) => {
        const parsed = parseTorrentName(r.title);
        if (parsed.title) {
          const normalizedReleaseTitle = normalizeTitle(parsed.title);
          if (normalizedReleaseTitle !== normalizedRequestTitle) {
            console.log(`[TvPipeline] ✗ REJECTED (title): "${parsed.title}" ≠ "${request.title}"`);
            return false;
          }
        }
        return true;
      });

      console.log(`[TvPipeline] After title filter: ${titleMatchedReleases.length} releases match "${request.title}"`);

      if (titleMatchedReleases.length === 0) {
        console.log(`[TvPipeline] ✗ No releases match show title for ${formatEpisode(seasonNumber, ep.episode)}`);
        await prisma.tvEpisode.update({
          where: { id: ep.id },
          data: {
            status: TvEpisodeStatus.AWAITING,
            error: "No releases found for this show",
          },
        });
        continue;
      }

      // Filter by quality requirement
      const { matching: matchingEpisodes, belowQuality: belowQualityEpisodes } = filterReleasesByQuality(
        titleMatchedReleases,
        requiredResolution
      );

      console.log(`[TvPipeline] Quality filter (need ${resolutionLabel}+): ${matchingEpisodes.length} match, ${belowQualityEpisodes.length} below`);

      if (matchingEpisodes.length === 0) {
        // No quality matches - check for alternatives
        if (belowQualityEpisodes.length > 0) {
          const bestAvailable = getBestAvailableResolution(belowQualityEpisodes);
          const storedAlternatives = releasesToStorageFormat(belowQualityEpisodes.slice(0, 5));

          await prisma.tvEpisode.update({
            where: { id: ep.id },
            data: {
              status: TvEpisodeStatus.QUALITY_UNAVAILABLE,
              qualityMet: false,
              availableReleases: storedAlternatives as unknown as Prisma.InputJsonValue,
              error: `No ${resolutionLabel} releases (best: ${bestAvailable})`,
            },
          });
        } else {
          await prisma.tvEpisode.update({
            where: { id: ep.id },
            data: {
              status: TvEpisodeStatus.AWAITING,
              error: "No suitable releases found",
            },
          });
        }
        continue;
      }

      // Rank matching releases
      const { matching: rankedMatching } = rankReleasesWithQualityFilter(
        matchingEpisodes,
        requiredResolution,
        5
      );

      if (rankedMatching.length === 0) {
        console.log(`[TvPipeline] ✗ No releases passed ranking for ${formatEpisode(seasonNumber, ep.episode)}`);
        await prisma.tvEpisode.update({
          where: { id: ep.id },
          data: {
            status: TvEpisodeStatus.AWAITING,
            error: "No suitable releases found",
          },
        });
        continue;
      }

      console.log(`[TvPipeline] Ranked releases for ${formatEpisode(seasonNumber, ep.episode)}:`);
      for (const r of rankedMatching) {
        console.log(`[TvPipeline]   #${rankedMatching.indexOf(r) + 1} score=${r.score.toFixed(1)} - ${r.release.title}`);
      }

      const bestRelease = rankedMatching[0].release;
      const alternatives = rankedMatching.slice(1).map((r) => r.release);

      console.log(`[TvPipeline] ★ SELECTED for ${formatEpisode(seasonNumber, ep.episode)}: ${bestRelease.title}`);

      await logActivity(requestId, ActivityType.SUCCESS, `Found ${formatEpisode(seasonNumber, ep.episode)}: ${bestRelease.title}`);

      // Mark episode as quality met
      await prisma.tvEpisode.update({
        where: { id: ep.id },
        data: { qualityMet: true },
      });

      const download = await downloadManager.createDownload({
        requestId,
        mediaType: MediaType.TV,
        release: bestRelease,
        alternativeReleases: alternatives,
        isSeasonPack: false,
        season: seasonNumber,
        episodeIds: [ep.id],
      });

      if (download) {
        await jobQueue.addJob("tv:download" as JobType, {
          requestId,
          downloadId: download.id,
        } as TvDownloadPayload, { priority: 5, maxAttempts: 3 });
      } else {
        // Download creation failed - mark episode as failed
        await logActivity(
          requestId,
          ActivityType.ERROR,
          `Failed to create download for ${formatEpisode(seasonNumber, ep.episode)}: ${bestRelease.title}`
        );
        await prisma.tvEpisode.update({
          where: { id: ep.id },
          data: {
            status: TvEpisodeStatus.FAILED,
            error: "Failed to create download - no valid download URL",
          },
        });
      }
    }
  }

  await updateOverallProgress(requestId);
}

// =============================================================================
// TV Download Handler
// =============================================================================

/**
 * Monitor a download until completion
 */
async function handleTvDownload(payload: TvDownloadPayload, jobId: string): Promise<void> {
  const { requestId, downloadId } = payload;
  const jobQueue = getJobQueueService();

  if (jobQueue.isCancelled(jobId)) {
    await prisma.download.update({
      where: { id: downloadId },
      data: { status: DownloadStatus.CANCELLED },
    });
    await updateOverallProgress(requestId);
    return;
  }

  // Check if request was cancelled
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { status: true },
  });

  if (request?.status === RequestStatus.FAILED) {
    console.log(`[TvPipeline] Skipping download monitoring - request was cancelled`);
    await prisma.download.update({
      where: { id: downloadId },
      data: { status: DownloadStatus.CANCELLED },
    });
    return;
  }

  const download = await prisma.download.findUnique({
    where: { id: downloadId },
    include: { tvEpisodes: true },
  });

  if (!download) {
    throw new Error(`Download not found: ${downloadId}`);
  }

  await logActivity(requestId, ActivityType.INFO, `Monitoring download: ${download.torrentName}`);

  const qb = getDownloadService();

  // Wait for download to complete
  const downloadResult = await qb.waitForCompletion(download.torrentHash, {
    pollInterval: 5000,
    timeout: 48 * 60 * 60 * 1000, // 48 hours
    onProgress: async (progress) => {
      // Update Download record
      await prisma.download.update({
        where: { id: downloadId },
        data: {
          progress: progress.progress,
          lastProgressAt: new Date(),
          seedCount: progress.seeds,
          peerCount: progress.peers,
          savePath: progress.savePath,
          contentPath: progress.contentPath,
        },
      });

      // Update request progress display
      const label = download.isSeasonPack
        ? `S${download.season?.toString().padStart(2, "0")}`
        : download.tvEpisodes[0]
        ? formatEpisode(download.tvEpisodes[0].season, download.tvEpisodes[0].episode)
        : "Download";

      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          currentStep: `${label}: ${progress.progress.toFixed(1)}% - ${formatBytes(progress.downloadSpeed)}/s`,
        },
      });
    },
    checkCancelled: () => jobQueue.isCancelled(jobId),
  });

  if (!downloadResult.success) {
    // Handle failure - try alternative if available
    await downloadManager.handleStalledDownload(downloadId, downloadResult.error || "Download failed");
    await updateOverallProgress(requestId);
    return;
  }

  // Download complete
  await prisma.download.update({
    where: { id: downloadId },
    data: {
      status: DownloadStatus.COMPLETED,
      progress: 100,
      completedAt: new Date(),
      savePath: downloadResult.progress?.savePath,
      contentPath: downloadResult.progress?.contentPath,
    },
  });

  await logActivity(requestId, ActivityType.SUCCESS, `Download complete: ${download.torrentName}`);

  // Queue file mapping
  await jobQueue.addJob("tv:map-files" as JobType, {
    requestId,
    downloadId,
  } as TvMapFilesPayload, { priority: 5, maxAttempts: 3 });

  await updateOverallProgress(requestId);
}

// =============================================================================
// File Mapping Handler
// =============================================================================

/**
 * Map downloaded files to episodes
 * Handles:
 * - RAR archive extraction (common in scene releases)
 * - Sample file filtering (excludes files in "Sample" folders or with "sample" in name)
 * - Size-based filtering (excludes very small files that are likely samples)
 */
async function handleTvMapFiles(payload: TvMapFilesPayload, jobId: string): Promise<void> {
  const { requestId, downloadId } = payload;
  const jobQueue = getJobQueueService();

  if (jobQueue.isCancelled(jobId)) {
    return;
  }

  // Check if request was cancelled
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { status: true },
  });

  if (request?.status === RequestStatus.FAILED) {
    console.log(`[TvPipeline] Skipping file mapping - request was cancelled`);
    return;
  }

  const download = await prisma.download.findUnique({
    where: { id: downloadId },
    include: { tvEpisodes: true },
  });

  if (!download) {
    throw new Error(`Download not found: ${downloadId}`);
  }

  await prisma.download.update({
    where: { id: downloadId },
    data: { status: DownloadStatus.IMPORTING },
  });

  const qb = getDownloadService();
  const torrentFiles = await qb.getTorrentFiles(download.torrentHash);

  // Get save path for full file paths
  const progressInfo = await qb.getProgress(download.torrentHash);
  const basePath = progressInfo?.savePath || download.savePath || "";
  const contentPath = progressInfo?.contentPath || basePath;

  console.log(`[TvPipeline] File mapping for torrent ${download.torrentHash.substring(0, 8)}...`);
  console.log(`[TvPipeline]   basePath (savePath): ${basePath}`);
  console.log(`[TvPipeline]   contentPath: ${contentPath}`);
  console.log(`[TvPipeline]   torrentFiles: ${torrentFiles.length} files`);
  if (torrentFiles.length > 0) {
    console.log(`[TvPipeline]   First file.name: ${torrentFiles[0].name}`);
  }

  // Check for RAR archives in the download
  const archiveInfo = detectRarArchive(contentPath);

  if (archiveInfo.hasArchive && archiveInfo.archivePath) {
    await logActivity(requestId, ActivityType.INFO, `Extracting RAR archive: ${archiveInfo.archivePath}`);

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { currentStep: "Extracting archive..." },
    });

    const extractResult = await extractRar(archiveInfo.archivePath, contentPath, {
      onProgress: (msg) => console.log(`[TvPipeline] Extract: ${msg.trim()}`),
    });

    if (!extractResult.success) {
      await logActivity(requestId, ActivityType.ERROR, `Failed to extract archive: ${extractResult.error}`);
      // Continue anyway - there might be video files outside the archive
    } else {
      await logActivity(requestId, ActivityType.SUCCESS, `Extracted ${extractResult.extractedFiles.length} files from archive`);
    }
  }

  // Filter to video files
  const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
  let videoFiles: Array<{ name: string; size: number }> = torrentFiles
    .filter((f) => videoExtensions.some((ext) => f.name.toLowerCase().endsWith(ext)))
    .map((f) => ({ name: f.name, size: f.size }));

  // Filter out sample files
  const originalCount = videoFiles.length;
  videoFiles = videoFiles.filter((f) => !isSampleFile(f.name));

  // Also filter by size - anything under 100MB is likely a sample
  const minSizeBytes = 100 * 1024 * 1024; // 100MB
  videoFiles = videoFiles.filter((f) => f.size >= minSizeBytes);

  if (originalCount > videoFiles.length) {
    console.log(`[TvPipeline] Filtered out ${originalCount - videoFiles.length} sample/small files`);
  }

  // If we extracted files and still have no valid video files in torrent list,
  // scan the directory for extracted files
  if (videoFiles.length === 0 && archiveInfo.hasArchive) {
    console.log(`[TvPipeline] No video files in torrent list after extraction, scanning directory...`);

    const { readdirSync, statSync } = await import("fs");
    const { join } = await import("path");

    try {
      const scanFiles = readdirSync(contentPath);
      for (const filename of scanFiles) {
        const lower = filename.toLowerCase();
        if (videoExtensions.some((ext) => lower.endsWith(ext)) && !isSampleFile(filename)) {
          const filePath = join(contentPath, filename);
          try {
            const stat = statSync(filePath);
            if (stat.size >= minSizeBytes) {
              videoFiles.push({
                name: filename,
                size: stat.size,
              });
            }
          } catch {
            // Ignore stat errors
          }
        }
      }
    } catch (err) {
      console.error(`[TvPipeline] Failed to scan directory: ${err}`);
    }
  }

  if (videoFiles.length === 0) {
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: DownloadStatus.FAILED,
        failureReason: "No video files found in torrent (samples excluded)",
      },
    });

    await prisma.tvEpisode.updateMany({
      where: { downloadId },
      data: {
        status: TvEpisodeStatus.FAILED,
        error: "No video files found (samples excluded)",
      },
    });

    await logActivity(requestId, ActivityType.ERROR, "No video files found in download (samples excluded)");
    await updateOverallProgress(requestId);
    return;
  }

  // Map files to episodes using parse-torrent-title
  let mappedCount = 0;
  let skippedCount = 0;

  for (const episode of download.tvEpisodes) {
    // Skip episodes that are already past the mapping stage (prevents re-mapping on duplicate job runs)
    if (
      episode.status === TvEpisodeStatus.ENCODED ||
      episode.status === TvEpisodeStatus.DELIVERING ||
      episode.status === TvEpisodeStatus.COMPLETED ||
      episode.status === TvEpisodeStatus.SKIPPED
    ) {
      console.log(`[TvPipeline] Skipping S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")} - already ${episode.status}`);
      skippedCount++;
      continue;
    }

    // Find matching file
    let matchedFile = null;

    for (const file of videoFiles) {
      const parsed = parseTorrentName(file.name);

      // Check season match
      if (parsed.season !== episode.season) continue;

      // Check episode match (handle arrays for multi-episode files)
      const epMatch = Array.isArray(parsed.episode)
        ? parsed.episode.includes(episode.episode)
        : parsed.episode === episode.episode;

      if (epMatch) {
        // Skip multi-episode files for now
        if (Array.isArray(parsed.episode) && parsed.episode.length > 1) {
          continue;
        }
        matchedFile = file;
        break;
      }
    }

    if (matchedFile) {
      // Construct full path - handle both torrent files and extracted files
      // Note: qBittorrent file.name includes relative path from save_path (e.g., "TorrentFolder/Episode.mkv")
      // So we use basePath (save_path), not contentPath (which already includes the torrent folder)
      const fullPath = matchedFile.name.startsWith("/")
        ? matchedFile.name
        : `${basePath}/${matchedFile.name}`;

      console.log(`[TvPipeline] Mapped S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")} -> ${fullPath}`);

      await prisma.tvEpisode.update({
        where: { id: episode.id },
        data: {
          sourceFilePath: fullPath,
          status: TvEpisodeStatus.DOWNLOADED,
          downloadedAt: new Date(),
        },
      });

      mappedCount++;

      // Queue encoding for this episode (use addJobIfNotExists to prevent duplicates)
      await jobQueue.addJobIfNotExists(
        "tv:encode" as JobType,
        {
          requestId,
          episodeId: episode.id,
        } as TvEncodePayload,
        `tv:encode:${episode.id}`,
        { priority: 5, maxAttempts: 2 }
      );
    } else {
      await prisma.tvEpisode.update({
        where: { id: episode.id },
        data: {
          status: TvEpisodeStatus.FAILED,
          error: "Could not match file to episode",
        },
      });
    }
  }

  const skippedMsg = skippedCount > 0 ? ` (${skippedCount} already processed)` : "";
  await logActivity(requestId, ActivityType.INFO, `Mapped ${mappedCount}/${download.tvEpisodes.length} episodes to files${skippedMsg}`);

  // Update download status
  await prisma.download.update({
    where: { id: downloadId },
    data: { status: DownloadStatus.PROCESSED },
  });

  await updateOverallProgress(requestId);
}

// =============================================================================
// TV Encode Handler
// =============================================================================

/**
 * Handle encoding a single TV episode
 */
async function handleTvEncode(payload: TvEncodePayload, jobId: string): Promise<void> {
  const { requestId, episodeId } = payload;
  const jobQueue = getJobQueueService();

  if (jobQueue.isCancelled(jobId)) {
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: { status: TvEpisodeStatus.FAILED, error: "Cancelled during encoding" },
    });
    await updateOverallProgress(requestId);
    return;
  }

  const episode = await prisma.tvEpisode.findUnique({
    where: { id: episodeId },
    include: { request: true },
  });

  if (!episode || !episode.sourceFilePath) {
    throw new Error(`Episode not found or no source file: ${episodeId}`);
  }

  const request = episode.request;
  const epLabel = formatEpisode(episode.season, episode.episode);

  // Check if the request was cancelled (status set to FAILED with cancelled error)
  if (request.status === RequestStatus.FAILED) {
    console.log(`[TvPipeline] Skipping ${epLabel} encoding - request was cancelled`);
    return;
  }

  // Skip if episode is already encoded or completed (prevents duplicate encode runs)
  if (
    episode.status === TvEpisodeStatus.ENCODED ||
    episode.status === TvEpisodeStatus.DELIVERING ||
    episode.status === TvEpisodeStatus.COMPLETED
  ) {
    console.log(`[TvPipeline] Skipping ${epLabel} encoding - already ${episode.status}`);
    return;
  }

  await prisma.tvEpisode.update({
    where: { id: episodeId },
    data: { status: TvEpisodeStatus.ENCODING, progress: 0 },
  });

  await logActivity(requestId, ActivityType.INFO, `Encoding ${epLabel}`);

  const encoding = getEncodingService();
  const targets = getRequestTargets(request);
  const serverIds = targets.map((t) => t.serverId);

  const servers = await prisma.storageServer.findMany({
    where: { id: { in: serverIds } },
  });
  const serverMap = new Map(servers.map((s) => [s.id, s]));

  // Get profiles
  const profileIds = targets
    .filter((t) => t.encodingProfileId)
    .map((t) => t.encodingProfileId!);

  const profiles = await prisma.encodingProfile.findMany({
    where: { id: { in: profileIds } },
  });
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  const defaultProfile = await encoding.getDefaultProfile();

  // Group targets by profile
  const profileGroups = new Map<string, {
    profile: EncodingProfile;
    targets: Array<{ target: RequestTarget; server: StorageServer }>;
  }>();

  for (const target of targets) {
    const server = serverMap.get(target.serverId);
    if (!server) continue;

    let profile: EncodingProfile | null = null;
    if (target.encodingProfileId) {
      profile = profileMap.get(target.encodingProfileId) || null;
    }
    if (!profile && server.encodingProfileId) {
      profile = profileMap.get(server.encodingProfileId) || null;
    }
    if (!profile) {
      profile = defaultProfile;
    }
    if (!profile) continue;

    const key = profile.id;
    if (!profileGroups.has(key)) {
      profileGroups.set(key, { profile, targets: [] });
    }
    profileGroups.get(key)!.targets.push({ target, server });
  }

  // Check if we have any encoding profiles to use
  if (profileGroups.size === 0) {
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.FAILED,
        error: "No encoding profile configured",
      },
    });
    await logActivity(requestId, ActivityType.ERROR, `${epLabel}: No encoding profile configured - please set up an encoding profile`);
    await updateOverallProgress(requestId);
    return;
  }

  // Encode for each profile
  let encodedSuccessfully = false;

  for (const [profileId, { profile, targets: profileTargets }] of profileGroups) {
    if (jobQueue.isCancelled(jobId)) {
      return;
    }

    const outputPath = encoding.generateOutputPath(episode.sourceFilePath, profile);

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { currentStep: `Encoding ${epLabel}: ${profile.name}` },
    });

    // Require remote encoding
    const encoderDispatch = getEncoderDispatchService();
    let result: { success: boolean; outputPath: string; outputSize: number; compressionRatio: number; error?: string };

    if (!encoderDispatch.hasEncoders()) {
      await logActivity(requestId, ActivityType.ERROR, `${epLabel}: No remote encoders available`);
      continue; // Skip to next episode/profile
    }

    await logActivity(requestId, ActivityType.INFO, `${epLabel}: Using remote encoder for ${profile.name}`);

    try {
      // Use the actual job ID for the encoder assignment (foreign key to Job table)
      const { waitForCompletion } = await encoderDispatch.queueEncodingJob(
        jobId,
        episode.sourceFilePath,
        outputPath,
        profileId
      );

      // Set up a progress polling interval since remote progress comes via WebSocket
      const progressPollInterval = setInterval(async () => {
        if (jobQueue.isCancelled(jobId)) {
          clearInterval(progressPollInterval);
          await encoderDispatch.cancelJob(jobId, "Pipeline cancelled");
          return;
        }

        // Get latest progress from database
        const assignment = await prisma.encoderAssignment.findUnique({
          where: { jobId: jobId },
        });

        if (assignment && assignment.status === "ENCODING") {
          // Update episode progress directly
          await prisma.tvEpisode.update({
            where: { id: episodeId },
            data: { progress: assignment.progress },
          });

          // Also update request currentStep
          await prisma.mediaRequest.update({
            where: { id: requestId },
            data: {
              currentStep: `${epLabel} ${profile.name}: ${assignment.progress.toFixed(1)}%`,
            },
          });
        }
      }, 2000);

      // Wait for remote encoding to complete
      const completedAssignment = await waitForCompletion();
      clearInterval(progressPollInterval);

      result = {
        success: true,
        outputPath: completedAssignment.outputPath,
        outputSize: Number(completedAssignment.outputSize || 0),
        compressionRatio: completedAssignment.compressionRatio || 1,
      };
    } catch (error) {
      result = {
        success: false,
        outputPath,
        outputSize: 0,
        compressionRatio: 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!result.success) {
      await logActivity(requestId, ActivityType.ERROR, `${epLabel} encoding failed: ${result.error}`);
      continue;
    }

    encodedSuccessfully = true;
    await logActivity(requestId, ActivityType.SUCCESS, `${epLabel} encoded with ${profile.name}`);

    // Clean up audio/subtitle tracks after encoding
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { currentStep: `${epLabel}: Cleaning up tracks...` },
    });

    const remuxResult = await encoding.remuxTracks(result.outputPath);
    if (remuxResult.success) {
      if (remuxResult.audioTracksRemoved > 0 || remuxResult.subtitleTracksRemoved > 0) {
        await logActivity(requestId, ActivityType.INFO,
          `${epLabel} track cleanup: removed ${remuxResult.audioTracksRemoved} audio, ${remuxResult.subtitleTracksRemoved} subtitle tracks`
        );
      }
    } else {
      await logActivity(requestId, ActivityType.WARNING, `${epLabel} track cleanup failed: ${remuxResult.error}`);
    }

    // Queue delivery
    const targetServerIds = profileTargets.map((t) => t.server.id);
    const codec = encoding.getCodecForEncoder(profile.videoEncoder).toUpperCase();

    await jobQueue.addJob("tv:deliver" as JobType, {
      requestId,
      episodeId,
      encodedFilePath: remuxResult.outputPath, // Use remuxed path (same as input if unchanged)
      profileId: profile.id,
      resolution: encoding.resolutionToString(profile.videoMaxResolution),
      codec,
      targetServerIds,
    } as TvDeliverPayload, { priority: 5, maxAttempts: 3 });
  }

  if (encodedSuccessfully) {
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.ENCODED,
        progress: 100,
        encodedAt: new Date(),
      },
    });
  } else {
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.FAILED,
        error: "All encoding attempts failed",
      },
    });
  }

  await updateOverallProgress(requestId);
}

// =============================================================================
// TV Deliver Handler
// =============================================================================

/**
 * Handle delivering a TV episode to storage servers
 */
async function handleTvDeliver(payload: TvDeliverPayload, jobId: string): Promise<void> {
  const { requestId, episodeId, encodedFilePath, resolution, codec, targetServerIds } = payload;
  const jobQueue = getJobQueueService();

  if (jobQueue.isCancelled(jobId)) {
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: { status: TvEpisodeStatus.FAILED, error: "Cancelled during delivery" },
    });
    await updateOverallProgress(requestId);
    return;
  }

  const episode = await prisma.tvEpisode.findUnique({
    where: { id: episodeId },
    include: { request: true },
  });

  if (!episode) {
    throw new Error(`Episode not found: ${episodeId}`);
  }

  const request = episode.request;
  const epLabel = formatEpisode(episode.season, episode.episode);

  // Check if the request was cancelled
  if (request.status === RequestStatus.FAILED) {
    console.log(`[TvPipeline] Skipping ${epLabel} delivery - request was cancelled`);
    return;
  }

  await prisma.tvEpisode.update({
    where: { id: episodeId },
    data: { status: TvEpisodeStatus.DELIVERING },
  });

  const servers = await prisma.storageServer.findMany({
    where: { id: { in: targetServerIds } },
  });

  const naming = getNamingService();
  const delivery = getDeliveryService();
  const container = encodedFilePath.split(".").pop() || "mkv";

  let successCount = 0;

  for (const server of servers) {
    if (jobQueue.isCancelled(jobId)) {
      return;
    }

    const remotePath = naming.getTvDestinationPath(server.pathTv, {
      series: request.title,
      year: request.year,
      season: episode.season,
      episode: episode.episode,
      episodeTitle: episode.title || `Episode ${episode.episode}`,
      quality: resolution,
      codec,
      container,
    });

    await logActivity(requestId, ActivityType.INFO, `Delivering ${epLabel} to ${server.name}`);

    const result = await delivery.deliver(server.id, encodedFilePath, remotePath, {
      onProgress: async (progress) => {
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            currentStep: `${epLabel} → ${server.name}: ${progress.progress.toFixed(1)}%`,
          },
        });
      },
      checkCancelled: () => jobQueue.isCancelled(jobId),
    });

    if (result.success) {
      successCount++;
      await logActivity(requestId, ActivityType.SUCCESS, `${epLabel} delivered to ${server.name}`);
    } else {
      await logActivity(requestId, ActivityType.ERROR, `${epLabel} delivery to ${server.name} failed: ${result.error}`);
    }
  }

  // Update episode status
  if (successCount > 0) {
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.COMPLETED,
        deliveredAt: new Date(),
      },
    });
    await logActivity(requestId, ActivityType.SUCCESS, `${epLabel} completed`);
  } else {
    // Keep status as ENCODED so retry knows to skip encoding and just retry delivery
    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.ENCODED,
        error: "Delivery failed to all servers",
      },
    });
  }

  await updateOverallProgress(requestId);
}

// =============================================================================
// New Episode Checker
// =============================================================================

/**
 * Check for new episodes on all monitored TV shows
 */
async function handleCheckNewEpisodes(): Promise<void> {
  const monitoredRequests = await prisma.mediaRequest.findMany({
    where: {
      type: MediaType.TV,
      monitoring: true,
      status: { notIn: [RequestStatus.FAILED] },
    },
  });

  if (monitoredRequests.length === 0) {
    console.log("[TvPipeline] No monitored TV shows to check");
    return;
  }

  console.log(`[TvPipeline] Checking ${monitoredRequests.length} monitored TV shows for new episodes`);

  const now = new Date();
  const jobQueue = getJobQueueService();

  for (const request of monitoredRequests) {
    await prisma.mediaRequest.update({
      where: { id: request.id },
      data: { lastCheckedAt: now },
    });

    try {
      await initializeTvEpisodes(request.id);

      // Check for pending episodes
      const pendingEpisodes = await prisma.tvEpisode.findMany({
        where: {
          requestId: request.id,
          status: TvEpisodeStatus.PENDING,
        },
      });

      // Also check awaiting episodes whose air date has passed
      const nowAiredEpisodes = await prisma.tvEpisode.findMany({
        where: {
          requestId: request.id,
          status: TvEpisodeStatus.AWAITING,
          airDate: { lte: now },
        },
      });

      if (nowAiredEpisodes.length > 0) {
        await prisma.tvEpisode.updateMany({
          where: {
            id: { in: nowAiredEpisodes.map((e) => e.id) },
          },
          data: { status: TvEpisodeStatus.PENDING },
        });

        await logActivity(request.id, ActivityType.INFO, `${nowAiredEpisodes.length} episodes now available`);
      }

      const totalPending = pendingEpisodes.length + nowAiredEpisodes.length;
      if (totalPending > 0) {
        await jobQueue.addJobIfNotExists(
          "tv:search" as JobType,
          { requestId: request.id },
          `tv:search:${request.id}`,
          { priority: 3, maxAttempts: 3 }
        );

        console.log(`[TvPipeline] Queued search for ${request.title} (${totalPending} pending episodes)`);
      }
    } catch (error) {
      console.error(`[TvPipeline] Error checking ${request.title}:`, error);
    }
  }
}

// =============================================================================
// Download Health Check Handler
// =============================================================================

/**
 * Periodic health check for all active downloads
 */
async function handleDownloadHealthCheck(): Promise<void> {
  console.log("[TvPipeline] Running download health check...");

  const healthResults = await downloadManager.checkDownloadHealth();

  for (const health of healthResults) {
    if (health.recommendation === "retry") {
      console.log(`[TvPipeline] Download ${health.id} stalled, attempting retry`);
      await downloadManager.handleStalledDownload(health.id, health.isStalled ? "stalled" : "no_seeds");
    } else if (health.recommendation === "fail") {
      console.log(`[TvPipeline] Download ${health.id} failed after all retries`);
      await downloadManager.handleStalledDownload(health.id, "max_retries_exceeded");
    }
  }

  console.log(`[TvPipeline] Health check complete: ${healthResults.length} downloads checked`);
}

// =============================================================================
// Registration
// =============================================================================

/**
 * Register TV pipeline handlers with the job queue
 */
export function registerTvPipelineHandlers(): void {
  const jobQueue = getJobQueueService();

  jobQueue.registerHandler("tv:search" as JobType, async (payload, jobId) => {
    await handleTvSearch(payload as TvSearchPayload, jobId);
  });

  jobQueue.registerHandler("tv:download" as JobType, async (payload, jobId) => {
    await handleTvDownload(payload as TvDownloadPayload, jobId);
  });

  jobQueue.registerHandler("tv:map-files" as JobType, async (payload, jobId) => {
    await handleTvMapFiles(payload as TvMapFilesPayload, jobId);
  });

  jobQueue.registerHandler("tv:encode" as JobType, async (payload, jobId) => {
    await handleTvEncode(payload as TvEncodePayload, jobId);
  });

  jobQueue.registerHandler("tv:deliver" as JobType, async (payload, jobId) => {
    await handleTvDeliver(payload as TvDeliverPayload, jobId);
  });

  jobQueue.registerHandler("tv:check-new-episodes" as JobType, async () => {
    await handleCheckNewEpisodes();
  });

  jobQueue.registerHandler("system:download-health-check" as JobType, async () => {
    await handleDownloadHealthCheck();
  });

  console.log("[TvPipeline] Registered TV pipeline handlers");
}

/**
 * Start the TV pipeline for a request
 */
export async function startTvPipeline(requestId: string): Promise<void> {
  const jobQueue = getJobQueueService();

  // Enable monitoring by default for TV shows
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: { monitoring: true },
  });

  await jobQueue.addJob("tv:search" as JobType, {
    requestId,
  } as TvSearchPayload, { priority: 10, maxAttempts: 3 });

  console.log(`[TvPipeline] Started TV pipeline for request ${requestId}`);
}

/**
 * Reprocess a completed TV episode
 *
 * This re-encodes and re-delivers an episode that has already been processed.
 * Useful when encoding settings have changed or if there was an issue with the original encode.
 *
 * Flow:
 * 1. Check for RAR archives and extract if needed
 * 2. Find valid source file (excluding samples)
 * 3. If found: queue encode job directly
 * 4. If not: reset episode to search for new download
 */
export async function reprocessTvEpisode(episodeId: string): Promise<{ step: string; sourceExists: boolean }> {
  const jobQueue = getJobQueueService();
  const { existsSync, readdirSync, statSync } = await import("fs");
  const { join } = await import("path");

  const episode = await prisma.tvEpisode.findUnique({
    where: { id: episodeId },
    include: {
      request: true,
      download: true,
    },
  });

  if (!episode) {
    throw new Error(`Episode not found: ${episodeId}`);
  }

  const requestId = episode.requestId;
  const epLabel = `S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")}`;

  const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
  const minSizeBytes = 100 * 1024 * 1024; // 100MB minimum for real content

  let sourceFilePath: string | null = null;
  let sourceExists = false;

  // First, check if we have a download with content
  if (episode.download) {
    const qb = getDownloadService();
    const progress = await qb.getProgress(episode.download.torrentHash);
    const contentPath = progress?.contentPath || progress?.savePath || episode.download.savePath || "";

    if (contentPath && existsSync(contentPath)) {
      // Check for RAR archives and extract if needed
      const archiveInfo = detectRarArchive(contentPath);

      if (archiveInfo.hasArchive && archiveInfo.archivePath) {
        await logActivity(requestId, ActivityType.INFO, `${epLabel}: Extracting RAR archive...`);

        const extractResult = await extractRar(archiveInfo.archivePath, contentPath, {
          onProgress: (msg) => console.log(`[TvPipeline] Reprocess extract: ${msg.trim()}`),
        });

        if (!extractResult.success) {
          await logActivity(requestId, ActivityType.WARNING, `${epLabel}: RAR extraction failed: ${extractResult.error}`);
        } else {
          await logActivity(requestId, ActivityType.SUCCESS, `${epLabel}: Extracted ${extractResult.extractedFiles.length} files`);
        }
      }

      // Now scan for valid video files (excluding samples)
      const scanForVideoFile = (dir: string): string | null => {
        try {
          const files = readdirSync(dir, { withFileTypes: true });
          let bestFile: { path: string; size: number } | null = null;

          for (const file of files) {
            const filePath = join(dir, file.name);

            if (file.isDirectory()) {
              // Skip Sample directories
              if (file.name.toLowerCase() === "sample") continue;
              // Recurse into subdirectories
              const found = scanForVideoFile(filePath);
              if (found) {
                try {
                  const stat = statSync(found);
                  if (!bestFile || stat.size > bestFile.size) {
                    bestFile = { path: found, size: stat.size };
                  }
                } catch {
                  // Ignore
                }
              }
            } else if (file.isFile()) {
              const lower = file.name.toLowerCase();
              if (videoExtensions.some((ext) => lower.endsWith(ext))) {
                // Skip sample files
                if (isSampleFile(filePath)) {
                  console.log(`[TvPipeline] Skipping sample file: ${filePath}`);
                  continue;
                }

                try {
                  const stat = statSync(filePath);
                  if (stat.size >= minSizeBytes) {
                    if (!bestFile || stat.size > bestFile.size) {
                      bestFile = { path: filePath, size: stat.size };
                    }
                  } else {
                    console.log(`[TvPipeline] Skipping small file (${stat.size} bytes): ${filePath}`);
                  }
                } catch {
                  // Ignore stat errors
                }
              }
            }
          }

          return bestFile?.path || null;
        } catch {
          return null;
        }
      };

      const foundFile = scanForVideoFile(contentPath);
      if (foundFile) {
        sourceFilePath = foundFile;
        sourceExists = true;
        console.log(`[TvPipeline] Found valid source file: ${sourceFilePath}`);
      }
    }
  }

  // Fallback: check stored sourceFilePath (but verify it's not a sample)
  if (!sourceExists && episode.sourceFilePath && existsSync(episode.sourceFilePath)) {
    if (!isSampleFile(episode.sourceFilePath)) {
      try {
        const stat = statSync(episode.sourceFilePath);
        if (stat.size >= minSizeBytes) {
          sourceFilePath = episode.sourceFilePath;
          sourceExists = true;
        }
      } catch {
        // Ignore
      }
    } else {
      console.log(`[TvPipeline] Stored source is a sample file, ignoring: ${episode.sourceFilePath}`);
    }
  }

  // Note: EncodingJob doesn't track individual episodes, so we don't delete them here.
  // They will be re-created during the encode step.

  if (sourceExists && sourceFilePath) {
    // Source exists - queue encode job directly
    await logActivity(requestId, ActivityType.INFO, `Reprocessing ${epLabel}: source file found (${sourceFilePath}), starting encode`);

    await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.ENCODING,
        error: null,
        sourceFilePath,
      },
    });

    // Update overall request status
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.ENCODING,
        currentStep: `Reprocessing ${epLabel}...`,
        error: null,
      },
    });

    await jobQueue.addJobIfNotExists(
      "tv:encode" as JobType,
      { requestId, episodeId } as TvEncodePayload,
      `tv:encode:${episodeId}`,
      { priority: 5, maxAttempts: 2 }
    );

    return { step: "encoding", sourceExists: true };
  }

  // Source doesn't exist - reset to pending for re-search
  await logActivity(requestId, ActivityType.WARNING, `Reprocessing ${epLabel}: no valid source file found, starting fresh search`);

  await prisma.tvEpisode.update({
    where: { id: episodeId },
    data: {
      status: TvEpisodeStatus.PENDING,
      error: null,
      sourceFilePath: null,
      downloadId: null,
    },
  });

  // Update overall request status
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.SEARCHING,
      currentStep: `Reprocessing ${epLabel}: searching...`,
      error: null,
    },
  });

  // Trigger a search for this episode
  await jobQueue.addJob("tv:search" as JobType, {
    requestId,
  } as TvSearchPayload, { priority: 10, maxAttempts: 3 });

  return { step: "searching", sourceExists: false };
}

/**
 * Reprocess all episodes in a specific season
 */
export async function reprocessTvSeason(requestId: string, seasonNumber: number): Promise<{ episodesReprocessed: number; sourcesFound: number }> {
  const episodes = await prisma.tvEpisode.findMany({
    where: {
      requestId,
      season: seasonNumber,
      status: { in: [TvEpisodeStatus.COMPLETED, TvEpisodeStatus.SKIPPED] },
    },
  });

  if (episodes.length === 0) {
    throw new Error(`No completed/skipped episodes found in season ${seasonNumber}`);
  }

  let sourcesFound = 0;

  for (const episode of episodes) {
    const result = await reprocessTvEpisode(episode.id);
    if (result.sourceExists) {
      sourcesFound++;
    }
  }

  await logActivity(requestId, ActivityType.INFO, `Reprocessing season ${seasonNumber}: ${episodes.length} episodes queued`);

  return {
    episodesReprocessed: episodes.length,
    sourcesFound,
  };
}

/**
 * Reprocess all episodes in a TV request
 */
export async function reprocessTvRequest(requestId: string): Promise<{ episodesReprocessed: number; sourcesFound: number }> {
  const episodes = await prisma.tvEpisode.findMany({
    where: {
      requestId,
      status: { in: [TvEpisodeStatus.COMPLETED, TvEpisodeStatus.SKIPPED] },
    },
  });

  if (episodes.length === 0) {
    throw new Error("No completed/skipped episodes found to reprocess");
  }

  let sourcesFound = 0;

  for (const episode of episodes) {
    const result = await reprocessTvEpisode(episode.id);
    if (result.sourceExists) {
      sourcesFound++;
    }
  }

  await logActivity(requestId, ActivityType.INFO, `Reprocessing all episodes: ${episodes.length} episodes queued`);

  return {
    episodesReprocessed: episodes.length,
    sourcesFound,
  };
}
