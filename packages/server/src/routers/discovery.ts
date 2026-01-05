import crypto from "node:crypto";
import type { TrendingResult } from "@annex/shared";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getJobQueueService } from "../services/jobQueue.js";
import { getLibraryStatusService } from "../services/libraryStatus.js";
import { getTMDBService } from "../services/tmdb.js";
import {
  getTraktService,
  type TraktEpisodeDetails,
  type TraktListType,
  type TraktPeriod,
} from "../services/trakt.js";
import { publicProcedure, router } from "../trpc.js";

const ITEMS_PER_PAGE = 20;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// =============================================================================
// Cache Helper Functions
// =============================================================================

/**
 * Fetch Trakt list, hydrate with status, and update cache
 * Can be called from endpoint (cache miss) or background job (refresh)
 */
export async function refreshTraktListCache(
  input: {
    listType: string;
    type: "movie" | "tv";
    page: number;
    period?: string;
    query?: string;
    years?: string;
    genres?: string[];
    languages?: string[];
    countries?: string[];
    runtimes?: string;
    certifications?: string[];
    ratings?: string;
    tmdbRatings?: string;
    imdbRatings?: string;
    rtMeters?: string;
    rtUserMeters?: string;
    metascores?: string;
  },
  filterHash: string | null
): Promise<void> {
  const trakt = getTraktService();

  // Build filter params for Trakt API
  const filters = {
    years: input.years,
    genres: input.genres?.join(","),
    languages: input.languages?.join(","),
    countries: input.countries?.join(","),
    runtimes: input.runtimes,
    certifications: input.certifications?.join(","),
    ratings: input.ratings,
    tmdb_ratings: input.tmdbRatings,
    imdb_ratings: input.imdbRatings,
    rt_meters: input.rtMeters,
    rt_user_meters: input.rtUserMeters,
    metascores: input.metascores,
  };

  // Fetch from Trakt
  let traktItems: Awaited<ReturnType<typeof trakt.search>>;
  if (input.query?.trim()) {
    traktItems = await trakt.search(input.query, input.type, input.page, ITEMS_PER_PAGE, filters);
  } else {
    traktItems = await trakt.getList(
      input.listType as TraktListType,
      input.type,
      input.page,
      ITEMS_PER_PAGE,
      input.period as TraktPeriod,
      filters
    );
  }

  // Batch hydrate library/request status
  const libraryStatusService = getLibraryStatusService();
  const status = await libraryStatusService.getBatchStatus(
    traktItems.map((item) => ({ tmdbId: item.tmdbId, type: item.type }))
  );

  // Batch fetch from our database to enrich with ratings and trailer info
  const mediaItemIds = traktItems.map((item) => `tmdb-${item.type}-${item.tmdbId}`);

  const localItems = await prisma.mediaItem.findMany({
    where: { id: { in: mediaItemIds } },
    select: {
      id: true,
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
  });

  type LocalMediaItem = Prisma.MediaItemGetPayload<{
    select: {
      id: true;
      tmdbId: true;
      type: true;
      title: true;
      posterPath: true;
      backdropPath: true;
      year: true;
      overview: true;
      videos: true;
      ratings: true;
    };
  }>;

  // Create lookup map
  const localMap = new Map<string, LocalMediaItem>(
    localItems.map((item: LocalMediaItem) => [item.id, item])
  );

  // Build results with hydrated status
  const results: TrendingResult[] = traktItems.map((traktItem) => {
    const localId = `tmdb-${traktItem.type}-${traktItem.tmdbId}`;
    const local: LocalMediaItem | undefined = localMap.get(localId);
    const key = `${traktItem.type}-${traktItem.tmdbId}`;

    const baseResult =
      local && local.ratings !== undefined
        ? mediaItemToTrendingResult(local)
        : mediaItemToTrendingResult({
            type: (traktItem.type === "movie" ? "MOVIE" : "TV") as "MOVIE" | "TV",
            tmdbId: traktItem.tmdbId,
            title: traktItem.title,
            posterPath: traktItem.posterUrl || null,
            backdropPath: traktItem.fanartUrl || null,
            year: traktItem.year,
            overview: "",
            ratings: null,
          });

    // Add hydrated status
    return {
      ...baseResult,
      inLibrary: status.inLibrary[key] || null,
      requestStatus: status.requestStatus[key] || null,
    };
  });

  // Trakt doesn't give us total count, estimate based on whether we got a full page
  const hasMore = traktItems.length === ITEMS_PER_PAGE;
  const totalPages = hasMore ? input.page + 1 : input.page;
  const totalResults = hasMore ? (input.page + 1) * ITEMS_PER_PAGE : input.page * traktItems.length;

  // Upsert cache (create or update)
  await prisma.traktListCache.upsert({
    where: {
      listType_mediaType_page_period_filterHash: {
        listType: input.listType,
        mediaType: input.type,
        page: input.page,
        period: input.period || "",
        filterHash: filterHash || "",
      },
    },
    create: {
      listType: input.listType,
      mediaType: input.type,
      page: input.page,
      period: input.period || "",
      filterHash: filterHash || "",
      results: results as unknown as Prisma.InputJsonValue,
      totalPages,
      totalResults,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    },
    update: {
      results: results as unknown as Prisma.InputJsonValue,
      totalPages,
      totalResults,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    },
  });

  console.log(
    `[TraktCache] Updated cache: ${input.listType}/${input.type}/page${input.page} (${results.length} items)`
  );

  // Queue background job to hydrate items without ratings
  const itemsToHydrate = traktItems
    .filter((item) => {
      const localId = `tmdb-${item.type}-${item.tmdbId}`;
      const local: LocalMediaItem | undefined = localMap.get(localId);
      return !local || !local.ratings;
    })
    .map((item) => ({
      tmdbId: item.tmdbId,
      type: item.type as "movie" | "tv",
    }));

  if (itemsToHydrate.length > 0) {
    const { getMDBListService } = await import("../services/mdblist.js");
    const mdblist = getMDBListService();
    const isMdblistConfigured = await mdblist.isConfigured();

    if (isMdblistConfigured) {
      const jobQueue = getJobQueueService();
      jobQueue
        .addJobIfNotExists(
          "mdblist:hydrate-discover",
          { items: itemsToHydrate },
          `mdblist:hydrate-discover:${input.type}:${input.listType}:${input.page}`,
          { priority: 1, maxAttempts: 2 }
        )
        .catch((err) => {
          console.error("[Discover] Failed to queue hydration job:", err);
        });
    }
  }
}

/**
 * Build deterministic MD5 hash of filter parameters for cache key
 * Returns null if no filters are active (no hash needed)
 */
function buildFilterHash(filters: {
  years?: string;
  genres?: string[];
  languages?: string[];
  countries?: string[];
  runtimes?: string;
  certifications?: string[];
  ratings?: string;
  tmdbRatings?: string;
  imdbRatings?: string;
  rtMeters?: string;
  rtUserMeters?: string;
  metascores?: string;
  query?: string;
}): string | null {
  // Check if any filters are active
  const hasFilters =
    filters.query ||
    filters.years ||
    filters.genres?.length ||
    filters.languages?.length ||
    filters.countries?.length ||
    filters.runtimes ||
    filters.certifications?.length ||
    filters.ratings ||
    filters.tmdbRatings ||
    filters.imdbRatings ||
    filters.rtMeters ||
    filters.rtUserMeters ||
    filters.metascores;

  if (!hasFilters) {
    return null;
  }

  // Sort arrays for consistent hashing
  const normalized = {
    certifications: filters.certifications?.sort(),
    countries: filters.countries?.sort(),
    genres: filters.genres?.sort(),
    imdbRatings: filters.imdbRatings,
    languages: filters.languages?.sort(),
    metascores: filters.metascores,
    query: filters.query,
    ratings: filters.ratings,
    rtMeters: filters.rtMeters,
    rtUserMeters: filters.rtUserMeters,
    runtimes: filters.runtimes,
    tmdbRatings: filters.tmdbRatings,
    years: filters.years,
  };

  const filterString = JSON.stringify(normalized);
  return crypto.createHash("md5").update(filterString).digest("hex");
}

// =============================================================================
// MDBList Rating Type
// =============================================================================

interface MDBListRating {
  source: string;
  value: number;
  score: number;
  votes: number;
}

function extractMDBListRatings(data: { ratings?: MDBListRating[]; score?: number }): {
  imdbScore: number | null;
  rtCriticScore: number | null;
  rtAudienceScore: number | null;
  metacriticScore: number | null;
  traktScore: number | null;
  letterboxdScore: number | null;
  mdblistScore: number | null;
} {
  const ratings = data.ratings || [];

  const findRating = (source: string): number | null => {
    const rating = ratings.find((r) => r.source.toLowerCase() === source.toLowerCase());
    return rating?.score ?? null;
  };

  return {
    imdbScore: findRating("imdb"),
    rtCriticScore: findRating("tomatoes"),
    rtAudienceScore: findRating("tomatoesaudience"),
    metacriticScore: findRating("metacritic"),
    traktScore: findRating("trakt"),
    letterboxdScore: findRating("letterboxd"),
    mdblistScore: data.score ?? null,
  };
}

// =============================================================================
// Trakt Image Helper
// =============================================================================

interface TraktImageArray {
  poster?: string[];
  fanart?: string[];
  banner?: string[];
  thumb?: string[];
  screenshot?: string[]; // Used for episode images
}

function extractTraktImage(
  images: TraktImageArray | undefined,
  type: "poster" | "fanart" | "banner" | "thumb" | "screenshot"
): string | null {
  const url = images?.[type]?.[0];
  if (!url) return null;
  return url.startsWith("http") ? url : `https://${url}`;
}

// Get backdrop - try fanart first, fall back to banner
function _extractTraktBackdrop(images: TraktImageArray | undefined): string | null {
  return extractTraktImage(images, "fanart") || extractTraktImage(images, "banner");
}

// Get episode still - try screenshot first, then thumb
function extractEpisodeStill(images: TraktImageArray | undefined): string | null {
  return extractTraktImage(images, "screenshot") || extractTraktImage(images, "thumb");
}

// =============================================================================
// Season Update Helper
// =============================================================================

async function updateSeasonEpisodes(
  mediaItemId: string,
  seasonNumber: number,
  episodes: TraktEpisodeDetails[]
): Promise<void> {
  // Get or create the season first
  const season = await prisma.season.upsert({
    where: {
      mediaItemId_seasonNumber: { mediaItemId, seasonNumber },
    },
    create: {
      mediaItemId,
      seasonNumber,
      name: `Season ${seasonNumber}`,
      episodeCount: episodes.length,
    },
    update: {
      episodeCount: episodes.length,
    },
  });

  // Upsert episodes
  for (const ep of episodes) {
    await prisma.episode.upsert({
      where: {
        seasonId_episodeNumber: {
          seasonId: season.id,
          episodeNumber: ep.number,
        },
      },
      create: {
        seasonId: season.id,
        seasonNumber,
        episodeNumber: ep.number,
        name: ep.title || `Episode ${ep.number}`,
        overview: ep.overview,
        stillPath: extractEpisodeStill(ep.images),
        airDate: ep.first_aired?.split("T")[0] || null,
        runtime: ep.runtime,
      },
      update: {
        name: ep.title || `Episode ${ep.number}`,
        overview: ep.overview,
        stillPath: extractEpisodeStill(ep.images) || undefined,
        airDate: ep.first_aired?.split("T")[0] || null,
        runtime: ep.runtime,
      },
    });
  }
}

// =============================================================================
// Trailer Extraction Helper
// =============================================================================

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
  const officialTrailer = youtubeVideos.find((v) => v.type === "Trailer" && v.official === true);
  if (officialTrailer) return officialTrailer.key;

  // Then any trailer
  const anyTrailer = youtubeVideos.find((v) => v.type === "Trailer");
  if (anyTrailer) return anyTrailer.key;

  // Then teaser
  const teaser = youtubeVideos.find((v) => v.type === "Teaser");
  if (teaser) return teaser.key;

  return null;
}

// =============================================================================
// Result Transformation Helper
// =============================================================================

function mediaItemToTrendingResult(item: {
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
    tmdbPopularity: number | null;
  } | null;
}): TrendingResult {
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
    ratings: item.ratings
      ? {
          tmdbScore: item.ratings.tmdbScore,
          imdbScore: item.ratings.imdbScore,
          rtCriticScore: item.ratings.rtCriticScore,
          rtAudienceScore: item.ratings.rtAudienceScore,
          metacriticScore: item.ratings.metacriticScore,
          traktScore: item.ratings.traktScore,
          letterboxdScore: item.ratings.letterboxdScore,
          mdblistScore: item.ratings.mdblistScore,
        }
      : undefined,
    trailerKey,
  };
}

// =============================================================================
// Discovery Router
// =============================================================================

export const discoveryRouter = router({
  /**
   * Get Trakt genres for movies or TV shows
   */
  traktGenres: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]),
      })
    )
    .query(async ({ input }) => {
      const trakt = getTraktService();

      if (!trakt.isConfigured()) {
        return {
          configured: false,
          genres: [],
          message: "Trakt API not configured. Set ANNEX_TRAKT_CLIENT_ID in your environment.",
        };
      }

      try {
        const genres = await trakt.getGenres(input.type);
        return {
          configured: true,
          genres,
          message: null,
        };
      } catch (error) {
        console.error("[Trakt] Error fetching genres:", error);
        return {
          configured: true,
          genres: [],
          message: error instanceof Error ? error.message : "Failed to fetch Trakt genres",
        };
      }
    }),

  /**
   * Unified Trakt discovery endpoint
   * Supports all 6 Trakt list types with native filtering
   * Items are enriched with local database info when available
   */
  traktDiscover: publicProcedure
    .input(
      z.object({
        type: z.enum(["movie", "tv"]),
        listType: z.enum(["trending", "popular", "favorited", "played", "watched", "collected"]),
        page: z.number().min(1).default(1),
        period: z.enum(["daily", "weekly", "monthly", "yearly", "all"]).default("weekly"),
        // Trakt native filters
        query: z.string().optional(),
        years: z.string().optional(),
        genres: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional(),
        countries: z.array(z.string()).optional(),
        runtimes: z.string().optional(),
        certifications: z.array(z.string()).optional(),
        // Rating filters
        ratings: z.string().optional(),
        tmdbRatings: z.string().optional(),
        imdbRatings: z.string().optional(),
        rtMeters: z.string().optional(),
        rtUserMeters: z.string().optional(),
        metascores: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const trakt = getTraktService();

      if (!trakt.isConfigured()) {
        return {
          configured: false,
          results: [],
          page: input.page,
          totalPages: 0,
          totalResults: 0,
          message: "Trakt API not configured. Set ANNEX_TRAKT_CLIENT_ID in your environment.",
        };
      }

      try {
        // Build filter hash for cache key
        const filterHash = buildFilterHash({
          query: input.query,
          years: input.years,
          genres: input.genres,
          languages: input.languages,
          countries: input.countries,
          runtimes: input.runtimes,
          certifications: input.certifications,
          ratings: input.ratings,
          tmdbRatings: input.tmdbRatings,
          imdbRatings: input.imdbRatings,
          rtMeters: input.rtMeters,
          rtUserMeters: input.rtUserMeters,
          metascores: input.metascores,
        });

        // Check database cache
        const cached = await prisma.traktListCache.findUnique({
          where: {
            listType_mediaType_page_period_filterHash: {
              listType: input.listType,
              mediaType: input.type,
              page: input.page,
              period: input.period || "",
              filterHash: filterHash || "",
            },
          },
        });

        const now = new Date();

        // If fresh (< 6 hours), return immediately with re-hydrated status
        if (cached && cached.expiresAt > now) {
          console.log(
            `[TraktCache] Cache hit (fresh): ${input.listType}/${input.type}/page${input.page}`
          );

          // Re-hydrate library/request status (not cached since it changes frequently)
          const cachedResults = cached.results as unknown as TrendingResult[];
          const libraryStatusService = getLibraryStatusService();
          const status = await libraryStatusService.getBatchStatus(
            cachedResults.map((item) => ({ tmdbId: item.tmdbId, type: item.type }))
          );

          // Update results with fresh status
          const resultsWithStatus = cachedResults.map((result) => {
            const key = `${result.type}-${result.tmdbId}`;
            return {
              ...result,
              inLibrary: status.inLibrary[key] || null,
              requestStatus: status.requestStatus[key] || null,
            };
          });

          return {
            configured: true,
            results: resultsWithStatus,
            page: input.page,
            totalPages: cached.totalPages,
            totalResults: cached.totalResults,
            message: null,
          };
        }

        // If stale but exists, return stale data with re-hydrated status and refresh in background
        if (cached) {
          console.log(
            `[TraktCache] Cache hit (stale): ${input.listType}/${input.type}/page${input.page} - queueing refresh`
          );

          // Queue background refresh job (fire and forget)
          const jobQueue = getJobQueueService();
          jobQueue
            .addJobIfNotExists(
              "trakt:refresh-list-cache",
              { input, filterHash },
              `trakt:refresh:${input.listType}:${input.type}:${input.page}:${input.period}:${filterHash || "none"}`,
              { priority: 2, maxAttempts: 2 }
            )
            .catch((err) => {
              console.error("[TraktCache] Failed to queue refresh job:", err);
            });

          // Re-hydrate library/request status
          const cachedResults = cached.results as unknown as TrendingResult[];
          const libraryStatusService = getLibraryStatusService();
          const status = await libraryStatusService.getBatchStatus(
            cachedResults.map((item) => ({ tmdbId: item.tmdbId, type: item.type }))
          );

          // Update results with fresh status
          const resultsWithStatus = cachedResults.map((result) => {
            const key = `${result.type}-${result.tmdbId}`;
            return {
              ...result,
              inLibrary: status.inLibrary[key] || null,
              requestStatus: status.requestStatus[key] || null,
            };
          });

          return {
            configured: true,
            results: resultsWithStatus,
            page: input.page,
            totalPages: cached.totalPages,
            totalResults: cached.totalResults,
            message: null,
          };
        }

        // No cache - fetch and hydrate synchronously
        console.log(
          `[TraktCache] Cache miss: ${input.listType}/${input.type}/page${input.page} - fetching`
        );

        // Call the refresh function to fetch, hydrate, and cache
        await refreshTraktListCache(input, filterHash);

        // Retrieve the newly cached data
        const newCached = await prisma.traktListCache.findUnique({
          where: {
            listType_mediaType_page_period_filterHash: {
              listType: input.listType,
              mediaType: input.type,
              page: input.page,
              period: input.period || "",
              filterHash: filterHash || "",
            },
          },
        });

        if (!newCached) {
          // Should never happen, but handle gracefully
          return {
            configured: true,
            results: [],
            page: input.page,
            totalPages: 0,
            totalResults: 0,
            message: null,
          };
        }

        return {
          configured: true,
          results: newCached.results as unknown as TrendingResult[],
          page: input.page,
          totalPages: newCached.totalPages,
          totalResults: newCached.totalResults,
          message: null,
        };
      } catch (error) {
        console.error("[Trakt] Error fetching discover:", error);
        return {
          configured: true,
          results: [],
          page: input.page,
          totalPages: 0,
          totalResults: 0,
          message: error instanceof Error ? error.message : "Failed to fetch Trakt discover",
        };
      }
    }),

  /**
   * Get trailer video for a media item from local database cache
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

      const item = await prisma.mediaItem.findUnique({
        where: { id },
        select: { videos: true },
      });

      if (item?.videos && Array.isArray(item.videos) && item.videos.length > 0) {
        const videos = item.videos as Array<{
          key: string;
          name?: string;
          site: string;
          type: string;
        }>;
        const trailer = videos.find((v) => v.type === "Trailer" || v.type === "Teaser");
        if (trailer) {
          return {
            key: trailer.key,
            name: trailer.name || "Trailer",
            site: trailer.site,
            type: trailer.type,
          };
        }
      }

      return null;
    }),

  /**
   * JIT Movie Details endpoint
   * Fetches from TMDB API with database caching (7-day TTL for TMDB, 1-hour for ratings)
   * Uses stale-while-revalidate: returns cached data immediately, refreshes in background if stale
   */
  traktMovieDetails: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const { getMDBListService } = await import("../services/mdblist.js");
      const mdblist = getMDBListService();

      const TMDB_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
      const RATINGS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

      const id = `tmdb-movie-${input.tmdbId}`;

      // Check local cache
      const cached = await prisma.mediaItem.findUnique({
        where: { id },
        include: { ratings: true },
      });

      const now = Date.now();
      const tmdbAge = cached?.tmdbUpdatedAt ? now - cached.tmdbUpdatedAt.getTime() : Infinity;
      const ratingsAge = cached?.mdblistUpdatedAt
        ? now - cached.mdblistUpdatedAt.getTime()
        : Infinity;

      // Helper to return cached data in the expected format
      const formatResponse = (item: typeof cached) => {
        if (!item) return null;

        const videos = item.videos as Array<{ key: string; site: string; type: string }> | null;
        const trailer = videos?.find((v) => v.type === "Trailer" && v.site === "YouTube");

        return {
          tmdbId: item.tmdbId,
          imdbId: item.imdbId,
          traktId: item.traktId,
          type: "movie" as const,
          title: item.title,
          originalTitle: item.originalTitle,
          year: item.year,
          releaseDate: item.releaseDate,
          overview: item.overview,
          tagline: item.tagline,
          runtime: item.runtime,
          status: item.status,
          certification: item.certification,
          genres: item.genres,
          language: item.language,
          country: item.country,
          posterPath: item.posterPath,
          backdropPath: item.backdropPath,
          trailerKey: trailer?.key || null,
          cast: item.cast,
          crew: item.crew,
          director: item.director,
          ratings: item.ratings
            ? {
                tmdbScore: item.ratings.tmdbScore,
                imdbScore: item.ratings.imdbScore,
                rtCriticScore: item.ratings.rtCriticScore,
                rtAudienceScore: item.ratings.rtAudienceScore,
                metacriticScore: item.ratings.metacriticScore,
                traktScore: item.ratings.traktScore,
                letterboxdScore: item.ratings.letterboxdScore,
                mdblistScore: item.ratings.mdblistScore,
              }
            : null,
          tmdbUpdatedAt: item.tmdbUpdatedAt,
          mdblistUpdatedAt: item.mdblistUpdatedAt,
        };
      };

      // If we have fresh data, return it immediately
      if (cached && tmdbAge < TMDB_CACHE_TTL && ratingsAge < RATINGS_CACHE_TTL) {
        return formatResponse(cached);
      }

      // If we have stale data, return it and refresh in background
      if (cached) {
        (async () => {
          try {
            if (tmdbAge >= TMDB_CACHE_TTL) {
              const [details, videos, credits] = await Promise.all([
                tmdb.getMovieDetails(input.tmdbId),
                tmdb.getMovieVideos(input.tmdbId),
                tmdb.getMovieCredits(input.tmdbId),
              ]);

              const trailerKey = tmdb.extractTrailerKey(videos);
              const director = credits.crew.find((c) => c.job === "Director")?.name || null;
              const genres = details.genres.map((g) => g.name);

              await prisma.mediaItem.update({
                where: { id },
                data: {
                  title: details.title,
                  originalTitle: details.original_title,
                  year: details.release_date
                    ? Number.parseInt(details.release_date.split("-")[0], 10)
                    : undefined,
                  releaseDate: details.release_date,
                  overview: details.overview,
                  tagline: details.tagline,
                  runtime: details.runtime,
                  status: details.status,
                  genres,
                  language: details.original_language,
                  country:
                    details.production_countries.length > 0
                      ? details.production_countries[0].iso_3166_1
                      : undefined,
                  imdbId: details.imdb_id,
                  posterPath: tmdb.getImageUrl(details.poster_path, "w500") || cached.posterPath,
                  backdropPath:
                    tmdb.getImageUrl(details.backdrop_path, "original") || cached.backdropPath,
                  videos: trailerKey
                    ? [{ key: trailerKey, type: "Trailer", site: "YouTube" }]
                    : undefined,
                  cast: credits.cast.slice(0, 20).map((c) => ({
                    id: c.id,
                    name: c.name,
                    character: c.character,
                    order: c.order,
                    profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
                  })),
                  crew: credits.crew.slice(0, 20).map((c) => ({
                    id: c.id,
                    name: c.name,
                    job: c.job,
                    department: c.department,
                    profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
                  })),
                  director,
                  tmdbUpdatedAt: new Date(),
                },
              });

              // Update TMDB rating
              const tmdbScore = details.vote_average ? Math.round(details.vote_average * 10) : null;
              if (tmdbScore !== null || details.vote_count) {
                await prisma.mediaRatings.upsert({
                  where: { mediaId: id },
                  create: {
                    mediaId: id,
                    tmdbScore,
                    tmdbVotes: details.vote_count || null,
                  },
                  update: {
                    tmdbScore,
                    tmdbVotes: details.vote_count || undefined,
                  },
                });
              }
            }

            const isMdblistConfigured = await mdblist.isConfigured();
            if (isMdblistConfigured && ratingsAge >= RATINGS_CACHE_TTL) {
              const mdbData = await mdblist.getByTmdbId(input.tmdbId, "movie");
              if (mdbData) {
                const ratings = extractMDBListRatings(mdbData);
                await prisma.mediaRatings.upsert({
                  where: { mediaId: id },
                  create: { mediaId: id, ...ratings },
                  update: ratings,
                });
                await prisma.mediaItem.update({
                  where: { id },
                  data: { mdblistUpdatedAt: new Date() },
                });
              }
            }
          } catch (error) {
            console.error("[JIT] Background refresh error:", error);
          }
        })().catch(console.error);

        return formatResponse(cached);
      }

      // No cache - fetch from APIs and save
      if (!(await tmdb.isConfigured())) {
        throw new Error("TMDB API not configured");
      }

      const [details, videos, credits] = await Promise.all([
        tmdb.getMovieDetails(input.tmdbId),
        tmdb.getMovieVideos(input.tmdbId),
        tmdb.getMovieCredits(input.tmdbId),
      ]);

      const trailerKey = tmdb.extractTrailerKey(videos);
      const director = credits.crew.find((c) => c.job === "Director")?.name || null;
      const genres = details.genres.map((g) => g.name);
      const tmdbScore = details.vote_average ? Math.round(details.vote_average * 10) : null;

      const mediaItemData = {
        id,
        tmdbId: input.tmdbId,
        type: "MOVIE" as const,
        title: details.title,
        originalTitle: details.original_title,
        year: details.release_date ? Number.parseInt(details.release_date.split("-")[0], 10) : null,
        releaseDate: details.release_date,
        overview: details.overview,
        tagline: details.tagline,
        runtime: details.runtime,
        status: details.status,
        genres,
        language: details.original_language,
        country:
          details.production_countries.length > 0
            ? details.production_countries[0].iso_3166_1
            : null,
        imdbId: details.imdb_id,
        posterPath: tmdb.getImageUrl(details.poster_path, "w500"),
        backdropPath: tmdb.getImageUrl(details.backdrop_path, "original"),
        videos: trailerKey ? [{ key: trailerKey, type: "Trailer", site: "YouTube" }] : [],
        cast: credits.cast.slice(0, 20).map((c) => ({
          id: c.id,
          name: c.name,
          character: c.character,
          order: c.order,
          profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
        })),
        crew: credits.crew.slice(0, 20).map((c) => ({
          id: c.id,
          name: c.name,
          job: c.job,
          department: c.department,
          profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
        })),
        director,
        tmdbUpdatedAt: new Date(),
      };

      await prisma.mediaItem.upsert({
        where: { id },
        create: mediaItemData,
        update: mediaItemData,
      });

      // Save TMDB rating
      if (tmdbScore !== null || details.vote_count) {
        await prisma.mediaRatings.upsert({
          where: { mediaId: id },
          create: {
            mediaId: id,
            tmdbScore,
            tmdbVotes: details.vote_count || null,
          },
          update: {
            tmdbScore,
            tmdbVotes: details.vote_count || undefined,
          },
        });
      }

      // Fetch and save ratings from MDBList (if configured)
      const isMdblistConfigured = await mdblist.isConfigured();
      if (isMdblistConfigured) {
        const mdbData = await mdblist.getByTmdbId(input.tmdbId, "movie");
        if (mdbData) {
          const ratings = extractMDBListRatings(mdbData);
          await prisma.mediaRatings.upsert({
            where: { mediaId: id },
            create: { mediaId: id, ...ratings },
            update: ratings,
          });
          await prisma.mediaItem.update({
            where: { id },
            data: { mdblistUpdatedAt: new Date() },
          });
        }
      }

      const fresh = await prisma.mediaItem.findUnique({
        where: { id },
        include: { ratings: true },
      });

      return formatResponse(fresh);
    }),

  /**
   * JIT TV Show Details endpoint
   * Fetches from TMDB API with database caching (7-day TTL for TMDB, 1-hour for ratings)
   * Uses stale-while-revalidate: returns cached data immediately, refreshes in background if stale
   */
  traktTvShowDetails: publicProcedure
    .input(z.object({ tmdbId: z.number() }))
    .query(async ({ input }) => {
      const tmdb = getTMDBService();
      const { getMDBListService } = await import("../services/mdblist.js");
      const mdblist = getMDBListService();

      const TMDB_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
      const RATINGS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

      const id = `tmdb-tv-${input.tmdbId}`;

      // Check local cache
      const cached = await prisma.mediaItem.findUnique({
        where: { id },
        include: { ratings: true, seasons: { include: { episodes: true } } },
      });

      type MediaItemWithSeasonsAndEpisodes = Prisma.MediaItemGetPayload<{
        include: { ratings: true; seasons: { include: { episodes: true } } };
      }>;

      type SeasonWithEpisodes = Prisma.SeasonGetPayload<{ include: { episodes: true } }>;
      type Episode = Prisma.EpisodeGetPayload<Record<string, never>>;

      const now = Date.now();
      const tmdbAge = cached?.tmdbUpdatedAt ? now - cached.tmdbUpdatedAt.getTime() : Infinity;
      const ratingsAge = cached?.mdblistUpdatedAt
        ? now - cached.mdblistUpdatedAt.getTime()
        : Infinity;

      // Helper to return cached data in the expected format
      const formatResponse = (item: MediaItemWithSeasonsAndEpisodes | null) => {
        if (!item) return null;

        const videos = item.videos as Array<{ key: string; site: string; type: string }> | null;
        const trailer = videos?.find((v) => v.type === "Trailer" && v.site === "YouTube");

        return {
          tmdbId: item.tmdbId,
          imdbId: item.imdbId,
          traktId: item.traktId,
          tvdbId: item.tvdbId,
          type: "tv" as const,
          title: item.title,
          originalTitle: item.originalTitle,
          year: item.year,
          releaseDate: item.releaseDate,
          overview: item.overview,
          runtime: item.runtime,
          status: item.status,
          certification: item.certification,
          genres: item.genres,
          language: item.language,
          country: item.country,
          posterPath: item.posterPath,
          backdropPath: item.backdropPath,
          trailerKey: trailer?.key || null,
          cast: item.cast,
          crew: item.crew,
          networks: item.networks,
          createdBy: item.createdBy,
          numberOfSeasons: item.numberOfSeasons,
          numberOfEpisodes: item.numberOfEpisodes,
          seasons:
            item.seasons?.map((s: SeasonWithEpisodes) => ({
              seasonNumber: s.seasonNumber,
              name: s.name,
              overview: s.overview,
              posterPath: s.posterPath,
              episodeCount: s.episodeCount,
              airDate: s.airDate,
              episodes: s.episodes?.map((e: Episode) => ({
                episodeNumber: e.episodeNumber,
                name: e.name,
                overview: e.overview,
                stillPath: e.stillPath,
                airDate: e.airDate,
                runtime: e.runtime,
              })),
            })) || [],
          ratings: item.ratings
            ? {
                tmdbScore: item.ratings.tmdbScore,
                imdbScore: item.ratings.imdbScore,
                rtCriticScore: item.ratings.rtCriticScore,
                rtAudienceScore: item.ratings.rtAudienceScore,
                metacriticScore: item.ratings.metacriticScore,
                traktScore: item.ratings.traktScore,
                letterboxdScore: item.ratings.letterboxdScore,
                mdblistScore: item.ratings.mdblistScore,
              }
            : null,
          tmdbUpdatedAt: item.tmdbUpdatedAt,
          mdblistUpdatedAt: item.mdblistUpdatedAt,
        };
      };

      // If we have fresh data, return it immediately
      if (cached && tmdbAge < TMDB_CACHE_TTL && ratingsAge < RATINGS_CACHE_TTL) {
        return formatResponse(cached);
      }

      // If we have stale data, return it and refresh in background
      if (cached) {
        (async () => {
          try {
            if (tmdbAge >= TMDB_CACHE_TTL) {
              const [details, videos, credits] = await Promise.all([
                tmdb.getTVDetails(input.tmdbId),
                tmdb.getTVVideos(input.tmdbId),
                tmdb.getTVCredits(input.tmdbId),
              ]);

              const trailerKey = tmdb.extractTrailerKey(videos);
              const genres = details.genres.map((g) => g.name);
              const runtime =
                details.episode_run_time.length > 0 ? details.episode_run_time[0] : null;
              const seasonCount = details.seasons.filter((s) => s.season_number > 0).length;

              await prisma.mediaItem.update({
                where: { id },
                data: {
                  title: details.name,
                  originalTitle: details.original_name,
                  year: details.first_air_date
                    ? Number.parseInt(details.first_air_date.split("-")[0], 10)
                    : undefined,
                  releaseDate: details.first_air_date,
                  overview: details.overview,
                  runtime,
                  status: details.status,
                  genres,
                  language: details.original_language,
                  country:
                    details.origin_country.length > 0 ? details.origin_country[0] : undefined,
                  numberOfSeasons: seasonCount,
                  numberOfEpisodes: details.number_of_episodes,
                  networks:
                    details.networks.length > 0
                      ? details.networks.map((n) => ({ name: n.name }))
                      : undefined,
                  posterPath: tmdb.getImageUrl(details.poster_path, "w500") || cached.posterPath,
                  backdropPath:
                    tmdb.getImageUrl(details.backdrop_path, "original") || cached.backdropPath,
                  videos: trailerKey
                    ? [{ key: trailerKey, type: "Trailer", site: "YouTube" }]
                    : undefined,
                  cast: credits.cast.slice(0, 20).map((c) => ({
                    id: c.id,
                    name: c.name,
                    character: c.character,
                    order: c.order,
                    profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
                  })),
                  crew: credits.crew.slice(0, 20).map((c) => ({
                    id: c.id,
                    name: c.name,
                    job: c.job,
                    department: c.department,
                    profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
                  })),
                  tmdbUpdatedAt: new Date(),
                },
              });

              // Update TMDB rating
              const tmdbScore = details.vote_average ? Math.round(details.vote_average * 10) : null;
              if (tmdbScore !== null || details.vote_count) {
                await prisma.mediaRatings.upsert({
                  where: { mediaId: id },
                  create: {
                    mediaId: id,
                    tmdbScore,
                    tmdbVotes: details.vote_count || null,
                  },
                  update: {
                    tmdbScore,
                    tmdbVotes: details.vote_count || undefined,
                  },
                });
              }

              // Save each season and its episodes
              for (const season of details.seasons) {
                const savedSeason = await prisma.season.upsert({
                  where: {
                    mediaItemId_seasonNumber: {
                      mediaItemId: id,
                      seasonNumber: season.season_number,
                    },
                  },
                  create: {
                    mediaItemId: id,
                    seasonNumber: season.season_number,
                    name: season.name,
                    overview: season.overview,
                    posterPath: tmdb.getImageUrl(season.poster_path, "w500"),
                    episodeCount: season.episode_count,
                    airDate: season.air_date,
                  },
                  update: {
                    name: season.name,
                    overview: season.overview,
                    posterPath: tmdb.getImageUrl(season.poster_path, "w500") || undefined,
                    episodeCount: season.episode_count,
                    airDate: season.air_date,
                  },
                });

                // Fetch and save episodes for this season
                try {
                  const seasonDetails = await tmdb.getTVSeasonDetails(
                    input.tmdbId,
                    season.season_number
                  );
                  if (seasonDetails.episodes) {
                    for (const ep of seasonDetails.episodes) {
                      await prisma.episode.upsert({
                        where: {
                          seasonId_episodeNumber: {
                            seasonId: savedSeason.id,
                            episodeNumber: ep.episode_number,
                          },
                        },
                        create: {
                          seasonId: savedSeason.id,
                          seasonNumber: season.season_number,
                          episodeNumber: ep.episode_number,
                          name: ep.name,
                          overview: ep.overview,
                          stillPath: tmdb.getImageUrl(ep.still_path, "w500"),
                          airDate: ep.air_date,
                          runtime: ep.runtime,
                        },
                        update: {
                          name: ep.name,
                          overview: ep.overview,
                          stillPath: tmdb.getImageUrl(ep.still_path, "w500") || undefined,
                          airDate: ep.air_date,
                          runtime: ep.runtime,
                        },
                      });
                    }
                  }
                } catch (epError) {
                  console.error(
                    `[JIT] Background: Failed to fetch episodes for season ${season.season_number}:`,
                    epError
                  );
                }
              }
            }

            const isMdblistConfigured = await mdblist.isConfigured();
            if (isMdblistConfigured && ratingsAge >= RATINGS_CACHE_TTL) {
              const mdbData = await mdblist.getByTmdbId(input.tmdbId, "show");
              if (mdbData) {
                const ratings = extractMDBListRatings(mdbData);
                await prisma.mediaRatings.upsert({
                  where: { mediaId: id },
                  create: { mediaId: id, ...ratings },
                  update: ratings,
                });
                await prisma.mediaItem.update({
                  where: { id },
                  data: { mdblistUpdatedAt: new Date() },
                });
              }
            }
          } catch (error) {
            console.error("[JIT] Background refresh error:", error);
          }
        })().catch(console.error);

        return formatResponse(cached);
      }

      // No cache - fetch from APIs and save
      if (!(await tmdb.isConfigured())) {
        throw new Error("TMDB API not configured");
      }

      const [details, videos, credits] = await Promise.all([
        tmdb.getTVDetails(input.tmdbId),
        tmdb.getTVVideos(input.tmdbId),
        tmdb.getTVCredits(input.tmdbId),
      ]);

      const trailerKey = tmdb.extractTrailerKey(videos);
      const genres = details.genres.map((g) => g.name);
      const runtime = details.episode_run_time.length > 0 ? details.episode_run_time[0] : null;
      const seasonCount = details.seasons.filter((s) => s.season_number > 0).length;
      const tmdbScore = details.vote_average ? Math.round(details.vote_average * 10) : null;

      const mediaItemData = {
        id,
        tmdbId: input.tmdbId,
        type: "TV" as const,
        title: details.name,
        originalTitle: details.original_name,
        year: details.first_air_date
          ? Number.parseInt(details.first_air_date.split("-")[0], 10)
          : null,
        releaseDate: details.first_air_date,
        overview: details.overview,
        runtime,
        status: details.status,
        genres,
        language: details.original_language,
        country: details.origin_country.length > 0 ? details.origin_country[0] : null,
        numberOfSeasons: seasonCount,
        numberOfEpisodes: details.number_of_episodes,
        networks:
          details.networks.length > 0 ? details.networks.map((n) => ({ name: n.name })) : [],
        posterPath: tmdb.getImageUrl(details.poster_path, "w500"),
        backdropPath: tmdb.getImageUrl(details.backdrop_path, "original"),
        videos: trailerKey ? [{ key: trailerKey, type: "Trailer", site: "YouTube" }] : [],
        cast: credits.cast.slice(0, 20).map((c) => ({
          id: c.id,
          name: c.name,
          character: c.character,
          order: c.order,
          profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
        })),
        crew: credits.crew.slice(0, 20).map((c) => ({
          id: c.id,
          name: c.name,
          job: c.job,
          department: c.department,
          profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
        })),
        tmdbUpdatedAt: new Date(),
      };

      await prisma.mediaItem.upsert({
        where: { id },
        create: mediaItemData,
        update: mediaItemData,
      });

      // Save TMDB rating
      if (tmdbScore !== null || details.vote_count) {
        await prisma.mediaRatings.upsert({
          where: { mediaId: id },
          create: {
            mediaId: id,
            tmdbScore,
            tmdbVotes: details.vote_count || null,
          },
          update: {
            tmdbScore,
            tmdbVotes: details.vote_count || undefined,
          },
        });
      }

      // Save each season and its episodes
      try {
        for (const season of details.seasons) {
          const savedSeason = await prisma.season.upsert({
            where: {
              mediaItemId_seasonNumber: {
                mediaItemId: id,
                seasonNumber: season.season_number,
              },
            },
            create: {
              mediaItemId: id,
              seasonNumber: season.season_number,
              name: season.name,
              overview: season.overview,
              posterPath: tmdb.getImageUrl(season.poster_path, "w500"),
              episodeCount: season.episode_count,
              airDate: season.air_date,
            },
            update: {
              name: season.name,
              overview: season.overview,
              posterPath: tmdb.getImageUrl(season.poster_path, "w500") || undefined,
              episodeCount: season.episode_count,
              airDate: season.air_date,
            },
          });

          // Fetch and save episodes for this season
          try {
            const seasonDetails = await tmdb.getTVSeasonDetails(input.tmdbId, season.season_number);
            if (seasonDetails.episodes) {
              for (const ep of seasonDetails.episodes) {
                await prisma.episode.upsert({
                  where: {
                    seasonId_episodeNumber: {
                      seasonId: savedSeason.id,
                      episodeNumber: ep.episode_number,
                    },
                  },
                  create: {
                    seasonId: savedSeason.id,
                    seasonNumber: season.season_number,
                    episodeNumber: ep.episode_number,
                    name: ep.name,
                    overview: ep.overview,
                    stillPath: tmdb.getImageUrl(ep.still_path, "w500"),
                    airDate: ep.air_date,
                    runtime: ep.runtime,
                  },
                  update: {
                    name: ep.name,
                    overview: ep.overview,
                    stillPath: tmdb.getImageUrl(ep.still_path, "w500") || undefined,
                    airDate: ep.air_date,
                    runtime: ep.runtime,
                  },
                });
              }
            }
          } catch (epError) {
            console.error(
              `[JIT] Failed to fetch episodes for season ${season.season_number}:`,
              epError
            );
          }
        }
      } catch (error) {
        console.error("[JIT] Failed to fetch seasons:", error);
      }

      // Fetch and save ratings from MDBList (if configured)
      const isMdblistConfigured = await mdblist.isConfigured();
      if (isMdblistConfigured) {
        const mdbData = await mdblist.getByTmdbId(input.tmdbId, "show");
        if (mdbData) {
          const ratings = extractMDBListRatings(mdbData);
          await prisma.mediaRatings.upsert({
            where: { mediaId: id },
            create: { mediaId: id, ...ratings },
            update: ratings,
          });
          await prisma.mediaItem.update({
            where: { id },
            data: { mdblistUpdatedAt: new Date() },
          });
        }
      }

      const fresh = await prisma.mediaItem.findUnique({
        where: { id },
        include: { ratings: true, seasons: { include: { episodes: true } } },
      });

      return formatResponse(fresh);
    }),

  /**
   * JIT TV Season Details endpoint
   * Fetches season with episodes from Trakt API with database caching
   */
  traktSeason: publicProcedure
    .input(
      z.object({
        tmdbId: z.number(),
        seasonNumber: z.number(),
      })
    )
    .query(async ({ input }) => {
      const trakt = getTraktService();

      const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

      const mediaItemId = `tmdb-tv-${input.tmdbId}`;

      // Check if we have cached season data
      const cachedSeason = await prisma.season.findUnique({
        where: {
          mediaItemId_seasonNumber: {
            mediaItemId,
            seasonNumber: input.seasonNumber,
          },
        },
        include: { episodes: true },
      });

      const now = Date.now();
      const seasonAge = cachedSeason?.updatedAt ? now - cachedSeason.updatedAt.getTime() : Infinity;

      // Helper to format response
      const formatSeasonResponse = (season: typeof cachedSeason) => {
        if (!season) return null;
        return {
          seasonNumber: season.seasonNumber,
          name: season.name,
          overview: season.overview,
          posterPath: season.posterPath,
          episodeCount: season.episodeCount,
          airDate: season.airDate,
          episodes: season.episodes.map(
            (e: {
              episodeNumber: number;
              name: string;
              overview: string | null;
              stillPath: string | null;
              airDate: string | null;
              runtime: number | null;
            }) => ({
              episodeNumber: e.episodeNumber,
              name: e.name,
              overview: e.overview,
              stillPath: e.stillPath,
              airDate: e.airDate,
              runtime: e.runtime,
            })
          ),
        };
      };

      // If fresh, return cached
      if (cachedSeason && seasonAge < CACHE_TTL) {
        return formatSeasonResponse(cachedSeason);
      }

      // If stale, return cached and refresh in background
      if (cachedSeason) {
        (async () => {
          try {
            const { episodes } = await trakt.getSeason(input.tmdbId, input.seasonNumber);
            await updateSeasonEpisodes(mediaItemId, input.seasonNumber, episodes);
          } catch (error) {
            console.error("[JIT] Background season refresh error:", error);
          }
        })().catch(console.error);

        return formatSeasonResponse(cachedSeason);
      }

      // No cache - fetch and save
      if (!trakt.isConfigured()) {
        throw new Error("Trakt API not configured");
      }

      const { episodes } = await trakt.getSeason(input.tmdbId, input.seasonNumber);
      await updateSeasonEpisodes(mediaItemId, input.seasonNumber, episodes);

      const fresh = await prisma.season.findUnique({
        where: {
          mediaItemId_seasonNumber: {
            mediaItemId,
            seasonNumber: input.seasonNumber,
          },
        },
        include: { episodes: true },
      });

      return formatSeasonResponse(fresh);
    }),
});
