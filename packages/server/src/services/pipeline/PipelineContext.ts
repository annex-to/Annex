// Pipeline Context - Shared data structure passed between pipeline steps
// Accumulates data as the pipeline executes, allowing steps to access results from previous steps

import type { MediaType } from "@prisma/client";

export interface PipelineContext {
  // Request details
  requestId: string;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  year: number;

  // TV-specific fields
  requestedSeasons?: number[];
  requestedEpisodes?: Array<{ season: number; episode: number }>;

  // Target servers with optional encoding profile overrides
  targets: Array<{
    serverId: string;
    encodingProfileId?: string;
  }>;

  // Processing metadata for deterministic file naming across retries
  processingItemId?: string;

  // Step outputs (accumulated as pipeline executes)
  search?: {
    selectedRelease?: {
      title: string;
      size: number;
      seeders: number;
      leechers?: number;
      indexer: string;
      indexerName?: string;
      magnetUri: string;
      publishDate?: string;
      quality?: string;
      source?: string;
      codec?: string;
      resolution?: string;
    };
    selectedPacks?: Array<{
      title: string;
      size: number;
      seeders: number;
      leechers?: number;
      indexer: string;
      indexerName?: string;
      magnetUri: string;
      publishDate?: string;
      quality?: string;
      source?: string;
      codec?: string;
      resolution?: string;
      season?: number;
    }>;
    bulkDownloadsForSeasonPacks?: Record<number, string>; // Maps season number to BulkDownload.id
    alternativeReleases?: unknown[];
    qualityMet?: boolean;
    existingDownload?: {
      torrentHash: string;
      isComplete: boolean;
    };
  };

  download?: {
    torrentHash: string;
    sourceFilePath?: string; // For movies (single file)
    episodeFiles?: Array<{
      // For TV shows (multiple files from season pack)
      season: number;
      episode: number;
      path: string;
      size: number;
      episodeId: string; // TvEpisode.id for status tracking
    }>;
    contentPath?: string;
    size?: number;
  };

  encode?: {
    encodedFiles: Array<{
      profileId: string;
      path: string;
      targetServerIds: string[];
      resolution: string;
      codec: string;
      size?: number;
      compressionRatio?: number;
      // TV episode metadata (for episode-aware delivery)
      season?: number;
      episode?: number;
      episodeId?: string;
      episodeTitle?: string;
    }>;
  };

  deliver?: {
    deliveredServers: string[];
    failedServers?: Array<{
      serverId: string;
      error: string;
    }>;
  };

  approval?: {
    approvalId: string;
    status: "PENDING" | "APPROVED" | "REJECTED" | "SKIPPED" | "TIMEOUT";
    processedBy?: string;
    comment?: string;
  };

  notification?: {
    sent: boolean;
    provider?: string;
    error?: string;
  };

  // Additional metadata that steps can store
  [key: string]: unknown;
}

export interface ConditionRule {
  field: string; // Context field path (e.g., "search.selectedRelease.quality")
  operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "not_in" | "contains" | "matches";
  value: unknown;
  logicalOp?: "AND" | "OR"; // For chaining multiple conditions
  conditions?: ConditionRule[]; // Nested conditions
}

export interface StepOutput {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  shouldSkip?: boolean; // If true, mark step as skipped and continue
  shouldPause?: boolean; // If true, pause execution (used by ApprovalStep)
  shouldRetry?: boolean; // If true, retry this step later
  nextStep?: string | null; // Hint for which step should execute next
}
