/**
 * Trakt API Service
 *
 * Provides access to Trakt.tv API for discovery lists.
 * API docs: https://trakt.docs.apiary.io/
 *
 * Supported list types:
 * - trending: Currently being watched
 * - popular: Most popular all-time
 * - favorited: Most favorited by users
 * - played: Most plays (with period)
 * - watched: Most watchers (with period)
 * - collected: Most collected (with period)
 */

import { getConfig } from "../config/index.js";
import { getSecretsService } from "./secrets.js";

const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_API_VERSION = "2";

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 250; // 4 requests per second max

// Cache TTLs (in milliseconds)
const CACHE_TTL = {
  trending: 2 * 60 * 1000, // 2 minutes - changes frequently
  popular: 10 * 60 * 1000, // 10 minutes - cumulative, changes slowly
  favorited: 10 * 60 * 1000, // 10 minutes - cumulative, changes slowly
  played: 5 * 60 * 1000, // 5 minutes - period-based activity
  watched: 5 * 60 * 1000, // 5 minutes - period-based activity
  collected: 5 * 60 * 1000, // 5 minutes - period-based activity
  genres: 60 * 60 * 1000, // 1 hour - rarely changes
  search: 5 * 60 * 1000, // 5 minutes - search results
} as const;

// Simple in-memory cache
interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class SimpleCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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

interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

interface TraktImages {
  poster?: string[];
  fanart?: string[];
  banner?: string[];
  thumb?: string[];
  screenshot?: string[];  // Used for episode images
  logo?: string[];
  clearart?: string[];
}

interface TraktMovie {
  title: string;
  year: number;
  ids: TraktIds;
  images?: TraktImages;
}

interface TraktShow {
  title: string;
  year: number;
  ids: TraktIds;
  images?: TraktImages;
}

// List response types
interface TraktTrendingMovie {
  watchers: number;
  movie: TraktMovie;
}

interface TraktTrendingShow {
  watchers: number;
  show: TraktShow;
}

interface TraktFavoritedMovie {
  user_count: number;
  movie: TraktMovie;
}

interface TraktFavoritedShow {
  user_count: number;
  show: TraktShow;
}

interface TraktPlayedMovie {
  watcher_count: number;
  play_count: number;
  movie: TraktMovie;
}

interface TraktPlayedShow {
  watcher_count: number;
  play_count: number;
  show: TraktShow;
}

interface TraktWatchedMovie {
  watcher_count: number;
  play_count: number;
  movie: TraktMovie;
}

interface TraktWatchedShow {
  watcher_count: number;
  play_count: number;
  show: TraktShow;
}

interface TraktCollectedMovie {
  collector_count: number;
  movie: TraktMovie;
}

interface TraktCollectedShow {
  collector_count: number;
  show: TraktShow;
}

// Search response types
interface TraktSearchResult {
  type: "movie" | "show";
  score: number;
  movie?: TraktMovie;
  show?: TraktShow;
}

export interface TraktGenre {
  name: string;
  slug: string;
}

// Filter parameters matching Trakt API
export interface TraktFilterParams {
  query?: string;
  years?: string;
  genres?: string;
  languages?: string;
  countries?: string;
  runtimes?: string;
  ratings?: string;
  tmdb_ratings?: string;
  imdb_ratings?: string;
  rt_meters?: string;
  rt_user_meters?: string;
  metascores?: string;
  certifications?: string;
}

export type TraktListType =
  | "trending"
  | "popular"
  | "favorited"
  | "played"
  | "watched"
  | "collected";

export type TraktPeriod = "daily" | "weekly" | "monthly" | "yearly" | "all";

// Unified result type
export interface TraktDiscoverItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  year: number;
  statValue?: number;
  statLabel?: string;
  posterUrl?: string;
  fanartUrl?: string;
}

// === Full detail types (from extended=full,images) ===

export interface TraktMovieDetails {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    imdb: string | null;
    tmdb: number;
  };
  tagline: string | null;
  overview: string | null;
  released: string | null; // YYYY-MM-DD
  runtime: number | null; // minutes
  certification: string | null;
  trailer: string | null; // YouTube URL
  homepage: string | null;
  status: string;
  rating: number; // 0-10
  votes: number;
  comment_count: number;
  updated_at: string;
  language: string | null;
  available_translations: string[];
  genres: string[];
  country: string | null;
  images?: TraktImages;
}

export interface TraktShowDetails {
  title: string;
  year: number;
  ids: {
    trakt: number;
    slug: string;
    imdb: string | null;
    tmdb: number;
    tvdb: number | null;
  };
  overview: string | null;
  first_aired: string | null; // ISO 8601
  runtime: number | null; // minutes
  certification: string | null;
  network: string | null;
  trailer: string | null; // YouTube URL
  homepage: string | null;
  status: string; // "returning series", "ended", "canceled", "in production"
  rating: number; // 0-10
  votes: number;
  comment_count: number;
  updated_at: string;
  language: string | null;
  available_translations: string[];
  genres: string[];
  country: string | null;
  aired_episodes: number;
  images?: TraktImages;
}

export interface TraktSeasonDetails {
  number: number;
  ids: {
    trakt: number;
    tvdb: number | null;
    tmdb: number | null;
  };
  rating: number;
  votes: number;
  episode_count: number;
  aired_episodes: number;
  title: string | null;
  overview: string | null;
  first_aired: string | null;
  updated_at: string;
  network: string | null;
  images?: TraktImages;
  episodes?: TraktEpisodeDetails[];
}

export interface TraktEpisodeDetails {
  season: number;
  number: number;
  title: string | null;
  ids: {
    trakt: number;
    tvdb: number | null;
    imdb: string | null;
    tmdb: number | null;
  };
  overview: string | null;
  rating: number;
  votes: number;
  first_aired: string | null;
  updated_at: string;
  runtime: number | null;
  images?: TraktImages;
}

class TraktService {
  private clientId: string | undefined;
  private clientIdPromise: Promise<string | undefined> | null = null;

  constructor() {
    const config = getConfig();
    // Load from config initially as fallback
    this.clientId = config.trakt?.clientId;

    // Listen for secret changes to refresh client ID
    const secrets = getSecretsService();
    secrets.on("change", (key: string) => {
      if (key === "trakt.clientId") {
        this.clientId = undefined;
        this.clientIdPromise = null;
      }
    });
  }

  /**
   * Get client ID from secrets store (preferred) or config (fallback)
   */
  private async getClientId(): Promise<string | undefined> {
    // Return cached value if available
    if (this.clientId) {
      return this.clientId;
    }

    // Prevent duplicate fetches
    if (this.clientIdPromise) {
      return this.clientIdPromise;
    }

    this.clientIdPromise = (async () => {
      try {
        const secrets = getSecretsService();
        const secretValue = await secrets.getSecret("trakt.clientId");
        if (secretValue) {
          this.clientId = secretValue;
          return secretValue;
        }
      } catch {
        // Fall back to config on error
      }

      // Fall back to config
      const config = getConfig();
      this.clientId = config.trakt?.clientId;
      return this.clientId;
    })();

    return this.clientIdPromise;
  }

  async isConfigured(): Promise<boolean> {
    const clientId = await this.getClientId();
    return Boolean(clientId);
  }

  private async fetch<T>(
    endpoint: string,
    params?: Record<string, string>
  ): Promise<T> {
    const clientId = await this.getClientId();
    if (!clientId) {
      throw new Error(
        "Trakt API not configured. Set ANNEX_TRAKT_CLIENT_ID in your environment or configure via Settings."
      );
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

    const url = new URL(`${TRAKT_API_BASE}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value) {
          url.searchParams.set(key, value);
        }
      });
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": TRAKT_API_VERSION,
        "trakt-api-key": clientId,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Trakt API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  private buildParams(
    page: number,
    limit: number,
    filters?: TraktFilterParams
  ): Record<string, string> {
    const params: Record<string, string> = {
      page: String(page),
      limit: String(limit),
      extended: "images",
    };

    if (filters) {
      if (filters.query) params.query = filters.query;
      if (filters.years) params.years = filters.years;
      if (filters.genres) params.genres = filters.genres;
      if (filters.languages) params.languages = filters.languages;
      if (filters.countries) params.countries = filters.countries;
      if (filters.runtimes) params.runtimes = filters.runtimes;
      if (filters.ratings) params.ratings = filters.ratings;
      if (filters.tmdb_ratings) params.tmdb_ratings = filters.tmdb_ratings;
      if (filters.imdb_ratings) params.imdb_ratings = filters.imdb_ratings;
      if (filters.rt_meters) params.rt_meters = filters.rt_meters;
      if (filters.rt_user_meters) params.rt_user_meters = filters.rt_user_meters;
      if (filters.metascores) params.metascores = filters.metascores;
      if (filters.certifications) params.certifications = filters.certifications;
    }

    return params;
  }

  private extractPoster(images?: TraktImages): string | undefined {
    const url = images?.poster?.[0];
    if (!url) return undefined;
    // Ensure URL has protocol
    return url.startsWith("http") ? url : `https://${url}`;
  }

  private extractFanart(images?: TraktImages): string | undefined {
    // Try fanart first, fall back to banner
    const url = images?.fanart?.[0] || images?.banner?.[0];
    if (!url) return undefined;
    // Ensure URL has protocol
    return url.startsWith("http") ? url : `https://${url}`;
  }

  // === Trending ===

  async getTrending(
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const params = this.buildParams(page, limit, filters);
    const endpoint = type === "movie" ? "/movies/trending" : "/shows/trending";

    if (type === "movie") {
      const results = await this.fetch<TraktTrendingMovie[]>(endpoint, params);
      return results
        .filter((item) => item.movie.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.movie.ids.tmdb!,
          type: "movie" as const,
          title: item.movie.title,
          year: item.movie.year,
          statValue: item.watchers,
          statLabel: "watching",
          posterUrl: this.extractPoster(item.movie.images),
          fanartUrl: this.extractFanart(item.movie.images),
        }));
    } else {
      const results = await this.fetch<TraktTrendingShow[]>(endpoint, params);
      return results
        .filter((item) => item.show.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.show.ids.tmdb!,
          type: "tv" as const,
          title: item.show.title,
          year: item.show.year,
          statValue: item.watchers,
          statLabel: "watching",
          posterUrl: this.extractPoster(item.show.images),
          fanartUrl: this.extractFanart(item.show.images),
        }));
    }
  }

  // === Popular ===

  async getPopular(
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const params = this.buildParams(page, limit, filters);
    const endpoint = type === "movie" ? "/movies/popular" : "/shows/popular";

    if (type === "movie") {
      const results = await this.fetch<TraktMovie[]>(endpoint, params);
      return results
        .filter((item) => item.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.ids.tmdb!,
          type: "movie" as const,
          title: item.title,
          year: item.year,
          posterUrl: this.extractPoster(item.images),
          fanartUrl: this.extractFanart(item.images),
        }));
    } else {
      const results = await this.fetch<TraktShow[]>(endpoint, params);
      return results
        .filter((item) => item.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.ids.tmdb!,
          type: "tv" as const,
          title: item.title,
          year: item.year,
          posterUrl: this.extractPoster(item.images),
          fanartUrl: this.extractFanart(item.images),
        }));
    }
  }

  // === Favorited ===

  async getFavorited(
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const params = this.buildParams(page, limit, filters);
    const endpoint = type === "movie" ? "/movies/favorited" : "/shows/favorited";

    if (type === "movie") {
      const results = await this.fetch<TraktFavoritedMovie[]>(endpoint, params);
      return results
        .filter((item) => item.movie.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.movie.ids.tmdb!,
          type: "movie" as const,
          title: item.movie.title,
          year: item.movie.year,
          statValue: item.user_count,
          statLabel: "favorites",
          posterUrl: this.extractPoster(item.movie.images),
          fanartUrl: this.extractFanart(item.movie.images),
        }));
    } else {
      const results = await this.fetch<TraktFavoritedShow[]>(endpoint, params);
      return results
        .filter((item) => item.show.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.show.ids.tmdb!,
          type: "tv" as const,
          title: item.show.title,
          year: item.show.year,
          statValue: item.user_count,
          statLabel: "favorites",
          posterUrl: this.extractPoster(item.show.images),
          fanartUrl: this.extractFanart(item.show.images),
        }));
    }
  }

  // === Played (with period) ===

  async getPlayed(
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    period: TraktPeriod = "weekly",
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const params = this.buildParams(page, limit, filters);
    const endpoint =
      type === "movie" ? `/movies/played/${period}` : `/shows/played/${period}`;

    if (type === "movie") {
      const results = await this.fetch<TraktPlayedMovie[]>(endpoint, params);
      return results
        .filter((item) => item.movie.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.movie.ids.tmdb!,
          type: "movie" as const,
          title: item.movie.title,
          year: item.movie.year,
          statValue: item.play_count,
          statLabel: "plays",
          posterUrl: this.extractPoster(item.movie.images),
          fanartUrl: this.extractFanart(item.movie.images),
        }));
    } else {
      const results = await this.fetch<TraktPlayedShow[]>(endpoint, params);
      return results
        .filter((item) => item.show.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.show.ids.tmdb!,
          type: "tv" as const,
          title: item.show.title,
          year: item.show.year,
          statValue: item.play_count,
          statLabel: "plays",
          posterUrl: this.extractPoster(item.show.images),
          fanartUrl: this.extractFanart(item.show.images),
        }));
    }
  }

  // === Watched (with period) ===

  async getWatched(
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    period: TraktPeriod = "weekly",
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const params = this.buildParams(page, limit, filters);
    const endpoint =
      type === "movie" ? `/movies/watched/${period}` : `/shows/watched/${period}`;

    if (type === "movie") {
      const results = await this.fetch<TraktWatchedMovie[]>(endpoint, params);
      return results
        .filter((item) => item.movie.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.movie.ids.tmdb!,
          type: "movie" as const,
          title: item.movie.title,
          year: item.movie.year,
          statValue: item.watcher_count,
          statLabel: "watchers",
          posterUrl: this.extractPoster(item.movie.images),
          fanartUrl: this.extractFanart(item.movie.images),
        }));
    } else {
      const results = await this.fetch<TraktWatchedShow[]>(endpoint, params);
      return results
        .filter((item) => item.show.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.show.ids.tmdb!,
          type: "tv" as const,
          title: item.show.title,
          year: item.show.year,
          statValue: item.watcher_count,
          statLabel: "watchers",
          posterUrl: this.extractPoster(item.show.images),
          fanartUrl: this.extractFanart(item.show.images),
        }));
    }
  }

  // === Collected (with period) ===

  async getCollected(
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    period: TraktPeriod = "weekly",
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const params = this.buildParams(page, limit, filters);
    const endpoint =
      type === "movie"
        ? `/movies/collected/${period}`
        : `/shows/collected/${period}`;

    if (type === "movie") {
      const results = await this.fetch<TraktCollectedMovie[]>(endpoint, params);
      return results
        .filter((item) => item.movie.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.movie.ids.tmdb!,
          type: "movie" as const,
          title: item.movie.title,
          year: item.movie.year,
          statValue: item.collector_count,
          statLabel: "collected",
          posterUrl: this.extractPoster(item.movie.images),
          fanartUrl: this.extractFanart(item.movie.images),
        }));
    } else {
      const results = await this.fetch<TraktCollectedShow[]>(endpoint, params);
      return results
        .filter((item) => item.show.ids.tmdb != null)
        .map((item) => ({
          tmdbId: item.show.ids.tmdb!,
          type: "tv" as const,
          title: item.show.title,
          year: item.show.year,
          statValue: item.collector_count,
          statLabel: "collected",
          posterUrl: this.extractPoster(item.show.images),
          fanartUrl: this.extractFanart(item.show.images),
        }));
    }
  }

  // === Cache key generation ===

  private buildCacheKey(
    listType: TraktListType,
    type: "movie" | "tv",
    page: number,
    limit: number,
    period?: TraktPeriod,
    filters?: TraktFilterParams
  ): string {
    const parts: (string | number)[] = [listType, type, page, limit];
    if (period && ["played", "watched", "collected"].includes(listType)) {
      parts.push(period);
    }
    if (filters) {
      // Sort filter keys for consistent cache keys
      const filterStr = Object.entries(filters)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&");
      if (filterStr) parts.push(filterStr);
    }
    return parts.join(":");
  }

  // === Unified list method (with caching) ===

  async getList(
    listType: TraktListType,
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    period: TraktPeriod = "weekly",
    filters?: TraktFilterParams
  ): Promise<TraktDiscoverItem[]> {
    const cacheKey = this.buildCacheKey(listType, type, page, limit, period, filters);
    const cached = cache.get<TraktDiscoverItem[]>(cacheKey);
    if (cached) {
      return cached;
    }

    let result: TraktDiscoverItem[];
    switch (listType) {
      case "trending":
        result = await this.getTrending(type, page, limit, filters);
        break;
      case "popular":
        result = await this.getPopular(type, page, limit, filters);
        break;
      case "favorited":
        result = await this.getFavorited(type, page, limit, filters);
        break;
      case "played":
        result = await this.getPlayed(type, page, limit, period, filters);
        break;
      case "watched":
        result = await this.getWatched(type, page, limit, period, filters);
        break;
      case "collected":
        result = await this.getCollected(type, page, limit, period, filters);
        break;
      default:
        throw new Error(`Unknown list type: ${listType}`);
    }

    cache.set(cacheKey, result, CACHE_TTL[listType]);
    return result;
  }

  // === Genres (with caching) ===

  async getGenres(type: "movie" | "tv"): Promise<TraktGenre[]> {
    const cacheKey = `genres:${type}`;
    const cached = cache.get<TraktGenre[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const endpoint = type === "movie" ? "/genres/movies" : "/genres/shows";
    const result = await this.fetch<TraktGenre[]>(endpoint);
    cache.set(cacheKey, result, CACHE_TTL.genres);
    return result;
  }

  // === Search (with caching) ===

  async search(
    query: string,
    type: "movie" | "tv",
    page = 1,
    limit = 20,
    filters?: Omit<TraktFilterParams, "query">
  ): Promise<TraktDiscoverItem[]> {
    if (!query.trim()) {
      return [];
    }

    const cacheKey = `search:${type}:${page}:${limit}:${query}:${JSON.stringify(filters || {})}`;
    const cached = cache.get<TraktDiscoverItem[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const searchType = type === "movie" ? "movie" : "show";
    const endpoint = `/search/${searchType}`;

    const params: Record<string, string> = {
      query: query.trim(),
      page: String(page),
      limit: String(limit),
      extended: "images",
    };

    // Add optional filters
    if (filters) {
      if (filters.years) params.years = filters.years;
      if (filters.genres) params.genres = filters.genres;
      if (filters.languages) params.languages = filters.languages;
      if (filters.countries) params.countries = filters.countries;
      if (filters.runtimes) params.runtimes = filters.runtimes;
      if (filters.ratings) params.ratings = filters.ratings;
      if (filters.tmdb_ratings) params.tmdb_ratings = filters.tmdb_ratings;
      if (filters.imdb_ratings) params.imdb_ratings = filters.imdb_ratings;
      if (filters.rt_meters) params.rt_meters = filters.rt_meters;
      if (filters.rt_user_meters) params.rt_user_meters = filters.rt_user_meters;
      if (filters.metascores) params.metascores = filters.metascores;
      if (filters.certifications) params.certifications = filters.certifications;
    }

    const results = await this.fetch<TraktSearchResult[]>(endpoint, params);

    const items: TraktDiscoverItem[] = [];
    for (const item of results) {
      if (item.type === "movie" && item.movie?.ids.tmdb) {
        items.push({
          tmdbId: item.movie.ids.tmdb,
          type: "movie",
          title: item.movie.title,
          year: item.movie.year,
          posterUrl: this.extractPoster(item.movie.images),
          fanartUrl: this.extractFanart(item.movie.images),
        });
      } else if (item.type === "show" && item.show?.ids.tmdb) {
        items.push({
          tmdbId: item.show.ids.tmdb,
          type: "tv",
          title: item.show.title,
          year: item.show.year,
          posterUrl: this.extractPoster(item.show.images),
          fanartUrl: this.extractFanart(item.show.images),
        });
      }
    }

    cache.set(cacheKey, items, CACHE_TTL.search);
    return items;
  }

  // === Lookup Trakt ID from TMDB ID ===

  private async getTraktSlugFromTmdbId(
    tmdbId: number,
    type: "movie" | "show"
  ): Promise<string> {
    const cacheKey = `tmdb-to-trakt:${type}:${tmdbId}`;
    const cached = cache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    // Use Trakt's ID lookup endpoint to find by TMDB ID
    const endpoint = `/search/tmdb/${tmdbId}`;
    const params = { type };

    interface SearchResult {
      type: string;
      score: number;
      movie?: { ids: { trakt: number; slug: string; imdb: string; tmdb: number } };
      show?: { ids: { trakt: number; slug: string; imdb: string; tmdb: number } };
    }

    const results = await this.fetch<SearchResult[]>(endpoint, params);

    if (!results || results.length === 0) {
      throw new Error(`No Trakt entry found for TMDB ID ${tmdbId} (${type})`);
    }

    // Get the slug from the first matching result
    const result = results[0];
    const slug = type === "movie" ? result.movie?.ids.slug : result.show?.ids.slug;

    if (!slug) {
      throw new Error(`No slug found for TMDB ID ${tmdbId} (${type})`);
    }

    // Cache the mapping for 30 days (IDs don't change)
    cache.set(cacheKey, slug, 30 * 24 * 60 * 60 * 1000);
    return slug;
  }

  // === Movie Details ===

  async getMovieDetails(tmdbId: number): Promise<TraktMovieDetails> {
    const cacheKey = `movie:details:${tmdbId}`;
    const cached = cache.get<TraktMovieDetails>(cacheKey);
    if (cached) {
      return cached;
    }

    // First lookup the Trakt slug from TMDB ID
    const slug = await this.getTraktSlugFromTmdbId(tmdbId, "movie");

    const endpoint = `/movies/${slug}`;
    const params = { extended: "full,images" };

    const result = await this.fetch<TraktMovieDetails>(endpoint, params);

    // Cache for 7 days (matches our DB cache TTL)
    cache.set(cacheKey, result, 7 * 24 * 60 * 60 * 1000);
    return result;
  }

  // === TV Show Details ===

  async getTvShowDetails(tmdbId: number): Promise<TraktShowDetails> {
    const cacheKey = `show:details:${tmdbId}`;
    const cached = cache.get<TraktShowDetails>(cacheKey);
    if (cached) {
      return cached;
    }

    // First lookup the Trakt slug from TMDB ID
    const slug = await this.getTraktSlugFromTmdbId(tmdbId, "show");

    const endpoint = `/shows/${slug}`;
    const params = { extended: "full,images" };

    const result = await this.fetch<TraktShowDetails>(endpoint, params);

    // Cache for 7 days
    cache.set(cacheKey, result, 7 * 24 * 60 * 60 * 1000);
    return result;
  }

  // === TV Season Episodes ===
  // Note: GET /shows/{id}/seasons/{season} returns an array of episodes directly

  async getSeasonEpisodes(
    tmdbId: number,
    seasonNumber: number
  ): Promise<TraktEpisodeDetails[]> {
    const cacheKey = `show:season:episodes:${tmdbId}:${seasonNumber}`;
    const cached = cache.get<TraktEpisodeDetails[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // First lookup the Trakt slug from TMDB ID
    const slug = await this.getTraktSlugFromTmdbId(tmdbId, "show");

    // Fetch episodes for season - returns array of episodes directly
    const endpoint = `/shows/${slug}/seasons/${seasonNumber}`;
    const params = { extended: "full,images" };

    const result = await this.fetch<TraktEpisodeDetails[]>(endpoint, params);

    // Cache for 7 days
    cache.set(cacheKey, result, 7 * 24 * 60 * 60 * 1000);
    return result;
  }

  // Legacy alias for backward compatibility
  async getSeason(
    tmdbId: number,
    seasonNumber: number
  ): Promise<{ episodes: TraktEpisodeDetails[] }> {
    const episodes = await this.getSeasonEpisodes(tmdbId, seasonNumber);
    return { episodes };
  }

  // === Get All Seasons (summary) ===

  async getSeasons(tmdbId: number): Promise<TraktSeasonDetails[]> {
    const cacheKey = `show:seasons:${tmdbId}`;
    const cached = cache.get<TraktSeasonDetails[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // First lookup the Trakt slug from TMDB ID
    const slug = await this.getTraktSlugFromTmdbId(tmdbId, "show");

    const endpoint = `/shows/${slug}/seasons`;
    // Include episodes in the response - required for initializeTvEpisodes
    const params = { extended: "full,episodes" };

    const result = await this.fetch<TraktSeasonDetails[]>(endpoint, params);

    // Cache for 7 days
    cache.set(cacheKey, result, 7 * 24 * 60 * 60 * 1000);
    return result;
  }

  // === Helper: Extract YouTube key from trailer URL ===

  extractTrailerKey(trailerUrl: string | null): string | null {
    if (!trailerUrl) return null;

    // Handle various YouTube URL formats
    // https://www.youtube.com/watch?v=VIDEO_ID
    // https://youtu.be/VIDEO_ID
    try {
      const url = new URL(trailerUrl);
      if (url.hostname.includes("youtube.com")) {
        return url.searchParams.get("v");
      } else if (url.hostname === "youtu.be") {
        return url.pathname.slice(1);
      }
    } catch {
      // Not a valid URL
    }
    return null;
  }

  // === Cache management ===

  clearCache(): void {
    cache.clear();
  }

  getCacheSize(): number {
    return cache.size();
  }
}

// Singleton instance
let traktService: TraktService | null = null;

export function getTraktService(): TraktService {
  if (!traktService) {
    traktService = new TraktService();
  }
  return traktService;
}

export { TraktService };
