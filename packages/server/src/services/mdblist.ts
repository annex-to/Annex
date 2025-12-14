/**
 * MDBList API Service
 *
 * Aggregates ratings and metadata from multiple sources:
 * - IMDB, Rotten Tomatoes, Metacritic, Trakt, TMDb, Letterboxd, Roger Ebert, MAL
 *
 * Supports batch requests (up to 200 items) for efficient bulk operations.
 */

import { getConfig } from "../config/index.js";
import { prisma } from "../db/client.js";
import { MediaType, Prisma } from "@prisma/client";
import { calculateAggregateScore } from "./ratingAggregator.js";

const MDBLIST_BASE_URL = "https://api.mdblist.com";

// Rate limiting - token bucket approach with mutex for parallel safety
let tokens = 10; // Start with some tokens
let lastRefill = Date.now();
let maxTokens = 10; // Max tokens (requests per second)
let isWaiting = false; // Mutex to prevent stampede
const waitQueue: Array<() => void> = [];

interface MDBListRating {
  source: string;
  value: number;
  score: number;
  votes: number;
}

interface MDBListStream {
  name: string;
  id?: number;
  logo?: string;
  homePage?: string;
}

interface MDBListWatchProvider {
  name: string;
  id?: number;
  logo?: string;
  link?: string;
  [key: string]: string | number | undefined; // Index signature for Prisma JSON compatibility
}

interface MDBListMediaInfo {
  id: number;
  title: string;
  year: number;
  released?: string;
  released_digital?: string;
  description?: string;
  tagline?: string;
  runtime?: number;
  score?: number;
  score_average?: number;
  imdbid?: string;
  traktid?: number;
  tmdbid?: number;
  tvdbid?: number;
  malid?: number;
  type: "movie" | "show";
  ratings?: MDBListRating[];
  streams?: MDBListStream[];
  watch_providers?: MDBListWatchProvider[];
  keywords?: string[];
  language?: string;
  country?: string;
  certification?: string;
  status?: string;
  trailer?: string;
  poster?: string;
  backdrop?: string;
  genre?: string[];
  // TV specific
  season_count?: number;
  episode_count?: number;
  // Movie specific
  budget?: number;
  revenue?: number;
}

interface MDBListBatchResponse {
  id: number;
  title?: string;
  error?: string;
  ids?: {
    imdb?: string;
    trakt?: number;
    tmdb?: number;
    tvdb?: number;
    mal?: number;
  };
  [key: string]: unknown;
}

class MDBListService {
  private apiKey: string | undefined;

  constructor() {
    const config = getConfig();
    this.apiKey = config.mdblist.apiKey;
    // Use configured rate limit but cap at something reasonable for Cloudflare
    // Cloudflare typically allows ~10-20 req/sec before triggering rate limits
    maxTokens = Math.min(config.mdblist.rateLimit, 10);
    tokens = maxTokens;
  }

  /**
   * Token bucket rate limiter with proper parallel request handling
   * Refills tokens over time, waits when empty
   */
  private async rateLimit(): Promise<void> {
    // Refill tokens based on elapsed time
    const now = Date.now();
    const elapsed = now - lastRefill;
    const refill = Math.floor(elapsed / 1000) * maxTokens;
    if (refill > 0) {
      tokens = Math.min(maxTokens, tokens + refill);
      lastRefill = now;
    }

    // If we have tokens, use one
    if (tokens > 0) {
      tokens--;
      return;
    }

    // No tokens - wait in queue to avoid stampede
    return new Promise<void>((resolve) => {
      waitQueue.push(resolve);

      // Start a waiter if not already waiting
      if (!isWaiting) {
        isWaiting = true;
        const checkTokens = () => {
          const checkNow = Date.now();
          const checkElapsed = checkNow - lastRefill;
          const checkRefill = Math.floor(checkElapsed / 1000) * maxTokens;
          if (checkRefill > 0) {
            tokens = Math.min(maxTokens, tokens + checkRefill);
            lastRefill = checkNow;
          }

          // Release waiting requests
          while (tokens > 0 && waitQueue.length > 0) {
            tokens--;
            const next = waitQueue.shift();
            if (next) next();
          }

          // Continue waiting if queue not empty
          if (waitQueue.length > 0) {
            setTimeout(checkTokens, 200);
          } else {
            isWaiting = false;
          }
        };
        setTimeout(checkTokens, 200);
      }
    });
  }

  /**
   * Fetch with retry on 429 rate limit errors
   */
  private async fetch<T>(endpoint: string, options: RequestInit = {}, retries = 3): Promise<T> {
    if (!this.apiKey) {
      throw new Error("MDBList API key not configured. Set MDBLIST_API_KEY in your environment.");
    }

    await this.rateLimit();

    const url = new URL(`${MDBLIST_BASE_URL}${endpoint}`);
    url.searchParams.set("apikey", this.apiKey);

    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await fetch(url.toString(), {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...options.headers,
        },
      });

      if (response.ok) {
        const text = await response.text();
        return JSON.parse(text) as T;
      }

      // Handle rate limiting with exponential backoff
      if (response.status === 429) {
        if (attempt < retries) {
          // Exponential backoff: 2s, 4s, 8s
          const backoffMs = Math.pow(2, attempt + 1) * 1000;
          console.log(`[MDBList] Rate limited (429), backing off ${backoffMs}ms (attempt ${attempt + 1}/${retries})`);
          // Also reduce our token rate to avoid future 429s
          tokens = 0;
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }
      }

      const errorText = await response.text();
      throw new Error(`MDBList API error ${response.status}: ${errorText}`);
    }

    throw new Error("MDBList API: Max retries exceeded");
  }

  /**
   * Get media info by IMDB ID
   */
  async getByImdbId(imdbId: string, type: "movie" | "show"): Promise<MDBListMediaInfo | null> {
    try {
      const data = await this.fetch<MDBListMediaInfo>(`/imdb/${type}/${imdbId}`);
      return data;
    } catch (error) {
      console.error(`Failed to fetch from MDBList: ${imdbId}`, error);
      return null;
    }
  }

  /**
   * Get media info by TMDB ID
   */
  async getByTmdbId(tmdbId: number, type: "movie" | "show"): Promise<MDBListMediaInfo | null> {
    try {
      const data = await this.fetch<MDBListMediaInfo>(`/tmdb/${type}/${tmdbId}`);
      return data;
    } catch (error) {
      console.error(`Failed to fetch from MDBList: tmdb-${type}-${tmdbId}`, error);
      return null;
    }
  }

  /**
   * Batch get media info by TMDB IDs (up to 200 at a time)
   */
  async batchGetByTmdbIds(
    tmdbIds: number[],
    type: "movie" | "show"
  ): Promise<Map<number, MDBListMediaInfo>> {
    const results = new Map<number, MDBListMediaInfo>();

    // Process in chunks of 200
    const chunkSize = 200;
    for (let i = 0; i < tmdbIds.length; i += chunkSize) {
      const chunk = tmdbIds.slice(i, i + chunkSize);

      try {
        const response = await this.fetch<MDBListBatchResponse[]>(`/tmdb/${type}`, {
          method: "POST",
          body: JSON.stringify({ ids: chunk }),
        });

        for (const item of response) {
          // Use ids.tmdb as the key since item.id is MDBList's internal ID
          const tmdbId = item.ids?.tmdb;
          if (tmdbId && !item.error) {
            results.set(tmdbId, item as unknown as MDBListMediaInfo);
          }
        }
      } catch (error) {
        console.error(`Failed to batch fetch from MDBList (chunk ${i}-${i + chunk.length}):`, error);
      }
    }

    return results;
  }

  /**
   * Hydrate a media item in the database with MDBList data
   */
  async hydrateMediaItem(tmdbId: number, type: "movie" | "tv"): Promise<boolean> {
    const mdbType = type === "movie" ? "movie" : "show";
    const data = await this.getByTmdbId(tmdbId, mdbType);

    if (!data) {
      return false;
    }

    const id = `tmdb-${type}-${tmdbId}`;
    const prismaType = type === "movie" ? MediaType.MOVIE : MediaType.TV;

    // Extract ratings from the ratings array
    const ratings = this.extractRatings(data.ratings || []);

    // Calculate aggregate score from all rating sources
    const aggregate = calculateAggregateScore(ratings);

    try {
      await prisma.mediaItem.upsert({
        where: { id },
        create: {
          id,
          tmdbId,
          imdbId: data.imdbid || null,
          traktId: data.traktid || null,
          tvdbId: data.tvdbid || null,
          malId: data.malid || null,
          type: prismaType,
          title: data.title,
          year: data.year,
          releaseDate: data.released || null,
          overview: data.description || null,
          tagline: data.tagline || null,
          posterPath: data.poster || null,
          backdropPath: data.backdrop || null,
          genres: data.genre || [],
          keywords: data.keywords || [],
          certification: data.certification || null,
          runtime: data.runtime || null,
          status: data.status || null,
          language: data.language || null,
          country: data.country || null,
          numberOfSeasons: data.season_count || null,
          numberOfEpisodes: data.episode_count || null,
                    budget: data.budget ? BigInt(data.budget) : null,
          revenue: data.revenue ? BigInt(data.revenue) : null,
          watchProviders: data.watch_providers as Prisma.InputJsonValue ?? undefined,
          mdblistUpdatedAt: new Date(),
          ratings: {
            create: {
              ...ratings,
              mdblistScore: data.score || null,
              aggregateScore: aggregate.aggregateScore,
              sourceCount: aggregate.sourceCount,
              confidenceScore: aggregate.confidenceScore,
              isTrusted: aggregate.isTrusted,
              aggregatedAt: aggregate.aggregatedAt,
            },
          },
        },
        update: {
          imdbId: data.imdbid || undefined,
          traktId: data.traktid || undefined,
          tvdbId: data.tvdbid || undefined,
          malId: data.malid || undefined,
          title: data.title,
          year: data.year,
          releaseDate: data.released || undefined,
          overview: data.description || undefined,
          tagline: data.tagline || undefined,
          posterPath: data.poster || undefined,
          backdropPath: data.backdrop || undefined,
          genres: data.genre || [],
          keywords: data.keywords || [],
          certification: data.certification || undefined,
          runtime: data.runtime || undefined,
          status: data.status || undefined,
          language: data.language || undefined,
          country: data.country || undefined,
          numberOfSeasons: data.season_count || undefined,
          numberOfEpisodes: data.episode_count || undefined,
                    budget: data.budget ? BigInt(data.budget) : undefined,
          revenue: data.revenue ? BigInt(data.revenue) : undefined,
          watchProviders: data.watch_providers as Prisma.InputJsonValue ?? undefined,
          mdblistUpdatedAt: new Date(),
          ratings: {
            upsert: {
              create: {
                ...ratings,
                mdblistScore: data.score || null,
                aggregateScore: aggregate.aggregateScore,
                sourceCount: aggregate.sourceCount,
                confidenceScore: aggregate.confidenceScore,
                isTrusted: aggregate.isTrusted,
                aggregatedAt: aggregate.aggregatedAt,
              },
              update: {
                ...ratings,
                mdblistScore: data.score || undefined,
                aggregateScore: aggregate.aggregateScore,
                sourceCount: aggregate.sourceCount,
                confidenceScore: aggregate.confidenceScore,
                isTrusted: aggregate.isTrusted,
                aggregatedAt: aggregate.aggregatedAt,
              },
            },
          },
        },
      });

      return true;
    } catch (error) {
      console.error(`Failed to hydrate media item ${id}:`, error);
      return false;
    }
  }

  /**
   * Batch hydrate multiple media items from MDBList only
   * Items not found in MDBList are skipped (use TMDB sync separately)
   * Optimized for high throughput with parallel operations
   */
  async batchHydrateMediaItems(
    items: { tmdbId: number; type: "movie" | "tv" }[]
  ): Promise<{ success: number; failed: number; skipped: number }> {
    let success = 0;
    let failed = 0;
    let skipped = 0;

    // Group by type
    const movies = items.filter((i) => i.type === "movie").map((i) => i.tmdbId);
    const shows = items.filter((i) => i.type === "tv").map((i) => i.tmdbId);

    // Batch fetch movies from MDBList
    if (movies.length > 0) {
      const movieData = await this.batchGetByTmdbIds(movies, "movie");

      // Separate found vs not found
      const foundMovies: Array<{ tmdbId: number; data: MDBListMediaInfo }> = [];

      for (const tmdbId of movies) {
        const data = movieData.get(tmdbId);
        if (data) {
          foundMovies.push({ tmdbId, data });
        } else {
          skipped++; // Not in MDBList - will be handled by TMDB sync
        }
      }

      // Batch save MDBList data (parallel)
      if (foundMovies.length > 0) {
        const saveResults = await Promise.allSettled(
          foundMovies.map(({ tmdbId, data }) => this.saveMediaData(tmdbId, "movie", data))
        );
        for (const result of saveResults) {
          if (result.status === "fulfilled" && result.value) success++;
          else failed++;
        }
      }
    }

    // Batch fetch shows from MDBList
    if (shows.length > 0) {
      const showData = await this.batchGetByTmdbIds(shows, "show");

      // Separate found vs not found
      const foundShows: Array<{ tmdbId: number; data: MDBListMediaInfo }> = [];

      for (const tmdbId of shows) {
        const data = showData.get(tmdbId);
        if (data) {
          foundShows.push({ tmdbId, data });
        } else {
          skipped++; // Not in MDBList - will be handled by TMDB sync
        }
      }

      // Batch save MDBList data (parallel)
      if (foundShows.length > 0) {
        const saveResults = await Promise.allSettled(
          foundShows.map(({ tmdbId, data }) => this.saveMediaData(tmdbId, "tv", data))
        );
        for (const result of saveResults) {
          if (result.status === "fulfilled" && result.value) success++;
          else failed++;
        }
      }
    }

    return { success, failed, skipped };
  }

  /**
   * Save MDBList data to database
   */
  private async saveMediaData(
    tmdbId: number,
    type: "movie" | "tv",
    data: MDBListMediaInfo
  ): Promise<boolean> {
    const id = `tmdb-${type}-${tmdbId}`;
    const prismaType = type === "movie" ? MediaType.MOVIE : MediaType.TV;
    const ratings = this.extractRatings(data.ratings || []);

    // Calculate aggregate score from all rating sources
    const aggregate = calculateAggregateScore(ratings);

    try {
      await prisma.mediaItem.upsert({
        where: { id },
        create: {
          id,
          tmdbId,
          imdbId: data.imdbid || null,
          traktId: data.traktid || null,
          tvdbId: data.tvdbid || null,
          malId: data.malid || null,
          type: prismaType,
          title: data.title,
          year: data.year,
          releaseDate: data.released || null,
          overview: data.description || null,
          tagline: data.tagline || null,
          posterPath: data.poster || null,
          backdropPath: data.backdrop || null,
          genres: data.genre || [],
          keywords: data.keywords || [],
          certification: data.certification || null,
          runtime: data.runtime || null,
          status: data.status || null,
          language: data.language || null,
          country: data.country || null,
          numberOfSeasons: data.season_count || null,
          numberOfEpisodes: data.episode_count || null,
                    budget: data.budget ? BigInt(data.budget) : null,
          revenue: data.revenue ? BigInt(data.revenue) : null,
          watchProviders: data.watch_providers as Prisma.InputJsonValue ?? undefined,
          mdblistUpdatedAt: new Date(),
          ratings: {
            create: {
              ...ratings,
              mdblistScore: data.score || null,
              aggregateScore: aggregate.aggregateScore,
              sourceCount: aggregate.sourceCount,
              confidenceScore: aggregate.confidenceScore,
              isTrusted: aggregate.isTrusted,
              aggregatedAt: aggregate.aggregatedAt,
            },
          },
        },
        update: {
          imdbId: data.imdbid || undefined,
          traktId: data.traktid || undefined,
          tvdbId: data.tvdbid || undefined,
          malId: data.malid || undefined,
          title: data.title,
          year: data.year,
          releaseDate: data.released || undefined,
          overview: data.description || undefined,
          tagline: data.tagline || undefined,
          posterPath: data.poster || undefined,
          backdropPath: data.backdrop || undefined,
          genres: data.genre || [],
          keywords: data.keywords || [],
          certification: data.certification || undefined,
          runtime: data.runtime || undefined,
          status: data.status || undefined,
          language: data.language || undefined,
          country: data.country || undefined,
          numberOfSeasons: data.season_count || undefined,
          numberOfEpisodes: data.episode_count || undefined,
                    budget: data.budget ? BigInt(data.budget) : undefined,
          revenue: data.revenue ? BigInt(data.revenue) : undefined,
          watchProviders: data.watch_providers as Prisma.InputJsonValue ?? undefined,
          mdblistUpdatedAt: new Date(),
          ratings: {
            upsert: {
              create: {
                ...ratings,
                mdblistScore: data.score || null,
                aggregateScore: aggregate.aggregateScore,
                sourceCount: aggregate.sourceCount,
                confidenceScore: aggregate.confidenceScore,
                isTrusted: aggregate.isTrusted,
                aggregatedAt: aggregate.aggregatedAt,
              },
              update: {
                ...ratings,
                mdblistScore: data.score || undefined,
                aggregateScore: aggregate.aggregateScore,
                sourceCount: aggregate.sourceCount,
                confidenceScore: aggregate.confidenceScore,
                isTrusted: aggregate.isTrusted,
                aggregatedAt: aggregate.aggregatedAt,
              },
            },
          },
        },
      });

      return true;
    } catch (error) {
      console.error(`Failed to save media data ${id}:`, error);
      return false;
    }
  }

  /**
   * Extract ratings from MDBList ratings array into our schema format
   */
  private extractRatings(ratings: MDBListRating[]): Record<string, number | null> {
    const result: Record<string, number | null> = {
      imdbScore: null,
      imdbVotes: null,
      tmdbScore: null,
      tmdbVotes: null,
      tmdbPopularity: null,
      rtCriticScore: null,
      rtAudienceScore: null,
      metacriticScore: null,
      metacriticUserScore: null,
      traktScore: null,
      traktVotes: null,
      letterboxdScore: null,
      rogerebtScore: null,
      malScore: null,
    };

    for (const rating of ratings) {
      switch (rating.source.toLowerCase()) {
        case "imdb":
          result.imdbScore = rating.value; // 0-10
          result.imdbVotes = rating.votes;
          break;
        case "tmdb":
          result.tmdbScore = rating.value; // 0-10
          result.tmdbVotes = rating.votes;
          break;
        case "tomatoes":
          result.rtCriticScore = rating.score; // 0-100
          break;
        case "audience":
          result.rtAudienceScore = rating.score; // 0-100
          break;
        case "metacritic":
          result.metacriticScore = rating.score; // 0-100
          break;
        case "metacriticuser":
          result.metacriticUserScore = rating.value; // 0-10
          break;
        case "trakt":
          result.traktScore = rating.score; // 0-100
          result.traktVotes = rating.votes;
          break;
        case "letterboxd":
          result.letterboxdScore = rating.score; // 0-100 (converted from 0-5)
          break;
        case "rogerebert":
          result.rogerebtScore = rating.value; // 0-4 stars
          break;
        case "mal":
          result.malScore = rating.value; // 0-10
          break;
      }
    }

    return result;
  }

  /**
   * Check if a media item needs refreshing (older than 24 hours)
   */
  async needsRefresh(tmdbId: number, type: "movie" | "tv"): Promise<boolean> {
    const id = `tmdb-${type}-${tmdbId}`;
    const item = await prisma.mediaItem.findUnique({
      where: { id },
      select: { mdblistUpdatedAt: true },
    });

    if (!item || !item.mdblistUpdatedAt) {
      return true;
    }

    const hoursSinceUpdate = (Date.now() - item.mdblistUpdatedAt.getTime()) / (1000 * 60 * 60);
    return hoursSinceUpdate > 24;
  }

  /**
   * Queue a background refresh for a media item if stale
   */
  async queueRefreshIfStale(tmdbId: number, type: "movie" | "tv"): Promise<void> {
    const needsUpdate = await this.needsRefresh(tmdbId, type);
    if (needsUpdate) {
      // Queue a job to refresh this item
      await prisma.job.create({
        data: {
          type: "mdblist-refresh",
          payload: { tmdbId, type },
          priority: 0, // Low priority for background refresh
        },
      });
    }
  }

  /**
   * Search for media on MDBList
   */
  async search(
    query: string,
    type: "movie" | "show" | "any" = "any",
    limit = 20
  ): Promise<Array<{ tmdbId: number; title: string; year: number; score: number }>> {
    try {
      const response = await this.fetch<Array<{
        id: number;
        title: string;
        year: number;
        score: number;
        imdbid?: string;
        tmdbid?: number;
      }>>(`/search/${type}?query=${encodeURIComponent(query)}&limit=${limit}`);

      return response.map((item) => ({
        tmdbId: item.tmdbid || item.id,
        title: item.title,
        year: item.year,
        score: item.score,
      }));
    } catch (error) {
      console.error("MDBList search failed:", error);
      return [];
    }
  }

  /**
   * Get API usage limits
   */
  async getLimits(): Promise<{ used: number; limit: number; patron: boolean } | null> {
    try {
      const response = await this.fetch<{
        api_requests: number;
        api_requests_limit: number;
        patron: boolean;
      }>("/user");

      return {
        used: response.api_requests,
        limit: response.api_requests_limit,
        patron: response.patron,
      };
    } catch (error) {
      console.error("Failed to get MDBList limits:", error);
      return null;
    }
  }
}

// Singleton instance
let mdblistService: MDBListService | null = null;

export function getMDBListService(): MDBListService {
  if (!mdblistService) {
    mdblistService = new MDBListService();
  }
  return mdblistService;
}

export { MDBListService };
