/**
 * Indexer Service
 *
 * Handles search across configured indexers (Torznab, Newznab, TorrentLeech).
 * Aggregates, deduplicates, and scores results by quality.
 */

import { prisma } from "../db/client.js";
import { XMLParser } from "fast-xml-parser";
import { IndexerType } from "@prisma/client";
import {
  getTorrentLeechProvider,
  TORRENTLEECH_CATEGORY_GROUPS,
  type TorrentLeechSearchOptions,
} from "./torrentleech.js";
import { getCryptoService } from "./crypto.js";

// Decrypt API key, falling back to the raw value for legacy unencrypted data
function decryptApiKey(encrypted: string): string {
  try {
    const crypto = getCryptoService();
    return crypto.decrypt(encrypted);
  } catch {
    // Return as-is if decryption fails (might be unencrypted legacy data)
    return encrypted;
  }
}

// Quality scoring weights
const QUALITY_SCORES = {
  // Resolution (higher = better)
  "2160p": 100,
  "1080p": 80,
  "720p": 60,
  "480p": 40,
  SD: 20,

  // Source type (higher = better)
  REMUX: 50,
  BLURAY: 40,
  "WEB-DL": 35,
  WEBDL: 35,
  WEBRIP: 30,
  HDTV: 25,
  DVDRIP: 15,
  CAM: 5,

  // Codec preference
  AV1: 15,
  HEVC: 12,
  H265: 12,
  "X265": 12,
  H264: 10,
  "X264": 10,

  // Audio
  ATMOS: 8,
  "TRUEHD": 7,
  "DTS-HD": 6,
  DTS: 4,
  AAC: 3,
};

export interface Release {
  id: string;
  title: string;
  indexerId: string;
  indexerName: string;
  resolution: string;
  source: string;
  codec: string;
  size: number; // bytes
  seeders: number;
  leechers: number;
  magnetUri?: string;
  downloadUrl?: string;
  infoUrl?: string;
  publishDate: Date;
  score: number;
  categories: number[];
}

export interface SearchOptions {
  type: "movie" | "tv";
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  query?: string;
  year?: number;
  season?: number;
  episode?: number;
}

export interface SearchResult {
  releases: Release[];
  indexersQueried: number;
  indexersFailed: number;
  errors: Array<{ indexer: string; error: string }>;
}

interface TorznabItem {
  title: string;
  guid: string;
  link?: string;
  comments?: string;
  pubDate?: string;
  size?: string;
  enclosure?: {
    "@_url": string;
    "@_length": string;
    "@_type": string;
  };
  "torznab:attr"?: Array<{
    "@_name": string;
    "@_value": string;
  }> | {
    "@_name": string;
    "@_value": string;
  };
}

class IndexerService {
  private xmlParser: XMLParser;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });
  }

  /**
   * Search all enabled indexers for releases
   */
  async search(options: SearchOptions): Promise<SearchResult> {
    const indexers = await prisma.indexer.findMany({
      where: { enabled: true },
      orderBy: { priority: "desc" },
    });

    if (indexers.length === 0) {
      return {
        releases: [],
        indexersQueried: 0,
        indexersFailed: 0,
        errors: [],
      };
    }

    // Decrypt API keys before searching
    const indexersWithDecryptedKeys = indexers.map((indexer) => ({
      ...indexer,
      apiKey: decryptApiKey(indexer.apiKey),
    }));

    const results = await Promise.allSettled(
      indexersWithDecryptedKeys.map((indexer) => this.searchIndexer(indexer, options))
    );

    const allReleases: Release[] = [];
    const errors: Array<{ indexer: string; error: string }> = [];
    let indexersFailed = 0;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const indexer = indexers[i];

      if (result.status === "fulfilled") {
        allReleases.push(...result.value);
      } else {
        indexersFailed++;
        errors.push({
          indexer: indexer.name,
          error: result.reason?.message || "Unknown error",
        });
        console.error(`[Indexer] ${indexer.name} failed:`, result.reason);
      }
    }

    // Deduplicate by title similarity and score
    const dedupedReleases = this.deduplicateReleases(allReleases);

    // Sort by score (descending)
    dedupedReleases.sort((a, b) => b.score - a.score);

    return {
      releases: dedupedReleases,
      indexersQueried: indexers.length,
      indexersFailed,
      errors,
    };
  }

  /**
   * Search a single indexer (dispatches to appropriate provider)
   */
  private async searchIndexer(
    indexer: {
      id: string;
      name: string;
      type: IndexerType;
      url: string;
      apiKey: string;
      categoriesMovies: number[];
      categoriesTv: number[];
    },
    options: SearchOptions
  ): Promise<Release[]> {
    console.log(`[Indexer] Searching ${indexer.name} (${indexer.type})...`);

    // Dispatch to appropriate provider
    switch (indexer.type) {
      case IndexerType.TORRENTLEECH:
        return this.searchTorrentLeech(indexer, options);

      case IndexerType.TORZNAB:
      case IndexerType.NEWZNAB:
      default:
        return this.searchTorznab(indexer, options);
    }
  }

  /**
   * Search a Torznab/Newznab indexer
   */
  private async searchTorznab(
    indexer: {
      id: string;
      name: string;
      url: string;
      apiKey: string;
      categoriesMovies: number[];
      categoriesTv: number[];
    },
    options: SearchOptions
  ): Promise<Release[]> {
    const url = this.buildSearchUrl(indexer, options);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const xml = await response.text();
    return this.parseResults(xml, indexer.id, indexer.name);
  }

  /**
   * Search TorrentLeech indexer
   */
  private async searchTorrentLeech(
    indexer: {
      id: string;
      name: string;
      url: string;
      apiKey: string;
      categoriesMovies: number[];
      categoriesTv: number[];
    },
    options: SearchOptions
  ): Promise<Release[]> {
    // Parse TorrentLeech credentials from apiKey
    // Format: username:password or username:password:alt2FAToken or username:password:alt2FAToken:rssKey
    const parts = indexer.apiKey.split(":");
    const [username, password] = parts;
    // Third part could be 2FA token (32 char MD5) or RSS key (longer)
    // 2FA token is an MD5 hash (32 hex chars), RSS key is typically longer
    let alt2FAToken: string | undefined;
    let rssKey: string | undefined;

    if (parts[2]) {
      if (parts[2].length === 32 && /^[a-f0-9]+$/i.test(parts[2])) {
        // Looks like an MD5 hash - it's the 2FA token
        alt2FAToken = parts[2];
        rssKey = parts[3]; // RSS key is 4th if present
      } else {
        // Not an MD5 hash - treat as RSS key (legacy format)
        rssKey = parts[2];
      }
    }

    if (!username || !password) {
      throw new Error("TorrentLeech requires credentials in format 'username:password' or 'username:password:alt2FAToken' or 'username:password:alt2FAToken:rssKey'");
    }

    const provider = getTorrentLeechProvider({
      baseUrl: indexer.url,
      username,
      password,
      alt2FAToken,
      rssKey,
    });

    // Build search options
    // Note: TorrentLeech doesn't support IMDB ID search for individual episodes,
    // so we only use IMDB ID for movies. For TV, we use title + season/episode format.
    const searchOptions: TorrentLeechSearchOptions = {
      query: options.query || "",
      imdbId: options.type === "movie" ? options.imdbId : undefined,
    };

    // Determine categories
    if (options.type === "movie") {
      searchOptions.categories =
        indexer.categoriesMovies.length > 0
          ? indexer.categoriesMovies
          : TORRENTLEECH_CATEGORY_GROUPS.movies;
    } else {
      searchOptions.categories =
        indexer.categoriesTv.length > 0
          ? indexer.categoriesTv
          : TORRENTLEECH_CATEGORY_GROUPS.tv;
    }

    // Add season/episode to query for TV searches
    if (options.type === "tv" && options.query) {
      if (options.season !== undefined && options.episode !== undefined) {
        searchOptions.query = `${options.query} S${options.season.toString().padStart(2, "0")}E${options.episode.toString().padStart(2, "0")}`;
      } else if (options.season !== undefined) {
        searchOptions.query = `${options.query} S${options.season.toString().padStart(2, "0")}`;
      }
    }

    const releases = await provider.search(searchOptions);

    // Update indexer ID/name on releases
    return releases.map((r) => ({
      ...r,
      id: `${indexer.id}-${r.id}`,
      indexerId: indexer.id,
      indexerName: indexer.name,
    }));
  }

  /**
   * Build Torznab search URL
   */
  private buildSearchUrl(
    indexer: { url: string; apiKey: string; categoriesMovies: number[]; categoriesTv: number[] },
    options: SearchOptions
  ): string {
    const baseUrl = indexer.url.replace(/\/+$/, "");
    const url = new URL(`${baseUrl}/api`);

    url.searchParams.set("apikey", indexer.apiKey);

    // Determine search type and categories
    if (options.type === "movie") {
      url.searchParams.set("t", "movie");
      if (indexer.categoriesMovies.length > 0) {
        url.searchParams.set("cat", indexer.categoriesMovies.join(","));
      }
      if (options.tmdbId) {
        url.searchParams.set("tmdbid", options.tmdbId.toString());
      }
      if (options.imdbId) {
        url.searchParams.set("imdbid", options.imdbId);
      }
    } else {
      url.searchParams.set("t", "tvsearch");
      if (indexer.categoriesTv.length > 0) {
        url.searchParams.set("cat", indexer.categoriesTv.join(","));
      }
      if (options.tvdbId) {
        url.searchParams.set("tvdbid", options.tvdbId.toString());
      }
      if (options.tmdbId) {
        url.searchParams.set("tmdbid", options.tmdbId.toString());
      }
      if (options.season !== undefined) {
        url.searchParams.set("season", options.season.toString());
      }
      if (options.episode !== undefined) {
        url.searchParams.set("ep", options.episode.toString());
      }
    }

    // Fallback to query search
    if (options.query) {
      url.searchParams.set("q", options.query);
    }

    return url.toString();
  }

  /**
   * Parse Torznab XML response
   */
  private parseResults(xml: string, indexerId: string, indexerName: string): Release[] {
    const parsed = this.xmlParser.parse(xml);

    // Handle error responses
    if (parsed.error) {
      throw new Error(parsed.error["@_description"] || "Unknown Torznab error");
    }

    const channel = parsed.rss?.channel;
    if (!channel) {
      return [];
    }

    const items = channel.item;
    if (!items) {
      return [];
    }

    // Normalize to array
    const itemArray: TorznabItem[] = Array.isArray(items) ? items : [items];

    return itemArray
      .map((item) => this.parseItem(item, indexerId, indexerName))
      .filter((r): r is Release => r !== null);
  }

  /**
   * Parse a single Torznab item
   */
  private parseItem(item: TorznabItem, indexerId: string, indexerName: string): Release | null {
    const title = item.title;
    if (!title) return null;

    // Extract torznab attributes
    const attrs = this.extractAttributes(item["torznab:attr"]);

    // Get download URL from enclosure or link
    const downloadUrl = item.enclosure?.["@_url"] || item.link;
    const magnetUri = attrs.magneturl;

    // Need at least one download method
    if (!downloadUrl && !magnetUri) {
      return null;
    }

    // Parse size
    const size = parseInt(attrs.size || item.enclosure?.["@_length"] || item.size || "0", 10);

    // Parse seeders/leechers
    const seeders = parseInt(attrs.seeders || attrs.peers || "0", 10);
    const leechers = parseInt(attrs.leechers || "0", 10);

    // Parse categories
    const categories: number[] = [];
    if (attrs.category) {
      categories.push(parseInt(attrs.category, 10));
    }

    // Extract quality info from title
    const resolution = this.extractResolution(title);
    const source = this.extractSource(title);
    const codec = this.extractCodec(title);

    // Calculate quality score
    const score = this.calculateScore(title, resolution, source, codec, seeders);

    return {
      id: `${indexerId}-${item.guid || title}`,
      title,
      indexerId,
      indexerName,
      resolution,
      source,
      codec,
      size,
      seeders,
      leechers,
      magnetUri,
      downloadUrl,
      infoUrl: item.comments,
      publishDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      score,
      categories,
    };
  }

  /**
   * Extract torznab attributes
   */
  private extractAttributes(attrs: TorznabItem["torznab:attr"]): Record<string, string> {
    const result: Record<string, string> = {};
    if (!attrs) return result;

    const attrArray = Array.isArray(attrs) ? attrs : [attrs];
    for (const attr of attrArray) {
      if (attr["@_name"] && attr["@_value"]) {
        result[attr["@_name"]] = attr["@_value"];
      }
    }

    return result;
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

  /**
   * Deduplicate releases by normalized title
   */
  private deduplicateReleases(releases: Release[]): Release[] {
    const seen = new Map<string, Release>();

    for (const release of releases) {
      // Normalize title for comparison
      const normalized = this.normalizeTitle(release.title);

      const existing = seen.get(normalized);
      if (!existing || release.score > existing.score) {
        seen.set(normalized, release);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Normalize title for deduplication
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();
  }

  /**
   * Get the best release for a movie request
   */
  async searchMovie(options: {
    tmdbId: number;
    imdbId?: string;
    title: string;
    year: number;
  }): Promise<SearchResult> {
    return this.search({
      type: "movie",
      tmdbId: options.tmdbId,
      imdbId: options.imdbId,
      query: `${options.title} ${options.year}`,
      year: options.year,
    });
  }

  /**
   * Get the best release for a TV episode
   */
  async searchTvEpisode(options: {
    tmdbId: number;
    tvdbId?: number;
    imdbId?: string;
    title: string;
    year?: number;
    season: number;
    episode: number;
  }): Promise<SearchResult> {
    return this.search({
      type: "tv",
      tmdbId: options.tmdbId,
      tvdbId: options.tvdbId,
      imdbId: options.imdbId,
      query: options.title,
      year: options.year,
      season: options.season,
      episode: options.episode,
    });
  }

  /**
   * Get the best release for a full TV season
   */
  async searchTvSeason(options: {
    tmdbId: number;
    tvdbId?: number;
    imdbId?: string;
    title: string;
    year?: number;
    season: number;
  }): Promise<SearchResult> {
    return this.search({
      type: "tv",
      tmdbId: options.tmdbId,
      tvdbId: options.tvdbId,
      imdbId: options.imdbId,
      query: `${options.title} S${options.season.toString().padStart(2, "0")}`,
      year: options.year,
      season: options.season,
    });
  }

  /**
   * Select the best release from search results
   * Considers quality, seeders, and size constraints
   */
  selectBestRelease(
    releases: Release[],
    constraints?: {
      maxSize?: number; // bytes
      minSeeders?: number;
      preferredResolution?: string;
    }
  ): Release | null {
    let candidates = [...releases];

    // Apply constraints
    if (constraints?.maxSize) {
      candidates = candidates.filter((r) => r.size <= constraints.maxSize!);
    }
    if (constraints?.minSeeders) {
      candidates = candidates.filter((r) => r.seeders >= constraints.minSeeders!);
    }

    // Sort by score (already sorted, but re-sort after filtering)
    candidates.sort((a, b) => b.score - a.score);

    // Prefer specific resolution if requested
    if (constraints?.preferredResolution) {
      const preferred = candidates.find((r) => r.resolution === constraints.preferredResolution);
      if (preferred) return preferred;
    }

    return candidates[0] || null;
  }
}

// Singleton instance
let indexerService: IndexerService | null = null;

export function getIndexerService(): IndexerService {
  if (!indexerService) {
    indexerService = new IndexerService();
  }
  return indexerService;
}

export { IndexerService };
