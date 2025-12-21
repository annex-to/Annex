/**
 * Cardigann Provider Service
 *
 * Adapts Cardigann indexers to work with the unified indexer search interface.
 * Transforms Cardigann search results into the standard Release format.
 */

import type { CardigannIndexer } from "@prisma/client";
import { cardigannExecutor, cardigannRepository } from "./cardigann/index.js";
import type {
  CardigannContext,
  CardigannSearchParams,
  CardigannSearchResult,
} from "./cardigann/types.js";
import type { Release, SearchOptions } from "./indexer.js";

export interface CardigannProviderConfig {
  indexerId: string;
  indexerName: string;
  cardigannIndexer: CardigannIndexer;
}

class CardigannProvider {
  /**
   * Search a Cardigann indexer
   */
  async search(config: CardigannProviderConfig, options: SearchOptions): Promise<Release[]> {
    const { cardigannIndexer, indexerId, indexerName } = config;

    // Load the definition
    const parsedDefinition = await cardigannRepository.getDefinition(cardigannIndexer.definitionId);

    if (!parsedDefinition) {
      throw new Error(`Cardigann definition not found: ${cardigannIndexer.definitionId}`);
    }

    const definition = parsedDefinition.definition;

    // Determine base URL from definition links
    const baseUrl = definition.links?.[0];
    if (!baseUrl) {
      throw new Error(`No base URL found in definition: ${cardigannIndexer.definitionId}`);
    }

    // Build settings object from stored settings
    const settings: { [key: string]: string | boolean } = {};
    const storedSettings = cardigannIndexer.settings as Record<string, unknown>;

    for (const [key, value] of Object.entries(storedSettings)) {
      if (typeof value === "string" || typeof value === "boolean") {
        settings[key] = value;
      }
    }

    // Build Cardigann context
    const context: CardigannContext = {
      definition,
      settings,
      cookies: {},
      baseUrl,
    };

    // Map search options to Cardigann params
    const searchParams: CardigannSearchParams = {
      query: options.query,
      imdbId: options.imdbId,
      tmdbId: options.tmdbId?.toString(),
      tvdbId: options.tvdbId?.toString(),
      season: options.season,
      episode: options.episode,
    };

    // Determine categories to search
    if (options.type === "movie" && cardigannIndexer.categoriesMovies.length > 0) {
      searchParams.categories = cardigannIndexer.categoriesMovies.map(String);
    } else if (options.type === "tv" && cardigannIndexer.categoriesTv.length > 0) {
      searchParams.categories = cardigannIndexer.categoriesTv.map(String);
    }

    console.log(`[Cardigann Search] ${indexerName} - Searching with params:`, {
      query: searchParams.query,
      categories: searchParams.categories,
      imdbId: searchParams.imdbId,
      season: searchParams.season,
    });

    // Execute the search
    const results = await cardigannExecutor.search(context, searchParams);

    console.log(`[Cardigann Search] ${indexerName} - Found ${results.length} results`);
    if (results.length > 0) {
      console.log(`[Cardigann Search] ${indexerName} - First 3 results:`);
      results.slice(0, 3).forEach((r, idx) => {
        console.log(
          `[Cardigann Search]   ${idx + 1}. ${r.title} | ${r.size || "?"} | ${r.seeders || 0} seeders`
        );
      });
    }

    // Build Cookie header from login cookies for authenticated downloads
    const cookieHeader =
      Object.keys(context.cookies).length > 0
        ? Object.entries(context.cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; ")
        : undefined;

    // Transform results to Release format
    return results.map((result) =>
      this.transformToRelease(result, indexerId, indexerName, cookieHeader)
    );
  }

  /**
   * Transform CardigannSearchResult to Release
   */
  private transformToRelease(
    result: CardigannSearchResult,
    indexerId: string,
    indexerName: string,
    cookieHeader?: string
  ): Release {
    const title = result.title;

    // Extract quality info from title
    const resolution = this.extractResolution(title);
    const source = this.extractSource(title);
    const codec = this.extractCodec(title);

    // Calculate quality score
    const score = this.calculateScore(title, resolution, source, codec, result.seeders || 0);

    // Determine download URL or magnet
    let magnetUri: string | undefined;
    let downloadUrl: string | undefined;
    let downloadHeaders: Record<string, string> | undefined;

    if (result.downloadUrl.startsWith("magnet:")) {
      magnetUri = result.downloadUrl;
    } else {
      downloadUrl = result.downloadUrl;
      // Include authentication cookies for download
      if (cookieHeader) {
        downloadHeaders = { Cookie: cookieHeader };
      }
    }

    return {
      id: `${indexerId}-${result.infohash || result.title}`,
      title: result.title,
      indexerId,
      indexerName,
      resolution,
      source,
      codec,
      size: result.size || 0,
      seeders: result.seeders || 0,
      leechers: result.leechers || 0,
      magnetUri,
      downloadUrl,
      downloadHeaders,
      infoUrl: result.infoUrl,
      publishDate: result.publishDate || new Date(),
      score,
      categories: result.category?.map((c) => parseInt(c, 10)) || [],
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
    if (upper.includes("BLURAY") || upper.includes("BLU-RAY") || upper.includes("BDRIP"))
      return "BLURAY";
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
    if (
      upper.includes("HEVC") ||
      upper.includes("H.265") ||
      upper.includes("H265") ||
      upper.includes("X265")
    )
      return "HEVC";
    if (
      upper.includes("H.264") ||
      upper.includes("H264") ||
      upper.includes("X264") ||
      upper.includes("AVC")
    )
      return "H264";
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
    const QUALITY_SCORES: Record<string, number> = {
      "2160p": 100,
      "1080p": 80,
      "720p": 60,
      "480p": 40,
      SD: 20,
      REMUX: 50,
      BLURAY: 40,
      "WEB-DL": 35,
      WEBDL: 35,
      WEBRIP: 30,
      HDTV: 25,
      DVDRIP: 15,
      CAM: 5,
      AV1: 15,
      HEVC: 12,
      H265: 12,
      X265: 12,
      H264: 10,
      X264: 10,
      ATMOS: 8,
      TRUEHD: 7,
      "DTS-HD": 6,
      DTS: 4,
      AAC: 3,
    };

    let score = 0;

    score += QUALITY_SCORES[resolution] || 0;
    score += QUALITY_SCORES[source] || 0;
    score += QUALITY_SCORES[codec] || 0;

    const upper = title.toUpperCase();
    if (upper.includes("ATMOS")) score += QUALITY_SCORES.ATMOS;
    if (upper.includes("TRUEHD")) score += QUALITY_SCORES.TRUEHD;
    if (upper.includes("DTS-HD") || upper.includes("DTSHD")) score += QUALITY_SCORES["DTS-HD"];
    if (upper.includes("DTS") && !upper.includes("DTS-HD")) score += QUALITY_SCORES.DTS;

    if (seeders > 0) {
      score += Math.min(20, Math.floor(Math.log10(seeders) * 5));
    }

    if (upper.includes("SAMPLE")) score -= 100;
    if (upper.includes("HARDCODED") || upper.includes("HC ")) score -= 30;
    if (upper.includes("KOREAN") && !upper.includes("KOREAN.ENG")) score -= 20;

    return score;
  }
}

let cardigannProvider: CardigannProvider | null = null;

export function getCardigannProvider(): CardigannProvider {
  if (!cardigannProvider) {
    cardigannProvider = new CardigannProvider();
  }
  return cardigannProvider;
}

export { CardigannProvider };
