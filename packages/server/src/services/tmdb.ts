/**
 * TMDB (The Movie Database) API Service
 *
 * Provides access to TMDB API for metadata, images, and videos.
 * API docs: https://developer.themoviedb.org/docs/getting-started
 *
 * Features:
 * - Rate limiting (10 requests/second)
 * - In-memory caching (1 minute for deduplication)
 * - High-quality images (posters, backdrops)
 * - Comprehensive metadata (cast, crew, genres, ratings, etc.)
 */

import { getSecretsService } from "./secrets.js";

const TMDB_API_BASE = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100; // 10 requests per second max

// Cache TTLs (in milliseconds)
const CACHE_TTL = {
  details: 60 * 1000, // 1 minute - for request deduplication
  videos: 60 * 1000, // 1 minute
} as const;

// Simple in-memory cache
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class SimpleCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Interval must be stored to keep it alive
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Cleanup expired entries every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttl: number): void {
    this.cache.set(key, {
      data,
      expiresAt: Date.now() + ttl,
    });
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

const cache = new SimpleCache();

// === Types ===

export interface TMDBMovieDetails {
  id: number;
  imdb_id: string | null;
  title: string;
  original_title: string;
  overview: string | null;
  tagline: string | null;
  release_date: string | null; // YYYY-MM-DD
  runtime: number | null; // minutes
  status: string; // "Released", "Post Production", etc.
  genres: Array<{ id: number; name: string }>;
  spoken_languages: Array<{ iso_639_1: string; name: string }>;
  production_countries: Array<{ iso_3166_1: string; name: string }>;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count: number;
  popularity: number;
  adult: boolean;
  original_language: string;
  budget: number;
  revenue: number;
  homepage: string | null;
  production_companies: Array<{ id: number; name: string; logo_path: string | null }>;
}

export interface TMDBTVDetails {
  id: number;
  name: string;
  original_name: string;
  overview: string | null;
  tagline: string | null;
  first_air_date: string | null; // YYYY-MM-DD
  last_air_date: string | null;
  episode_run_time: number[];
  status: string; // "Returning Series", "Ended", "Canceled", etc.
  genres: Array<{ id: number; name: string }>;
  spoken_languages: Array<{ iso_639_1: string; name: string }>;
  origin_country: string[];
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count: number;
  popularity: number;
  adult: boolean;
  original_language: string;
  homepage: string | null;
  networks: Array<{ id: number; name: string; logo_path: string | null }>;
  production_companies: Array<{ id: number; name: string; logo_path: string | null }>;
  number_of_seasons: number;
  number_of_episodes: number;
  seasons: Array<{
    id: number;
    season_number: number;
    episode_count: number;
    name: string;
    overview: string | null;
    poster_path: string | null;
    air_date: string | null;
  }>;
}

export interface TMDBVideos {
  results: Array<{
    id: string;
    key: string; // YouTube video ID
    name: string;
    site: string; // "YouTube"
    type: string; // "Trailer", "Teaser", "Clip", etc.
    official: boolean;
    published_at: string;
    size: number; // 360, 480, 720, 1080
  }>;
}

export interface TMDBCredits {
  cast: Array<{
    id: number;
    name: string;
    character: string;
    order: number;
    profile_path: string | null;
  }>;
  crew: Array<{
    id: number;
    name: string;
    job: string;
    department: string;
    profile_path: string | null;
  }>;
}

class TMDBService {
  private apiKey: string | undefined;
  private apiKeyPromise: Promise<string | undefined> | null = null;

  constructor() {
    // Load from env initially as fallback (for backward compatibility with ENV var)
    this.apiKey = process.env.TMDB_API_KEY;

    // Listen for secret changes to refresh API key
    const secrets = getSecretsService();
    secrets.on("change", (key: string) => {
      if (key === "tmdb.apiKey") {
        this.apiKey = undefined;
        this.apiKeyPromise = null;
      }
    });
  }

  /**
   * Get API key from secrets or config (with caching)
   */
  private async getApiKey(): Promise<string | undefined> {
    if (this.apiKey) return this.apiKey;

    if (this.apiKeyPromise) {
      return await this.apiKeyPromise;
    }

    this.apiKeyPromise = (async () => {
      const secrets = getSecretsService();
      const secretKey = await secrets.getSecret("tmdb.apiKey");
      if (secretKey) {
        this.apiKey = secretKey;
        return secretKey;
      }

      // Fall back to env var if no secret
      if (process.env.TMDB_API_KEY) {
        this.apiKey = process.env.TMDB_API_KEY;
        return process.env.TMDB_API_KEY;
      }

      return undefined;
    })();

    return await this.apiKeyPromise;
  }

  /**
   * Check if TMDB API is configured
   */
  async isConfigured(): Promise<boolean> {
    const key = await this.getApiKey();
    return !!key;
  }

  /**
   * Make rate-limited API request
   */
  private async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error("TMDB API key not configured");
    }

    // Rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest)
      );
    }
    lastRequestTime = Date.now();

    // Build URL
    const url = new URL(`${TMDB_API_BASE}${endpoint}`);
    url.searchParams.set("api_key", apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TMDB API error: ${response.status} ${error}`);
    }

    return (await response.json()) as T;
  }

  /**
   * Get full image URL from TMDB path
   */
  getImageUrl(path: string | null, size: "w500" | "original" = "w500"): string | null {
    if (!path) return null;
    return `${TMDB_IMAGE_BASE}/${size}${path}`;
  }

  /**
   * Get movie details by TMDB ID
   */
  async getMovieDetails(tmdbId: number): Promise<TMDBMovieDetails> {
    const cacheKey = `movie:${tmdbId}`;
    const cached = cache.get<TMDBMovieDetails>(cacheKey);
    if (cached) return cached;

    const data = await this.request<TMDBMovieDetails>(`/movie/${tmdbId}`);
    cache.set(cacheKey, data, CACHE_TTL.details);
    return data;
  }

  /**
   * Get TV show details by TMDB ID
   */
  async getTVDetails(tmdbId: number): Promise<TMDBTVDetails> {
    const cacheKey = `tv:${tmdbId}`;
    const cached = cache.get<TMDBTVDetails>(cacheKey);
    if (cached) return cached;

    const data = await this.request<TMDBTVDetails>(`/tv/${tmdbId}`);
    cache.set(cacheKey, data, CACHE_TTL.details);
    return data;
  }

  /**
   * Get movie videos (trailers, etc.)
   */
  async getMovieVideos(tmdbId: number): Promise<TMDBVideos> {
    const cacheKey = `movie:${tmdbId}:videos`;
    const cached = cache.get<TMDBVideos>(cacheKey);
    if (cached) return cached;

    const data = await this.request<TMDBVideos>(`/movie/${tmdbId}/videos`);
    cache.set(cacheKey, data, CACHE_TTL.videos);
    return data;
  }

  /**
   * Get TV show videos (trailers, etc.)
   */
  async getTVVideos(tmdbId: number): Promise<TMDBVideos> {
    const cacheKey = `tv:${tmdbId}:videos`;
    const cached = cache.get<TMDBVideos>(cacheKey);
    if (cached) return cached;

    const data = await this.request<TMDBVideos>(`/tv/${tmdbId}/videos`);
    cache.set(cacheKey, data, CACHE_TTL.videos);
    return data;
  }

  /**
   * Get movie credits (cast and crew)
   */
  async getMovieCredits(tmdbId: number): Promise<TMDBCredits> {
    const cacheKey = `movie:${tmdbId}:credits`;
    const cached = cache.get<TMDBCredits>(cacheKey);
    if (cached) return cached;

    const data = await this.request<TMDBCredits>(`/movie/${tmdbId}/credits`);
    cache.set(cacheKey, data, CACHE_TTL.details);
    return data;
  }

  /**
   * Get TV show credits (cast and crew)
   */
  async getTVCredits(tmdbId: number): Promise<TMDBCredits> {
    const cacheKey = `tv:${tmdbId}:credits`;
    const cached = cache.get<TMDBCredits>(cacheKey);
    if (cached) return cached;

    const data = await this.request<TMDBCredits>(`/tv/${tmdbId}/credits`);
    cache.set(cacheKey, data, CACHE_TTL.details);
    return data;
  }

  /**
   * Get TV season details with episodes
   */
  async getTVSeasonDetails(
    tmdbId: number,
    seasonNumber: number
  ): Promise<{
    id: number;
    season_number: number;
    name: string;
    overview: string | null;
    poster_path: string | null;
    air_date: string | null;
    episodes: Array<{
      id: number;
      episode_number: number;
      name: string;
      overview: string | null;
      still_path: string | null;
      air_date: string | null;
      runtime: number | null;
    }>;
  }> {
    const cacheKey = `tv:${tmdbId}:season:${seasonNumber}`;
    const cached = cache.get<{
      id: number;
      season_number: number;
      name: string;
      overview: string | null;
      poster_path: string | null;
      air_date: string | null;
      episodes: Array<{
        id: number;
        episode_number: number;
        name: string;
        overview: string | null;
        still_path: string | null;
        air_date: string | null;
        runtime: number | null;
      }>;
    }>(cacheKey);
    if (cached) return cached;

    const data = await this.request<{
      id: number;
      season_number: number;
      name: string;
      overview: string | null;
      poster_path: string | null;
      air_date: string | null;
      episodes: Array<{
        id: number;
        episode_number: number;
        name: string;
        overview: string | null;
        still_path: string | null;
        air_date: string | null;
        runtime: number | null;
      }>;
    }>(`/tv/${tmdbId}/season/${seasonNumber}`);
    cache.set(cacheKey, data, CACHE_TTL.details);
    return data;
  }

  /**
   * Get trailer key from videos response
   */
  extractTrailerKey(videos: TMDBVideos): string | null {
    // Find official trailer first
    const officialTrailer = videos.results.find(
      (v) => v.site === "YouTube" && v.type === "Trailer" && v.official
    );
    if (officialTrailer) return officialTrailer.key;

    // Fall back to any trailer
    const anyTrailer = videos.results.find((v) => v.site === "YouTube" && v.type === "Trailer");
    if (anyTrailer) return anyTrailer.key;

    return null;
  }
}

// Singleton instance
let tmdbService: TMDBService | null = null;

export function getTMDBService(): TMDBService {
  if (!tmdbService) {
    tmdbService = new TMDBService();
  }
  return tmdbService;
}
