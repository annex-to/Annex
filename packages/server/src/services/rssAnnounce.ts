/**
 * RSS Announce Monitor Service
 *
 * Polls TorrentLeech RSS feed for new releases.
 * When a release matches a monitored request, it automatically triggers the download.
 */

import { prisma } from "../db/client.js";
import { getConfig } from "../config/index.js";
import { RequestStatus, MediaType, TvEpisodeStatus, Prisma } from "@prisma/client";
import { getJobQueueService } from "./jobQueue.js";
import { getSchedulerService } from "./scheduler.js";
import { XMLParser } from "fast-xml-parser";
import type { Release } from "./indexer.js";
import { resolutionMeetsRequirement } from "./qualityService.js";
import type { Resolution } from "../types/download.js";

// =============================================================================
// Types
// =============================================================================

interface RssItem {
  title: string;
  link: string;
  guid: string;
  pubDate: string;
  description?: string;
  category?: string;
}

interface RssFeed {
  rss?: {
    channel?: {
      item?: RssItem | RssItem[];
    };
  };
}

// Quality scoring weights (same as indexer service)
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

// =============================================================================
// RSS Announce Monitor
// =============================================================================

class RssAnnounceMonitor {
  private rssKey: string | null = null;
  private lastSeenGuids: Set<string> = new Set();
  private isPolling = false;
  private isStarted = false;
  private xmlParser: XMLParser;

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });
  }

  /**
   * Start the RSS monitor
   */
  async start(): Promise<void> {
    const config = getConfig();

    if (!config.rss.enabled) {
      console.log("[RSS] Announce monitor is disabled");
      return;
    }

    // Get RSS key from TorrentLeech indexer config
    const tlIndexer = await prisma.indexer.findFirst({
      where: { type: "TORRENTLEECH", enabled: true },
    });

    if (tlIndexer) {
      // Parse RSS key from apiKey field
      // Format: username:password:alt2FAToken:rssKey
      const parts = tlIndexer.apiKey.split(":");
      if (parts.length >= 4 && parts[3]) {
        this.rssKey = parts[3];
        console.log(`[RSS] Found RSS key from TorrentLeech indexer config`);
      } else if (parts.length === 3 && parts[2] && parts[2].length > 32) {
        // Legacy format: username:password:rssKey (no 2FA token)
        this.rssKey = parts[2];
        console.log(`[RSS] Found RSS key from TorrentLeech indexer config (legacy format)`);
      }
    }

    if (!this.rssKey) {
      console.warn("[RSS] No RSS key found - cannot monitor TorrentLeech feed");
      console.warn("[RSS] Add RSS key to TorrentLeech indexer config: username:password:alt2FAToken:rssKey");
      return;
    }

    // Register polling task with scheduler
    const scheduler = getSchedulerService();
    scheduler.register(
      "rss-poll",
      "RSS Feed Poll",
      config.rss.pollInterval,
      async () => {
        await this.poll().catch((err) => {
          console.error("[RSS] Poll error:", err.message);
        });
      }
    );

    this.isStarted = true;
    console.log(`[RSS] Started monitor (polling every ${config.rss.pollInterval / 1000}s)`);
  }

  /**
   * Stop the RSS monitor
   */
  stop(): void {
    if (this.isStarted) {
      const scheduler = getSchedulerService();
      scheduler.unregister("rss-poll");
      this.isStarted = false;
    }
    console.log("[RSS] Monitor stopped");
  }

  /**
   * Poll the RSS feed for new releases
   */
  private async poll(): Promise<void> {
    if (this.isPolling) {
      console.log("[RSS] Already polling, skipping");
      return;
    }

    this.isPolling = true;

    try {
      const feedUrl = `https://rss24h.torrentleech.org/${this.rssKey}`;
      console.log("[RSS] Fetching feed...");

      const response = await fetch(feedUrl, {
        signal: AbortSignal.timeout(30000),
        headers: {
          "User-Agent": "Annex/1.0",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const xml = await response.text();
      const feed = this.xmlParser.parse(xml) as RssFeed;

      const items = feed.rss?.channel?.item;
      if (!items) {
        console.log("[RSS] No items in feed");
        return;
      }

      const itemArray = Array.isArray(items) ? items : [items];
      console.log(`[RSS] Found ${itemArray.length} items in feed`);

      // Process new items (ones we haven't seen before)
      let newCount = 0;
      for (const item of itemArray) {
        const guid = item.guid || item.link;

        if (this.lastSeenGuids.has(guid)) {
          continue;
        }

        newCount++;
        this.lastSeenGuids.add(guid);

        // Log the new item
        console.log(`[RSS] New: ${item.title}`);

        // Try to match against monitored requests
        await this.processItem(item);
      }

      if (newCount > 0) {
        console.log(`[RSS] Processed ${newCount} new items`);
      }

      // Keep the set from growing indefinitely (keep last 1000)
      if (this.lastSeenGuids.size > 1000) {
        const guidsArray = Array.from(this.lastSeenGuids);
        this.lastSeenGuids = new Set(guidsArray.slice(-500));
      }
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Process an RSS item and try to match it
   */
  private async processItem(item: RssItem): Promise<void> {
    const title = item.title;
    const category = item.category?.toLowerCase() || "";

    // Determine if this is a movie or TV release
    const isMovie = category.includes("movie") || this.looksLikeMovie(title);
    const isTv = category.includes("tv") || category.includes("episode") || this.looksLikeTv(title);

    if (isMovie) {
      await this.matchMovieRelease(item);
    }
    if (isTv) {
      await this.matchTvRelease(item);
    }
  }

  /**
   * Check if a release title looks like a movie
   */
  private looksLikeMovie(title: string): boolean {
    // Movies typically have year in title but no season/episode
    const hasYear = /\b(19|20)\d{2}\b/.test(title);
    const hasSeasonEpisode = /S\d{1,2}E\d{1,2}/i.test(title) || /S\d{1,2}/i.test(title);
    return hasYear && !hasSeasonEpisode;
  }

  /**
   * Check if a release title looks like TV
   */
  private looksLikeTv(title: string): boolean {
    return /S\d{1,2}E\d{1,2}/i.test(title) || /S\d{1,2}(?!E)/i.test(title);
  }

  /**
   * Match a movie release against AWAITING or QUALITY_UNAVAILABLE movie requests
   */
  private async matchMovieRelease(item: RssItem): Promise<void> {
    const requests = await prisma.mediaRequest.findMany({
      where: {
        type: MediaType.MOVIE,
        status: { in: [RequestStatus.AWAITING, RequestStatus.QUALITY_UNAVAILABLE] },
      },
    });

    // Extract resolution from release title
    const releaseResolution = this.extractResolution(item.title);

    for (const request of requests) {
      if (this.releaseMatchesMovie(item.title, request.title, request.year)) {
        // Check if release meets quality requirement (if set)
        if (request.requiredResolution) {
          const meetsQuality = resolutionMeetsRequirement(releaseResolution, request.requiredResolution as Resolution);
          if (!meetsQuality) {
            console.log(`[RSS] Movie match but quality too low: "${item.title}" (${releaseResolution}) < ${request.requiredResolution}`);
            continue;
          }
        }

        console.log(`[RSS] Movie match: "${item.title}" -> "${request.title}" (${request.year})`);
        await this.triggerDownload(request.id, item, request.status === RequestStatus.QUALITY_UNAVAILABLE);
        break;
      }
    }
  }

  /**
   * Match a TV release against AWAITING or QUALITY_UNAVAILABLE episodes
   */
  private async matchTvRelease(item: RssItem): Promise<void> {
    const seInfo = this.parseSeasonEpisode(item.title);
    if (!seInfo) {
      return;
    }

    // Extract resolution from release title
    const releaseResolution = this.extractResolution(item.title);

    // Find AWAITING or QUALITY_UNAVAILABLE episodes that match
    const episodes = await prisma.tvEpisode.findMany({
      where: {
        status: { in: [TvEpisodeStatus.AWAITING, TvEpisodeStatus.QUALITY_UNAVAILABLE] },
        season: seInfo.season,
        episode: seInfo.episode !== null ? seInfo.episode : undefined,
      },
      include: {
        request: true,
      },
    });

    for (const episode of episodes) {
      const request = episode.request;
      if (this.releaseMatchesTvShow(item.title, request.title)) {
        // Check if release meets quality requirement (if set)
        if (request.requiredResolution) {
          const meetsQuality = resolutionMeetsRequirement(releaseResolution, request.requiredResolution as Resolution);
          if (!meetsQuality) {
            console.log(`[RSS] TV match but quality too low: "${item.title}" (${releaseResolution}) < ${request.requiredResolution}`);
            continue;
          }
        }

        const wasQualityUnavailable = episode.status === TvEpisodeStatus.QUALITY_UNAVAILABLE;

        if (seInfo.episode !== null) {
          console.log(`[RSS] TV match: "${item.title}" -> "${request.title}" S${seInfo.season}E${seInfo.episode}`);
          await this.triggerEpisodeDownload(episode.id, item, wasQualityUnavailable);
        } else {
          console.log(`[RSS] TV season match: "${item.title}" -> "${request.title}" S${seInfo.season}`);
          await this.triggerSeasonDownload(request.id, seInfo.season, item, wasQualityUnavailable);
        }
        break;
      }
    }
  }

  /**
   * Check if a release name matches a movie title
   */
  private releaseMatchesMovie(releaseName: string, title: string, year: number): boolean {
    const normalizedRelease = this.normalizeTitle(releaseName);
    const normalizedTitle = this.normalizeTitle(title);
    const yearStr = year.toString();

    return normalizedRelease.includes(normalizedTitle) && releaseName.includes(yearStr);
  }

  /**
   * Check if a release name matches a TV show title
   */
  private releaseMatchesTvShow(releaseName: string, title: string): boolean {
    const normalizedRelease = this.normalizeTitle(releaseName);
    const normalizedTitle = this.normalizeTitle(title);

    return normalizedRelease.includes(normalizedTitle);
  }

  /**
   * Parse season and episode from a release name
   */
  private parseSeasonEpisode(name: string): { season: number; episode: number | null } | null {
    // Try S01E01 format first
    const episodeMatch = name.match(/S(\d{1,2})E(\d{1,2})/i);
    if (episodeMatch) {
      return {
        season: parseInt(episodeMatch[1], 10),
        episode: parseInt(episodeMatch[2], 10),
      };
    }

    // Try S01 format (season pack)
    const seasonMatch = name.match(/S(\d{1,2})(?!E\d)/i);
    if (seasonMatch) {
      return {
        season: parseInt(seasonMatch[1], 10),
        episode: null,
      };
    }

    return null;
  }

  /**
   * Normalize a title for matching
   */
  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .trim();
  }

  /**
   * Build a release object from an RSS item
   */
  private buildRelease(item: RssItem): Release {
    const title = item.title;
    const upper = title.toUpperCase();

    // Extract quality info
    const resolution = this.extractResolution(title);
    const source = this.extractSource(title);
    const codec = this.extractCodec(title);

    // Calculate score
    let score = 0;
    score += QUALITY_SCORES[resolution as keyof typeof QUALITY_SCORES] || 0;
    score += QUALITY_SCORES[source as keyof typeof QUALITY_SCORES] || 0;
    score += QUALITY_SCORES[codec as keyof typeof QUALITY_SCORES] || 0;

    if (upper.includes("ATMOS")) score += QUALITY_SCORES.ATMOS;
    if (upper.includes("TRUEHD")) score += QUALITY_SCORES.TRUEHD;
    if (upper.includes("DTS-HD")) score += QUALITY_SCORES["DTS-HD"];

    // The link from RSS is the download URL
    const downloadUrl = item.link;

    // Extract torrent ID from link to build info URL
    const torrentIdMatch = item.link.match(/\/(\d+)\//);
    const infoUrl = torrentIdMatch
      ? `https://www.torrentleech.org/torrent/${torrentIdMatch[1]}`
      : undefined;

    return {
      id: `rss-tl-${item.guid || Date.now()}`,
      title,
      indexerId: "rss-torrentleech",
      indexerName: "TorrentLeech (RSS)",
      resolution,
      source,
      codec,
      size: 0, // Unknown from RSS
      seeders: 1,
      leechers: 0,
      downloadUrl,
      infoUrl,
      publishDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      score,
      categories: [],
    };
  }

  /**
   * Extract resolution from release name
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
   * Extract source from release name
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
   * Extract codec from release name
   */
  private extractCodec(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("AV1")) return "AV1";
    if (upper.includes("HEVC") || upper.includes("H.265") || upper.includes("H265") || upper.includes("X265")) return "HEVC";
    if (upper.includes("H.264") || upper.includes("H264") || upper.includes("X264") || upper.includes("AVC")) return "H264";
    return "UNKNOWN";
  }

  /**
   * Trigger download for a movie request
   */
  private async triggerDownload(requestId: string, item: RssItem, wasQualityUnavailable = false): Promise<void> {
    const release = this.buildRelease(item);

    if (!release.downloadUrl) {
      console.warn(`[RSS] Cannot download "${item.title}" - no download URL`);
      return;
    }

    // Update request with selected release and trigger download
    // Clear availableReleases if this was a quality upgrade
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.DOWNLOADING,
        selectedRelease: release as unknown as object,
        currentStep: wasQualityUnavailable
          ? `RSS: Quality upgrade found - ${release.title}`
          : `RSS: Found ${release.title}`,
        ...(wasQualityUnavailable ? { availableReleases: Prisma.JsonNull } : {}),
      },
    });

    // Queue download job
    const jobQueue = getJobQueueService();
    await jobQueue.addJob("pipeline:download", { requestId }, { priority: 10 });

    console.log(`[RSS] Queued download for request ${requestId}: ${release.title}${wasQualityUnavailable ? " (quality upgrade)" : ""}`);
  }

  /**
   * Trigger download for a specific episode
   */
  private async triggerEpisodeDownload(episodeId: string, item: RssItem, wasQualityUnavailable = false): Promise<void> {
    const release = this.buildRelease(item);

    if (!release.downloadUrl) {
      console.warn(`[RSS] Cannot download "${item.title}" - no download URL`);
      return;
    }

    // Update episode status and clear availableReleases if this was a quality upgrade
    const episode = await prisma.tvEpisode.update({
      where: { id: episodeId },
      data: {
        status: TvEpisodeStatus.DOWNLOADING,
        ...(wasQualityUnavailable ? { qualityMet: true, availableReleases: Prisma.JsonNull } : {}),
      },
      include: { request: true },
    });

    // Update parent request status
    await prisma.mediaRequest.update({
      where: { id: episode.requestId },
      data: {
        status: RequestStatus.DOWNLOADING,
        currentStep: wasQualityUnavailable
          ? `RSS: Quality upgrade found - S${episode.season}E${episode.episode}`
          : `RSS: Found S${episode.season}E${episode.episode}`,
      },
    });

    // Queue episode download job
    const jobQueue = getJobQueueService();
    await jobQueue.addJob("tv:download-episode", { requestId: episode.requestId, episodeId }, { priority: 10 });

    console.log(`[RSS] Queued episode download: S${episode.season}E${episode.episode}${wasQualityUnavailable ? " (quality upgrade)" : ""}`);
  }

  /**
   * Trigger download for a season pack
   */
  private async triggerSeasonDownload(requestId: string, season: number, item: RssItem, wasQualityUnavailable = false): Promise<void> {
    const release = this.buildRelease(item);

    if (!release.downloadUrl) {
      console.warn(`[RSS] Cannot download "${item.title}" - no download URL`);
      return;
    }

    // Get all awaiting or quality_unavailable episodes for this season
    const episodes = await prisma.tvEpisode.findMany({
      where: {
        requestId,
        season,
        status: { in: [TvEpisodeStatus.AWAITING, TvEpisodeStatus.QUALITY_UNAVAILABLE] },
      },
    });

    if (episodes.length === 0) return;

    // Update first episode status
    await prisma.tvEpisode.update({
      where: { id: episodes[0].id },
      data: {
        status: TvEpisodeStatus.DOWNLOADING,
        ...(wasQualityUnavailable ? { qualityMet: true, availableReleases: Prisma.JsonNull } : {}),
      },
    });

    // Mark other episodes as downloading too
    await prisma.tvEpisode.updateMany({
      where: {
        requestId,
        season,
        id: { not: episodes[0].id },
        status: { in: [TvEpisodeStatus.AWAITING, TvEpisodeStatus.QUALITY_UNAVAILABLE] },
      },
      data: {
        status: TvEpisodeStatus.DOWNLOADING,
        ...(wasQualityUnavailable ? { qualityMet: true, availableReleases: Prisma.JsonNull } : {}),
      },
    });

    // Update parent request
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.DOWNLOADING,
        currentStep: wasQualityUnavailable
          ? `RSS: Quality upgrade found - season ${season} pack`
          : `RSS: Found season ${season} pack`,
      },
    });

    // Queue season download job
    const jobQueue = getJobQueueService();
    await jobQueue.addJob("tv:download-season", { requestId, season, episodeId: episodes[0].id }, { priority: 10 });

    console.log(`[RSS] Queued season ${season} download for request ${requestId}${wasQualityUnavailable ? " (quality upgrade)" : ""}`);
  }
}

// =============================================================================
// Singleton
// =============================================================================

let rssMonitor: RssAnnounceMonitor | null = null;

export function getRssAnnounceMonitor(): RssAnnounceMonitor {
  if (!rssMonitor) {
    rssMonitor = new RssAnnounceMonitor();
  }
  return rssMonitor;
}

export { RssAnnounceMonitor };
