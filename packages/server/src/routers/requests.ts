import {
  type ExecutionStatus,
  MediaType,
  Prisma,
  ProcessingStatus,
  RequestStatus,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getDownloadService } from "../services/download.js";
import { getEncoderDispatchService } from "../services/encoderDispatch.js";
import type { PipelineContext } from "../services/pipeline/PipelineContext.js";
import type { StepTree } from "../services/pipeline/PipelineExecutor.js";
import { getPipelineExecutor } from "../services/pipeline/PipelineExecutor.js";
import { pipelineOrchestrator } from "../services/pipeline/PipelineOrchestrator.js";
import { requestStatusComputer } from "../services/requestStatusComputer.js";
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

/**
 * Create PipelineExecution record to store template configuration.
 * Workers read this to get encoding settings and other pipeline config.
 * Does NOT execute the old pipeline - workers handle all processing.
 */
async function storePipelineTemplate(
  requestId: string,
  mediaType: "MOVIE" | "TV",
  pipelineTemplateId?: string
): Promise<void> {
  // Get template ID (provided or default)
  const templateId = pipelineTemplateId || (await getDefaultTemplate(mediaType));

  // Fetch the template
  const template = await prisma.pipelineTemplate.findUnique({
    where: { id: templateId },
  });

  if (!template) {
    throw new Error(`Pipeline template ${templateId} not found`);
  }

  // Fetch the request for context
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request ${requestId} not found`);
  }

  // Parse steps tree from template
  const stepsTree = template.steps as unknown as StepTree[];

  // Initialize context from request
  const initialContext: PipelineContext = {
    requestId: request.id,
    mediaType: request.type,
    tmdbId: request.tmdbId,
    title: request.title,
    year: request.year,
    requestedSeasons: request.requestedSeasons,
    requestedEpisodes: request.requestedEpisodes as
      | Array<{ season: number; episode: number }>
      | undefined,
    targets: request.targets as Array<{ serverId: string; encodingProfileId?: string }>,
    processingItemId: request.id,
  };

  // Delete any existing pipeline executions for this request
  await prisma.pipelineExecution.deleteMany({
    where: { requestId },
  });

  // Create pipeline execution record (for workers to read config)
  await prisma.pipelineExecution.create({
    data: {
      requestId,
      templateId,
      status: "RUNNING" as ExecutionStatus,
      currentStep: 0,
      steps: stepsTree as unknown as Prisma.JsonArray,
      context: initialContext as unknown as Prisma.JsonObject,
      startedAt: new Date(),
    },
  });

  console.log(
    `[StorePipelineTemplate] Stored template ${templateId} config for request ${requestId}`
  );
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
      // Create request with ProcessingItems using new pipeline system
      const { requestId, items } = await pipelineOrchestrator.createRequest({
        type: "movie",
        tmdbId: input.tmdbId,
        title: input.title,
        year: input.year,
        targetServers: input.targets.map((t) => t.serverId),
      });

      // Update request with additional metadata
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          posterPath: input.posterPath ?? null,
          targets: input.targets as unknown as Prisma.JsonArray,
          selectedRelease: input.selectedRelease
            ? (input.selectedRelease as unknown as Prisma.JsonObject)
            : undefined,
        },
      });

      // Store pipeline template configuration for workers
      await storePipelineTemplate(requestId, "MOVIE", input.pipelineTemplateId);

      console.log(
        `[Requests] Created movie request ${requestId} with ${items.length} ProcessingItem(s)`
      );

      return { id: requestId };
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
        subscribe: z.boolean().optional(),
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
          subscribe: input.subscribe ?? false,
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

      // Episodes to process
      const episodesToCreate: Array<{
        season: number;
        episode: number;
        title?: string;
        airDate?: Date;
      }> = [];

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

                // Add to list for ProcessingItem creation if this episode is requested
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
      } catch (error) {
        console.error("Failed to fetch episode data from Trakt:", error);
        // Continue anyway - the request will be created but may not have complete episode data
      }

      // Create ProcessingItems for episodes using new pipeline system
      if (episodesToCreate.length > 0) {
        const { requestId: newRequestId, items } = await pipelineOrchestrator.createRequest({
          type: "tv",
          tmdbId: input.tmdbId,
          title: input.title,
          year: input.year,
          episodes: episodesToCreate.map((ep) => ({
            season: ep.season,
            episode: ep.episode,
            title: ep.title || `Episode ${ep.episode}`,
          })),
          targetServers: input.targets.map((t) => t.serverId),
        });

        // Update request with additional metadata
        await prisma.mediaRequest.update({
          where: { id: newRequestId },
          data: {
            posterPath: input.posterPath ?? null,
            requestedSeasons: input.seasons ?? [],
            requestedEpisodes: input.episodes ?? Prisma.JsonNull,
            targets: input.targets as unknown as Prisma.JsonArray,
            selectedRelease: input.selectedRelease
              ? (input.selectedRelease as unknown as Prisma.JsonObject)
              : undefined,
            subscribe: input.subscribe ?? false,
          },
        });

        // ProcessingItem records are created by PipelineOrchestrator.createRequest()

        console.log(
          `[Requests] Created TV request ${newRequestId} with ${items.length} ProcessingItem(s)`
        );

        // Store pipeline template configuration for workers
        await storePipelineTemplate(newRequestId, "TV", input.pipelineTemplateId);

        // Delete the old request we created earlier, use the new one from orchestrator
        await prisma.mediaRequest.delete({ where: { id: request.id } });

        return { id: newRequestId };
      } else {
        // No episodes found - mark request as failed
        await prisma.mediaRequest.update({
          where: { id: request.id },
          data: {
            status: RequestStatus.FAILED,
            error: "No episodes found for requested seasons",
          },
        });
        return { id: request.id };
      }
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
          processingItems: {
            select: {
              id: true,
              type: true,
              status: true,
              progress: true,
              season: true,
              episode: true,
              attempts: true,
              lastError: true,
            },
          },
          totalItems: true,
          completedItems: true,
          failedItems: true,
          status: true,
          progress: true,
          currentStep: true,
          currentStepStartedAt: true,
          error: true,
          requiredResolution: true,
          availableReleases: true,
          qualitySearchedAt: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          releaseFileSize: true,
          releaseIndexerName: true,
          releaseSeeders: true,
          releaseLeechers: true,
          releaseResolution: true,
          releaseSource: true,
          releaseCodec: true,
          releaseScore: true,
          releasePublishDate: true,
          releaseName: true,
        },
      });

      type MediaRequestWithEpisodes = Prisma.MediaRequestGetPayload<{
        select: {
          id: true;
          type: true;
          tmdbId: true;
          title: true;
          year: true;
          posterPath: true;
          targets: true;
          requestedSeasons: true;
          requestedEpisodes: true;
          status: true;
          progress: true;
          currentStep: true;
          currentStepStartedAt: true;
          error: true;
          requiredResolution: true;
          availableReleases: true;
          qualitySearchedAt: true;
          createdAt: true;
          updatedAt: true;
          completedAt: true;
          releaseFileSize: true;
          releaseIndexerName: true;
          releaseSeeders: true;
          releaseLeechers: true;
          releaseResolution: true;
          releaseSource: true;
          releaseCodec: true;
          releaseScore: true;
          releasePublishDate: true;
          releaseName: true;
        };
      }>;

      // Get server names for display
      const serverIds = new Set<string>();

      for (const r of results) {
        const targets = r.targets as unknown as RequestTarget[];
        if (Array.isArray(targets)) {
          for (const target of targets) {
            if (target?.serverId) {
              serverIds.add(target.serverId);
            }
          }
        }
      }

      // For requests without posterPath, look up from MediaItem (legacy support)
      const requestsWithoutPoster = results.filter((r: MediaRequestWithEpisodes) => !r.posterPath);
      const mediaItemIds = requestsWithoutPoster.map(
        (r: MediaRequestWithEpisodes) =>
          `tmdb-${r.type === MediaType.MOVIE ? "movie" : "tv"}-${r.tmdbId}`
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

      type ServerData = Prisma.StorageServerGetPayload<{ select: { id: true; name: true } }>;
      type MediaItemData = Prisma.MediaItemGetPayload<{ select: { id: true; posterPath: true } }>;

      const serverMap = new Map(servers.map((s: ServerData) => [s.id, s.name]));
      const posterMap = new Map(mediaItems.map((m: MediaItemData) => [m.id, m.posterPath]));

      // Compute status for all requests using batch operation
      const requestIds = results.map((r: MediaRequestWithEpisodes) => r.id);
      const statusMap = await requestStatusComputer.batchComputeStatus(requestIds);

      // Get release metadata for all requests
      const releaseMetadataPromises = requestIds.map((id: string) =>
        requestStatusComputer.getReleaseMetadata(id)
      );
      const releaseMetadataList = await Promise.all(releaseMetadataPromises);
      const releaseMetadataMap = new Map(
        requestIds.map((id: string, index: number) => [id, releaseMetadataList[index]])
      );

      return results.map((r: MediaRequestWithEpisodes) => {
        const targets = r.targets as unknown as RequestTarget[];
        const availableReleases = r.availableReleases as unknown[] | null;
        // Use stored posterPath, or fall back to MediaItem lookup for legacy requests
        const mediaItemId = `tmdb-${r.type === MediaType.MOVIE ? "movie" : "tv"}-${r.tmdbId}`;
        const posterPath = r.posterPath ?? posterMap.get(mediaItemId) ?? null;

        // Get computed status and release metadata
        const computed = statusMap.get(r.id);
        const releaseMetadata = (releaseMetadataMap.get(r.id) ?? null) as Awaited<
          ReturnType<typeof requestStatusComputer.getReleaseMetadata>
        >;

        return {
          id: r.id,
          type: fromMediaType(r.type),
          tmdbId: r.tmdbId,
          title: r.title,
          year: r.year,
          posterPath,
          targets: Array.isArray(targets)
            ? targets.map((t) => ({
                serverId: t.serverId,
                serverName: serverMap.get(t.serverId) || "Unknown",
              }))
            : [],
          requestedSeasons: r.requestedSeasons,
          requestedEpisodes: r.requestedEpisodes as { season: number; episode: number }[] | null,
          status: computed ? fromRequestStatus(computed.status) : fromRequestStatus(r.status),
          progress: computed?.progress ?? r.progress,
          currentStep: computed?.currentStep ?? r.currentStep,
          currentStepStartedAt: computed?.currentStepStartedAt ?? r.currentStepStartedAt,
          error: computed?.error ?? r.error,
          requiredResolution: r.requiredResolution,
          hasAlternatives:
            (computed?.status ?? r.status) === RequestStatus.QUALITY_UNAVAILABLE &&
            Array.isArray(availableReleases) &&
            availableReleases.length > 0,
          qualitySearchedAt: r.qualitySearchedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          completedAt: r.completedAt,
          releaseMetadata: releaseMetadata
            ? {
                fileSize: releaseMetadata.fileSize,
                indexerName: releaseMetadata.indexerName,
                seeders: releaseMetadata.seeders,
                leechers: releaseMetadata.leechers,
                resolution: releaseMetadata.resolution,
                source: releaseMetadata.source,
                codec: releaseMetadata.codec,
                score: releaseMetadata.score,
                publishDate: releaseMetadata.publishDate,
                name: releaseMetadata.name,
              }
            : null,
        };
      });
    }),

  /**
   * Get a single request by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const r = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
      include: {
        processingItems: {
          select: {
            id: true,
            type: true,
            status: true,
            progress: true,
            season: true,
            episode: true,
            title: true,
            attempts: true,
            maxAttempts: true,
            lastError: true,
            nextRetryAt: true,
            currentStep: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });

    if (!r) {
      return null;
    }

    const targets = r.targets as unknown as RequestTarget[];

    // Get server names
    const serverIds = Array.isArray(targets)
      ? targets.map((t) => t.serverId).filter((id) => id !== undefined)
      : [];

    const servers =
      serverIds.length > 0
        ? await prisma.storageServer.findMany({
            where: { id: { in: serverIds } },
            select: { id: true, name: true },
          })
        : [];

    type ServerInfo = Prisma.StorageServerGetPayload<{ select: { id: true; name: true } }>;

    const serverMap = new Map(servers.map((s: ServerInfo) => [s.id, s.name]));

    // Compute status from ProcessingItems
    const computed = await requestStatusComputer.computeStatus(input.id);

    // Get release metadata
    const releaseMetadata = await requestStatusComputer.getReleaseMetadata(input.id);

    // For TV shows, get episode count
    let episodeCount: number | null = null;
    if (r.type === MediaType.TV) {
      episodeCount = await prisma.processingItem.count({
        where: { requestId: input.id, type: "EPISODE" },
      });
    }

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
      status: fromRequestStatus(computed.status),
      progress: computed.progress,
      currentStep: computed.currentStep,
      currentStepStartedAt: computed.currentStepStartedAt,
      error: computed.error,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      completedAt: r.completedAt,
      releaseMetadata: releaseMetadata
        ? {
            fileSize: releaseMetadata.fileSize,
            indexerName: releaseMetadata.indexerName,
            seeders: releaseMetadata.seeders,
            leechers: releaseMetadata.leechers,
            resolution: releaseMetadata.resolution,
            source: releaseMetadata.source,
            codec: releaseMetadata.codec,
            score: releaseMetadata.score,
            publishDate: releaseMetadata.publishDate,
            name: releaseMetadata.name,
            episodeCount,
          }
        : null,
    };
  }),

  /**
   * Cancel a request
   */
  cancel: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Find all pipeline executions for this request (parent + branches)
    const executions = await prisma.pipelineExecution.findMany({
      where: { requestId: input.id },
    });

    // Cancel all running executions
    const executor = getPipelineExecutor();
    for (const execution of executions) {
      if (execution.status === "RUNNING") {
        await executor.cancelExecution(execution.id);
      }
    }

    // Cancel any encoding jobs for this request
    const itemsWithJobs = await prisma.processingItem.findMany({
      where: {
        requestId: input.id,
        encodingJobId: { not: null },
      },
      select: { encodingJobId: true },
    });

    if (itemsWithJobs.length > 0) {
      const encoderDispatch = getEncoderDispatchService();

      for (const item of itemsWithJobs) {
        if (item.encodingJobId) {
          await encoderDispatch.cancelJob(item.encodingJobId, "Request cancelled by user");
        }
      }
    }

    // Update all ProcessingItems to CANCELLED (MediaRequest status computed from items)
    await prisma.processingItem.updateMany({
      where: { requestId: input.id },
      data: {
        status: ProcessingStatus.CANCELLED,
        lastError: "Cancelled by user",
      },
    });

    return { success: true };
  }),

  /**
   * Delete a request and cancel any running jobs
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const request = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
    });

    if (!request) {
      return { success: false, error: "Request not found" };
    }

    // Cancel any running pipeline executions first (parent + branches)
    const executions = await prisma.pipelineExecution.findMany({
      where: { requestId: input.id },
    });

    const executor = getPipelineExecutor();
    for (const execution of executions) {
      if (execution.status === "RUNNING") {
        await executor.cancelExecution(execution.id);
      }
    }

    // TODO: Cancel torrent downloads and delete downloaded media from qBittorrent
    // - Get all torrent hashes from downloads (for TV) or the request itself (for movies)
    // - For each torrent hash, call downloadService.deleteTorrent(hash, deleteFiles: true)
    // - This should remove the torrent from qBittorrent and delete the downloaded files

    // Delete ProcessingItems first (foreign key constraint)
    await prisma.processingItem.deleteMany({
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
   * Retry a failed request by intelligently resuming from the appropriate step
   */
  retry: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const request = await prisma.mediaRequest.findUnique({
      where: { id: input.id },
    });

    if (!request) {
      throw new Error("Request not found");
    }

    // Find the execution to get the template ID
    const execution = await prisma.pipelineExecution.findFirst({
      where: { requestId: input.id, parentExecutionId: null },
      orderBy: { startedAt: "desc" },
      select: { templateId: true },
    });

    if (!execution) {
      throw new Error("No pipeline execution found for this request");
    }

    // If the found execution is a branch pipeline (e.g., episode-branch-pipeline),
    // use the default template instead since branch templates can't run as parent pipelines
    let templateId = execution.templateId;
    if (templateId === "episode-branch-pipeline" || templateId.includes("branch")) {
      const mediaType = request.type === MediaType.MOVIE ? "MOVIE" : "TV";
      templateId = await getDefaultTemplate(mediaType);
      console.log(
        `[Retry] Found branch template ${execution.templateId}, using default ${mediaType} template ${templateId} instead`
      );
    }

    // Check for active encoding jobs to avoid duplicates
    const activeEncodingJobs = await prisma.job.findMany({
      where: {
        requestId: input.id,
        type: "remote:encode",
        status: { in: ["PENDING", "RUNNING"] },
      },
      include: {
        encoderAssignment: true,
      },
    });

    if (activeEncodingJobs.length > 0) {
      console.log(
        `[Retry] Found ${activeEncodingJobs.length} active encoding jobs for ${request.title}, cancelling them first`
      );

      // Cancel active encoding assignments
      for (const job of activeEncodingJobs) {
        if (job.encoderAssignment) {
          const assignment = job.encoderAssignment;
          if (["PENDING", "ASSIGNED", "ENCODING"].includes(assignment.status)) {
            await prisma.encoderAssignment.update({
              where: { id: assignment.id },
              data: { status: "CANCELLED" },
            });
          }
        }
        // Mark job as failed so it can be retried
        await prisma.job.update({
          where: { id: job.id },
          data: { status: "FAILED" },
        });
      }
    }

    // Reset failed ProcessingItems to allow retry (pipeline will manage state from here)
    await prisma.processingItem.updateMany({
      where: {
        requestId: input.id,
        status: ProcessingStatus.FAILED,
      },
      data: {
        status: ProcessingStatus.PENDING,
        lastError: null,
      },
    });

    // Store pipeline template configuration for workers
    const mediaType = request.type === MediaType.MOVIE ? "MOVIE" : "TV";
    await storePipelineTemplate(input.id, mediaType, templateId);

    // NOTE: Old pipeline executor disabled - workers now handle all processing
    // Items in PENDING status will be picked up automatically by SearchWorker
    // const executor = getPipelineExecutor();
    // executor.startExecution(request.id, templateId).catch(async (error) => {
    //   console.error(`Pipeline retry failed for request ${request.id}:`, error);
    //   // Mark all ProcessingItems as failed (MediaRequest status computed from items)
    //   await prisma.processingItem.updateMany({
    //     where: { requestId: request.id },
    //     data: {
    //       status: ProcessingStatus.FAILED,
    //       lastError: `Pipeline failed to start: ${error.message}`,
    //     },
    //   });
    // });

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

      // Get ProcessingItems for this TV request
      const episodes = await prisma.processingItem.findMany({
        where: { requestId: input.requestId, type: "EPISODE" },
        orderBy: [{ season: "asc" }, { episode: "asc" }],
      });

      type ProcessingItemData = Prisma.ProcessingItemGetPayload<Record<string, never>>;

      // Get target server IDs from the request
      const targets = request.targets as unknown as RequestTarget[];
      const serverIds = Array.isArray(targets)
        ? targets.map((t) => t.serverId).filter((id) => id !== undefined)
        : [];

      // Get library availability for episodes on target servers
      const libraryEpisodes =
        serverIds.length > 0
          ? await prisma.episodeLibraryItem.findMany({
              where: {
                tmdbId: request.tmdbId,
                serverId: { in: serverIds },
              },
              select: {
                season: true,
                episode: true,
                serverId: true,
              },
            })
          : [];

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
        (ep: ProcessingItemData) => ep.status === ProcessingStatus.DOWNLOADING && ep.downloadId
      );

      const downloadService = getDownloadService();
      const progressMap = new Map<string, { progress: number; speed: number }>();

      // First, get the Download records for these episodes
      const downloadIds = downloadingEpisodes
        .map((ep: ProcessingItemData) => ep.downloadId)
        .filter((id: string | null): id is string => id !== null);

      const downloads = await prisma.download.findMany({
        where: { id: { in: downloadIds } },
      });

      type DownloadData = Prisma.DownloadGetPayload<Record<string, never>>;

      const downloadMap = new Map<string, DownloadData>(
        downloads.map((d: DownloadData) => [d.id, d])
      );

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

      // Get ProcessingItems for encoding episodes to check if they're pending an encoder
      const processingItems = await prisma.processingItem.findMany({
        where: {
          requestId: input.requestId,
          status: "ENCODING",
        },
        select: {
          season: true,
          episode: true,
          encodingJobId: true,
        },
      });

      // Check encoding job assignments for pending status
      const jobIds = processingItems
        .map((item: { encodingJobId: string | null }) => item.encodingJobId)
        .filter((id: string | null): id is string => id !== null);

      const assignments = await prisma.encoderAssignment.findMany({
        where: { jobId: { in: jobIds } },
        select: { jobId: true, status: true },
      });

      type AssignmentData = Prisma.EncoderAssignmentGetPayload<{
        select: { jobId: true; status: true };
      }>;

      const assignmentMap = new Map(assignments.map((a: AssignmentData) => [a.jobId, a.status]));

      // Build map of pending encode episodes: "season-episode" -> true
      const pendingEncodeMap = new Map<string, boolean>();
      for (const item of processingItems) {
        if (item.season === null || item.episode === null) continue;
        const key = `${item.season}-${item.episode}`;
        const assignmentStatus = item.encodingJobId
          ? assignmentMap.get(item.encodingJobId)
          : undefined;
        // Pending if no job, or job exists but assignment is PENDING
        const isPending = !item.encodingJobId || assignmentStatus === "PENDING";
        pendingEncodeMap.set(key, isPending);
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
            isPendingEncode: boolean;
            currentStep: string | null;
            isAvailableInLibrary: boolean;
            availableOnServerCount: number;
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

        // Always use actual processing status (not "available")
        const status = ep.status.toLowerCase();

        // Get download progress if available
        const downloadProgress = progressMap.get(key);

        // Get release name from Download record
        const download = ep.downloadId ? downloadMap.get(ep.downloadId) : null;

        // Determine progress based on status:
        // - For DOWNLOADING status, use download progress
        // - For ENCODING and DELIVERING status, use episode's progress field
        // - For other statuses, no progress
        let progress: number | null = null;
        if (ep.status === ProcessingStatus.DOWNLOADING) {
          progress = downloadProgress?.progress ?? null;
        } else if (
          ep.status === ProcessingStatus.ENCODING ||
          ep.status === ProcessingStatus.DELIVERING
        ) {
          progress = ep.progress;
        }

        const isPendingEncode = pendingEncodeMap.get(key) ?? false;

        seasons[ep.season].episodes.push({
          id: ep.id,
          episodeNumber: ep.episode ?? 0,
          status,
          error: ep.lastError,
          airDate: ep.airDate,
          downloadedAt: ep.downloadedAt,
          deliveredAt: ep.deliveredAt,
          progress,
          speed: downloadProgress?.speed ?? null,
          releaseName: download?.torrentName ?? null,
          isPendingEncode,
          currentStep: ep.currentStep,
          // Library availability as separate field
          isAvailableInLibrary: isAvailableOnAllTargets,
          availableOnServerCount: availableOnServers?.size ?? 0,
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

    type ServerConfig = Prisma.StorageServerGetPayload<{
      select: { id: true; name: true; maxResolution: true };
    }>;

    return {
      servers: servers.map((s: ServerConfig) => ({
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

      // Update request with selected release (configuration)
      await prisma.mediaRequest.update({
        where: { id: input.id },
        data: {
          selectedRelease: selectedRelease as Prisma.JsonObject,
        },
      });

      // Reset ProcessingItems to PENDING to restart pipeline
      await prisma.processingItem.updateMany({
        where: { requestId: input.id },
        data: {
          status: ProcessingStatus.PENDING,
          lastError: null,
        },
      });

      // NOTE: Old pipeline executor disabled - workers now handle all processing
      // Restart pipeline with the selected release
      // const execution = await prisma.pipelineExecution.findFirst({
      //   where: { requestId: input.id, parentExecutionId: null },
      //   orderBy: { startedAt: "desc" },
      //   select: { templateId: true },
      // });
      // Items in PENDING status will be picked up automatically by SearchWorker
      // if (execution) {
      //   const executor = getPipelineExecutor();
      //   executor.startExecution(request.id, execution.templateId).catch(async (error) => {
      //     console.error(`Pipeline restart failed for request ${request.id}:`, error);
      //     // Mark all ProcessingItems as failed (MediaRequest status computed from items)
      //     await prisma.processingItem.updateMany({
      //       where: { requestId: request.id },
      //       data: {
      //         status: ProcessingStatus.FAILED,
      //         lastError: `Pipeline failed to start: ${error.message}`,
      //       },
      //     });
      //   });
      // }

      return { success: true };
    }),

  /**
   * Manual search for releases when processing items have no downloadId
   */
  manualSearch: publicProcedure
    .input(z.object({ requestId: z.string() }))
    .query(async ({ input }) => {
      const request = await prisma.mediaRequest.findUnique({
        where: { id: input.requestId },
        include: { processingItems: true },
      });

      if (!request) {
        throw new Error("Request not found");
      }

      const seasonsNeedingDownloads =
        request.type === MediaType.TV
          ? [
              ...new Set(
                request.processingItems
                  .filter(
                    (item: { downloadId: string | null; season: number | null }) =>
                      !item.downloadId && item.season !== null
                  )
                  .map((item: { season: number | null }) => item.season as number)
              ),
            ]
          : [];

      const { getIndexerService } = await import("../services/indexer.js");
      const indexerService = getIndexerService();
      const releases = await indexerService.search({
        type: request.type === MediaType.MOVIE ? "movie" : "tv",
        tmdbId: request.tmdbId,
        year: request.year,
        season: seasonsNeedingDownloads[0] as number | undefined,
      });

      return {
        releases: releases.releases,
        requestInfo: {
          type: fromMediaType(request.type),
          title: request.title,
          year: request.year,
          seasonsNeedingDownloads,
        },
      };
    }),

  /**
   * Select a manual release for download
   */
  selectManualRelease: publicProcedure
    .input(
      z.object({
        requestId: z.string(),
        release: releaseSchema,
      })
    )
    .mutation(async ({ input }) => {
      const { requestId, release } = input;

      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        include: {
          processingItems: {
            where: { downloadId: null },
          },
        },
      });

      if (!request) {
        throw new Error("Request not found");
      }

      const { parseTorrentName, createDownload } = await import("../services/downloadManager.js");
      const parsed = parseTorrentName(release.title);
      const isSeasonPack = parsed.season !== undefined && parsed.episode === undefined;

      const download = await createDownload({
        requestId,
        mediaType: request.type,
        release,
        isSeasonPack,
        season: parsed.season,
      });

      if (!download) {
        throw new Error("Failed to create download");
      }

      let affectedItems = request.processingItems;

      if (request.type === MediaType.TV) {
        if (isSeasonPack && parsed.season !== null) {
          affectedItems = request.processingItems.filter(
            (item: { season: number | null }) => item.season === parsed.season
          );
        } else if (parsed.episode !== null && parsed.season !== null) {
          affectedItems = request.processingItems.filter(
            (item: { season: number | null; episode: number | null }) =>
              item.season === parsed.season && item.episode === parsed.episode
          );
        }
      }

      await prisma.$transaction([
        prisma.processingItem.updateMany({
          where: { id: { in: affectedItems.map((i: { id: string }) => i.id) } },
          data: {
            downloadId: download.id,
            status: ProcessingStatus.DOWNLOADING,
            currentStep: "download",
            stepContext: Prisma.JsonNull,
          },
        }),
        prisma.activityLog.create({
          data: {
            type: "DOWNLOAD_MANUAL_SEARCH",
            message: `Manual search: selected "${release.title}" for ${affectedItems.length} items`,
            requestId,
          },
        }),
      ]);

      return {
        success: true,
        downloadId: download.id,
        affectedItems: affectedItems.length,
      };
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

      // Clear user's selected release (configuration)
      await prisma.mediaRequest.update({
        where: { id: input.id },
        data: {
          selectedRelease: Prisma.JsonNull,
        },
      });

      // Reset ProcessingItems to PENDING to restart search
      await prisma.processingItem.updateMany({
        where: { requestId: input.id },
        data: {
          status: ProcessingStatus.PENDING,
          lastError: null,
        },
      });

      // NOTE: Old pipeline executor disabled - workers now handle all processing
      // const execution = await prisma.pipelineExecution.findFirst({
      //   where: { requestId: input.id, parentExecutionId: null },
      //   orderBy: { startedAt: "desc" },
      //   select: { templateId: true },
      // });
      // Items in PENDING status will be picked up automatically by SearchWorker
      // if (execution) {
      //   const executor = getPipelineExecutor();
      //   executor.startExecution(request.id, execution.templateId).catch(async (error) => {
      //     console.error(`Pipeline restart failed for request ${request.id}:`, error);
      //     // Mark all ProcessingItems as failed (MediaRequest status computed from items)
      //     await prisma.processingItem.updateMany({
      //       where: { requestId: request.id },
      //       data: {
      //         status: ProcessingStatus.FAILED,
      //         lastError: `Pipeline failed to start: ${error.message}`,
      //       },
      //     });
      //   });
      // }

      return { success: true };
    }),

  /**
   * Retry a failed ProcessingItem
   */
  retryItem: publicProcedure.input(z.object({ itemId: z.string() })).mutation(async ({ input }) => {
    await pipelineOrchestrator.retry(input.itemId);
    return { success: true };
  }),

  /**
   * Cancel a ProcessingItem
   */
  cancelItem: publicProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(async ({ input }) => {
      await pipelineOrchestrator.cancel(input.itemId);
      return { success: true };
    }),

  /**
   * Get ProcessingItems for a request
   */
  getProcessingItems: publicProcedure
    .input(z.object({ requestId: z.string() }))
    .query(async ({ input }) => {
      const items = await pipelineOrchestrator.getRequestItems(input.requestId);
      return items;
    }),

  /**
   * Get request statistics
   */
  getRequestStats: publicProcedure
    .input(z.object({ requestId: z.string() }))
    .query(async ({ input }) => {
      const stats = await pipelineOrchestrator.getRequestStats(input.requestId);
      return stats;
    }),

  /**
   * Cancel a single episode (user override)
   */
  cancelEpisode: publicProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(async ({ input }) => {
      await prisma.processingItem.update({
        where: { id: input.itemId },
        data: {
          status: ProcessingStatus.CANCELLED,
          lastError: "User cancelled",
        },
      });
      return { success: true };
    }),

  /**
   * Re-encode a single episode (reset to encoding stage)
   */
  reEncodeEpisode: publicProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(async ({ input }) => {
      const item = await prisma.processingItem.findUnique({
        where: { id: input.itemId },
      });

      if (!item) {
        throw new Error("Episode not found");
      }

      // Extract stepContext and download data
      const stepContext = (item.stepContext as Record<string, unknown>) || {};
      const downloadData = stepContext.download as Record<string, unknown> | undefined;

      // Verify episode has download file path before resetting to DOWNLOADED
      if (!downloadData?.sourceFilePath && !item.sourceFilePath) {
        throw new Error("Episode missing download file path - cannot re-encode");
      }

      // Preserve download context, fallback to top-level sourceFilePath if needed
      const preservedDownloadContext = downloadData || {
        sourceFilePath: item.sourceFilePath,
      };

      // Reset to downloaded status so encoding can restart
      await prisma.processingItem.update({
        where: { id: input.itemId },
        data: {
          status: ProcessingStatus.DOWNLOADED,
          lastError: null,
          encodingJobId: null,
          currentStep: "download",
          stepContext: {
            ...stepContext,
            download: preservedDownloadContext,
          },
          progress: 0,
        },
      });

      return { success: true };
    }),

  /**
   * Re-deliver a single episode (reset to delivery stage)
   */
  reDeliverEpisode: publicProcedure
    .input(z.object({ itemId: z.string() }))
    .mutation(async ({ input }) => {
      const item = await prisma.processingItem.findUnique({
        where: { id: input.itemId },
        include: {
          request: {
            select: {
              tmdbId: true,
              title: true,
              year: true,
              targets: true,
            },
          },
        },
      });

      if (!item || !item.request) {
        throw new Error("Episode not found");
      }

      if (item.type !== "EPISODE" || item.season === null || item.episode === null) {
        throw new Error("Only episodes can be re-delivered");
      }

      // Extract stepContext and encoded data
      const stepContext = (item.stepContext as Record<string, unknown>) || {};
      const encodeData = stepContext.encode as Record<string, unknown> | undefined;
      const encodedFiles = encodeData?.encodedFiles as Array<{ path: string }> | undefined;

      // Verify episode has output file path before re-delivering
      if (!encodedFiles?.[0]?.path) {
        throw new Error("Episode missing encoded output file - cannot re-deliver");
      }

      const outputPath = encodedFiles[0].path;

      // Reset to encoded status
      await prisma.processingItem.update({
        where: { id: input.itemId },
        data: {
          status: ProcessingStatus.ENCODED,
          progress: 0,
          lastError: null,
          deliveredAt: null,
          currentStep: "deliver",
        },
      });

      // Re-queue for delivery
      const deliveryQueue = (await import("../services/deliveryQueue.js")).getDeliveryQueue();

      const targets = item.request.targets as unknown as Array<{
        serverId: string;
        encodingProfileId: string;
      }>;

      await deliveryQueue.enqueue({
        episodeId: item.id,
        requestId: item.requestId,
        season: item.season,
        episode: item.episode,
        title: item.request.title,
        year: item.request.year ?? new Date().getFullYear(),
        sourceFilePath: outputPath,
        targetServers: targets,
      });

      return { success: true };
    }),
});
