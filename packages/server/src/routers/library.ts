import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { publicProcedure, router } from "../trpc.js";

export const libraryRouter = router({
  /**
   * Get all cached media items from the database
   */
  list: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]).optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        sortBy: z.enum(["title", "releaseDate", "rating", "addedAt"]).default("addedAt"),
        sortOrder: z.enum(["asc", "desc"]).default("desc"),
        search: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const where: Record<string, unknown> = {};

      if (input.type) {
        where.type = input.type === "movie" ? MediaType.MOVIE : MediaType.TV;
      }

      if (input.search) {
        where.title = {
          contains: input.search,
          mode: "insensitive",
        };
      }

      const orderBy: Record<string, string> = {};
      switch (input.sortBy) {
        case "title":
          orderBy.title = input.sortOrder;
          break;
        case "releaseDate":
          orderBy.releaseDate = input.sortOrder;
          break;
        case "rating":
          // This requires joining with ratings, handled separately
          orderBy.updatedAt = input.sortOrder;
          break;
        default:
          orderBy.createdAt = input.sortOrder;
          break;
      }

      const [items, total] = await Promise.all([
        prisma.mediaItem.findMany({
          where,
          orderBy,
          skip: (input.page - 1) * input.limit,
          take: input.limit,
          include: {
            ratings: true,
          },
        }),
        prisma.mediaItem.count({ where }),
      ]);

      type MediaItemWithRatings = Prisma.MediaItemGetPayload<{ include: { ratings: true } }>;

      return {
        items: items.map((item: MediaItemWithRatings) => ({
          id: item.id,
          tmdbId: item.tmdbId,
          imdbId: item.imdbId,
          type: item.type.toLowerCase() as "movie" | "tv",
          title: item.title,
          originalTitle: item.originalTitle,
          releaseDate: item.releaseDate,
          overview: item.overview,
          posterPath: item.posterPath,
          backdropPath: item.backdropPath,
          posterUrl: item.posterPath,
          backdropUrl: item.backdropPath,
          genres: item.genres,
          runtime: item.runtime,
          status: item.status,
          ratings: item.ratings
            ? {
                tmdbScore: item.ratings.tmdbScore,
                tmdbVotes: item.ratings.tmdbVotes,
                imdbScore: item.ratings.imdbScore,
                mdblistScore: item.ratings.mdblistScore,
              }
            : null,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
        page: input.page,
        totalPages: Math.ceil(total / input.limit),
        totalItems: total,
      };
    }),

  /**
   * Get a single cached media item
   */
  get: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        type: z.enum(["movie", "tv"]),
      })
    )
    .query(async ({ input }) => {
      const id = `tmdb-${input.type}-${input.tmdbId}`;

      const item = await prisma.mediaItem.findUnique({
        where: { id },
        include: { ratings: true },
      });

      if (!item) {
        return null;
      }

      return {
        id: item.id,
        tmdbId: item.tmdbId,
        imdbId: item.imdbId,
        type: item.type.toLowerCase() as "movie" | "tv",
        title: item.title,
        originalTitle: item.originalTitle,
        releaseDate: item.releaseDate,
        overview: item.overview,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        posterUrl: item.posterPath,
        backdropUrl: item.backdropPath,
        genres: item.genres,
        runtime: item.runtime,
        status: item.status,
        ratings: item.ratings,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };
    }),

  /**
   * Get library statistics
   */
  stats: publicProcedure.query(async () => {
    const [movieCount, tvCount, recentlyAdded] = await Promise.all([
      prisma.mediaItem.count({ where: { type: MediaType.MOVIE } }),
      prisma.mediaItem.count({ where: { type: MediaType.TV } }),
      prisma.mediaItem.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          tmdbId: true,
          title: true,
          type: true,
          posterPath: true,
          createdAt: true,
        },
      }),
    ]);

    type RecentMediaItem = Prisma.MediaItemGetPayload<{
      select: {
        id: true;
        tmdbId: true;
        title: true;
        type: true;
        posterPath: true;
        createdAt: true;
      };
    }>;

    return {
      movies: movieCount,
      tvShows: tvCount,
      total: movieCount + tvCount,
      recentlyAdded: recentlyAdded.map((item: RecentMediaItem) => ({
        id: item.id,
        tmdbId: item.tmdbId,
        title: item.title,
        type: item.type.toLowerCase(),
        posterUrl: item.posterPath,
        addedAt: item.createdAt,
      })),
    };
  }),

  /**
   * Check if a media item exists in any connected library (Plex/Emby)
   */
  checkInLibrary: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        type: z.enum(["movie", "tv"]),
      })
    )
    .query(async ({ input }) => {
      const libraryItems = await prisma.libraryItem.findMany({
        where: {
          tmdbId: input.tmdbId,
          type: input.type === "movie" ? MediaType.MOVIE : MediaType.TV,
        },
        include: {
          server: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      type LibraryItemWithServer = Prisma.LibraryItemGetPayload<{
        include: { server: { select: { id: true; name: true } } };
      }>;

      return {
        inLibrary: libraryItems.length > 0,
        servers: libraryItems.map((item: LibraryItemWithServer) => ({
          serverId: item.server.id,
          serverName: item.server.name,
          quality: item.quality,
          addedAt: item.addedAt,
        })),
      };
    }),

  /**
   * Get detailed episode availability for a TV show across all servers
   * Returns which episodes are available on which servers with quality info
   */
  tvShowAvailability: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
      })
    )
    .query(async ({ input }) => {
      // Get all episode library items for this show
      const episodeItems = await prisma.episodeLibraryItem.findMany({
        where: { tmdbId: input.tmdbId },
        include: {
          server: {
            select: {
              id: true,
              name: true,
              mediaServerType: true,
            },
          },
        },
        orderBy: [{ season: "asc" }, { episode: "asc" }],
      });

      type EpisodeLibraryItemWithServer = Prisma.EpisodeLibraryItemGetPayload<{
        include: { server: { select: { id: true; name: true; mediaServerType: true } } };
      }>;

      // Group by server, then by season
      const serverMap = new Map<
        string,
        {
          serverId: string;
          serverName: string;
          serverType: string | null;
          seasons: Map<number, { episode: number; quality: string | null }[]>;
        }
      >();

      for (const item of episodeItems) {
        if (!serverMap.has(item.serverId)) {
          serverMap.set(item.serverId, {
            serverId: item.server.id,
            serverName: item.server.name,
            serverType: item.server.mediaServerType,
            seasons: new Map(),
          });
        }

        const server = serverMap.get(item.serverId);
        if (server) {
          if (!server.seasons.has(item.season)) {
            server.seasons.set(item.season, []);
          }
          server.seasons.get(item.season)?.push({
            episode: item.episode,
            quality: item.quality,
          });
        }
      }

      // Convert to serializable format
      const servers = Array.from(serverMap.values()).map((server) => ({
        serverId: server.serverId,
        serverName: server.serverName,
        serverType: server.serverType,
        seasons: Array.from(server.seasons.entries())
          .map(([seasonNumber, episodes]) => ({
            seasonNumber,
            episodes: episodes.sort((a, b) => a.episode - b.episode),
            episodeCount: episodes.length,
          }))
          .sort((a, b) => a.seasonNumber - b.seasonNumber),
        totalEpisodes: episodeItems.filter(
          (e: EpisodeLibraryItemWithServer) => e.serverId === server.serverId
        ).length,
      }));

      return {
        tmdbId: input.tmdbId,
        servers,
        totalServers: servers.length,
        hasAnyEpisodes: episodeItems.length > 0,
      };
    }),
});
