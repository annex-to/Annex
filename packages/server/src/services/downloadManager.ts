/**
 * Download Manager Service
 *
 * Robust download management with:
 * - qBittorrent matching to reuse existing downloads
 * - Health monitoring for stalled/failed downloads
 * - Automatic retry with alternative releases
 * - Cleanup and lifecycle management
 */

import { type Download, DownloadStatus, MediaType, ProcessingStatus } from "@prisma/client";
import ptt from "parse-torrent-title";
import { prisma } from "../db/client.js";
import type {
  CreateDownloadParams,
  DownloadConfig,
  DownloadHealth,
  IndexerRelease,
  MatchResult,
  ParsedTorrent,
  QualityProfileConfig,
  Resolution,
  ScoredRelease,
  SystemHealth,
  TorrentMatch,
} from "../types/download.js";
import {
  DEFAULT_DOWNLOAD_CONFIG,
  DEFAULT_QUALITY_PROFILES,
  RESOLUTION_RANK,
} from "../types/download.js";
import { type DownloadProgress, getDownloadService } from "./download.js";
import { getDownloadClientManager } from "./downloadClients/DownloadClientManager.js";

// =============================================================================
// Configuration
// =============================================================================

let config: DownloadConfig = { ...DEFAULT_DOWNLOAD_CONFIG };

export function getDownloadConfig(): DownloadConfig {
  return config;
}

export function setDownloadConfig(newConfig: Partial<DownloadConfig>): void {
  config = { ...config, ...newConfig };
}

// =============================================================================
// Title Normalization
// =============================================================================

/**
 * Simple title normalization for legacy matching functions
 * For new code, use parsedTorrentsMatch() instead
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Parse a torrent name using parse-torrent-title
 */
export function parseTorrentName(name: string): ParsedTorrent {
  return ptt.parse(name) as ParsedTorrent;
}

/**
 * Compare two parsed torrents to see if they match
 * Compares essential fields while allowing for format variations
 */
export function parsedTorrentsMatch(
  release: ParsedTorrent,
  torrent: ParsedTorrent,
  mediaType: MediaType
): boolean {
  // For TV shows, must match: title, season
  if (mediaType === MediaType.TV) {
    // Title must match (case-insensitive, normalized)
    const releaseTitle = (release.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const torrentTitle = (torrent.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (releaseTitle !== torrentTitle) {
      return false;
    }

    // Season must match
    if (release.season !== torrent.season) {
      return false;
    }

    // Resolution should match (if both have it)
    if (release.resolution && torrent.resolution) {
      const releaseRes = release.resolution.replace(/p$/i, "");
      const torrentRes = torrent.resolution.replace(/p$/i, "");
      if (releaseRes !== torrentRes) {
        return false;
      }
    }

    // Codec should match (if both have it)
    if (release.codec && torrent.codec) {
      const releaseCodec = release.codec.toLowerCase();
      const torrentCodec = torrent.codec.toLowerCase();
      // Allow x264/h264 and x265/h265/hevc to match
      const normalizeCodec = (c: string) => {
        if (c === "h264") return "x264";
        if (c === "h265" || c === "hevc") return "x265";
        return c;
      };
      if (normalizeCodec(releaseCodec) !== normalizeCodec(torrentCodec)) {
        return false;
      }
    }

    return true;
  }

  // For movies, must match: title, year
  if (mediaType === MediaType.MOVIE) {
    const releaseTitle = (release.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const torrentTitle = (torrent.title || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (releaseTitle !== torrentTitle) {
      return false;
    }

    if (release.year !== torrent.year) {
      return false;
    }

    // Resolution should match (if both have it)
    if (release.resolution && torrent.resolution) {
      const releaseRes = release.resolution.replace(/p$/i, "");
      const torrentRes = torrent.resolution.replace(/p$/i, "");
      if (releaseRes !== torrentRes) {
        return false;
      }
    }

    return true;
  }

  return false;
}

// =============================================================================
// qBittorrent Matching
// =============================================================================

/**
 * Find existing downloads in qBittorrent that match a movie
 */
export async function findExistingMovieDownload(
  movieTitle: string,
  year: number
): Promise<MatchResult> {
  const qb = getDownloadService();
  const torrents = await qb.getAllTorrents();
  const normalizedTitle = normalizeTitle(movieTitle);

  const matches: TorrentMatch[] = [];

  for (const torrent of torrents) {
    const parsed = parseTorrentName(torrent.name);

    // Must have title and no season (not TV)
    if (!parsed.title || parsed.season !== undefined) continue;

    // Title must match
    if (normalizeTitle(parsed.title) !== normalizedTitle) continue;

    // Year must match if parsed
    if (parsed.year && parsed.year !== year) continue;

    const score = calculateMatchScore(parsed, torrent);
    matches.push({
      torrent: {
        hash: torrent.clientHash,
        name: torrent.name,
        size: torrent.totalBytes,
        progress: torrent.progress / 100,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        seeds: torrent.seeds,
        peers: torrent.peers,
        ratio: torrent.ratio,
        eta: torrent.eta,
        state: torrent.state,
        savePath: torrent.savePath,
        contentPath: torrent.contentPath,
        addedOn: 0,
        completedOn: 0,
      },
      parsed,
      score,
    });
  }

  if (matches.length === 0) {
    return { found: false, isComplete: false };
  }

  const best = pickBestMatch(matches);
  return {
    found: true,
    match: best,
    isComplete: best.torrent.progress >= 1,
  };
}

/**
 * Find existing downloads in qBittorrent that match a TV season pack
 */
export async function findExistingSeasonDownload(
  showName: string,
  season: number
): Promise<MatchResult> {
  const qb = getDownloadService();
  const torrents = await qb.getAllTorrents();
  const normalizedShow = normalizeTitle(showName);

  console.log(
    `[DownloadManager] findExistingSeasonDownload: show="${showName}", normalized="${normalizedShow}", season=${season}`
  );
  console.log(`[DownloadManager] Checking ${torrents.length} torrents`);

  const matches: TorrentMatch[] = [];

  for (const torrent of torrents) {
    const parsed = parseTorrentName(torrent.name);

    // Must have a title and season
    if (!parsed.title || parsed.season !== season) continue;

    // Must be a season pack (no episode number)
    if (parsed.episode !== undefined) continue;

    // Title must match
    const normalizedTorrent = normalizeTitle(parsed.title);
    console.log(
      `[DownloadManager] Candidate: "${torrent.name}" -> title="${parsed.title}", normalized="${normalizedTorrent}", season=${parsed.season}, episode=${parsed.episode}`
    );

    if (normalizedTorrent !== normalizedShow) {
      console.log(
        `[DownloadManager] Title mismatch: "${normalizedTorrent}" !== "${normalizedShow}"`
      );
      continue;
    }

    console.log(`[DownloadManager] MATCH FOUND: ${torrent.name}`);

    const score = calculateMatchScore(parsed, torrent);
    matches.push({
      torrent: {
        hash: torrent.clientHash,
        name: torrent.name,
        size: torrent.totalBytes,
        progress: torrent.progress / 100,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        seeds: torrent.seeds,
        peers: torrent.peers,
        ratio: torrent.ratio,
        eta: torrent.eta,
        state: torrent.state,
        savePath: torrent.savePath,
        contentPath: torrent.contentPath,
        addedOn: 0,
        completedOn: 0,
      },
      parsed,
      score,
    });
  }

  if (matches.length === 0) {
    return { found: false, isComplete: false };
  }

  const best = pickBestMatch(matches);
  return {
    found: true,
    match: best,
    isComplete: best.torrent.progress >= 1,
  };
}

/**
 * Find existing downloads in qBittorrent that match an individual episode
 */
export async function findExistingEpisodeDownload(
  showName: string,
  season: number,
  episode: number
): Promise<MatchResult> {
  const qb = getDownloadService();
  const torrents = await qb.getAllTorrents();
  const normalizedShow = normalizeTitle(showName);

  const matches: TorrentMatch[] = [];

  for (const torrent of torrents) {
    const parsed = parseTorrentName(torrent.name);

    // Must match show, season, and episode
    if (!parsed.title) continue;
    if (parsed.season !== season) continue;

    // Episode can be a number or array
    const epMatch = Array.isArray(parsed.episode)
      ? parsed.episode.includes(episode)
      : parsed.episode === episode;

    if (!epMatch) continue;

    if (normalizeTitle(parsed.title) !== normalizedShow) continue;

    const score = calculateMatchScore(parsed, torrent);
    matches.push({
      torrent: {
        hash: torrent.clientHash,
        name: torrent.name,
        size: torrent.totalBytes,
        progress: torrent.progress / 100,
        downloadSpeed: torrent.downloadSpeed,
        uploadSpeed: torrent.uploadSpeed,
        seeds: torrent.seeds,
        peers: torrent.peers,
        ratio: torrent.ratio,
        eta: torrent.eta,
        state: torrent.state,
        savePath: torrent.savePath,
        contentPath: torrent.contentPath,
        addedOn: 0,
        completedOn: 0,
      },
      parsed,
      score,
    });
  }

  if (matches.length === 0) {
    return { found: false, isComplete: false };
  }

  const best = pickBestMatch(matches);
  return {
    found: true,
    match: best,
    isComplete: best.torrent.progress >= 1,
  };
}

/**
 * Calculate match score for ranking
 */
function calculateMatchScore(parsed: ParsedTorrent, torrent: DownloadProgress): number {
  let score = 0;

  // Resolution score (0-400)
  const resRank = RESOLUTION_RANK[parsed.resolution as Resolution] || 0;
  score += resRank * 100;

  // Completion bonus (prefer completed)
  if (torrent.progress >= 100 || torrent.isComplete) {
    score += 500;
  }

  // Size bonus (larger usually = better quality)
  score += Math.min(torrent.totalBytes / 1e9, 50); // Up to 50 points for 50GB

  // Seeder bonus
  score += Math.min(torrent.seeds, 100);

  return score;
}

/**
 * Pick the best match from multiple candidates
 */
function pickBestMatch(matches: TorrentMatch[]): TorrentMatch {
  return matches.sort((a, b) => {
    // Prefer completed over in-progress
    const aComplete = a.torrent.progress >= 1;
    const bComplete = b.torrent.progress >= 1;
    if (aComplete !== bComplete) return bComplete ? 1 : -1;

    // Then by score
    return b.score - a.score;
  })[0];
}

// =============================================================================
// Release Scoring
// =============================================================================

/**
 * Score a release based on quality profile preferences
 */
export function scoreRelease(
  release: IndexerRelease,
  profile: QualityProfileConfig
): ScoredRelease {
  const parsed = parseTorrentName(release.title);
  let score = 0;
  let rejectionReason: string | undefined;

  // Check banned groups first
  if (parsed.group && profile.bannedGroups.includes(parsed.group.toUpperCase())) {
    return { release, score: -1, parsed, rejectionReason: `Banned group: ${parsed.group}` };
  }

  // Size check
  const sizeGB = release.size / 1e9;
  if (profile.minSizeGB && sizeGB < profile.minSizeGB) {
    return {
      release,
      score: -1,
      parsed,
      rejectionReason: `Too small: ${sizeGB.toFixed(1)}GB < ${profile.minSizeGB}GB`,
    };
  }
  if (profile.maxSizeGB && sizeGB > profile.maxSizeGB) {
    return {
      release,
      score: -1,
      parsed,
      rejectionReason: `Too large: ${sizeGB.toFixed(1)}GB > ${profile.maxSizeGB}GB`,
    };
  }

  // Resolution check
  const resolution = (parsed.resolution || release.resolution) as Resolution | undefined;
  const resRank = resolution ? RESOLUTION_RANK[resolution] || 0 : 0;
  const minRank = RESOLUTION_RANK[profile.minResolution] || 0;

  if (resRank < minRank) {
    return {
      release,
      score: -1,
      parsed,
      rejectionReason: `Resolution too low: ${resolution} < ${profile.minResolution}`,
    };
  }

  // Resolution score (0-400)
  const resIndex = profile.preferredResolutions.indexOf(resolution as Resolution);
  if (resIndex !== -1) {
    score += (profile.preferredResolutions.length - resIndex) * 100;
  } else if (resolution) {
    score += resRank * 50; // Partial score for valid but non-preferred resolution
  }

  // Source score (0-50)
  const source = parsed.source || release.source;
  if (source) {
    const sourceIndex = profile.preferredSources.findIndex(
      (s) => s.toLowerCase() === source.toLowerCase()
    );
    if (sourceIndex !== -1) {
      score += (profile.preferredSources.length - sourceIndex) * 10;
    }
  }

  // Codec score (0-30)
  const codec = parsed.codec || release.codec;
  if (codec) {
    const codecIndex = profile.preferredCodecs.findIndex(
      (c) => c.toLowerCase() === codec.toLowerCase()
    );
    if (codecIndex !== -1) {
      score += (profile.preferredCodecs.length - codecIndex) * 10;
    }
  }

  // Seeder bonus (0-100)
  score += Math.min(release.seeders, 100);

  // Preferred group bonus
  if (parsed.group && profile.preferredGroups.includes(parsed.group.toUpperCase())) {
    score += 50;
  }

  // Proper/Repack bonus
  if (parsed.proper || parsed.repack) {
    score += 25;
  }

  return { release, score, parsed, rejectionReason };
}

/**
 * Rank releases by quality profile and return top N
 */
export function rankReleases(
  releases: IndexerRelease[],
  profile: QualityProfileConfig,
  topN: number = 5
): ScoredRelease[] {
  const scored = releases.map((r) => scoreRelease(r, profile));

  // Filter out rejected releases
  const valid = scored.filter((s) => s.score >= 0);

  // Sort by score descending
  valid.sort((a, b) => b.score - a.score);

  return valid.slice(0, topN);
}

/**
 * Get the default quality profile
 */
export function getDefaultQualityProfile(): QualityProfileConfig {
  return DEFAULT_QUALITY_PROFILES.find((p) => p.id === "hd-1080p") || DEFAULT_QUALITY_PROFILES[0];
}

/**
 * Get quality profile by ID
 */
export function getQualityProfile(id: string): QualityProfileConfig | undefined {
  return DEFAULT_QUALITY_PROFILES.find((p) => p.id === id);
}

// =============================================================================
// Download Creation
// =============================================================================

/**
 * Create a new Download record and add to appropriate download client
 */
export async function createDownload(params: CreateDownloadParams): Promise<Download | null> {
  const { requestId, mediaType, release, alternativeReleases, isSeasonPack, season, episodeIds } =
    params;

  // Select appropriate download client based on release type
  const clientManager = getDownloadClientManager();
  const selection = clientManager.selectClientForRelease(release);

  if (!selection) {
    console.error(`[DownloadManager] No compatible download client for release: ${release.title}`);
    return null;
  }

  const { client, clientId } = selection;
  console.log(`[DownloadManager] Using client: ${client.name} for ${release.title}`);

  // Check if this specific torrent is already being downloaded
  // For TV shows, we may have multiple downloads per request (one per episode)
  const existingDownload = await prisma.download.findFirst({
    where: {
      requestId,
      torrentName: release.title,
    },
    orderBy: { startedAt: "desc" },
  });

  if (existingDownload) {
    console.log(
      `[DownloadManager] Reusing existing download ${existingDownload.id} for ${existingDownload.torrentName}`
    );
    return existingDownload;
  }

  // Check if already at max concurrent downloads
  const activeCount = await prisma.download.count({
    where: { status: DownloadStatus.DOWNLOADING },
  });

  if (activeCount >= config.maxConcurrentDownloads) {
    console.log(
      `[DownloadManager] Max concurrent downloads reached (${config.maxConcurrentDownloads}), queueing...`
    );
    // Create as PENDING, will be started later
  }

  const magnetUri = release.magnetUri;
  const downloadUrl = release.downloadUrl;

  if (!magnetUri && !downloadUrl) {
    console.error(`[DownloadManager] No download URL for release: ${release.title}`);
    return null;
  }

  // Add to download client
  const requestTag = `request:${requestId}`;
  let addResult: { success: boolean; clientHash?: string; error?: string };

  if (magnetUri) {
    addResult = await client.addDownload(magnetUri, undefined, {
      category: "annex",
      tags: [requestTag],
    });
  } else if (downloadUrl) {
    // Fetch file data if needed for authenticated URLs
    const redactedUrl = downloadUrl.replace(
      /(?:api_token|apikey|passkey|torrent_pass|key)=[^&]+/gi,
      (match) => {
        const param = match.split("=")[0];
        return `${param}=***`;
      }
    );
    console.log(`[DownloadManager] Fetching file from: ${redactedUrl}`);

    // Try fetching the file data
    let fileData: ArrayBuffer | undefined;
    try {
      const response = await fetch(downloadUrl, {
        headers: release.downloadHeaders || {},
      });
      if (response.ok) {
        fileData = await response.arrayBuffer();
      }
    } catch (error) {
      console.warn(`[DownloadManager] Failed to fetch file: ${error}`);
    }

    // Add with file data if we have it, otherwise try URL directly
    if (fileData) {
      addResult = await client.addDownload(downloadUrl, fileData, {
        category: "annex",
        tags: [requestTag],
      });
    } else {
      addResult = await client.addDownload(downloadUrl, undefined, {
        category: "annex",
        tags: [requestTag],
      });
    }
  } else {
    console.error(
      `[DownloadManager] No magnet URI or download URL available for release: ${release.title}`
    );
    return null;
  }

  if (!addResult.success || !addResult.clientHash) {
    console.error(`[DownloadManager] Failed to add download to ${client.name}: ${addResult.error}`);
    return null;
  }

  const clientHash = addResult.clientHash;

  // Get initial download info
  const progress = await client.getProgress(clientHash);

  // Create or update Download record (upsert for reused downloads)
  const download = await prisma.download.upsert({
    where: { torrentHash: clientHash },
    create: {
      requestId,
      torrentHash: clientHash, // Keep for backward compatibility
      clientHash,
      downloadClientId: clientId,
      torrentName: release.title,
      magnetUri: magnetUri || null,
      mediaType,
      status: DownloadStatus.DOWNLOADING,
      progress: progress?.progress || 0,
      size: progress?.totalBytes ? BigInt(progress.totalBytes) : null,
      savePath: progress?.savePath || null,
      contentPath: progress?.contentPath || null,
      isSeasonPack: isSeasonPack || false,
      season: season || null,
      startedAt: new Date(),
      lastProgressAt: new Date(),
      seedCount: progress?.seeds || null,
      peerCount: progress?.peers || null,
      alternativeReleases: alternativeReleases
        ? JSON.parse(JSON.stringify(alternativeReleases))
        : undefined,
      // Release metadata (migrated from MediaRequest)
      indexerName: release.indexerName || release.indexer || null,
      resolution: release.resolution || null,
      source: release.source || null,
      codec: release.codec || null,
      qualityScore: (release as { score?: number }).score || null,
      publishDate: release.publishDate || null,
    },
    update: {
      requestId, // Update to new request
      downloadClientId: clientId,
      status: DownloadStatus.DOWNLOADING,
      progress: progress?.progress || 0,
      lastProgressAt: new Date(),
      seedCount: progress?.seeds || null,
      peerCount: progress?.peers || null,
    },
  });

  // Link TV episodes if provided
  if (episodeIds && episodeIds.length > 0) {
    await prisma.processingItem.updateMany({
      where: { id: { in: episodeIds } },
      data: {
        downloadId: download.id,
        status: ProcessingStatus.DOWNLOADING,
      },
    });
  }

  // Log event
  await logDownloadEvent(download.id, "created", {
    requestId,
    torrentName: release.title,
    clientHash,
    clientId,
    clientName: client.name,
  });

  console.log(`[DownloadManager] Created download ${download.id} for ${release.title}`);
  return download;
}

/**
 * Create a Download record from an existing qBittorrent torrent (reuse)
 */
export async function createDownloadFromExisting(
  requestId: string,
  mediaType: MediaType,
  match: TorrentMatch,
  options: {
    isSeasonPack?: boolean;
    season?: number;
    episodeIds?: string[];
    isComplete?: boolean;
  } = {}
): Promise<Download> {
  const { isSeasonPack, season, episodeIds, isComplete = false } = options;

  // Check if we already have a Download record for this hash
  const existing = await prisma.download.findUnique({
    where: { torrentHash: match.torrent.hash },
  });

  if (existing) {
    // Link episodes to existing download
    if (episodeIds && episodeIds.length > 0) {
      await prisma.processingItem.updateMany({
        where: { id: { in: episodeIds } },
        data: {
          downloadId: existing.id,
          status: isComplete ? ProcessingStatus.DOWNLOADED : ProcessingStatus.DOWNLOADING,
        },
      });
    }

    console.log(
      `[DownloadManager] Reusing existing download ${existing.id} for ${match.torrent.name}`
    );
    return existing;
  }

  // Create new Download record for existing torrent
  console.log(`[DownloadManager] Creating download from existing torrent:`, {
    hash: match.torrent.hash,
    name: match.torrent.name,
    hasName: !!match.torrent.name,
  });

  const download = await prisma.download.create({
    data: {
      torrentHash: match.torrent.hash,
      torrentName: match.torrent.name || match.torrent.hash,
      mediaType,
      status: isComplete ? DownloadStatus.COMPLETED : DownloadStatus.DOWNLOADING,
      progress: isComplete ? 100 : (match.torrent.progress ?? 0) * 100,
      size: match.torrent.size ? BigInt(match.torrent.size) : null,
      savePath: match.torrent.savePath || null,
      contentPath: match.torrent.contentPath || null,
      isSeasonPack: isSeasonPack || false,
      season: season || null,
      startedAt: new Date(),
      completedAt: isComplete ? new Date() : null,
      lastProgressAt: new Date(),
      seedCount: match.torrent.seeds ?? null,
      peerCount: match.torrent.peers ?? null,
      request: {
        connect: { id: requestId },
      },
    },
  });

  // Link TV episodes if provided
  if (episodeIds && episodeIds.length > 0) {
    await prisma.processingItem.updateMany({
      where: { id: { in: episodeIds } },
      data: {
        downloadId: download.id,
        status: isComplete ? ProcessingStatus.DOWNLOADED : ProcessingStatus.DOWNLOADING,
      },
    });
  }

  // Log event
  await logDownloadEvent(download.id, "created", {
    requestId,
    torrentName: match.torrent.name,
    torrentHash: match.torrent.hash,
    reusedExisting: true,
    wasComplete: isComplete,
  });

  console.log(
    `[DownloadManager] Created download ${download.id} from existing torrent ${match.torrent.name}`
  );
  return download;
}

// =============================================================================
// Download Health Monitoring
// =============================================================================

/**
 * Check health of all active downloads
 */
export async function checkDownloadHealth(): Promise<DownloadHealth[]> {
  const activeDownloads = await prisma.download.findMany({
    where: { status: DownloadStatus.DOWNLOADING },
  });

  if (activeDownloads.length === 0) {
    return [];
  }

  const qb = getDownloadService();
  const healthResults: DownloadHealth[] = [];

  // Fetch all torrents once instead of individual calls per download
  const allTorrents = await qb.getAllTorrents();
  const torrentMap = new Map(allTorrents.map((t) => [t.clientHash.toLowerCase(), t]));

  for (const download of activeDownloads) {
    const torrent = torrentMap.get(download.torrentHash.toLowerCase());

    if (!torrent) {
      // Torrent disappeared from qBittorrent
      healthResults.push({
        id: download.id,
        torrentHash: download.torrentHash,
        status: download.status,
        progress: download.progress,
        isStalled: true,
        hasSeeds: false,
        lastProgressAt: download.lastProgressAt,
        stalledMinutes: Infinity,
        recommendation: "retry",
      });
      continue;
    }

    const now = new Date();
    const lastProgressAt = download.lastProgressAt || download.startedAt || download.createdAt;
    const stalledMinutes = (now.getTime() - lastProgressAt.getTime()) / (60 * 1000);

    // Check for stalled conditions
    const isStalled =
      stalledMinutes > config.stalledTimeoutMinutes ||
      (torrent.seeds === 0 && stalledMinutes > config.noSeedsTimeoutMinutes);

    const hasSeeds = torrent.seeds > 0;

    // Determine recommendation
    let recommendation: "continue" | "retry" | "fail" = "continue";

    if (isStalled) {
      // Check if we have alternatives to try
      const hasAlternatives =
        download.alternativeReleases &&
        Array.isArray(download.alternativeReleases) &&
        download.alternativeReleases.length > 0;

      if (hasAlternatives && download.attemptCount < config.maxAttempts) {
        recommendation = "retry";
      } else {
        recommendation = "fail";
      }
    }

    // Update progress tracking if progress has changed
    if (torrent.progress > download.progress) {
      await prisma.download.update({
        where: { id: download.id },
        data: {
          progress: torrent.progress,
          lastProgressAt: now,
          seedCount: torrent.seeds,
          peerCount: torrent.peers,
          savePath: torrent.savePath,
          contentPath: torrent.contentPath,
        },
      });
    }

    healthResults.push({
      id: download.id,
      torrentHash: download.torrentHash,
      status: download.status,
      progress: torrent.progress,
      isStalled,
      hasSeeds,
      lastProgressAt,
      stalledMinutes,
      recommendation,
    });
  }

  return healthResults;
}

/**
 * Get overall system health
 */
export async function getSystemHealth(): Promise<SystemHealth> {
  const qb = getDownloadService();

  // Test qBittorrent connection
  const qbTest = await qb.testConnection();

  // Count downloads by status
  const activeDownloads = await prisma.download.count({
    where: { status: DownloadStatus.DOWNLOADING },
  });

  const stalledDownloads = await prisma.download.count({
    where: { status: DownloadStatus.STALLED },
  });

  // Find orphaned downloads (in DB but missing from qBittorrent)
  const dbDownloads = await prisma.download.findMany({
    where: { status: { in: [DownloadStatus.DOWNLOADING, DownloadStatus.PENDING] } },
    select: { torrentHash: true },
  });

  const qbTorrents = await qb.getAllTorrents();
  const qbHashes = new Set(qbTorrents.map((t) => t.hash));

  const orphanedDownloads = dbDownloads.filter(
    (d: (typeof dbDownloads)[number]) => !qbHashes.has(d.torrentHash)
  ).length;

  // Disk space check (simplified - would need actual disk check in production)
  const diskSpaceFreeGB = 100; // Placeholder
  const diskSpaceOk = diskSpaceFreeGB > 10;

  return {
    qbittorrentConnected: qbTest.success,
    qbittorrentVersion: qbTest.version,
    diskSpaceFreeGB,
    diskSpaceOk,
    activeDownloads,
    stalledDownloads,
    orphanedDownloads,
  };
}

// =============================================================================
// Retry and Recovery
// =============================================================================

/**
 * Retry a failed/stalled download with the next alternative release
 */
export async function retryWithAlternative(downloadId: string): Promise<Download | null> {
  const download = await prisma.download.findUnique({
    where: { id: downloadId },
  });

  if (!download) {
    console.error(`[DownloadManager] Download not found: ${downloadId}`);
    return null;
  }

  const alternatives = download.alternativeReleases as IndexerRelease[] | null;
  if (!alternatives || alternatives.length === 0) {
    console.error(`[DownloadManager] No alternative releases for download ${downloadId}`);
    return null;
  }

  // Get next alternative
  const nextRelease = alternatives[0];
  const remainingAlternatives = alternatives.slice(1);

  console.log(`[DownloadManager] Retrying download ${downloadId} with: ${nextRelease.title}`);

  // Get the client for this download
  const clientManager = getDownloadClientManager();
  let client = download.downloadClientId
    ? clientManager.getClient(download.downloadClientId)
    : null;

  // If no client or client unavailable, select new client based on release type
  if (!client) {
    const selection = clientManager.selectClientForRelease(nextRelease);
    if (!selection) {
      console.error(`[DownloadManager] No compatible client for alternative: ${nextRelease.title}`);
      await prisma.download.update({
        where: { id: downloadId },
        data: {
          status: DownloadStatus.FAILED,
          failureReason: "No compatible download client for alternative release",
        },
      });
      return null;
    }
    client = selection.client;
  }

  // Remove old download from client
  if (download.clientHash) {
    await client.deleteDownload(download.clientHash, false); // Don't delete files yet
  }

  // Log retry event
  await logDownloadEvent(downloadId, "retried", {
    previousRelease: download.torrentName,
    newRelease: nextRelease.title,
    attemptCount: download.attemptCount + 1,
  });

  // Add new download
  const magnetUri = nextRelease.magnetUri;
  const downloadUrl = nextRelease.downloadUrl;

  if (!magnetUri && !downloadUrl) {
    console.error(`[DownloadManager] No download URL for alternative: ${nextRelease.title}`);
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: DownloadStatus.FAILED,
        failureReason: "No download URL for alternative release",
      },
    });
    return null;
  }

  const tag = `request:${download.requestId}`;
  // biome-ignore lint/style/noNonNullAssertion: checked above
  const addResult = await client.addDownload(magnetUri || downloadUrl!, undefined, {
    category: "annex",
    tags: [tag],
  });

  if (!addResult.success || !addResult.clientHash) {
    console.error(`[DownloadManager] Failed to add alternative: ${addResult.error}`);
    // Try next alternative recursively
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        alternativeReleases: JSON.parse(JSON.stringify(remainingAlternatives)),
        attemptCount: download.attemptCount + 1,
      },
    });
    return retryWithAlternative(downloadId);
  }

  const clientHash = addResult.clientHash;

  // Update download record
  const updated = await prisma.download.update({
    where: { id: downloadId },
    data: {
      torrentHash: clientHash, // Keep for backward compatibility
      clientHash,
      torrentName: nextRelease.title,
      magnetUri: magnetUri || null,
      status: DownloadStatus.DOWNLOADING,
      progress: 0,
      error: null,
      failureReason: null,
      attemptCount: download.attemptCount + 1,
      lastAttemptAt: new Date(),
      lastProgressAt: new Date(),
      alternativeReleases: JSON.parse(JSON.stringify(remainingAlternatives)),
    },
  });

  return updated;
}

/**
 * Handle a stalled download
 */
export async function handleStalledDownload(downloadId: string, reason: string): Promise<void> {
  const download = await prisma.download.findUnique({
    where: { id: downloadId },
  });

  if (!download) return;

  // Log stalled event
  await logDownloadEvent(downloadId, "stalled", {
    reason,
    lastProgress: download.progress,
  });

  // Check if we can retry
  const alternatives = download.alternativeReleases as IndexerRelease[] | null;
  const canRetry =
    alternatives && alternatives.length > 0 && download.attemptCount < config.maxAttempts;

  if (canRetry) {
    await prisma.download.update({
      where: { id: downloadId },
      data: { status: DownloadStatus.STALLED },
    });
    await retryWithAlternative(downloadId);
  } else {
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: DownloadStatus.FAILED,
        failureReason: reason,
      },
    });

    // Update linked episodes
    await prisma.processingItem.updateMany({
      where: { downloadId },
      data: {
        status: ProcessingStatus.FAILED,
        lastError: reason,
      },
    });

    await logDownloadEvent(downloadId, "failed", {
      reason,
      attemptCount: download.attemptCount,
    });
  }
}

// =============================================================================
// Cleanup and Lifecycle
// =============================================================================

/**
 * Clean up a completed download after all processing is done
 */
export async function cleanupDownload(downloadId: string): Promise<void> {
  const download = await prisma.download.findUnique({
    where: { id: downloadId },
  });

  if (!download) return;

  // Get the client for this download
  const clientManager = getDownloadClientManager();
  const client = download.downloadClientId
    ? clientManager.getClient(download.downloadClientId)
    : getDownloadService(); // Fallback to legacy qBittorrent

  if (!client) {
    console.error(`[DownloadManager] No client found for download ${downloadId}`);
    return;
  }

  const clientHash = download.clientHash || download.torrentHash;
  const progress = await client.getProgress(clientHash);

  if (!progress) {
    // Already removed
    await prisma.download.update({
      where: { id: downloadId },
      data: { status: DownloadStatus.CLEANED },
    });
    return;
  }

  // Check seeding requirements
  const seedTimeMet =
    download.completedAt &&
    Date.now() - download.completedAt.getTime() > config.minSeedTimeMinutes * 60 * 1000;

  const seedRatioMet = progress.ratio >= config.minSeedRatio;

  if (!seedTimeMet && !seedRatioMet) {
    console.log(
      `[DownloadManager] Download ${downloadId} still seeding (ratio: ${progress.ratio.toFixed(2)})`
    );
    return;
  }

  // Check if all linked content is processed
  if (download.mediaType === MediaType.TV) {
    const unprocessedEpisodes = await prisma.processingItem.count({
      where: {
        downloadId,
        type: "EPISODE",
        status: { notIn: [ProcessingStatus.COMPLETED, ProcessingStatus.CANCELLED] },
      },
    });

    if (unprocessedEpisodes > 0) {
      console.log(
        `[DownloadManager] Download ${downloadId} has ${unprocessedEpisodes} unprocessed episodes`
      );
      return;
    }
  }

  // Remove from download client
  if (!config.keepInQbittorrent) {
    await client.deleteDownload(clientHash, config.deleteSourceAfterEncode);
  }

  // Update database
  await prisma.download.update({
    where: { id: downloadId },
    data: { status: DownloadStatus.CLEANED },
  });

  // Log event
  await logDownloadEvent(downloadId, "cleaned", {
    deletedFiles: config.deleteSourceAfterEncode,
    seedTime: download.completedAt
      ? (Date.now() - download.completedAt.getTime()) / (60 * 1000)
      : 0,
    ratio: progress.ratio,
  });

  console.log(`[DownloadManager] Cleaned up download ${downloadId}`);
}

/**
 * Reconcile database state with qBittorrent on startup
 */
export async function reconcileOnStartup(): Promise<{
  recovered: number;
  orphaned: number;
  completed: number;
}> {
  console.log("[DownloadManager] Running startup reconciliation...");

  const qb = getDownloadService();

  // Test connection first
  const connected = await qb.testConnection();
  if (!connected.success) {
    console.error("[DownloadManager] Cannot connect to qBittorrent");
    return { recovered: 0, orphaned: 0, completed: 0 };
  }

  // Get all torrents from qBittorrent
  const qbTorrents = await qb.getAllTorrents();
  const qbHashMap = new Map(qbTorrents.map((t) => [t.hash, t]));

  // Get all active downloads from database
  const dbDownloads = await prisma.download.findMany({
    where: { status: { in: [DownloadStatus.PENDING, DownloadStatus.DOWNLOADING] } },
  });

  let recovered = 0;
  let orphaned = 0;
  let completed = 0;

  for (const download of dbDownloads) {
    const torrent = qbHashMap.get(download.torrentHash);

    if (!torrent) {
      // Torrent missing from qBittorrent
      if (download.magnetUri) {
        // Try to re-add
        console.log(`[DownloadManager] Re-adding missing torrent: ${download.torrentName}`);
        const addResult = await qb.addMagnet(download.magnetUri, {
          category: "annex",
          tags: [`request:${download.requestId}`],
        });

        if (addResult.success) {
          recovered++;
          await logDownloadEvent(download.id, "recovered", { method: "re-added from magnet" });
        } else {
          orphaned++;
          await prisma.download.update({
            where: { id: download.id },
            data: {
              status: DownloadStatus.FAILED,
              failureReason: "Torrent disappeared from qBittorrent and could not be re-added",
            },
          });
        }
      } else {
        orphaned++;
        await prisma.download.update({
          where: { id: download.id },
          data: {
            status: DownloadStatus.FAILED,
            failureReason: "Torrent disappeared from qBittorrent (no magnet URI to re-add)",
          },
        });
      }
    } else if (torrent.isComplete && download.status === DownloadStatus.DOWNLOADING) {
      // Torrent completed while we weren't watching
      console.log(`[DownloadManager] Download ${download.id} completed while offline`);
      completed++;

      await prisma.download.update({
        where: { id: download.id },
        data: {
          status: DownloadStatus.COMPLETED,
          progress: 100,
          completedAt: new Date(),
          savePath: torrent.savePath,
          contentPath: torrent.contentPath,
        },
      });

      await logDownloadEvent(download.id, "completed", {
        savePath: torrent.savePath,
        contentPath: torrent.contentPath,
        size: torrent.totalBytes,
      });

      // Update linked episodes
      await prisma.processingItem.updateMany({
        where: { downloadId: download.id },
        data: { status: ProcessingStatus.DOWNLOADED },
      });
    }
  }

  console.log(
    `[DownloadManager] Reconciliation complete: ${recovered} recovered, ${orphaned} orphaned, ${completed} completed`
  );
  return { recovered, orphaned, completed };
}

// =============================================================================
// Event Logging
// =============================================================================

async function logDownloadEvent(
  downloadId: string,
  event: string,
  details: Record<string, unknown>
): Promise<void> {
  await prisma.downloadEvent.create({
    data: {
      downloadId,
      event,
      details: JSON.parse(JSON.stringify(details)),
    },
  });
}

// =============================================================================
// Exports
// =============================================================================

export const downloadManager = {
  // Configuration
  getConfig: getDownloadConfig,
  setConfig: setDownloadConfig,

  // Title parsing
  normalizeTitle,
  parseTorrentName,

  // qBittorrent matching
  findExistingMovieDownload,
  findExistingSeasonDownload,
  findExistingEpisodeDownload,

  // Release scoring
  scoreRelease,
  rankReleases,
  getDefaultQualityProfile,
  getQualityProfile,

  // Download operations
  createDownload,
  createDownloadFromExisting,

  // Health monitoring
  checkDownloadHealth,
  getSystemHealth,

  // Retry and recovery
  retryWithAlternative,
  handleStalledDownload,

  // Cleanup
  cleanupDownload,
  reconcileOnStartup,
};
