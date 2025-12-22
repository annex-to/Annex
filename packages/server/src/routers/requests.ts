import { MediaType, Prisma, RequestStatus, TvEpisodeStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getDownloadService } from "../services/download.js";
import { getPipelineExecutor } from "../services/pipeline/PipelineExecutor.js";
import { getTraktService } from "../services/trakt.js";
import { publicProcedure, router } from "../trpc.js";

// =============================================================================
// Types
// =============================================================================

/**
 * Target server for request delivery.
 */
export interface RequestTarget {
  serverId: string;
}

// =============================================================================
// Schemas
// =============================================================================

const episodeRequestSchema = z.object({
  season: z.number(),
  episode: z.number(),
});

/**
 * Target schema for request delivery.
 */
const targetSchema = z.object({
  serverId: z.string(),
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
 * Get default pipeline template for a media type.
 * Throws error if no default template exists.
 */
async function getDefaultTemplate(mediaType: "MOVIE" | "TV"): Promise<string> {
  const template = await prisma.pipelineTemplate.findFirst({
    where: {
      mediaType: mediaType === "MOVIE" ? MediaType.MOVIE : MediaType.TV,
      isDefault: true,
    },
    select: { id: true },
  });

  if (!template) {
    throw new Error(
      `No default pipeline template found for ${mediaType}. Run: bun run scripts/seed-default-pipelines.ts`
    );
  }

  return template.id;
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
      const request = await prisma.mediaRequest.create({
        data: {
          type: MediaType.MOVIE,
          tmdbId: input.tmdbId,
          title: input.title,
          year: input.year,
          posterPath: input.posterPath ?? null,
          targets: input.targets as unknown as Prisma.JsonArray,
          status: RequestStatus.PENDING,
          progress: 0,
          // Store manually selected release if provided
          selectedRelease: input.selectedRelease
            ? (input.selectedRelease as unknown as Prisma.JsonObject)
            : undefined,
        },
      });

      // Get pipeline template: use provided one or auto-select default
      const templateId = input.pipelineTemplateId || (await getDefaultTemplate("MOVIE"));

      // Validate template exists
      const template = await prisma.pipelineTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error(`Pipeline template ${templateId} not found`);
      }

      // Start pipeline execution
      const executor = getPipelineExecutor();
      executor.startExecution(request.id, templateId).catch(async (error) => {
        console.error(`Pipeline execution failed for request ${request.id}:`, error);
        // Mark request as failed if pipeline fails to start
        await prisma.mediaRequest.update({
          where: { id: request.id },
          data: { status: RequestStatus.FAILED, error: error.message },
        });
      });

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
      const request = await prisma.mediaRequest.create({
        data: {
          type: MediaType.TV,
          tmdbId: input.tmdbId,
          title: input.title,
          year: input.year,
          posterPath: input.posterPath ?? null,
          requestedSeasons: input.seasons ?? [],
          requestedEpisodes: input.episodes ?? Prisma.JsonNull,
          targets: input.targets as unknown as Prisma.JsonArray,
          status: RequestStatus.PENDING,
          progress: 0,
          // Store manually selected release if provided
          selectedRelease: input.selectedRelease
            ? (input.selectedRelease as unknown as Prisma.JsonObject)
            : undefined,
        },
      });

      // Fetch latest episode data from Trakt
      const trakt = getTraktService();

      // Get or create MediaItem
      let mediaItem = await prisma.mediaItem.findFirst({
        where: { tmdbId: input.tmdbId },
      });

      if (!mediaItem) {
        // Create basic MediaItem if it doesn't exist
        mediaItem = await prisma.mediaItem.create({
          data: {
            id: `tmdb-tv-${input.tmdbId}`,
            tmdbId: input.tmdbId,
            type: MediaType.TV,
            title: input.title,
            year: input.year,
            posterPath: input.posterPath ?? undefined,
          },
        });
      }

      // Fetch and update seasons from Trakt
      try {
        const traktSeasons = await trakt.getSeasons(input.tmdbId);

        // Update numberOfSeasons
        const seasonCount = traktSeasons.filter((s) => s.number > 0).length;
        await prisma.mediaItem.update({
          where: { id: mediaItem.id },
          data: { numberOfSeasons: seasonCount },
        });

        // Determine which seasons we need to fetch episodes for
        const seasonsToFetch = new Set<number>();
        if (input.episodes && input.episodes.length > 0) {
          // Fetch only the seasons that contain requested episodes
          for (const ep of input.episodes) {
            seasonsToFetch.add(ep.season);
          }
        } else if (input.seasons && input.seasons.length > 0) {
          // Fetch the requested seasons
          for (const season of input.seasons) {
            seasonsToFetch.add(season);
          }
        } else {
          // No specific seasons/episodes requested - fetch all available seasons (excluding specials)
          for (const season of traktSeasons) {
            if (season.number > 0) {
              // Exclude season 0 (specials)
              seasonsToFetch.add(season.number);
            }
          }
        }

        // Fetch and save episodes for each needed season
        const episodesToCreate: Array<{
          season: number;
          episode: number;
          title?: string;
          airDate?: Date;
        }> = [];

        for (const seasonNumber of seasonsToFetch) {
          const traktSeason = traktSeasons.find((s) => s.number === seasonNumber);
          if (!traktSeason) continue;

          // Upsert season
          const savedSeason = await prisma.season.upsert({
            where: {
              mediaItemId_seasonNumber: {
                mediaItemId: mediaItem.id,
                seasonNumber,
              },
            },
            create: {
              mediaItemId: mediaItem.id,
              seasonNumber,
              name: traktSeason.title || `Season ${seasonNumber}`,
              overview: traktSeason.overview,
              episodeCount: traktSeason.episode_count,
              airDate: traktSeason.first_aired?.split("T")[0] || null,
            },
            update: {
              name: traktSeason.title || `Season ${seasonNumber}`,
              overview: traktSeason.overview,
              episodeCount: traktSeason.episode_count,
              airDate: traktSeason.first_aired?.split("T")[0] || null,
            },
          });

          // Fetch and save episodes
          try {
            const seasonDetails = await trakt.getSeason(input.tmdbId, seasonNumber);
            if (seasonDetails.episodes) {
              for (const ep of seasonDetails.episodes) {
                // Upsert episode
                await prisma.episode.upsert({
                  where: {
                    seasonId_episodeNumber: {
                      seasonId: savedSeason.id,
                      episodeNumber: ep.number,
                    },
                  },
                  create: {
                    seasonId: savedSeason.id,
                    seasonNumber,
                    episodeNumber: ep.number,
                    name: ep.title || `Episode ${ep.number}`,
                    overview: ep.overview,
                    airDate: ep.first_aired?.split("T")[0] || null,
                  },
                  update: {
                    name: ep.title || `Episode ${ep.number}`,
                    overview: ep.overview,
                    airDate: ep.first_aired?.split("T")[0] || null,
                  },
                });

                // Add to list for TvEpisode creation if this episode is requested
                if (input.episodes && input.episodes.length > 0) {
                  // Check if this specific episode was requested
                  if (
                    input.episodes.some((e) => e.season === seasonNumber && e.episode === ep.number)
                  ) {
                    episodesToCreate.push({
                      season: seasonNumber,
                      episode: ep.number,
                      title: ep.title ?? undefined,
                      airDate: ep.first_aired ? new Date(ep.first_aired) : undefined,
                    });
                  }
                } else {
                  // Whole season requested, add all episodes
                  episodesToCreate.push({
                    season: seasonNumber,
                    episode: ep.number,
                    title: ep.title ?? undefined,
                    airDate: ep.first_aired ? new Date(ep.first_aired) : undefined,
                  });
                }
              }
            }
          } catch (error) {
            console.error(`Failed to fetch episodes for season ${seasonNumber}:`, error);
          }
        }

        // Create TvEpisode records
        if (episodesToCreate.length > 0) {
          await prisma.tvEpisode.createMany({
            data: episodesToCreate.map((ep) => ({
              requestId: request.id,
              season: ep.season,
              episode: ep.episode,
              title: ep.title,
              airDate: ep.airDate,
            })),
          });
        }
      } catch (error) {
        console.error("Failed to fetch episode data from Trakt:", error);
        // Continue anyway - the request will be created but may not have complete episode data
      }

      // Get pipeline template: use provided one or auto-select default
      const templateId = input.pipelineTemplateId || (await getDefaultTemplate("TV"));

      // Validate template exists
      const template = await prisma.pipelineTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error(`Pipeline template ${templateId} not found`);
      }

      // Start pipeline execution
      const executor = getPipelineExecutor();
      executor.startExecution(request.id, templateId).catch(async (error) => {
        console.error(`Pipeline execution failed for request ${request.id}:`, error);
        // Mark request as failed if pipeline fails to start
        await prisma.mediaRequest.update({
          where: { id: request.id },
          data: { status: RequestStatus.FAILED, error: error.message },
        });
      });

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
          .enum([
            "pending",
            "searching",
            "awaiting",
            "quality_unavailable",
            "downloading",
            "encoding",
            "delivering",
            "completed",
            "failed",
          ])
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
          tvEpisodes: {
            select: {
              id: true,
              season: true,
              episode: true,
              title: true,
              airDate: true,
              status: true,
              progress: true,
            },
            orderBy: [{ season: "asc" }, { episode: "asc" }],
          },
        },
      });

      // Get server names for display
      const serverIds = new Set<string>();

      for (const r of results) {
        const targets = r.targets as unknown as RequestTarget[];
        for (const target of targets) {
          serverIds.add(target.serverId);
        }
      }

      // For requests without posterPath, look up from MediaItem (legacy support)
      const requestsWithoutPoster = results.filter((r: any) => !r.posterPath);
      const mediaItemIds = requestsWithoutPoster.map(
        (r: any) => `tmdb-${r.type === MediaType.MOVIE ? "movie" : "tv"}-${r.tmdbId}`
      );

      const [servers, mediaItems] = await Promise.all([
        prisma.storageServer.findMany({
          where: { id: { in: Array.from(serverIds) } },
          select: { id: true, name: true },
        }),
        mediaItemIds.length > 0
          ? prisma.mediaItem.findMany({
              where: { id: { in: mediaItemIds } },
              select: { id: true, posterPath: true },
            })
          : [],
      ]);

      const serverMap = new Map(servers.map((s: any) => [s.id, s.name]));
      const posterMap = new Map(mediaItems.map((m: any) => [m.id, m.posterPath]));

      return results.map((r: any) => {
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
          })),
          requestedSeasons: r.requestedSeasons,
          requestedEpisodes: r.requestedEpisodes as { season: number; episode: number }[] | null,
          status: fromRequestStatus(r.status),
          progress: r.progress,
          currentStep: r.currentStep,
          error: r.error,
          requiredResolution: r.requiredResolution,
          hasAlternatives:
            r.status === RequestStatus.QUALITY_UNAVAILABLE &&
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

    // Get server names
    const serverIds = targets.map((t) => t.serverId);

    const servers = await prisma.storageServer.findMany({
      where: { id: { in: serverIds } },
      select: { id: true, name: true },
    });

    const serverMap = new Map(servers.map((s: any) => [s.id, s.name]));

    return {
      id: r.id,
      type: fromMediaType(r.type),
      tmdbId: r.tmdbId,
      title: r.title,
      year: r.year,
      targets: targets.map((t) => ({
        serverId: t.serverId,
        serverName: serverMap.get(t.serverId) || "Unknown",
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
    // Find and cancel the pipeline execution
    const execution = await prisma.pipelineExecution.findUnique({
      where: { requestId: input.id },
    });

    if (execution && execution.status === "RUNNING") {
      const executor = getPipelineExecutor();
      await executor.cancelExecution(execution.id);
    }

    // Update request status
    await prisma.mediaRequest.update({
      where: { id: input.id },
      data: { status: RequestStatus.FAILED, error: "Cancelled by user" },
    });

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

    // Cancel any running pipeline execution first
    const execution = await prisma.pipelineExecution.findUnique({
      where: { requestId: input.id },
    });

    if (execution && execution.status === "RUNNING") {
      const executor = getPipelineExecutor();
      await executor.cancelExecution(execution.id);
    }

    // TODO: Cancel torrent downloads and delete downloaded media from WebTorrent
    // - Get all torrent hashes from downloads (for TV) or the request itself (for movies)
    // - For each torrent hash, call downloadService.deleteTorrent(hash, deleteFiles: true)
    // - This should remove the torrent from WebTorrent and delete the downloaded files

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
   * Retry a failed request by restarting its pipeline
   */
  retry: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const request = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
    });

    if (!request) {
      throw new Error("Request not found");
    }

    // Find the execution to get the template ID
    const execution = await prisma.pipelineExecution.findUnique({
      where: { requestId: input.id },
      select: { templateId: true },
    });

    if (!execution) {
      throw new Error("No pipeline execution found for this request");
    }

    // Reset request status
    await prisma.mediaRequest.update({
      where: { id: input.id },
      data: {
        status: RequestStatus.PENDING,
        progress: 0,
        error: null,
      },
    });

    // Start a new pipeline execution
    const executor = getPipelineExecutor();
    executor.startExecution(request.id, execution.templateId).catch(async (error) => {
      console.error(`Pipeline retry failed for request ${request.id}:`, error);
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: { status: RequestStatus.FAILED, error: error.message },
      });
    });

    return { success: true };
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
      const episodes = await prisma.tvEpisode.findMany({
        where: { requestId: input.requestId },
        orderBy: [{ season: "asc" }, { episode: "asc" }],
      });

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
        availableMap.get(key)?.add(ep.serverId);
      }

      // Get download progress for episodes that are downloading
      const downloadingEpisodes = episodes.filter(
        (ep: any) => ep.status === TvEpisodeStatus.DOWNLOADING && ep.downloadId
      );

      const downloadService = getDownloadService();
      const progressMap = new Map<string, { progress: number; speed: number }>();

      // First, get the Download records for these episodes
      const downloadIds = downloadingEpisodes
        .map((ep: any) => ep.downloadId)
        .filter((id: any): id is string => id !== null);

      const downloads = await prisma.download.findMany({
        where: { id: { in: downloadIds } },
      });

      const downloadMap = new Map(downloads.map((d: any) => [d.id, d]));

      // Fetch all torrents once instead of individual calls per episode
      // This reduces API overhead when WebTorrent is under load
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
      const seasons: Record<
        number,
        {
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
        }
      > = {};

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
        maxResolution: true,
      },
      orderBy: { name: "asc" },
    });

    return {
      servers: servers.map((s: any) => ({
        id: s.id,
        name: s.name,
        maxResolution: s.maxResolution,
      })),
      profiles: [], // No longer used
    };
  }),

  /**
   * Get alternative releases for a quality-unavailable request
   */
  getAlternatives: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
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
    .input(
      z.object({
        id: z.string(),
        releaseIndex: z.number().int().min(0),
      })
    )
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

      // Restart pipeline with the selected release
      const execution = await prisma.pipelineExecution.findUnique({
        where: { requestId: input.id },
        select: { templateId: true },
      });

      if (execution) {
        const executor = getPipelineExecutor();
        executor.startExecution(request.id, execution.templateId).catch(async (error) => {
          console.error(`Pipeline restart failed for request ${request.id}:`, error);
          await prisma.mediaRequest.update({
            where: { id: request.id },
            data: { status: RequestStatus.FAILED, error: error.message },
          });
        });
      }

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
      if (
        request.status !== RequestStatus.QUALITY_UNAVAILABLE &&
        request.status !== RequestStatus.AWAITING
      ) {
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

      const execution = await prisma.pipelineExecution.findUnique({
        where: { requestId: input.id },
        select: { templateId: true },
      });

      if (execution) {
        const executor = getPipelineExecutor();
        executor.startExecution(request.id, execution.templateId).catch(async (error) => {
          console.error(`Pipeline restart failed for request ${request.id}:`, error);
          await prisma.mediaRequest.update({
            where: { id: request.id },
            data: { status: RequestStatus.FAILED, error: error.message },
          });
        });
      }

      return { success: true };
    }),
});
