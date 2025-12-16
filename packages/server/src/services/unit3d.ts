/**
 * UNIT3D Provider Service
 *
 * Handles search for UNIT3D-based private trackers (e.g., YUSCENE).
 * Uses API token authentication and JSON API.
 *
 * API Documentation: https://hdinnovations.github.io/UNIT3D/torrent_api.html
 */

import type { Release } from "./indexer.js";

// UNIT3D category IDs (these vary per tracker, but common ones)
export const UNIT3D_CATEGORIES = {
  // Movies
  MOVIE: 1,
  MOVIE_4K: 2,
  // TV
  TV: 3,
  TV_4K: 4,
  // These are common defaults, actual IDs depend on the specific tracker
} as const;

// Category groups for easy selection
export const UNIT3D_CATEGORY_GROUPS = {
  movies: [1, 2],
  tv: [3, 4],
  all: [1, 2, 3, 4],
};

// UNIT3D API response types
interface Unit3dTorrent {
  id: number;
  name: string;
  info_hash: string;
  size: number;
  seeders: number;
  leechers: number;
  times_completed: number;
  category_id: number;
  type_id: number;
  resolution_id: number;
  tmdb_id: number | null;
  imdb_id: number | null;
  tvdb_id: number | null;
  mal_id: number | null;
  igdb_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  created_at: string;
  updated_at: string;
  // Download URLs
  details_link: string;
  download_link?: string;
  // Additional metadata
  freeleech?: string;
  double_upload?: string;
  featured?: boolean;
  internal?: boolean;
  personal_release?: boolean;
  // Uploader
  uploader?: string;
}

interface Unit3dFilterResponse {
  data: Unit3dTorrent[];
  links?: {
    first: string;
    last: string;
    prev: string | null;
    next: string | null;
  };
  meta?: {
    current_page: number;
    from: number;
    last_page: number;
    per_page: number;
    to: number;
    total: number;
  };
}

interface Unit3dUserResponse {
  username: string;
  group: string;
  uploaded: number;
  downloaded: number;
  ratio: number;
  buffer: number;
  seeding: number;
  leeching: number;
  hit_and_runs: number;
}

export interface Unit3dConfig {
  baseUrl: string;
  apiToken: string;
}

export interface Unit3dSearchOptions {
  query?: string;
  categories?: number[];
  types?: number[];
  resolutions?: number[];
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  season?: number;
  episode?: number;
  page?: number;
  perPage?: number;
}

// Quality scoring weights (same as main indexer service)
const QUALITY_SCORES = {
  // Resolution
  "2160p": 100,
  "1080p": 80,
  "720p": 60,
  "480p": 40,
  SD: 20,

  // Source type
  REMUX: 50,
  BLURAY: 40,
  "WEB-DL": 35,
  WEBDL: 35,
  WEBRIP: 30,
  HDTV: 25,
  DVDRIP: 15,
  CAM: 5,

  // Codec
  AV1: 15,
  HEVC: 12,
  H265: 12,
  X265: 12,
  H264: 10,
  X264: 10,

  // Audio
  ATMOS: 8,
  TRUEHD: 7,
  "DTS-HD": 6,
  DTS: 4,
  AAC: 3,
};

class Unit3dProvider {
  private baseUrl: string;
  private apiToken: string;

  constructor(config: Unit3dConfig) {
    // Normalize the base URL
    let baseUrl = config.baseUrl.replace(/\/+$/, "");
    if (!baseUrl.startsWith("http")) {
      baseUrl = `https://${baseUrl}`;
    }
    // Ensure https
    baseUrl = baseUrl.replace(/^http:/, "https:");

    this.baseUrl = baseUrl;
    this.apiToken = config.apiToken;
  }

  /**
   * Make an authenticated request to the UNIT3D API
   */
  private async request<T>(path: string, params?: Record<string, string | number | boolean | number[] | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    // Add API token
    url.searchParams.set("api_token", this.apiToken);

    // Add additional params
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
          // Handle array values with bracket notation (categories[]=1&categories[]=2)
          if (Array.isArray(value)) {
            for (const item of value) {
              url.searchParams.append(`${key}[]`, String(item));
            }
          } else {
            url.searchParams.set(key, String(value));
          }
        }
      }
    }

    console.log(`[UNIT3D] Request: ${url.toString().replace(this.apiToken, "[REDACTED]")}`);

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "Annex/1.0",
      },
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    console.log(`[UNIT3D] Response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[UNIT3D] Error response: ${text.substring(0, 500)}`);

      if (response.status === 401 || response.status === 403) {
        throw new Error("Invalid API token - check your UNIT3D API token");
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content type
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      console.error(`[UNIT3D] Unexpected content type: ${contentType}`);
      console.error(`[UNIT3D] Response body: ${text.substring(0, 500)}`);
      throw new Error(`Expected JSON but got ${contentType}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Search UNIT3D for torrents using the filter API
   */
  async search(options: Unit3dSearchOptions): Promise<Release[]> {
    const params: Record<string, string | number | boolean | number[] | undefined> = {
      perPage: options.perPage || 100,
      sortField: "seeders",
      sortDirection: "desc",
    };

    // Add search query
    if (options.query) {
      params.name = options.query;
    }

    // Add database IDs for precise matching
    if (options.tmdbId) {
      params.tmdbId = options.tmdbId;
    }
    if (options.imdbId) {
      // UNIT3D expects numeric IMDB ID without tt prefix
      const imdbNum = options.imdbId.replace(/^tt/, "");
      const parsed = parseInt(imdbNum, 10);
      // Only add if it's a valid number
      if (!isNaN(parsed) && parsed > 0) {
        params.imdbId = parsed;
      }
    }
    if (options.tvdbId) {
      params.tvdbId = options.tvdbId;
    }

    // Add categories as array (UNIT3D uses bracket notation: categories[]=1&categories[]=2)
    if (options.categories && options.categories.length > 0) {
      params.categories = options.categories;
    }

    // Add types as array if specified
    if (options.types && options.types.length > 0) {
      params.types = options.types;
    }

    // Add resolutions as array if specified
    if (options.resolutions && options.resolutions.length > 0) {
      params.resolutions = options.resolutions;
    }

    // Add season/episode for TV searches
    if (options.season !== undefined) {
      params.seasonNumber = options.season;
    }
    if (options.episode !== undefined) {
      params.episodeNumber = options.episode;
    }

    // Add pagination
    if (options.page) {
      params.page = options.page;
    }

    // Only alive torrents (with seeders)
    params.alive = true;

    console.log(`[UNIT3D] Searching with params:`, params);

    const response = await this.request<Unit3dFilterResponse>("/api/torrents/filter", params);

    if (!response.data || !Array.isArray(response.data)) {
      return [];
    }

    return response.data.map((torrent) => this.mapToRelease(torrent));
  }

  /**
   * Test connection to UNIT3D
   */
  async testConnection(): Promise<{
    success: boolean;
    message: string;
    username?: string;
  }> {
    try {
      console.log("[UNIT3D] Testing connection...");

      // Try to get user info
      const user = await this.request<Unit3dUserResponse>("/api/user");

      if (user && user.username) {
        return {
          success: true,
          message: `Connected as ${user.username} (${user.group})`,
          username: user.username,
        };
      }

      // Fallback: try to list torrents
      const response = await this.request<Unit3dFilterResponse>("/api/torrents/filter", {
        perPage: 1,
      });

      if (response.data !== undefined) {
        return {
          success: true,
          message: `Connected successfully (${response.meta?.total || "unknown"} torrents available)`,
        };
      }

      return {
        success: false,
        message: "Unexpected response from UNIT3D",
      };
    } catch (error) {
      console.error("[UNIT3D] Test connection error:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get categories available on the tracker
   * Note: UNIT3D doesn't have a standard categories API, so this returns common defaults
   */
  getCategories(): typeof UNIT3D_CATEGORIES {
    return UNIT3D_CATEGORIES;
  }

  /**
   * Get download URL for a torrent
   */
  getDownloadUrl(torrentId: number): string {
    return `${this.baseUrl}/api/torrents/${torrentId}/download?api_token=${this.apiToken}`;
  }

  /**
   * Map UNIT3D torrent to Release interface
   */
  private mapToRelease(torrent: Unit3dTorrent): Release {
    const title = torrent.name;
    const resolution = this.extractResolution(title);
    const source = this.extractSource(title);
    const codec = this.extractCodec(title);
    const score = this.calculateScore(title, resolution, source, codec, torrent.seeders);

    // Build download URL - UNIT3D provides download_link or we construct it
    const downloadUrl = torrent.download_link || this.getDownloadUrl(torrent.id);

    return {
      id: `unit3d-${torrent.id}`,
      title,
      indexerId: "unit3d",
      indexerName: "UNIT3D",
      resolution,
      source,
      codec,
      size: torrent.size,
      seeders: torrent.seeders,
      leechers: torrent.leechers,
      downloadUrl,
      infoUrl: torrent.details_link || `${this.baseUrl}/torrents/${torrent.id}`,
      publishDate: new Date(torrent.created_at),
      score,
      categories: [torrent.category_id],
    };
  }

  /**
   * Extract resolution from title
   */
  private extractResolution(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("2160P") || upper.includes("4K") || upper.includes("UHD")) return "2160p";
    if (upper.includes("1080P") || upper.includes("1080I")) return "1080p";
    if (upper.includes("720P")) return "720p";
    if (upper.includes("480P") || upper.includes("576P")) return "480p";
    return "SD";
  }

  /**
   * Extract source type from title
   */
  private extractSource(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("REMUX")) return "REMUX";
    if (upper.includes("BLURAY") || upper.includes("BLU-RAY") || upper.includes("BDRIP")) return "BLURAY";
    if (upper.includes("WEB-DL") || upper.includes("WEBDL")) return "WEB-DL";
    if (upper.includes("WEBRIP") || upper.includes("WEB-RIP")) return "WEBRIP";
    if (upper.includes("HDTV")) return "HDTV";
    if (upper.includes("DVDRIP") || upper.includes("DVD-RIP")) return "DVDRIP";
    if (upper.includes("CAM") || upper.includes("HDCAM")) return "CAM";
    return "UNKNOWN";
  }

  /**
   * Extract codec from title
   */
  private extractCodec(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("AV1")) return "AV1";
    if (upper.includes("HEVC") || upper.includes("H.265") || upper.includes("H265") || upper.includes("X265")) return "HEVC";
    if (upper.includes("H.264") || upper.includes("H264") || upper.includes("X264") || upper.includes("AVC")) return "H264";
    return "UNKNOWN";
  }

  /**
   * Calculate quality score for a release
   */
  private calculateScore(
    title: string,
    resolution: string,
    source: string,
    codec: string,
    seeders: number
  ): number {
    let score = 0;

    // Resolution score
    score += QUALITY_SCORES[resolution as keyof typeof QUALITY_SCORES] || 0;

    // Source score
    score += QUALITY_SCORES[source as keyof typeof QUALITY_SCORES] || 0;

    // Codec score
    score += QUALITY_SCORES[codec as keyof typeof QUALITY_SCORES] || 0;

    // Audio bonus
    const upper = title.toUpperCase();
    if (upper.includes("ATMOS")) score += QUALITY_SCORES.ATMOS;
    if (upper.includes("TRUEHD")) score += QUALITY_SCORES.TRUEHD;
    if (upper.includes("DTS-HD") || upper.includes("DTSHD")) score += QUALITY_SCORES["DTS-HD"];
    if (upper.includes("DTS") && !upper.includes("DTS-HD")) score += QUALITY_SCORES.DTS;

    // Seeder bonus (logarithmic, capped at 20 points)
    if (seeders > 0) {
      score += Math.min(20, Math.floor(Math.log10(seeders) * 5));
    }

    // Penalty for samples, hardcoded subs, etc.
    if (upper.includes("SAMPLE")) score -= 100;
    if (upper.includes("HARDCODED") || upper.includes("HC ")) score -= 30;
    if (upper.includes("KOREAN") && !upper.includes("KOREAN.ENG")) score -= 20;

    return score;
  }
}

// Provider instance cache
const providerCache = new Map<string, Unit3dProvider>();

/**
 * Get or create a UNIT3D provider instance
 */
export function getUnit3dProvider(config: Unit3dConfig): Unit3dProvider {
  const key = `${config.baseUrl}`;

  let provider = providerCache.get(key);
  if (!provider) {
    provider = new Unit3dProvider(config);
    providerCache.set(key, provider);
  }

  return provider;
}

/**
 * Clear a cached provider
 */
export function clearUnit3dProvider(baseUrl: string): void {
  providerCache.delete(baseUrl);
}

export { Unit3dProvider };
