/**
 * Media request types
 */

import type { MediaType } from "./media.js";

export type RequestStatus =
  | "pending"
  | "searching"
  | "awaiting"
  | "quality_unavailable"
  | "downloading"
  | "encoding"
  | "delivering"
  | "completed"
  | "failed";

export interface EpisodeRequest {
  season: number;
  episode: number;
}

export interface MediaRequest {
  id: string;
  type: MediaType;
  tmdbId: number;
  title: string;
  year: number;
  // TV-specific
  requestedSeasons: number[] | null;
  requestedEpisodes: EpisodeRequest[] | null;
  // Target servers
  targetServers: string[];
  // Status
  status: RequestStatus;
  progress: number; // 0-100
  currentStep: string | null; // Human-readable current action
  error: string | null;
  // Quality requirements
  requiredResolution: string | null; // e.g., "2160p", "1080p"
  availableReleases: AvailableRelease[] | null; // Lower-quality alternatives
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CreateMovieRequest {
  tmdbId: number;
  targetServers: string[];
}

export interface CreateTvRequest {
  tmdbId: number;
  targetServers: string[];
  seasons?: number[]; // Specific seasons, or omit for all
  episodes?: EpisodeRequest[]; // Specific episodes
}

export interface RequestProgress {
  requestId: string;
  status: RequestStatus;
  progress: number;
  currentStep: string | null;
  error: string | null;
}

export interface ActivityLogEntry {
  id: string;
  requestId: string | null;
  type: "info" | "warning" | "error" | "success";
  message: string;
  details: Record<string, unknown> | null;
  timestamp: Date;
}

export interface QueueItem {
  requestId: string;
  title: string;
  type: MediaType;
  status: RequestStatus;
  progress: number;
  position: number;
}

/**
 * A release that was found but doesn't meet quality requirements
 */
export interface AvailableRelease {
  title: string;
  resolution: string;
  source: string;
  codec: string;
  size: number;
  seeders: number;
  leechers: number;
  score: number;
  downloadUrl?: string;
  magnetUri?: string;
  indexerName: string;
}
