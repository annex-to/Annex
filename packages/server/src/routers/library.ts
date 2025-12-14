import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { getTMDBService, TMDBService } from "../services/tmdb.js";
import { MediaType } from "@prisma/client";
import {
  isEmbyFullyConfigured,
  getEmbyAllMedia,
  getEmbyRecentlyAdded,
  getEmbyLibraryStats,
  searchEmby,
  getEmbyGenres,
  getEmbyItem,
} from "../services/emby.js";

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
        case "addedAt":
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

      return {
        items: items.map((item) => ({
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
          posterUrl: TMDBService.getImageUrl(item.posterPath, "w342"),
          backdropUrl: TMDBService.getImageUrl(item.backdropPath, "w780"),
          genres: item.genres,
          runtime: item.runtime,
          status: item.status,
          ratings: item.ratings
            ? {
                tmdbScore: item.ratings.tmdbScore,
                tmdbVotes: item.ratings.tmdbVotes,
                imdbScore: item.ratings.imdbScore,
                aggregateScore: item.ratings.aggregateScore,
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
        posterUrl: TMDBService.getImageUrl(item.posterPath, "w500"),
        backdropUrl: TMDBService.getImageUrl(item.backdropPath, "original"),
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

    return {
      movies: movieCount,
      tvShows: tvCount,
      total: movieCount + tvCount,
      recentlyAdded: recentlyAdded.map((item) => ({
        id: item.id,
        tmdbId: item.tmdbId,
        title: item.title,
        type: item.type.toLowerCase(),
        posterUrl: TMDBService.getImageUrl(item.posterPath, "w185"),
        addedAt: item.createdAt,
      })),
    };
  }),

  /**
   * Sync popular media from TMDB to database
   */
  sync: publicProcedure
    .input(
      z.object({
        movies: z.boolean().default(true),
        tvShows: z.boolean().default(true),
        pages: z.number().min(1).max(20).default(5),
      })
    )
    .mutation(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.syncPopularMedia({
        movies: input.movies,
        tvShows: input.tvShows,
        pages: input.pages,
      });

      return {
        success: true,
        synced: result,
        message: `Synced ${result.movies} movies and ${result.tvShows} TV shows`,
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

      return {
        inLibrary: libraryItems.length > 0,
        servers: libraryItems.map((item) => ({
          serverId: item.server.id,
          serverName: item.server.name,
          quality: item.quality,
          addedAt: item.addedAt,
        })),
      };
    }),

  // =============================================================================
  // Emby Library Endpoints
  // =============================================================================

  /**
   * Check if Emby library is available (configured with URL and API key)
   */
  embyConfigured: publicProcedure.query(() => {
    return { configured: isEmbyFullyConfigured() };
  }),

  /**
   * Get all media from Emby library
   */
  embyMedia: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]).optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(24),
        sortBy: z.enum(["SortName", "DateCreated", "PremiereDate", "CommunityRating"]).default("SortName"),
        sortOrder: z.enum(["Ascending", "Descending"]).default("Ascending"),
        search: z.string().optional(),
        genres: z.array(z.string()).optional(),
        years: z.array(z.number()).optional(),
      })
    )
    .query(async ({ input }) => {
      if (!isEmbyFullyConfigured()) {
        return {
          items: [],
          page: 1,
          totalPages: 0,
          totalItems: 0,
          configured: false,
        };
      }

      const startIndex = (input.page - 1) * input.limit;

      const result = await getEmbyAllMedia({
        type: input.type,
        startIndex,
        limit: input.limit,
        sortBy: input.sortBy,
        sortOrder: input.sortOrder,
        searchTerm: input.search,
        genres: input.genres,
        years: input.years,
      });

      return {
        items: result.items,
        page: input.page,
        totalPages: Math.ceil(result.totalCount / input.limit),
        totalItems: result.totalCount,
        configured: true,
      };
    }),

  /**
   * Get recently added items from Emby
   */
  embyRecentlyAdded: publicProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(50).default(20),
        type: z.enum(["movie", "tv"]).optional(),
      })
    )
    .query(async ({ input }) => {
      if (!isEmbyFullyConfigured()) {
        return { items: [], configured: false };
      }

      const items = await getEmbyRecentlyAdded({
        limit: input.limit,
        type: input.type,
      });

      return { items, configured: true };
    }),

  /**
   * Get Emby library statistics
   */
  embyStats: publicProcedure.query(async () => {
    if (!isEmbyFullyConfigured()) {
      return {
        configured: false,
        movieCount: 0,
        tvShowCount: 0,
        episodeCount: 0,
      };
    }

    const stats = await getEmbyLibraryStats();

    return {
      configured: true,
      ...stats,
    };
  }),

  /**
   * Search Emby library
   */
  embySearch: publicProcedure
    .input(
      z.object({
        query: z.string().min(1),
        limit: z.number().min(1).max(50).default(20),
        type: z.enum(["movie", "tv"]).optional(),
      })
    )
    .query(async ({ input }) => {
      if (!isEmbyFullyConfigured()) {
        return { items: [], configured: false };
      }

      const items = await searchEmby(input.query, {
        limit: input.limit,
        type: input.type,
      });

      return { items, configured: true };
    }),

  /**
   * Get available genres from Emby
   */
  embyGenres: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]).optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      if (!isEmbyFullyConfigured()) {
        return { genres: [], configured: false };
      }

      const genres = await getEmbyGenres(input?.type);

      return { genres, configured: true };
    }),

  /**
   * Get a single item from Emby by ID
   */
  embyItem: publicProcedure
    .input(
      z.object({
        itemId: z.string(),
      })
    )
    .query(async ({ input }) => {
      if (!isEmbyFullyConfigured()) {
        return { item: null, configured: false };
      }

      const item = await getEmbyItem(input.itemId);

      return { item, configured: true };
    }),
});
