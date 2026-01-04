/**
 * IRC Announce Monitor Service
 *
 * Monitors IRC announce channels (like TorrentLeech #tlannounces) for new releases.
 * When a release matches a monitored request, it automatically triggers the download.
 *
 * This is more efficient than polling - we get instant notifications of new releases.
 */

import { MediaType, Prisma, ProcessingStatus, RequestStatus } from "@prisma/client";
import { Client } from "irc-framework";
import { getConfig } from "../config/index.js";
import { prisma } from "../db/client.js";
import type { Resolution } from "../types/download.js";
import type { Release } from "./indexer.js";
import { getJobQueueService } from "./jobQueue.js";
import { resolutionMeetsRequirement } from "./qualityService.js";

// =============================================================================
// Types
// =============================================================================

interface ParsedAnnounce {
  category: string;
  name: string;
  uploader: string;
  baseUrl: string;
  torrentId: string;
}

interface TorrentLeechCategories {
  movies: string[];
  tv: string[];
}

// TorrentLeech category mapping (from their IRC announcements)
const TL_CATEGORIES: TorrentLeechCategories = {
  movies: [
    "Movies :: Bluray",
    "Movies :: BDRemux",
    "Movies :: 4K",
    "Movies :: WEBDL",
    "Movies :: WEBRip",
    "Movies :: HDRip",
    "Movies :: DVDRip/DVDScreener",
    "Movies :: Boxsets",
    "Movies :: Documentaries",
    "Movies :: Foreign",
    "Movies :: CAM",
    "Movies :: TS/TC",
  ],
  tv: [
    "TV :: Episodes HD",
    "TV :: Episodes SD",
    "TV :: Episodes 4K",
    "TV :: Boxsets",
    "TV :: Boxsets HD",
    "TV :: Boxsets 4K",
    "TV :: Foreign",
  ],
};

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
// IRC Announce Monitor
// =============================================================================

class IrcAnnounceMonitor {
  private client: Client | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private rssKey: string | null = null;

  /**
   * Start the IRC monitor
   */
  async start(): Promise<void> {
    const config = getConfig();

    console.log(`[IRC] Config: enabled=${config.irc.enabled}`);

    if (!config.irc.enabled) {
      console.log("[IRC] Announce monitor is disabled");
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
        // Fourth part is the RSS key
        this.rssKey = parts[3];
        console.log(`[IRC] Found RSS key from TorrentLeech indexer config`);
      } else if (parts.length === 3 && parts[2] && parts[2].length > 32) {
        // Legacy format: username:password:rssKey (no 2FA token)
        this.rssKey = parts[2];
        console.log(`[IRC] Found RSS key from TorrentLeech indexer config (legacy format)`);
      }
    }

    if (!this.rssKey) {
      console.warn("[IRC] No RSS key found - will not be able to download from announces");
      console.warn("[IRC] Add RSS key to TorrentLeech indexer config: username:password:rssKey");
    }

    this.connect();
  }

  /**
   * Stop the IRC monitor
   */
  stop(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      this.client.quit("Shutting down");
      this.client = null;
    }

    this.connected = false;
    console.log("[IRC] Monitor stopped");
  }

  /**
   * Connect to IRC server
   */
  private connect(): void {
    const config = getConfig();

    // Generate a random nickname if not configured
    const nickname = config.irc.nickname || `Annex${Math.floor(Math.random() * 10000)}`;

    console.log(`[IRC] Connecting to ${config.irc.server}:${config.irc.port} as ${nickname}...`);
    console.log(`[IRC] SSL: ${config.irc.ssl}, Channels: ${config.irc.channels.join(", ")}`);

    this.client = new Client();

    // Set up event handlers BEFORE connecting
    this.setupEventHandlers();

    console.log("[IRC] Event handlers registered, initiating connection...");

    this.client.connect({
      host: config.irc.server,
      port: config.irc.port,
      nick: nickname,
      tls: config.irc.ssl,
      auto_reconnect: false, // We handle reconnection ourselves
    });

    console.log("[IRC] Connection initiated (async)");
  }

  /**
   * Set up IRC event handlers
   */
  private setupEventHandlers(): void {
    if (!this.client) return;

    const config = getConfig();

    // Debug: log all raw events
    this.client.on("raw", (event) => {
      const rawEvent = event as { line: string };
      console.log(`[IRC:RAW] ${rawEvent.line}`);
    });

    this.client.on("socket connected", () => {
      console.log("[IRC] Socket connected");
    });

    this.client.on("connected", () => {
      console.log("[IRC] Connected event fired");
    });

    this.client.on("registered", () => {
      console.log("[IRC] Registered with server");
      this.connected = true;
      this.reconnectAttempts = 0;

      // Join announce channels
      for (const channel of config.irc.channels) {
        console.log(`[IRC] Joining ${channel}`);
        this.client?.join(channel);
      }
    });

    this.client.on("join", (event) => {
      console.log(`[IRC] Joined ${event.channel}`);
    });

    this.client.on("message", (event) => {
      // Only process messages from announce channels
      if (!config.irc.channels.includes(event.target)) return;

      // Log all announce channel messages
      console.log(`[IRC] <${event.target}> ${event.message}`);

      // Process the announcement
      this.handleAnnounce(event.message).catch((err) => {
        console.error("[IRC] Error handling announce:", err);
      });
    });

    this.client.on("close", () => {
      console.log("[IRC] Connection closed");
      this.connected = false;
      this.scheduleReconnect();
    });

    this.client.on("socket close", () => {
      if (this.connected) {
        console.log("[IRC] Socket closed unexpectedly");
        this.connected = false;
        this.scheduleReconnect();
      }
    });

    this.client.on("error", (event) => {
      console.error(`[IRC] Error: ${event.error}`, event.reason || "");
    });

    this.client.on("socket error", (err) => {
      const error = err as Error;
      console.error(`[IRC] Socket error: ${error.message}`);
    });
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    const config = getConfig();

    // Don't reconnect if IRC is disabled
    if (!config.irc.enabled) {
      console.log("[IRC] IRC is disabled, not reconnecting");
      return;
    }

    if (!config.irc.reconnect) {
      console.log("[IRC] Reconnection disabled, not reconnecting");
      return;
    }

    if (
      config.irc.reconnectMaxRetries > 0 &&
      this.reconnectAttempts >= config.irc.reconnectMaxRetries
    ) {
      console.error(`[IRC] Max reconnection attempts (${config.irc.reconnectMaxRetries}) reached`);
      return;
    }

    this.reconnectAttempts++;
    const delay = config.irc.reconnectDelay * Math.min(this.reconnectAttempts, 5); // Exponential backoff, max 5x

    console.log(`[IRC] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /**
   * Handle an IRC announce message
   */
  private async handleAnnounce(message: string): Promise<void> {
    // Parse TorrentLeech announce format:
    // New Torrent Announcement: <Category> Name:'Torrent Name' uploaded by 'Uploader' - http://torrentleech.org/torrent/123456
    const pattern =
      /^New Torrent Announcement:\s*<([^>]*)>\s*Name:'(.*)' uploaded by '([^']*)'\s*-\s*https?:\/\/([^/]+\/)torrent\/(\d+)/;
    const match = message.match(pattern);

    if (!match) {
      // Not a standard announce message, ignore
      return;
    }

    const announce: ParsedAnnounce = {
      category: match[1],
      name: match[2],
      uploader: match[3],
      baseUrl: match[4],
      torrentId: match[5],
    };

    console.log(`[IRC] Announce: ${announce.name} [${announce.category}]`);

    // Determine if this is a movie or TV release
    const isMovie = TL_CATEGORIES.movies.some(
      (cat) => announce.category.includes(cat) || cat.includes(announce.category)
    );
    const isTv = TL_CATEGORIES.tv.some(
      (cat) => announce.category.includes(cat) || cat.includes(announce.category)
    );

    if (!isMovie && !isTv) {
      // Not a media category we care about
      return;
    }

    // Try to match against our monitored requests
    if (isMovie) {
      await this.matchMovieAnnounce(announce);
    }
    if (isTv) {
      await this.matchTvAnnounce(announce);
    }
  }

  /**
   * Match a movie announce against monitored movie requests
   */
  private async matchMovieAnnounce(announce: ParsedAnnounce): Promise<void> {
    // Find AWAITING or QUALITY_UNAVAILABLE movie requests
    const requests = await prisma.mediaRequest.findMany({
      where: {
        type: MediaType.MOVIE,
        status: { in: [RequestStatus.AWAITING, RequestStatus.QUALITY_UNAVAILABLE] },
      },
    });

    // Extract resolution from release title
    const releaseResolution = this.extractResolution(announce.name);

    for (const request of requests) {
      if (this.releaseMatchesMovie(announce.name, request.title, request.year)) {
        // Check if release meets quality requirement (if set)
        if (request.requiredResolution) {
          const meetsQuality = resolutionMeetsRequirement(
            releaseResolution,
            request.requiredResolution as Resolution
          );
          if (!meetsQuality) {
            console.log(
              `[IRC] Movie match but quality too low: "${announce.name}" (${releaseResolution}) < ${request.requiredResolution}`
            );
            continue;
          }
        }

        console.log(
          `[IRC] Movie match: "${announce.name}" -> "${request.title}" (${request.year})`
        );
        await this.triggerDownload(
          request.id,
          announce,
          request.status === RequestStatus.QUALITY_UNAVAILABLE
        );
        break; // Only trigger once per announce
      }
    }
  }

  /**
   * Match a TV announce against monitored TV requests
   */
  private async matchTvAnnounce(announce: ParsedAnnounce): Promise<void> {
    // Parse season/episode from release name
    const seInfo = this.parseSeasonEpisode(announce.name);
    if (!seInfo) {
      // Couldn't parse season/episode, might be a full series pack
      // For now, skip these
      return;
    }

    // Extract resolution from release title
    const releaseResolution = this.extractResolution(announce.name);

    // Find SEARCHING episodes that match (includes quality unavailable cases)
    const episodes = await prisma.processingItem.findMany({
      where: {
        type: "EPISODE",
        status: ProcessingStatus.SEARCHING,
        season: seInfo.season,
        episode: seInfo.episode !== null ? seInfo.episode : undefined,
      },
      include: {
        request: true,
      },
    });

    for (const episode of episodes) {
      const request = episode.request;
      if (this.releaseMatchesTvShow(announce.name, request.title)) {
        // Check if release meets quality requirement (if set)
        if (request.requiredResolution) {
          const meetsQuality = resolutionMeetsRequirement(
            releaseResolution,
            request.requiredResolution as Resolution
          );
          if (!meetsQuality) {
            console.log(
              `[IRC] TV match but quality too low: "${announce.name}" (${releaseResolution}) < ${request.requiredResolution}`
            );
            continue;
          }
        }

        const wasQualityUnavailable = episode.qualityMet === false;

        if (seInfo.episode !== null) {
          console.log(
            `[IRC] TV match: "${announce.name}" -> "${request.title}" S${seInfo.season}E${seInfo.episode}`
          );
          await this.triggerEpisodeDownload(episode.id, announce, wasQualityUnavailable);
        } else {
          // Season pack
          console.log(
            `[IRC] TV season match: "${announce.name}" -> "${request.title}" S${seInfo.season}`
          );
          await this.triggerSeasonDownload(
            request.id,
            seInfo.season,
            announce,
            wasQualityUnavailable
          );
        }
        break; // Only trigger once per announce
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

    // Release should contain the title and year
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
   * Build a release object from an announce
   */
  private buildRelease(announce: ParsedAnnounce): Release {
    const upper = announce.name.toUpperCase();

    // Extract quality info
    const resolution = this.extractResolution(announce.name);
    const source = this.extractSource(announce.name);
    const codec = this.extractCodec(announce.name);

    // Calculate score
    let score = 0;
    score += QUALITY_SCORES[resolution as keyof typeof QUALITY_SCORES] || 0;
    score += QUALITY_SCORES[source as keyof typeof QUALITY_SCORES] || 0;
    score += QUALITY_SCORES[codec as keyof typeof QUALITY_SCORES] || 0;

    if (upper.includes("ATMOS")) score += QUALITY_SCORES.ATMOS;
    if (upper.includes("TRUEHD")) score += QUALITY_SCORES.TRUEHD;
    if (upper.includes("DTS-HD")) score += QUALITY_SCORES["DTS-HD"];

    // Build download URL
    let downloadUrl: string | undefined;
    if (this.rssKey) {
      // URL encode the torrent name for the download URL
      const encodedName = encodeURIComponent(announce.name);
      downloadUrl = `https://${announce.baseUrl}rss/download/${announce.torrentId}/${this.rssKey}/${encodedName}.torrent`;
    }

    return {
      id: `irc-tl-${announce.torrentId}`,
      title: announce.name,
      indexerId: "irc-torrentleech",
      indexerName: "TorrentLeech (IRC)",
      resolution,
      source,
      codec,
      size: 0, // Unknown from IRC announce
      seeders: 1, // Assume at least the uploader is seeding
      leechers: 0,
      downloadUrl,
      infoUrl: `https://${announce.baseUrl}torrent/${announce.torrentId}`,
      publishDate: new Date(),
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
   * Extract codec from release name
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
   * Trigger download for a movie request
   */
  private async triggerDownload(
    requestId: string,
    announce: ParsedAnnounce,
    wasQualityUnavailable = false
  ): Promise<void> {
    const release = this.buildRelease(announce);

    if (!release.downloadUrl) {
      console.warn(`[IRC] Cannot download "${announce.name}" - no RSS key configured`);
      return;
    }

    // Update request with selected release (configuration)
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        selectedRelease: release as unknown as object,
      },
    });

    // Queue download job
    const jobQueue = getJobQueueService();
    await jobQueue.addJob("pipeline:download", { requestId }, { priority: 10 });

    console.log(
      `[IRC] Queued download for request ${requestId}: ${release.title}${wasQualityUnavailable ? " (quality upgrade)" : ""}`
    );
  }

  /**
   * Trigger download for a specific episode
   */
  private async triggerEpisodeDownload(
    episodeId: string,
    announce: ParsedAnnounce,
    wasQualityUnavailable = false
  ): Promise<void> {
    const release = this.buildRelease(announce);

    if (!release.downloadUrl) {
      console.warn(`[IRC] Cannot download "${announce.name}" - no RSS key configured`);
      return;
    }

    // Update episode status and clear availableReleases if this was a quality upgrade
    const episode = await prisma.processingItem.update({
      where: { id: episodeId },
      data: {
        status: ProcessingStatus.DOWNLOADING,
        ...(wasQualityUnavailable ? { qualityMet: true, availableReleases: Prisma.JsonNull } : {}),
      },
      include: { request: true },
    });

    // MediaRequest status computed from ProcessingItems - no update needed

    // Queue episode download job
    const jobQueue = getJobQueueService();
    await jobQueue.addJob(
      "tv:download-episode",
      { requestId: episode.requestId, episodeId },
      { priority: 10 }
    );

    console.log(
      `[IRC] Queued episode download: S${episode.season}E${episode.episode}${wasQualityUnavailable ? " (quality upgrade)" : ""}`
    );
  }

  /**
   * Trigger download for a season pack
   */
  private async triggerSeasonDownload(
    requestId: string,
    season: number,
    announce: ParsedAnnounce,
    wasQualityUnavailable = false
  ): Promise<void> {
    const release = this.buildRelease(announce);

    if (!release.downloadUrl) {
      console.warn(`[IRC] Cannot download "${announce.name}" - no RSS key configured`);
      return;
    }

    // Get all awaiting or quality_unavailable episodes for this season
    const episodes = await prisma.processingItem.findMany({
      where: {
        type: "EPISODE",
        requestId,
        season,
        status: ProcessingStatus.SEARCHING,
      },
    });

    if (episodes.length === 0) return;

    // Update first episode status
    await prisma.processingItem.update({
      where: { id: episodes[0].id },
      data: {
        status: ProcessingStatus.DOWNLOADING,
        ...(wasQualityUnavailable ? { qualityMet: true, availableReleases: Prisma.JsonNull } : {}),
      },
    });

    // Mark other episodes as downloading too
    await prisma.processingItem.updateMany({
      where: {
        type: "EPISODE",
        requestId,
        season,
        id: { not: episodes[0].id },
        status: ProcessingStatus.SEARCHING,
      },
      data: {
        status: ProcessingStatus.DOWNLOADING,
        ...(wasQualityUnavailable ? { qualityMet: true, availableReleases: Prisma.JsonNull } : {}),
      },
    });

    // MediaRequest status computed from ProcessingItems - no update needed

    // Queue season download job
    const jobQueue = getJobQueueService();
    await jobQueue.addJob(
      "tv:download-season",
      { requestId, season, episodeId: episodes[0].id },
      { priority: 10 }
    );

    console.log(
      `[IRC] Queued season ${season} download for request ${requestId}${wasQualityUnavailable ? " (quality upgrade)" : ""}`
    );
  }
}

// =============================================================================
// Singleton
// =============================================================================

let ircMonitor: IrcAnnounceMonitor | null = null;

export function getIrcAnnounceMonitor(): IrcAnnounceMonitor {
  if (!ircMonitor) {
    ircMonitor = new IrcAnnounceMonitor();
  }
  return ircMonitor;
}

export { IrcAnnounceMonitor };
