/**
 * Download System Types
 *
 * Comprehensive type definitions for the download management system.
 */

import type { Download, MediaType, DownloadStatus, TvEpisode } from "@prisma/client";

// =============================================================================
// parse-torrent-title types (no @types package available)
// =============================================================================

export interface ParsedTorrent {
  title?: string;
  year?: number;
  season?: number;
  episode?: number | number[]; // Can be array for multi-episode files
  resolution?: string;
  source?: string;
  codec?: string;
  group?: string;
  audio?: string;
  container?: string;
  language?: string;
  hdr?: string[];
  proper?: boolean;
  repack?: boolean;
  extended?: boolean;
  hardcoded?: boolean;
  date?: string;
}

// =============================================================================
// Configuration Types
// =============================================================================

export interface DownloadConfig {
  // Retry settings
  maxAttempts: number;           // Max releases to try before giving up
  backoffMinutes: number[];      // Wait between attempts [5, 15, 60]

  // Health check thresholds
  stalledTimeoutMinutes: number; // No progress for this long = stalled
  noSeedsTimeoutMinutes: number; // 0 seeds for this long = give up
  minDownloadSpeedKBps: number;  // Below this for extended time = slow
  slowDownloadTimeoutMinutes: number;

  // Concurrency
  maxConcurrentDownloads: number;
  maxDownloadsPerRequest: number;

  // Cleanup settings
  minSeedTimeMinutes: number;    // Seed for at least this long
  minSeedRatio: number;          // Or until this ratio reached
  deleteSourceAfterEncode: boolean;
  deleteSourceAfterDays: number;
  keepInQbittorrent: boolean;
}

export const DEFAULT_DOWNLOAD_CONFIG: DownloadConfig = {
  maxAttempts: 3,
  backoffMinutes: [5, 15, 60],

  stalledTimeoutMinutes: 30,
  noSeedsTimeoutMinutes: 10,
  minDownloadSpeedKBps: 10,
  slowDownloadTimeoutMinutes: 60,

  maxConcurrentDownloads: 5,
  maxDownloadsPerRequest: 2,

  minSeedTimeMinutes: 60,
  minSeedRatio: 1.0,
  deleteSourceAfterEncode: true,
  deleteSourceAfterDays: 7,
  keepInQbittorrent: false,
};

// =============================================================================
// Quality Profile Types
// =============================================================================

export interface QualityProfileConfig {
  id: string;
  name: string;

  // Resolution preferences (in order of preference)
  preferredResolutions: Resolution[];
  minResolution: Resolution;

  // Source preferences (in order of preference)
  preferredSources: Source[];

  // Codec preferences
  preferredCodecs: Codec[];

  // Size limits
  minSizeGB: number | null;
  maxSizeGB: number | null;

  // Release group preferences
  preferredGroups: string[];
  bannedGroups: string[];

  // Upgrade settings
  allowUpgrades: boolean;
  upgradeUntilResolution: Resolution | null;
}

export type Resolution = "2160p" | "1080p" | "720p" | "480p";
export type Source = "BluRay" | "Remux" | "WEB-DL" | "WEBRip" | "HDTV" | "DVDRip" | "BDRip";
export type Codec = "x265" | "HEVC" | "x264" | "AV1" | "VP9" | "MPEG";

export const RESOLUTION_RANK: Record<Resolution, number> = {
  "2160p": 4,
  "1080p": 3,
  "720p": 2,
  "480p": 1,
};

export const DEFAULT_QUALITY_PROFILES: QualityProfileConfig[] = [
  {
    id: "hd-1080p",
    name: "HD-1080p",
    preferredResolutions: ["1080p", "720p"],
    minResolution: "720p",
    preferredSources: ["BluRay", "WEB-DL", "WEBRip"],
    preferredCodecs: ["x265", "x264"],
    minSizeGB: 1,
    maxSizeGB: 20,
    preferredGroups: [],
    bannedGroups: ["YIFY", "YTS", "SPARKS"],
    allowUpgrades: true,
    upgradeUntilResolution: "1080p",
  },
  {
    id: "4k-ultra",
    name: "4K Ultra",
    preferredResolutions: ["2160p", "1080p"],
    minResolution: "1080p",
    preferredSources: ["Remux", "BluRay", "WEB-DL"],
    preferredCodecs: ["x265", "AV1"],
    minSizeGB: 5,
    maxSizeGB: 80,
    preferredGroups: [],
    bannedGroups: ["YIFY", "YTS"],
    allowUpgrades: true,
    upgradeUntilResolution: "2160p",
  },
  {
    id: "any",
    name: "Any Quality",
    preferredResolutions: ["1080p", "720p", "2160p", "480p"],
    minResolution: "480p",
    preferredSources: ["BluRay", "WEB-DL", "WEBRip", "HDTV", "DVDRip"],
    preferredCodecs: ["x265", "x264", "AV1"],
    minSizeGB: null,
    maxSizeGB: null,
    preferredGroups: [],
    bannedGroups: [],
    allowUpgrades: false,
    upgradeUntilResolution: null,
  },
];

// =============================================================================
// Torrent Matching Types
// =============================================================================

export interface TorrentInfo {
  hash: string;
  name: string;
  size: number;
  progress: number;        // 0-1
  downloadSpeed: number;   // bytes/sec
  uploadSpeed: number;     // bytes/sec
  seeds: number;
  peers: number;
  ratio: number;
  eta: number;             // seconds
  state: string;
  savePath: string;
  contentPath: string;
  addedOn: number;         // Unix timestamp
  completedOn: number;     // Unix timestamp
}

export interface TorrentMatch {
  torrent: TorrentInfo;
  parsed: ParsedTorrent;
  score: number;
}

export interface MatchResult {
  found: boolean;
  match?: TorrentMatch;
  isComplete: boolean;
}

// =============================================================================
// Release Types
// =============================================================================

export interface IndexerRelease {
  title: string;
  size: number;
  seeders: number;
  leechers: number;
  magnetUri?: string;
  downloadUrl?: string;
  indexer?: string;       // Optional - from internal types
  indexerName?: string;   // Optional - from Release type in indexer.ts
  indexerId?: string;     // Optional - from Release type in indexer.ts
  publishDate?: Date;
  resolution?: string;
  source?: string;
  codec?: string;
  group?: string;
}

export interface ScoredRelease {
  release: IndexerRelease;
  score: number;
  parsed: ParsedTorrent;
  rejectionReason?: string;
}

// =============================================================================
// Download Events
// =============================================================================

export type DownloadEventType =
  | "created"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "retried"
  | "stalled"
  | "recovered"
  | "cleaned"
  | "cancelled";

export interface DownloadEventData {
  created: { requestId: string; torrentName: string };
  started: { torrentHash: string };
  progress: { progress: number; speed: number; seeds: number };
  completed: { savePath: string; contentPath: string; size: number };
  failed: { reason: string; attemptCount: number };
  retried: { previousRelease: string; newRelease: string; attemptCount: number };
  stalled: { reason: "no_seeds" | "no_progress" | "slow"; lastProgress: number };
  recovered: { method: string };
  cleaned: { deletedFiles: boolean; seedTime: number; ratio: number };
  cancelled: { reason: string };
}

// =============================================================================
// Health Check Types
// =============================================================================

export interface DownloadHealth {
  id: string;
  torrentHash: string;
  status: DownloadStatus;
  progress: number;
  isStalled: boolean;
  hasSeeds: boolean;
  lastProgressAt: Date | null;
  stalledMinutes: number;
  recommendation: "continue" | "retry" | "fail";
}

export interface SystemHealth {
  qbittorrentConnected: boolean;
  qbittorrentVersion?: string;
  diskSpaceFreeGB: number;
  diskSpaceOk: boolean;
  activeDownloads: number;
  stalledDownloads: number;
  orphanedDownloads: number;
}

// =============================================================================
// Download Manager Types
// =============================================================================

export interface CreateDownloadParams {
  requestId: string;
  mediaType: MediaType;
  release: IndexerRelease;
  alternativeReleases?: IndexerRelease[];
  isSeasonPack?: boolean;
  season?: number;
  episodeIds?: string[]; // TvEpisode IDs to link
}

export interface DownloadWithEpisodes extends Download {
  tvEpisodes: TvEpisode[];
}

export interface DownloadManagerCallbacks {
  onProgress?: (download: Download, progress: number, speed: number) => Promise<void>;
  onComplete?: (download: Download) => Promise<void>;
  onFailed?: (download: Download, error: string) => Promise<void>;
  onStalled?: (download: Download) => Promise<void>;
}
