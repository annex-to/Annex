/**
 * Quality Service
 *
 * Handles quality requirements derivation from target servers and
 * filtering releases by quality thresholds.
 */

import type { Resolution as PrismaResolution } from "@prisma/client";
import { prisma } from "../db/client.js";
import type {
  IndexerRelease,
  QualityProfileConfig,
  Resolution,
  ScoredRelease,
} from "../types/download.js";
import { DEFAULT_QUALITY_PROFILES, RESOLUTION_RANK } from "../types/download.js";
import { scoreRelease } from "./downloadManager.js";
import type { Release } from "./indexer.js";

// =============================================================================
// Resolution Utilities
// =============================================================================

/**
 * Map Prisma Resolution enum to our internal Resolution type
 */
const PRISMA_RESOLUTION_MAP: Record<PrismaResolution, Resolution> = {
  RES_4K: "2160p",
  RES_2K: "1080p", // 2K treated as 1080p for source requirements
  RES_1080P: "1080p",
  RES_720P: "720p",
  RES_480P: "480p",
};

/**
 * Parse resolution string from various formats
 */
export function parseResolution(str: string | undefined | null): Resolution | null {
  if (!str) return null;

  const normalized = str.toLowerCase();

  if (normalized.includes("2160") || normalized.includes("4k") || normalized.includes("uhd")) {
    return "2160p";
  }
  if (normalized.includes("1080")) {
    return "1080p";
  }
  if (normalized.includes("720")) {
    return "720p";
  }
  if (normalized.includes("480") || normalized.includes("sd")) {
    return "480p";
  }

  return null;
}

/**
 * Check if a release resolution meets the required minimum
 */
export function resolutionMeetsRequirement(
  releaseResolution: string | undefined | null,
  requiredResolution: Resolution
): boolean {
  const parsed = parseResolution(releaseResolution);
  if (!parsed) return false;

  const releaseRank = RESOLUTION_RANK[parsed];
  const requiredRank = RESOLUTION_RANK[requiredResolution];

  return releaseRank >= requiredRank;
}

/**
 * Get human-readable resolution name
 */
export function getResolutionLabel(resolution: Resolution): string {
  switch (resolution) {
    case "2160p":
      return "4K";
    case "1080p":
      return "1080p";
    case "720p":
      return "720p";
    case "480p":
      return "480p";
    default:
      return resolution;
  }
}

// =============================================================================
// Quality Derivation
// =============================================================================

export interface RequestTarget {
  serverId: string;
  encodingProfileId?: string;
}

/**
 * Derive the minimum required resolution from target servers.
 *
 * Returns the HIGHEST maxResolution among all targets. This is because
 * we need the source quality to be at least as high as the highest target
 * output - we can't upscale 1080p to 4K meaningfully.
 */
export async function deriveRequiredResolution(targets: RequestTarget[]): Promise<Resolution> {
  const serverIds = targets.map((t) => t.serverId);

  const servers = await prisma.storageServer.findMany({
    where: { id: { in: serverIds } },
    select: { maxResolution: true },
  });

  // Find the highest resolution among targets
  let highest: Resolution = "480p";
  let highestRank = 0;

  for (const server of servers) {
    const maxRes = server.maxResolution as keyof typeof PRISMA_RESOLUTION_MAP;
    const res = PRISMA_RESOLUTION_MAP[maxRes] || ("480p" as Resolution);
    const rank = RESOLUTION_RANK[res as Resolution];
    if (rank > highestRank) {
      highestRank = rank;
      highest = res;
    }
  }

  return highest;
}

/**
 * Get required resolution for an existing request by looking up its targets
 */
export async function getRequiredResolutionForRequest(
  requestId: string
): Promise<Resolution | null> {
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { targets: true, requiredResolution: true },
  });

  if (!request) return null;

  // If already calculated, return it
  if (request.requiredResolution) {
    return request.requiredResolution as Resolution;
  }

  // Otherwise, calculate from targets
  const targets = (request.targets as unknown as RequestTarget[]) || [];
  if (targets.length === 0) return "480p";

  return deriveRequiredResolution(targets);
}

// =============================================================================
// Quality Filtering
// =============================================================================

export interface QualityFilterResult {
  /** Releases that meet quality requirements */
  matching: Release[];
  /** Releases below quality threshold (alternatives) */
  belowQuality: Release[];
}

/**
 * Filter releases by quality requirement.
 *
 * Separates releases into those that meet the quality threshold and those
 * that don't (but could be used as alternatives if user accepts lower quality).
 */
export function filterReleasesByQuality(
  releases: Release[],
  requiredResolution: Resolution
): QualityFilterResult {
  const matching: Release[] = [];
  const belowQuality: Release[] = [];

  for (const release of releases) {
    if (resolutionMeetsRequirement(release.resolution, requiredResolution)) {
      matching.push(release);
    } else {
      belowQuality.push(release);
    }
  }

  return { matching, belowQuality };
}

/**
 * Filter and rank releases with quality awareness.
 *
 * Returns both matching releases (ranked by quality profile) and
 * below-quality alternatives (also ranked).
 */
export function rankReleasesWithQualityFilter(
  releases: Release[] | IndexerRelease[],
  requiredResolution: Resolution,
  topN: number = 5
): {
  matching: ScoredRelease[];
  belowQuality: ScoredRelease[];
  rejected: ScoredRelease[];
} {
  // Build a quality profile for the required resolution
  const profile = buildQualityProfile(requiredResolution);

  // Score all releases
  const scored: ScoredRelease[] = [];
  const rejected: ScoredRelease[] = [];
  for (const r of releases) {
    const indexerRelease = r as IndexerRelease;
    const result = scoreRelease(indexerRelease, profile);
    if (result.score >= 0) {
      scored.push(result);
    } else {
      rejected.push(result);
    }
  }

  // Split by quality
  const matching: ScoredRelease[] = [];
  const belowQuality: ScoredRelease[] = [];

  for (const scored_item of scored) {
    const releaseRes = parseResolution(
      scored_item.parsed.resolution || scored_item.release.resolution
    );
    if (releaseRes && resolutionMeetsRequirement(releaseRes, requiredResolution)) {
      matching.push(scored_item);
    } else {
      belowQuality.push(scored_item);
    }
  }

  // Sort both by score (descending)
  matching.sort((a, b) => b.score - a.score);
  belowQuality.sort((a, b) => b.score - a.score);
  rejected.sort((a, b) => b.score - a.score);

  return {
    matching: matching.slice(0, topN),
    belowQuality: belowQuality.slice(0, topN),
    rejected: rejected.slice(0, topN),
  };
}

// =============================================================================
// Dynamic Quality Profiles
// =============================================================================

/**
 * Build a quality profile based on required resolution.
 *
 * Creates a profile that:
 * - Sets minResolution to the required resolution
 * - Prefers resolutions at or above the required resolution
 * - Uses sensible defaults for other settings
 */
export function buildQualityProfile(requiredResolution: Resolution): QualityProfileConfig {
  // For 4K, use the 4k-ultra profile as base
  if (requiredResolution === "2160p") {
    const base = DEFAULT_QUALITY_PROFILES.find((p) => p.id === "4k-ultra");
    if (base) {
      return {
        ...base,
        id: `dynamic-${requiredResolution}`,
        name: `Dynamic ${requiredResolution}`,
        minResolution: requiredResolution,
      };
    }
  }

  // For other resolutions, start with hd-1080p and adjust
  // biome-ignore lint/style/noNonNullAssertion: hd-1080p profile is guaranteed to exist in defaults
  const base = DEFAULT_QUALITY_PROFILES.find((p) => p.id === "hd-1080p")!;

  // Build preferred resolutions - all resolutions at or above required
  const allResolutions: Resolution[] = ["2160p", "1080p", "720p", "480p"];
  const reqRank = RESOLUTION_RANK[requiredResolution];
  const preferredResolutions = allResolutions.filter((r) => RESOLUTION_RANK[r] >= reqRank);

  return {
    ...base,
    id: `dynamic-${requiredResolution}`,
    name: `Dynamic ${requiredResolution}`,
    minResolution: requiredResolution,
    preferredResolutions,
    upgradeUntilResolution: requiredResolution,
  };
}

/**
 * Get the appropriate quality profile for a request.
 *
 * First tries to get the required resolution from the request,
 * then builds a profile for that resolution.
 */
export async function getQualityProfileForRequest(
  requestId: string
): Promise<QualityProfileConfig> {
  const requiredRes = await getRequiredResolutionForRequest(requestId);
  if (!requiredRes) {
    // Fallback to default
    // biome-ignore lint/style/noNonNullAssertion: hd-1080p profile is guaranteed to exist in defaults
    return DEFAULT_QUALITY_PROFILES.find((p) => p.id === "hd-1080p")!;
  }
  return buildQualityProfile(requiredRes);
}

// =============================================================================
// Helpers for Pipeline
// =============================================================================

/**
 * Stored release format for JSON fields
 */
export interface StoredRelease {
  title: string;
  resolution?: string;
  source?: string;
  codec?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  score: number;
  downloadUrl?: string;
  magnetUri?: string;
  downloadHeaders?: Record<string, string>;
  indexerName?: string;
  indexerId?: string;
}

/**
 * Convert Release array to format suitable for storing in availableReleases JSON field
 */
export function releasesToStorageFormat(releases: Release[] | ScoredRelease[]): StoredRelease[] {
  return releases.map((r) => {
    const release = "release" in r ? r.release : r;
    const score = "score" in r ? r.score : 0;
    return {
      title: release.title,
      resolution: release.resolution,
      source: release.source,
      codec: release.codec,
      size: release.size,
      seeders: release.seeders,
      leechers: release.leechers,
      score,
      downloadUrl: release.downloadUrl,
      magnetUri: release.magnetUri,
      downloadHeaders: release.downloadHeaders,
      indexerName: release.indexerName,
      indexerId: release.indexerId,
    };
  });
}

/**
 * Get the best available resolution from a list of releases
 */
export function getBestAvailableResolution(releases: Release[]): string {
  let best: Resolution | null = null;
  let bestRank = 0;

  for (const release of releases) {
    const res = parseResolution(release.resolution);
    if (res) {
      const rank = RESOLUTION_RANK[res];
      if (rank > bestRank) {
        bestRank = rank;
        best = res;
      }
    }
  }

  return best || "unknown";
}
