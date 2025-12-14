import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getTMDBService } from "../services/tmdb.js";
import { prisma } from "../db/client.js";
import { getJobQueueService } from "../services/jobQueue.js";
import type { TrendingResult, MediaRatings } from "@annex/shared";
import { Prisma } from "@prisma/client";

const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const ITEMS_PER_PAGE = 20;

// TMDB genre ID to name mapping
// These names must match what's stored in the database (from TMDB API)
const GENRE_ID_TO_NAME: Record<number, string> = {
  // Movie genres
  28: "Action",
  12: "Adventure",
  16: "Animation",
  35: "Comedy",
  80: "Crime",
  99: "Documentary",
  18: "Drama",
  10751: "Family",
  14: "Fantasy",
  36: "History",
  27: "Horror",
  10402: "Music",
  9648: "Mystery",
  10749: "Romance",
  878: "Science Fiction", // Displayed as "Sci-Fi" in UI but stored as "Science Fiction"
  10770: "TV Movie",
  53: "Thriller",
  10752: "War",
  37: "Western",
  // TV genres (some overlap with movie)
  10759: "Action & Adventure",
  10762: "Kids",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
};

// Sort option mappings for Prisma orderBy
type PrismaOrderBy = Prisma.MediaItemOrderByWithRelationInput[];

function getSortOrder(sortBy: string): PrismaOrderBy {
  switch (sortBy) {
    case "popularity.desc":
      return [{ ratings: { tmdbPopularity: "desc" } }, { tmdbId: "desc" }];
    case "popularity.asc":
      return [{ ratings: { tmdbPopularity: "asc" } }, { tmdbId: "asc" }];
    case "vote_average.desc":
      return [{ ratings: { tmdbScore: "desc" } }, { tmdbId: "desc" }];
    case "vote_average.asc":
      return [{ ratings: { tmdbScore: "asc" } }, { tmdbId: "asc" }];
    case "primary_release_date.desc":
    case "first_air_date.desc":
      return [{ releaseDate: "desc" }, { tmdbId: "desc" }];
    case "primary_release_date.asc":
    case "first_air_date.asc":
      return [{ releaseDate: "asc" }, { tmdbId: "asc" }];
    case "title.asc":
      return [{ title: "asc" }, { tmdbId: "asc" }];
    case "title.desc":
      return [{ title: "desc" }, { tmdbId: "desc" }];
    default:
      return [{ ratings: { tmdbPopularity: "desc" } }, { tmdbId: "desc" }];
  }
}

/**
 * Queue a background refresh job for a media item if it's stale
 * Returns immediately without waiting for the refresh
 */
async function queueRefreshIfStale(
  tmdbId: number,
  type: "movie" | "tv"
): Promise<void> {
  const prismaType = type === "movie" ? "MOVIE" : "TV";
  const id = `tmdb-${type}-${tmdbId}`;

  const item = await prisma.mediaItem.findUnique({
    where: { id },
    select: { mdblistUpdatedAt: true },
  });

  // If item doesn't exist or hasn't been hydrated, queue hydration
  if (!item || !item.mdblistUpdatedAt) {
    const jobQueue = getJobQueueService();
    await jobQueue.addJobIfNotExists(
      "mdblist:hydrate",
      { tmdbId, type },
      `hydrate-${type}-${tmdbId}`,
      { priority: 5 } // Medium priority
    );
    return;
  }

  // Check if stale (older than 24 hours)
  const age = Date.now() - item.mdblistUpdatedAt.getTime();
  if (age > STALE_THRESHOLD_MS) {
    const jobQueue = getJobQueueService();
    await jobQueue.addJobIfNotExists(
      "mdblist:hydrate",
      { tmdbId, type },
      `hydrate-${type}-${tmdbId}`,
      { priority: 3 } // Lower priority for stale refreshes
    );
  }
}

/**
 * Queue refresh jobs for multiple items in batch
 */
async function queueBatchRefreshIfStale(
  items: Array<{ tmdbId: number; type: "movie" | "tv" }>
): Promise<void> {
  if (items.length === 0) return;

  const cutoffDate = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Get all items that need refresh
  const existingItems = await prisma.mediaItem.findMany({
    where: {
      OR: items.map((item) => ({
        id: `tmdb-${item.type}-${item.tmdbId}`,
      })),
    },
    select: { id: true, mdblistUpdatedAt: true },
  });

  const existingMap = new Map(
    existingItems.map((item) => [item.id, item.mdblistUpdatedAt])
  );

  // Find items that need hydration
  const needsHydration: Array<{ tmdbId: number; type: "movie" | "tv" }> = [];

  for (const item of items) {
    const id = `tmdb-${item.type}-${item.tmdbId}`;
    const mdblistUpdatedAt = existingMap.get(id);

    // Needs hydration if: doesn't exist, never hydrated, or stale
    if (!mdblistUpdatedAt || mdblistUpdatedAt < cutoffDate) {
      needsHydration.push(item);
    }
  }

  if (needsHydration.length > 0) {
    const jobQueue = getJobQueueService();
    // Use batch hydration for efficiency
    await jobQueue.addJobIfNotExists(
      "mdblist:batch-hydrate",
      { items: needsHydration },
      `batch-hydrate-${Date.now()}`,
      { priority: 3 }
    );
  }
}

/**
 * Extract the best trailer key from a videos array
 * Prefers official trailers, then teasers, from YouTube
 */
function extractTrailerKey(
  videos: Array<{ key: string; site: string; type: string; official?: boolean }> | null | undefined
): string | null {
  if (!videos || !Array.isArray(videos) || videos.length === 0) {
    return null;
  }

  // Filter to only YouTube videos
  const youtubeVideos = videos.filter((v) => v.site === "YouTube");
  if (youtubeVideos.length === 0) return null;

  // Prefer official trailers first
  const officialTrailer = youtubeVideos.find(
    (v) => v.type === "Trailer" && v.official === true
  );
  if (officialTrailer) return officialTrailer.key;

  // Then any trailer
  const anyTrailer = youtubeVideos.find((v) => v.type === "Trailer");
  if (anyTrailer) return anyTrailer.key;

  // Then teaser
  const teaser = youtubeVideos.find((v) => v.type === "Teaser");
  if (teaser) return teaser.key;

  return null;
}

/**
 * Transform a database MediaItem with ratings into a TrendingResult
 */
function mediaItemToTrendingResult(
  item: {
    tmdbId: number;
    type: "MOVIE" | "TV";
    title: string;
    posterPath: string | null;
    backdropPath: string | null;
    year: number | null;
    overview: string | null;
    videos?: unknown;
    ratings: {
      tmdbScore: number | null;
      imdbScore: number | null;
      rtCriticScore: number | null;
      rtAudienceScore: number | null;
      metacriticScore: number | null;
      traktScore: number | null;
      letterboxdScore: number | null;
      mdblistScore: number | null;
      aggregateScore: number | null;
      tmdbPopularity: number | null;
    } | null;
  }
): TrendingResult {
  // Extract trailer key from videos JSON
  const trailerKey = extractTrailerKey(
    item.videos as Array<{ key: string; site: string; type: string; official?: boolean }> | null
  );

  return {
    type: item.type === "MOVIE" ? "movie" : "tv",
    tmdbId: item.tmdbId,
    title: item.title,
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
    year: item.year ?? 0,
    voteAverage: item.ratings?.tmdbScore ?? 0,
    overview: item.overview ?? "",
    ratings: item.ratings ? {
      tmdbScore: item.ratings.tmdbScore,
      imdbScore: item.ratings.imdbScore,
      rtCriticScore: item.ratings.rtCriticScore,
      rtAudienceScore: item.ratings.rtAudienceScore,
      metacriticScore: item.ratings.metacriticScore,
      traktScore: item.ratings.traktScore,
      letterboxdScore: item.ratings.letterboxdScore,
      mdblistScore: item.ratings.mdblistScore,
      aggregateScore: item.ratings.aggregateScore,
    } : undefined,
    trailerKey,
  };
}

export const discoveryRouter = router({
  /**
   * Get trending movies or TV shows from local database
   * Sorted by popularity (tmdbPopularity) which reflects current trending
   * Falls back to TMDB API if local database has insufficient data
   */
  trending: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]),
        page: z.number().min(1).default(1),
        timeWindow: z.enum(["day", "week"]).default("week"),
      })
    )
    .query(async ({ input }) => {
      const prismaType = input.type === "movie" ? "MOVIE" : "TV";
      const skip = (input.page - 1) * ITEMS_PER_PAGE;

      // Query local database for items with ratings, sorted by popularity
      // Include both MDBList-hydrated items and TMDB-only items (which have ratings but no mdblistUpdatedAt)
      // Filter out items without useful data (no poster, TBA titles, etc.)
      const [items, totalCount] = await Promise.all([
        prisma.mediaItem.findMany({
          where: {
            type: prismaType,
            ratings: { isNot: null }, // Has ratings (from either MDBList or TMDB)
            posterPath: { not: null }, // Must have a poster
            title: {
              not: { in: ["TBA", "TBD", "Untitled", ""] },
            },
            year: { not: null }, // Must have a year
          },
          select: {
            tmdbId: true,
            type: true,
            title: true,
            posterPath: true,
            backdropPath: true,
            year: true,
            overview: true,
            videos: true,
            ratings: true,
          },
          orderBy: [
            { ratings: { tmdbPopularity: "desc" } },
            { tmdbId: "desc" }, // Secondary sort for stable ordering
          ],
          skip,
          take: ITEMS_PER_PAGE,
        }),
        prisma.mediaItem.count({
          where: {
            type: prismaType,
            ratings: { isNot: null },
            posterPath: { not: null },
            title: {
              not: { in: ["TBA", "TBD", "Untitled", ""] },
            },
            year: { not: null },
          },
        }),
      ]);

      // If we have local data, use it
      if (items.length > 0) {
        const results: TrendingResult[] = items.map(mediaItemToTrendingResult);

        // Queue background refresh for stale items (fire and forget)
        const staleItems = items.map((item) => ({
          tmdbId: item.tmdbId,
          type: input.type,
        }));
        queueBatchRefreshIfStale(staleItems).catch(console.error);

        return {
          results,
          page: input.page,
          totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE),
          totalResults: totalCount,
        };
      }

      // Fallback to TMDB API if no local data
      const tmdb = getTMDBService();
      const result = await tmdb.getTrending(input.type, input.timeWindow, input.page);

      // Queue background refresh for stale items (fire and forget)
      const tmdbItems = result.results.map((item) => ({
        tmdbId: item.tmdbId,
        type: input.type,
      }));
      queueBatchRefreshIfStale(tmdbItems).catch(console.error);

      return result;
    }),

  /**
   * Search for movies or TV shows
   * Searches local database first, falls back to TMDB API
   */
  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1),
        type: z.enum(["movie", "tv", "multi"]).default("multi"),
        page: z.number().min(1).default(1),
      })
    )
    .query(async ({ input }) => {
      const skip = (input.page - 1) * ITEMS_PER_PAGE;

      // Build the type filter
      const typeFilter = input.type === "multi"
        ? {}
        : { type: input.type === "movie" ? "MOVIE" as const : "TV" as const };

      // Search local database first using case-insensitive title match
      // Include both MDBList-hydrated items and TMDB-only items
      // Filter out items without useful data (no poster, TBA titles, etc.)
      const [items, totalCount] = await Promise.all([
        prisma.mediaItem.findMany({
          where: {
            ...typeFilter,
            ratings: { isNot: null },
            posterPath: { not: null },
            year: { not: null },
            title: {
              contains: input.query,
              mode: "insensitive",
              not: { in: ["TBA", "TBD", "Untitled", ""] },
            },
          },
          select: {
            tmdbId: true,
            type: true,
            title: true,
            posterPath: true,
            backdropPath: true,
            year: true,
            overview: true,
            videos: true,
            ratings: true,
          },
          orderBy: [
            { ratings: { tmdbPopularity: "desc" } },
            { tmdbId: "desc" }, // Secondary sort for stable ordering
          ],
          skip,
          take: ITEMS_PER_PAGE,
        }),
        prisma.mediaItem.count({
          where: {
            ...typeFilter,
            ratings: { isNot: null },
            posterPath: { not: null },
            year: { not: null },
            title: {
              contains: input.query,
              mode: "insensitive",
              not: { in: ["TBA", "TBD", "Untitled", ""] },
            },
          },
        }),
      ]);

      // If we have local results, use them
      if (items.length > 0) {
        const results: TrendingResult[] = items.map(mediaItemToTrendingResult);
        return {
          results,
          page: input.page,
          totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE),
          totalResults: totalCount,
        };
      }

      // Fallback to TMDB API if no local results
      const tmdb = getTMDBService();
      const result = await tmdb.search(input.query, input.type, input.page);

      // Queue background hydration for search results
      const tmdbItems = result.results.map((item) => ({
        tmdbId: item.tmdbId,
        type: item.type,
      }));
      queueBatchRefreshIfStale(tmdbItems).catch(console.error);

      return result;
    }),

  /**
   * Get movie details by TMDB ID
   * Automatically queues refresh if data is stale (>24 hours)
   */
  movie: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.getMovie(input.tmdbId);

      // Queue background refresh if stale (fire and forget)
      queueRefreshIfStale(input.tmdbId, "movie").catch(console.error);

      return result;
    }),

  /**
   * Get TV show details by TMDB ID
   * Automatically queues refresh if data is stale (>24 hours)
   */
  tvShow: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.getTvShow(input.tmdbId);

      // Queue background refresh if stale (fire and forget)
      queueRefreshIfStale(input.tmdbId, "tv").catch(console.error);

      return result;
    }),

  /**
   * Get extended movie details including videos, credits, spoken languages
   * Automatically queues refresh if data is stale (>24 hours)
   */
  movieDetails: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.getMovieDetails(input.tmdbId);

      // Queue background refresh if stale (fire and forget)
      queueRefreshIfStale(input.tmdbId, "movie").catch(console.error);

      return result;
    }),

  /**
   * Get extended TV show details including videos, credits, spoken languages
   * Automatically queues refresh if data is stale (>24 hours)
   */
  tvShowDetails: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.getTvShowDetails(input.tmdbId);

      // Queue background refresh if stale (fire and forget)
      queueRefreshIfStale(input.tmdbId, "tv").catch(console.error);

      return result;
    }),

  /**
   * Get ratings for a media item from local database
   * Returns all available ratings (TMDB, IMDb, RT, Metacritic, Trakt, Letterboxd, MDBList)
   */
  ratings: publicProcedure
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

      if (!item?.ratings) {
        // Queue hydration if not in database
        queueRefreshIfStale(input.tmdbId, input.type).catch(console.error);
        return null;
      }

      return {
        tmdbScore: item.ratings.tmdbScore,
        tmdbPopularity: item.ratings.tmdbPopularity,
        imdbScore: item.ratings.imdbScore,
        imdbVotes: item.ratings.imdbVotes,
        rtCriticScore: item.ratings.rtCriticScore,
        rtAudienceScore: item.ratings.rtAudienceScore,
        metacriticScore: item.ratings.metacriticScore,
        traktScore: item.ratings.traktScore,
        letterboxdScore: item.ratings.letterboxdScore,
        mdblistScore: item.ratings.mdblistScore,
        aggregateScore: item.ratings.aggregateScore,
        updatedAt: item.mdblistUpdatedAt,
      };
    }),

  /**
   * Get TV season details with episodes
   */
  season: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        seasonNumber: z.number(),
      })
    )
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      return tmdb.getSeason(input.tmdbId, input.seasonNumber);
    }),

  /**
   * Discover movies with filters
   * Automatically queues stale items for background refresh
   */
  discoverMovies: publicProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        sortBy: z.string().optional(),
        year: z.number().optional(),
        withGenres: z.string().optional(),
        voteAverageGte: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.discoverMovies(input);

      // Queue background refresh for stale items
      const items = result.results.map((item) => ({
        tmdbId: item.tmdbId,
        type: "movie" as const,
      }));
      queueBatchRefreshIfStale(items).catch(console.error);

      return result;
    }),

  /**
   * Discover TV shows with filters
   * Automatically queues stale items for background refresh
   */
  discoverTvShows: publicProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        sortBy: z.string().optional(),
        year: z.number().optional(),
        withGenres: z.string().optional(),
        voteAverageGte: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.discoverTvShows(input);

      // Queue background refresh for stale items
      const items = result.results.map((item) => ({
        tmdbId: item.tmdbId,
        type: "tv" as const,
      }));
      queueBatchRefreshIfStale(items).catch(console.error);

      return result;
    }),

  /**
   * Get popular movies
   * Automatically queues stale items for background refresh
   */
  popularMovies: publicProcedure
    .input(z.object({ page: z.number().min(1).default(1) }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.getPopularMovies(input.page);

      // Queue background refresh for stale items
      const items = result.results.map((item) => ({
        tmdbId: item.tmdbId,
        type: "movie" as const,
      }));
      queueBatchRefreshIfStale(items).catch(console.error);

      return result;
    }),

  /**
   * Get popular TV shows
   * Automatically queues stale items for background refresh
   */
  popularTvShows: publicProcedure
    .input(z.object({ page: z.number().min(1).default(1) }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const result = await tmdb.getPopularTvShows(input.page);

      // Queue background refresh for stale items
      const items = result.results.map((item) => ({
        tmdbId: item.tmdbId,
        type: "tv" as const,
      }));
      queueBatchRefreshIfStale(items).catch(console.error);

      return result;
    }),

  /**
   * Advanced discover endpoint with comprehensive filtering
   * Queries local database with support for genres, year range, ratings, and sorting
   * Falls back to TMDB API if local database has insufficient data
   */
  discover: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]),
        page: z.number().min(1).default(1),
        query: z.string().optional(),
        genres: z.array(z.number()).optional(),
        yearFrom: z.number().optional(),
        yearTo: z.number().optional(),
        // Multiple rating filters - each source can have min/max
        ratingFilters: z.record(
          z.enum([
            "imdb", "tmdb", "rt_critic", "rt_audience",
            "metacritic", "trakt", "letterboxd", "mdblist"
          ]),
          z.object({
            min: z.number(),
            max: z.number(),
          })
        ).optional(),
        language: z.string().optional(), // ISO 639-1 language code (e.g., "en", "ja")
        releasedOnly: z.boolean().optional(), // Filter to only show released content
        hideUnrated: z.boolean().default(true), // Hide media without any ratings (default: true)
        sortBy: z.string().default("popularity.desc"),
      })
    )
    .query(async ({ input }) => {
      const prismaType = input.type === "movie" ? "MOVIE" : "TV";
      const skip = (input.page - 1) * ITEMS_PER_PAGE;

      // Build where clause
      const where: Prisma.MediaItemWhereInput = {
        type: prismaType,
        ratings: { isNot: null },
        posterPath: { not: null },
        title: {
          not: { in: ["TBA", "TBD", "Untitled", ""] },
        },
        year: { not: null },
      };

      // Search query filter (title search)
      if (input.query && input.query.trim()) {
        where.title = {
          contains: input.query.trim(),
          mode: "insensitive",
          not: { in: ["TBA", "TBD", "Untitled", ""] },
        };
      }

      // Genre filter - matches if ANY of the genres are present
      // Convert genre IDs to names for database query
      if (input.genres && input.genres.length > 0) {
        const genreNames = input.genres
          .map(id => GENRE_ID_TO_NAME[id])
          .filter(Boolean); // Remove any unmapped IDs

        if (genreNames.length > 0) {
          where.genres = {
            hasSome: genreNames,
          };
        }
      }

      // Year range filter
      if (input.yearFrom !== undefined || input.yearTo !== undefined) {
        where.year = {
          ...(input.yearFrom !== undefined ? { gte: input.yearFrom } : {}),
          ...(input.yearTo !== undefined ? { lte: input.yearTo } : {}),
          not: null,
        };
      }

      // Multi-source rating filters with min/max ranges
      // Maps rating source IDs to their Prisma field names
      if (input.ratingFilters && Object.keys(input.ratingFilters).length > 0) {
        const ratingFieldMap: Record<string, string> = {
          imdb: "imdbScore",
          tmdb: "tmdbScore",
          rt_critic: "rtCriticScore",
          rt_audience: "rtAudienceScore",
          metacritic: "metacriticScore",
          trakt: "traktScore",
          letterboxd: "letterboxdScore",
          mdblist: "mdblistScore",
        };

        // Get the default max values for each source
        const sourceMaxValues: Record<string, number> = {
          imdb: 10,
          tmdb: 10,
          rt_critic: 100,
          rt_audience: 100,
          metacritic: 100,
          trakt: 100,
          letterboxd: 100,
          mdblist: 100,
        };

        // Build rating conditions - all must match (AND logic)
        const ratingConditions: Prisma.MediaRatingsWhereInput = {};

        for (const [sourceId, range] of Object.entries(input.ratingFilters)) {
          const field = ratingFieldMap[sourceId];
          const maxValue = sourceMaxValues[sourceId] ?? 100;

          if (field) {
            // Build conditions for this field
            // Always require the field to not be null when filtering on it
            const conditions: { not?: null; gte?: number; lte?: number } = {
              not: null, // Exclude items without this rating
            };

            if (range.min > 0) {
              conditions.gte = range.min;
            }
            if (range.max < maxValue) {
              conditions.lte = range.max;
            }

            (ratingConditions as Record<string, unknown>)[field] = conditions;
          }
        }

        if (Object.keys(ratingConditions).length > 0) {
          where.ratings = {
            is: ratingConditions,
          };
        }
      }

      // Language filter
      if (input.language) {
        where.language = input.language;
      }

      // Released only filter
      // Matches status values like "Released", "released", "Ended", "Returning Series"
      // Excludes "In Production", "Planned", "Post Production", "Rumored"
      if (input.releasedOnly) {
        where.status = {
          in: ["Released", "released", "Ended", "Returning Series", "Canceled", "Cancelled"],
        };
      }

      // Hide unrated filter - requires at least one non-zero rating score to be present
      if (input.hideUnrated) {
        // Add condition to require at least one rating score that is not null AND greater than 0
        // This filters out both null ratings and 0.0 placeholder ratings
        // The OR must be inside 'is' for relation filters in Prisma
        const existingRatingsIs = (where.ratings as { is?: Prisma.MediaRatingsWhereInput })?.is || {};
        where.ratings = {
          is: {
            ...existingRatingsIs,
            OR: [
              { imdbScore: { gt: 0 } },
              { tmdbScore: { gt: 0 } },
              { rtCriticScore: { gt: 0 } },
              { rtAudienceScore: { gt: 0 } },
              { metacriticScore: { gt: 0 } },
              { traktScore: { gt: 0 } },
              { letterboxdScore: { gt: 0 } },
              { mdblistScore: { gt: 0 } },
            ],
          },
        };
      }

      // Get sort order
      const orderBy = getSortOrder(input.sortBy);

      // Query local database
      const [items, totalCount] = await Promise.all([
        prisma.mediaItem.findMany({
          where,
          select: {
            tmdbId: true,
            type: true,
            title: true,
            posterPath: true,
            backdropPath: true,
            year: true,
            overview: true,
            videos: true,
            ratings: true,
          },
          orderBy,
          skip,
          take: ITEMS_PER_PAGE,
        }),
        prisma.mediaItem.count({ where }),
      ]);

      // Always return local data - don't fall back to TMDB mid-pagination
      // This ensures consistent totalResults across all pages
      const results: TrendingResult[] = items.map(mediaItemToTrendingResult);

      // Queue background refresh for stale items (fire and forget)
      if (items.length > 0) {
        const staleItems = items.map((item) => ({
          tmdbId: item.tmdbId,
          type: input.type,
        }));
        queueBatchRefreshIfStale(staleItems).catch(console.error);
      }

      return {
        results,
        page: input.page,
        totalPages: Math.ceil(totalCount / ITEMS_PER_PAGE),
        totalResults: totalCount,
      };
    }),

  /**
   * Get available genres from the local database
   * Returns distinct genres that exist in the database
   */
  availableGenres: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]),
      })
    )
    .query(async ({ input }) => {
      const prismaType = input.type === "movie" ? "MOVIE" : "TV";

      // Get all unique genres from media items
      const items = await prisma.mediaItem.findMany({
        where: {
          type: prismaType,
          genres: { isEmpty: false },
        },
        select: {
          genres: true,
        },
        take: 10000, // Limit to prevent memory issues
      });

      // Aggregate and count genres
      const genreCounts = new Map<string, number>();
      for (const item of items) {
        for (const genre of item.genres) {
          genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
        }
      }

      // Convert to array and sort by count
      return Array.from(genreCounts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    }),

  /**
   * Get trailer video for a media item
   * Returns the best available YouTube trailer (prefers official trailers)
   */
  getTrailer: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        type: z.enum(["movie", "tv"]),
      })
    )
    .query(async ({ input }) => {
      const id = `tmdb-${input.type}-${input.tmdbId}`;

      // First try to get from local database
      const item = await prisma.mediaItem.findUnique({
        where: { id },
        select: { videos: true },
      });

      if (item?.videos && Array.isArray(item.videos) && item.videos.length > 0) {
        const videos = item.videos as Array<{ key: string; name: string; site: string; type: string }>;
        const trailer = videos.find((v) => v.type === "Trailer" || v.type === "Teaser");
        if (trailer) {
          return {
            key: trailer.key,
            name: trailer.name,
            site: trailer.site,
            type: trailer.type,
          };
        }
      }

      // Fall back to TMDB API if not in database
      const tmdb = getTMDBService();
      const details = input.type === "movie"
        ? await tmdb.getMovieDetails(input.tmdbId)
        : await tmdb.getTvShowDetails(input.tmdbId);

      const trailer = details.videos.find(
        (v) => v.type === "Trailer" || v.type === "Teaser"
      );

      if (!trailer) {
        return null;
      }

      return {
        key: trailer.key,
        name: trailer.name,
        site: trailer.site,
        type: trailer.type,
      };
    }),

  /**
   * Get movie details from local database only
   * Returns null if not found or not fully hydrated
   */
  movieDetailsLocal: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const id = `tmdb-movie-${input.tmdbId}`;

      const item = await prisma.mediaItem.findUnique({
        where: { id },
        include: { ratings: true },
      });

      if (!item) {
        return null;
      }

      // Transform to MovieDetails shape
      return {
        tmdbId: item.tmdbId,
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year ?? 0,
        overview: item.overview ?? "",
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        releaseDate: item.releaseDate ?? "",
        runtime: item.runtime,
        genres: item.genres,
        voteAverage: item.ratings?.tmdbScore ?? 0,
        voteCount: item.ratings?.tmdbVotes ?? 0,
        tagline: item.tagline,
        budget: item.budget ? Number(item.budget) : null,
        revenue: item.revenue ? Number(item.revenue) : null,
        originalLanguage: item.language,
        spokenLanguages: (item.spokenLanguages || []).map((iso) => ({
          englishName: iso,
          iso,
          name: iso,
        })),
        productionCompanies: (item.productionCompanies as Array<{
          id: number;
          name: string;
          logoPath: string | null;
          originCountry: string;
        }>) || [],
        productionCountries: item.productionCountries || [],
        videos: (item.videos as Array<{
          id: string;
          key: string;
          name: string;
          site: string;
          type: string;
          official: boolean;
        }>) || [],
        cast: (item.cast as Array<{
          id: number;
          name: string;
          character: string;
          profilePath: string | null;
          order: number;
        }>) || [],
        crew: (item.crew as Array<{
          id: number;
          name: string;
          job: string;
          department: string;
          profilePath: string | null;
        }>) || [],
        director: item.director,
        imdbId: item.imdbId,
        // Include ratings
        ratings: item.ratings ? {
          tmdbScore: item.ratings.tmdbScore,
          imdbScore: item.ratings.imdbScore,
          rtCriticScore: item.ratings.rtCriticScore,
          rtAudienceScore: item.ratings.rtAudienceScore,
          metacriticScore: item.ratings.metacriticScore,
          traktScore: item.ratings.traktScore,
          letterboxdScore: item.ratings.letterboxdScore,
          mdblistScore: item.ratings.mdblistScore,
          aggregateScore: item.ratings.aggregateScore,
        } : null,
        // Hydration status
        isFullyHydrated: item.tmdbUpdatedAt !== null,
        tmdbUpdatedAt: item.tmdbUpdatedAt,
      };
    }),

  /**
   * Get TV show details from local database only
   * Returns null if not found
   */
  tvShowDetailsLocal: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const id = `tmdb-tv-${input.tmdbId}`;

      const item = await prisma.mediaItem.findUnique({
        where: { id },
        include: {
          ratings: true,
          seasons: {
            include: {
              episodes: {
                orderBy: { episodeNumber: "asc" },
              },
            },
            orderBy: { seasonNumber: "asc" },
          },
        },
      });

      if (!item) {
        return null;
      }

      // Transform to TvShowDetails shape
      return {
        tmdbId: item.tmdbId,
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year ?? 0,
        overview: item.overview ?? "",
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        firstAirDate: item.releaseDate ?? "",
        lastAirDate: null, // Not stored separately
        status: (item.status as "Returning Series" | "Ended" | "Canceled" | "In Production") ?? "Returning Series",
        genres: item.genres,
        voteAverage: item.ratings?.tmdbScore ?? 0,
        voteCount: item.ratings?.tmdbVotes ?? 0,
        numberOfSeasons: item.numberOfSeasons ?? 0,
        numberOfEpisodes: item.numberOfEpisodes ?? 0,
        tagline: item.tagline,
        originalLanguage: item.language,
        spokenLanguages: (item.spokenLanguages || []).map((iso) => ({
          englishName: iso,
          iso,
          name: iso,
        })),
        productionCompanies: (item.productionCompanies as Array<{
          id: number;
          name: string;
          logoPath: string | null;
          originCountry: string;
        }>) || [],
        productionCountries: item.productionCountries || [],
        networks: (item.networks as Array<{
          id: number;
          name: string;
          logoPath: string | null;
          originCountry: string;
        }>) || [],
        createdBy: item.createdBy || [],
        videos: (item.videos as Array<{
          id: string;
          key: string;
          name: string;
          site: string;
          type: string;
          official: boolean;
        }>) || [],
        cast: (item.cast as Array<{
          id: number;
          name: string;
          character: string;
          profilePath: string | null;
          order: number;
        }>) || [],
        crew: (item.crew as Array<{
          id: number;
          name: string;
          job: string;
          department: string;
          profilePath: string | null;
        }>) || [],
        imdbId: item.imdbId,
        // Include ratings
        ratings: item.ratings ? {
          tmdbScore: item.ratings.tmdbScore,
          imdbScore: item.ratings.imdbScore,
          rtCriticScore: item.ratings.rtCriticScore,
          rtAudienceScore: item.ratings.rtAudienceScore,
          metacriticScore: item.ratings.metacriticScore,
          traktScore: item.ratings.traktScore,
          letterboxdScore: item.ratings.letterboxdScore,
          mdblistScore: item.ratings.mdblistScore,
          aggregateScore: item.ratings.aggregateScore,
        } : null,
        // Include seasons with episodes
        seasons: item.seasons.map((season) => ({
          seasonNumber: season.seasonNumber,
          name: season.name,
          overview: season.overview,
          posterPath: season.posterPath,
          airDate: season.airDate,
          episodeCount: season.episodeCount,
          episodes: season.episodes.map((ep) => ({
            episodeNumber: ep.episodeNumber,
            seasonNumber: ep.seasonNumber,
            name: ep.name,
            overview: ep.overview,
            stillPath: ep.stillPath,
            airDate: ep.airDate,
            runtime: ep.runtime,
          })),
        })),
        // Hydration status
        isFullyHydrated: item.tmdbUpdatedAt !== null,
        tmdbUpdatedAt: item.tmdbUpdatedAt,
      };
    }),

  /**
   * Get TV season with episodes from local database
   * Returns null if not found
   */
  seasonLocal: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        seasonNumber: z.number(),
      })
    )
    .query(async ({ input }) => {
      const mediaItemId = `tmdb-tv-${input.tmdbId}`;

      const season = await prisma.season.findUnique({
        where: {
          mediaItemId_seasonNumber: {
            mediaItemId,
            seasonNumber: input.seasonNumber,
          },
        },
        include: {
          episodes: {
            orderBy: { episodeNumber: "asc" },
          },
        },
      });

      if (!season) {
        return null;
      }

      return {
        seasonNumber: season.seasonNumber,
        name: season.name,
        overview: season.overview ?? "",
        posterPath: season.posterPath,
        airDate: season.airDate,
        episodeCount: season.episodeCount,
        episodes: season.episodes.map((ep) => ({
          episodeNumber: ep.episodeNumber,
          seasonNumber: ep.seasonNumber,
          name: ep.name,
          overview: ep.overview ?? "",
          stillPath: ep.stillPath,
          airDate: ep.airDate,
          runtime: ep.runtime,
        })),
      };
    }),

  /**
   * Get all seasons for a TV show from local database
   */
  seasonsLocal: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const mediaItemId = `tmdb-tv-${input.tmdbId}`;

      const seasons = await prisma.season.findMany({
        where: { mediaItemId },
        orderBy: { seasonNumber: "asc" },
        include: {
          episodes: {
            orderBy: { episodeNumber: "asc" },
          },
        },
      });

      return seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        name: season.name,
        overview: season.overview ?? "",
        posterPath: season.posterPath,
        airDate: season.airDate,
        episodeCount: season.episodeCount,
        episodes: season.episodes.map((ep) => ({
          episodeNumber: ep.episodeNumber,
          seasonNumber: ep.seasonNumber,
          name: ep.name,
          overview: ep.overview ?? "",
          stillPath: ep.stillPath,
          airDate: ep.airDate,
          runtime: ep.runtime,
        })),
      }));
    }),

  /**
   * Queue TMDB hydration for a single media item
   * Use this when a user navigates to a detail page and data is missing
   */
  hydrateMedia: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        type: z.enum(["movie", "tv"]),
        includeSeasons: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const jobQueue = getJobQueueService();

      const job = await jobQueue.addJobIfNotExists(
        "tmdb:hydrate",
        {
          tmdbId: input.tmdbId,
          type: input.type,
          includeSeasons: input.includeSeasons,
        },
        `tmdb-hydrate-${input.type}-${input.tmdbId}`,
        { priority: 10 } // High priority for user-requested hydration
      );

      if (!job) {
        return {
          message: "Hydration already in progress",
          jobId: null,
          alreadyQueued: true,
        };
      }

      return {
        message: "Hydration queued",
        jobId: job.id,
        alreadyQueued: false,
      };
    }),
});
