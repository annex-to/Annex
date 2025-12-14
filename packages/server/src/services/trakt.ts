/**
 * Trakt API Service
 *
 * Provides access to Trakt.tv API for trending movies and shows.
 * API docs: https://trakt.docs.apiary.io/
 */

import { getConfig } from "../config/index.js";

const TRAKT_API_BASE = "https://api.trakt.tv";
const TRAKT_API_VERSION = "2";

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 250; // 4 requests per second max

interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

interface TraktMovie {
  title: string;
  year: number;
  ids: TraktIds;
}

interface TraktShow {
  title: string;
  year: number;
  ids: TraktIds;
}

interface TraktTrendingMovie {
  watchers: number;
  movie: TraktMovie;
}

interface TraktTrendingShow {
  watchers: number;
  show: TraktShow;
}

export interface TraktTrendingItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  year: number;
  watchers: number;
}

class TraktService {
  private clientId: string | undefined;

  constructor() {
    const config = getConfig();
    this.clientId = config.trakt?.clientId;
  }

  /**
   * Check if the service is configured
   */
  isConfigured(): boolean {
    return Boolean(this.clientId);
  }

  /**
   * Rate-limited fetch
   */
  private async fetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    if (!this.clientId) {
      throw new Error("Trakt API not configured. Set ANNEX_TRAKT_CLIENT_ID in your environment.");
    }

    // Rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }
    lastRequestTime = Date.now();

    const url = new URL(`${TRAKT_API_BASE}${endpoint}`);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }

    const response = await fetch(url.toString(), {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": TRAKT_API_VERSION,
        "trakt-api-key": this.clientId,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Trakt API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get trending movies from Trakt
   */
  async getTrendingMovies(page = 1, limit = 20): Promise<TraktTrendingItem[]> {
    const results = await this.fetch<TraktTrendingMovie[]>("/movies/trending", {
      page: String(page),
      limit: String(limit),
    });

    return results
      .filter((item) => item.movie.ids.tmdb != null)
      .map((item) => ({
        tmdbId: item.movie.ids.tmdb!,
        type: "movie" as const,
        title: item.movie.title,
        year: item.movie.year,
        watchers: item.watchers,
      }));
  }

  /**
   * Get trending shows from Trakt
   */
  async getTrendingShows(page = 1, limit = 20): Promise<TraktTrendingItem[]> {
    const results = await this.fetch<TraktTrendingShow[]>("/shows/trending", {
      page: String(page),
      limit: String(limit),
    });

    return results
      .filter((item) => item.show.ids.tmdb != null)
      .map((item) => ({
        tmdbId: item.show.ids.tmdb!,
        type: "tv" as const,
        title: item.show.title,
        year: item.show.year,
        watchers: item.watchers,
      }));
  }

  /**
   * Get trending content (movies or shows) from Trakt
   */
  async getTrending(type: "movie" | "tv", page = 1, limit = 20): Promise<TraktTrendingItem[]> {
    if (type === "movie") {
      return this.getTrendingMovies(page, limit);
    }
    return this.getTrendingShows(page, limit);
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
