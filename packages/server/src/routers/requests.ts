import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { MediaType, RequestStatus, Prisma, TvEpisodeStatus } from "@prisma/client";
import { startLegacyMoviePipeline, cancelLegacyMoviePipeline, retryLegacyMoviePipeline, reprocessLegacyMoviePipeline } from "../services/legacyMoviePipeline.js";
import { initializeLegacyTvEpisodes, reprocessLegacyTvEpisode, reprocessLegacyTvSeason, reprocessLegacyTvRequest } from "../services/legacyTvPipeline.js";
import { getDownloadService } from "../services/download.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Target server with optional encoding profile override.
 * If encodingProfileId is not specified, uses the server's default profile.
 */
export interface RequestTarget {
  serverId: string;
  encodingProfileId?: string;
}

// =============================================================================
// Schemas
// =============================================================================

const episodeRequestSchema = z.object({
  season: z.number(),
  episode: z.number(),
});

/**
 * Target schema for per-server profile selection.
 * Each target specifies a server and optionally an encoding profile.
 * If no profile is specified, the server's default profile is used.
 */
const targetSchema = z.object({
  serverId: z.string(),
  encodingProfileId: z.string().optional(),
});

/**
 * Release schema for manually selected releases.
 * Matches the Release interface from indexer service.
 */
const releaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  indexerId: z.string(),
  indexerName: z.string(),
  resolution: z.string(),
  source: z.string(),
  codec: z.string(),
  size: z.number(),
  seeders: z.number(),
  leechers: z.number(),
  magnetUri: z.string().optional(),
  downloadUrl: z.string().optional(),
  infoUrl: z.string().optional(),
  publishDate: z.coerce.date(),
  score: z.number(),
  categories: z.array(z.number()),
});

// =============================================================================
// Helpers
// =============================================================================

function toRequestStatus(value: string): RequestStatus {
  const map: Record<string, RequestStatus> = {
    pending: RequestStatus.PENDING,
    searching: RequestStatus.SEARCHING,
    awaiting: RequestStatus.AWAITING,
    quality_unavailable: RequestStatus.QUALITY_UNAVAILABLE,
    downloading: RequestStatus.DOWNLOADING,
    encoding: RequestStatus.ENCODING,
    delivering: RequestStatus.DELIVERING,
    completed: RequestStatus.COMPLETED,
    failed: RequestStatus.FAILED,
  };
  return map[value] ?? RequestStatus.PENDING;
}

function fromMediaType(value: MediaType): string {
  return value.toLowerCase();
}

function fromRequestStatus(value: RequestStatus): string {
  return value.toLowerCase();
}

/**
 * Resolve encoding profile for each target.
 * If target has no profile specified, use server's default profile.
 * If server has no default profile, use system default profile.
 */
async function resolveTargetProfiles(targets: RequestTarget[]): Promise<RequestTarget[]> {
  const resolvedTargets: RequestTarget[] = [];

  // Get all servers in one query
  const serverIds = targets.map((t) => t.serverId);
  const servers = await prisma.storageServer.findMany({
    where: { id: { in: serverIds } },
    select: { id: true, encodingProfileId: true },
  });

  const serverMap = new Map(servers.map((s) => [s.id, s]));

  // Get system default profile
  const defaultProfile = await prisma.encodingProfile.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });

  for (const target of targets) {
    const server = serverMap.get(target.serverId);
    if (!server) {
      throw new Error(`Server not found: ${target.serverId}`);
    }

    // Priority: target profile > server profile > system default
    const profileId =
      target.encodingProfileId || server.encodingProfileId || defaultProfile?.id;

    resolvedTargets.push({
      serverId: target.serverId,
      encodingProfileId: profileId,
    });
  }

  return resolvedTargets;
}

// =============================================================================
// Router
// =============================================================================

export const requestsRouter = router({
  /**
   * Create a new movie request
   */
  createMovie: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        title: z.string(),
        year: z.number(),
        posterPath: z.string().nullable().optional(),
        targets: z.array(targetSchema).min(1),
        selectedRelease: releaseSchema.optional(),
        pipelineTemplateId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Resolve profiles for each target
      const resolvedTargets = await resolveTargetProfiles(input.targets);

      const request = await prisma.mediaRequest.create({
        data: {
          type: MediaType.MOVIE,
          tmdbId: input.tmdbId,
          title: input.title,
          year: input.year,
          posterPath: input.posterPath ?? null,
          targets: resolvedTargets as unknown as Prisma.JsonArray,
          status: RequestStatus.PENDING,
          progress: 0,
          // Store manually selected release if provided
          selectedRelease: input.selectedRelease
            ? (input.selectedRelease as unknown as Prisma.JsonObject)
            : undefined,
        },
      });

      // TODO: Use new pipeline executor if pipelineTemplateId is provided
      // For now, always use legacy pipeline
      await startLegacyMoviePipeline(request.id);

      return { id: request.id };
    }),

  /**
   * Create a new TV show request
   */
  createTv: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        title: z.string(),
        year: z.number(),
        posterPath: z.string().nullable().optional(),
        targets: z.array(targetSchema).min(1),
        seasons: z.array(z.number()).optional(),
        episodes: z.array(episodeRequestSchema).optional(),
        selectedRelease: releaseSchema.optional(),
        pipelineTemplateId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Resolve profiles for each target
      const resolvedTargets = await resolveTargetProfiles(input.targets);

      const request = await prisma.mediaRequest.create({
        data: {
          type: MediaType.TV,
          tmdbId: input.tmdbId,
          title: input.title,
          year: input.year,
          posterPath: input.posterPath ?? null,
          requestedSeasons: input.seasons ?? [],
          requestedEpisodes: input.episodes ?? Prisma.JsonNull,
          targets: resolvedTargets as unknown as Prisma.JsonArray,
          status: RequestStatus.PENDING,
          progress: 0,
          // Store manually selected release if provided
          selectedRelease: input.selectedRelease
            ? (input.selectedRelease as unknown as Prisma.JsonObject)
            : undefined,
        },
      });

      // TODO: Use new pipeline executor if pipelineTemplateId is provided
      // For now, always use legacy pipeline
      await startLegacyMoviePipeline(request.id);

      return { id: request.id };
    }),

  /**
   * List all requests
   */
  list: publicProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        status: z
          .enum(["pending", "searching", "awaiting", "quality_unavailable", "downloading", "encoding", "delivering", "completed", "failed"])
          .optional(),
      })
    )
    .query(async ({ input }) => {
      const results = await prisma.mediaRequest.findMany({
        where: input.status ? { status: toRequestStatus(input.status) } : undefined,
        orderBy: { createdAt: "desc" },
        take: input.limit,
        select: {
          id: true,
          type: true,
          tmdbId: true,
          title: true,
          year: true,
          posterPath: true,
          targets: true,
          requestedSeasons: true,
          requestedEpisodes: true,
          status: true,
          progress: true,
          currentStep: true,
          error: true,
          requiredResolution: true,
          availableReleases: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
        },
      });

      // Get server and profile names for display
      const serverIds = new Set<string>();
      const profileIds = new Set<string>();

      for (const r of results) {
        const targets = r.targets as unknown as RequestTarget[];
        for (const target of targets) {
          serverIds.add(target.serverId);
          if (target.encodingProfileId) {
            profileIds.add(target.encodingProfileId);
          }
        }
      }

      // For requests without posterPath, look up from MediaItem (legacy support)
      const requestsWithoutPoster = results.filter((r) => !r.posterPath);
      const mediaItemIds = requestsWithoutPoster.map(
        (r) => `tmdb-${r.type === MediaType.MOVIE ? "movie" : "tv"}-${r.tmdbId}`
      );

      const [servers, profiles, mediaItems] = await Promise.all([
        prisma.storageServer.findMany({
          where: { id: { in: Array.from(serverIds) } },
          select: { id: true, name: true },
        }),
        prisma.encodingProfile.findMany({
          where: { id: { in: Array.from(profileIds) } },
          select: { id: true, name: true },
        }),
        mediaItemIds.length > 0
          ? prisma.mediaItem.findMany({
              where: { id: { in: mediaItemIds } },
              select: { id: true, posterPath: true },
            })
          : [],
      ]);

      const serverMap = new Map(servers.map((s) => [s.id, s.name]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      const posterMap = new Map(mediaItems.map((m) => [m.id, m.posterPath]));

      return results.map((r) => {
        const targets = r.targets as unknown as RequestTarget[];
        const availableReleases = r.availableReleases as unknown[] | null;
        // Use stored posterPath, or fall back to MediaItem lookup for legacy requests
        const mediaItemId = `tmdb-${r.type === MediaType.MOVIE ? "movie" : "tv"}-${r.tmdbId}`;
        const posterPath = r.posterPath ?? posterMap.get(mediaItemId) ?? null;
        return {
          id: r.id,
          type: fromMediaType(r.type),
          tmdbId: r.tmdbId,
          title: r.title,
          year: r.year,
          posterPath,
          targets: targets.map((t) => ({
            serverId: t.serverId,
            serverName: serverMap.get(t.serverId) || "Unknown",
            encodingProfileId: t.encodingProfileId,
            encodingProfileName: t.encodingProfileId
              ? profileMap.get(t.encodingProfileId) || "Unknown"
              : "Default",
          })),
          requestedSeasons: r.requestedSeasons,
          requestedEpisodes: r.requestedEpisodes as { season: number; episode: number }[] | null,
          status: fromRequestStatus(r.status),
          progress: r.progress,
          currentStep: r.currentStep,
          error: r.error,
          requiredResolution: r.requiredResolution,
          hasAlternatives: r.status === RequestStatus.QUALITY_UNAVAILABLE &&
            Array.isArray(availableReleases) &&
            availableReleases.length > 0,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          completedAt: r.completedAt,
        };
      });
    }),

  /**
   * Get a single request by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const r = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
    });

    if (!r) {
      return null;
    }

    const targets = r.targets as unknown as RequestTarget[];

    // Get server and profile names
    const serverIds = targets.map((t) => t.serverId);
    const profileIds = targets
      .filter((t) => t.encodingProfileId)
      .map((t) => t.encodingProfileId!);

    const [servers, profiles] = await Promise.all([
      prisma.storageServer.findMany({
        where: { id: { in: serverIds } },
        select: { id: true, name: true },
      }),
      prisma.encodingProfile.findMany({
        where: { id: { in: profileIds } },
        select: { id: true, name: true },
      }),
    ]);

    const serverMap = new Map(servers.map((s) => [s.id, s.name]));
    const profileMap = new Map(profiles.map((p) => [p.id, p.name]));

    return {
      id: r.id,
      type: fromMediaType(r.type),
      tmdbId: r.tmdbId,
      title: r.title,
      year: r.year,
      targets: targets.map((t) => ({
        serverId: t.serverId,
        serverName: serverMap.get(t.serverId) || "Unknown",
        encodingProfileId: t.encodingProfileId,
        encodingProfileName: t.encodingProfileId
          ? profileMap.get(t.encodingProfileId) || "Unknown"
          : "Default",
      })),
      requestedSeasons: r.requestedSeasons,
      requestedEpisodes: r.requestedEpisodes as { season: number; episode: number }[] | null,
      status: fromRequestStatus(r.status),
      progress: r.progress,
      currentStep: r.currentStep,
      error: r.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      completedAt: r.completedAt,
    };
  }),

  /**
   * Cancel a request
   */
  cancel: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Cancel any running pipeline jobs
    await cancelLegacyMoviePipeline(input.id);

    return { success: true };
  }),

  /**
   * Delete a request and cancel any running jobs
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const request = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
      include: { tvEpisodes: true },
    });

    if (!request) {
      return { success: false, error: "Request not found" };
    }

    // Cancel any running pipeline jobs first
    await cancelLegacyMoviePipeline(input.id);

    // TODO: Cancel torrent downloads and delete downloaded media from qBittorrent
    // - Get all torrent hashes from downloads (for TV) or the request itself (for movies)
    // - For each torrent hash, call downloadService.deleteTorrent(hash, deleteFiles: true)
    // - This should remove the torrent from qBittorrent and delete the downloaded files

    // Delete TV episodes first (foreign key constraint)
    await prisma.tvEpisode.deleteMany({
      where: { requestId: input.id },
    });

    // Delete downloads
    await prisma.download.deleteMany({
      where: { requestId: input.id },
    });

    // Delete activity logs
    await prisma.activityLog.deleteMany({
      where: { requestId: input.id },
    });

    // Delete the request
    await prisma.mediaRequest.delete({
      where: { id: input.id },
    });

    return { success: true };
  }),

  /**
   * Retry a failed request, resuming from the appropriate step
   */
  retry: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Use smart retry that resumes from where we left off
    const result = await retryLegacyMoviePipeline(input.id);

    return { success: true, step: result.step };
  }),

  /**
   * Reprocess a completed movie request (re-encode and re-deliver)
   */
  reprocess: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const request = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
    });

    if (!request) {
      return { success: false, error: "Request not found" };
    }

    if (request.type === MediaType.TV) {
      // For TV shows, reprocess all delivered episodes
      const result = await reprocessLegacyTvRequest(input.id);
      return {
        success: true,
        step: "encoding",
        episodesReprocessed: result.episodesReprocessed,
        sourcesFound: result.sourcesFound,
      };
    }

    // For movies
    const result = await reprocessLegacyMoviePipeline(input.id);
    return {
      success: true,
      step: result.step,
      sourceExists: result.sourceExists,
    };
  }),

  /**
   * Reprocess a single TV episode (re-encode and re-deliver)
   */
  reprocessEpisode: publicProcedure
    .input(z.object({ episodeId: z.string() }))
    .mutation(async ({ input }) => {
      const result = await reprocessLegacyTvEpisode(input.episodeId);
      return {
        success: true,
        step: result.step,
        sourceExists: result.sourceExists,
      };
    }),

  /**
   * Reprocess all episodes in a specific season
   */
  reprocessSeason: publicProcedure
    .input(z.object({ requestId: z.string(), seasonNumber: z.number() }))
    .mutation(async ({ input }) => {
      const result = await reprocessLegacyTvSeason(input.requestId, input.seasonNumber);
      return {
        success: true,
        episodesReprocessed: result.episodesReprocessed,
        sourcesFound: result.sourcesFound,
      };
    }),

  /**
   * Get episode statuses for a TV request
   * Also checks library availability on target servers
   * Initializes episode statuses on-demand if they don't exist yet
   */
  getEpisodeStatuses: publicProcedure
    .input(z.object({ requestId: z.string() }))
    .query(async ({ input }) => {
      // First, get the request to know the target servers and TMDB ID
      const request = await prisma.mediaRequest.findUnique({
        where: { id: input.requestId },
        select: {
          tmdbId: true,
          targets: true,
          type: true,
        },
      });

      if (!request) {
        return [];
      }

      // Only TV requests have episodes
      if (request.type !== MediaType.TV) {
        return [];
      }

      // Check if TV episodes exist, if not, initialize them
      let episodes = await prisma.tvEpisode.findMany({
        where: { requestId: input.requestId },
        orderBy: [{ season: "asc" }, { episode: "asc" }],
      });

      // Initialize TV episodes on-demand if they don't exist
      if (episodes.length === 0) {
        try {
          await initializeLegacyTvEpisodes(input.requestId);
          episodes = await prisma.tvEpisode.findMany({
            where: { requestId: input.requestId },
            orderBy: [{ season: "asc" }, { episode: "asc" }],
          });
        } catch (error) {
          console.error(`[Requests] Failed to initialize TV episodes for ${input.requestId}:`, error);
          return [];
        }
      }

      // Get target server IDs from the request
      const targets = request.targets as unknown as RequestTarget[];
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

      // Get download progress for episodes that are downloading
      const downloadingEpisodes = episodes.filter(
        (ep) => ep.status === TvEpisodeStatus.DOWNLOADING && ep.downloadId
      );

      const downloadService = getDownloadService();
      const progressMap = new Map<string, { progress: number; speed: number }>();

      // First, get the Download records for these episodes
      const downloadIds = downloadingEpisodes
        .map((ep) => ep.downloadId)
        .filter((id): id is string => id !== null);

      const downloads = await prisma.download.findMany({
        where: { id: { in: downloadIds } },
      });

      const downloadMap = new Map(downloads.map((d) => [d.id, d]));

      // Fetch all torrents once instead of individual calls per episode
      // This reduces API overhead when qBittorrent is under load
      if (downloadingEpisodes.length > 0) {
        try {
          const allTorrents = await downloadService.getAllTorrents();
          const torrentMap = new Map(allTorrents.map((t) => [t.hash.toLowerCase(), t]));

          for (const ep of downloadingEpisodes) {
            if (!ep.downloadId) continue;
            const download = downloadMap.get(ep.downloadId);
            if (!download) continue;

            const progress = torrentMap.get(download.torrentHash.toLowerCase());
            if (progress) {
              const key = `${ep.season}-${ep.episode}`;
              progressMap.set(key, {
                progress: progress.progress,
                speed: progress.downloadSpeed,
              });
            }
          }
        } catch {
          // Ignore errors - progress will just be unavailable
        }
      }

      // Group by season
      const seasons: Record<number, {
        seasonNumber: number;
        episodes: {
          id: string;
          episodeNumber: number;
          status: string;
          error: string | null;
          airDate: Date | null;
          downloadedAt: Date | null;
          deliveredAt: Date | null;
          progress: number | null;
          speed: number | null;
          releaseName: string | null;
        }[];
      }> = {};

      for (const ep of episodes) {
        if (!seasons[ep.season]) {
          seasons[ep.season] = {
            seasonNumber: ep.season,
            episodes: [],
          };
        }

        // Check if this episode is available on all target servers
        const key = `${ep.season}-${ep.episode}`;
        const availableOnServers = availableMap.get(key);
        const isAvailableOnAllTargets = availableOnServers?.size === serverIds.length;

        // Use "available" status if episode is in library on all target servers
        const status = isAvailableOnAllTargets ? "available" : ep.status.toLowerCase();

        // Get download progress if available
        const downloadProgress = progressMap.get(key);

        // Get release name from Download record
        const download = ep.downloadId ? downloadMap.get(ep.downloadId) : null;

        // Determine progress based on status:
        // - For DOWNLOADING status, use download progress
        // - For ENCODING status, use episode's progress field
        // - For other statuses, no progress
        let progress: number | null = null;
        if (ep.status === TvEpisodeStatus.DOWNLOADING) {
          progress = downloadProgress?.progress ?? null;
        } else if (ep.status === TvEpisodeStatus.ENCODING) {
          progress = ep.progress;
        }

        seasons[ep.season].episodes.push({
          id: ep.id,
          episodeNumber: ep.episode,
          status,
          error: ep.error,
          airDate: ep.airDate,
          downloadedAt: ep.downloadedAt,
          deliveredAt: ep.deliveredAt,
          progress,
          speed: downloadProgress?.speed ?? null,
          releaseName: download?.torrentName ?? null,
        });
      }

      return Object.values(seasons).sort((a, b) => a.seasonNumber - b.seasonNumber);
    }),

  /**
   * Get available servers for request targeting
   */
  getAvailableTargets: publicProcedure.query(async () => {
    const servers = await prisma.storageServer.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        encodingProfileId: true,
        maxResolution: true,
        encodingProfile: {
          select: { id: true, name: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const profiles = await prisma.encodingProfile.findMany({
      select: { id: true, name: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });

    return {
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        defaultProfileId: s.encodingProfileId,
        defaultProfileName: s.encodingProfile?.name || null,
        maxResolution: s.maxResolution,
      })),
      profiles: profiles.map((p) => ({
        id: p.id,
        name: p.name,
        isDefault: p.isDefault,
      })),
    };
  }),

  /**
   * Get alternative releases for a quality-unavailable request
   */
  getAlternatives: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const request = await prisma.mediaRequest.findUnique({
        where: { id: input.id },
        select: {
          status: true,
          requiredResolution: true,
          availableReleases: true,
          title: true,
          year: true,
          type: true,
        },
      });

      if (!request) return null;

      return {
        status: fromRequestStatus(request.status),
        requiredResolution: request.requiredResolution,
        availableReleases: request.availableReleases as unknown[] | null,
        title: request.title,
        year: request.year,
        type: fromMediaType(request.type),
      };
    }),

  /**
   * Accept a lower-quality release for a quality-unavailable request
   */
  acceptLowerQuality: publicProcedure
    .input(z.object({
      id: z.string(),
      releaseIndex: z.number().int().min(0),
    }))
    .mutation(async ({ input }) => {
      const request = await prisma.mediaRequest.findUnique({
        where: { id: input.id },
      });

      if (!request) {
        throw new Error("Request not found");
      }

      if (request.status !== RequestStatus.QUALITY_UNAVAILABLE) {
        throw new Error("Request not in QUALITY_UNAVAILABLE status");
      }

      const releases = request.availableReleases as unknown[] | null;
      if (!releases || !releases[input.releaseIndex]) {
        throw new Error("Invalid release index");
      }

      const selectedRelease = releases[input.releaseIndex] as Record<string, unknown>;

      // Update request with selected release and proceed
      await prisma.mediaRequest.update({
        where: { id: input.id },
        data: {
          status: RequestStatus.PENDING,
          selectedRelease: selectedRelease as Prisma.JsonObject,
          progress: 0,
          currentStep: `Accepted lower quality: ${String(selectedRelease.resolution || "unknown")}`,
          error: null,
        },
      });

      // Re-start pipeline with the selected release
      await startLegacyMoviePipeline(input.id);

      return { success: true };
    }),

  /**
   * Re-search for quality releases for a quality-unavailable request
   */
  refreshQualitySearch: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const request = await prisma.mediaRequest.findUnique({
        where: { id: input.id },
      });

      if (!request) {
        throw new Error("Request not found");
      }

      // Only allow refresh from certain states
      if (request.status !== RequestStatus.QUALITY_UNAVAILABLE &&
          request.status !== RequestStatus.AWAITING) {
        throw new Error("Request cannot be refreshed from current status");
      }

      await prisma.mediaRequest.update({
        where: { id: input.id },
        data: {
          status: RequestStatus.PENDING,
          selectedRelease: Prisma.JsonNull,
          availableReleases: Prisma.JsonNull,
          currentStep: "Re-searching for quality releases...",
          error: null,
        },
      });

      await startLegacyMoviePipeline(input.id);
      return { success: true };
    }),
});
