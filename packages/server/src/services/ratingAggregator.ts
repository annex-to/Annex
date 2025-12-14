/**
 * Rating Aggregator Service
 *
 * Calculates aggregate scores from multiple rating sources.
 * Weights sources by reliability and vote counts.
 * Requires 2+ sources for "trusted" status.
 */

import { Prisma } from "@prisma/client";

interface RatingSource {
  field: keyof RatingData;
  voteField?: keyof RatingData;
  scale: 10 | 100; // Original scale
  weight: number; // Base weight for this source
  voteThreshold: number; // Min votes for full confidence
}

// Input rating data (subset of MediaRatings)
interface RatingData {
  tmdbScore?: number | null;
  tmdbVotes?: number | null;
  imdbScore?: number | null;
  imdbVotes?: number | null;
  rtCriticScore?: number | null;
  rtAudienceScore?: number | null;
  metacriticScore?: number | null;
  traktScore?: number | null;
  traktVotes?: number | null;
  letterboxdScore?: number | null;
}

export interface AggregateResult {
  aggregateScore: number | null;
  sourceCount: number;
  confidenceScore: number;
  isTrusted: boolean;
  aggregatedAt: Date;
}

// Rating sources with weights based on reliability and coverage
// IMDb: Largest user base, most consistent ratings
// Metacritic: Professional critics, curated
// RT Critics: Professional critics
// RT Audience: Verified audience
// Letterboxd: Film enthusiast community
// Trakt: Tech-savvy TV/movie watchers
// TMDB: Open community, varies in quality
const RATING_SOURCES: RatingSource[] = [
  {
    field: "imdbScore",
    voteField: "imdbVotes",
    scale: 10,
    weight: 1.5,
    voteThreshold: 10000,
  },
  {
    field: "metacriticScore",
    scale: 100,
    weight: 1.3,
    voteThreshold: 10,
  },
  {
    field: "rtCriticScore",
    scale: 100,
    weight: 1.2,
    voteThreshold: 50,
  },
  {
    field: "rtAudienceScore",
    scale: 100,
    weight: 1.0,
    voteThreshold: 100,
  },
  {
    field: "letterboxdScore",
    scale: 100,
    weight: 1.1,
    voteThreshold: 100,
  },
  {
    field: "traktScore",
    voteField: "traktVotes",
    scale: 100,
    weight: 0.9,
    voteThreshold: 1000,
  },
  {
    field: "tmdbScore",
    voteField: "tmdbVotes",
    scale: 10,
    weight: 0.7,
    voteThreshold: 500,
  },
];

/**
 * Calculate aggregate score from multiple rating sources
 */
export function calculateAggregateScore(ratings: RatingData): AggregateResult {
  let weightedSum = 0;
  let totalWeight = 0;
  let sourceCount = 0;
  let confidenceSum = 0;

  for (const source of RATING_SOURCES) {
    const score = ratings[source.field];

    // Skip null/undefined/zero scores
    if (score === null || score === undefined || score === 0) {
      continue;
    }

    // Normalize to 0-100 scale
    const normalizedScore = source.scale === 10 ? score * 10 : score;

    // Calculate vote-based confidence (0-1)
    let voteConfidence = 0.5; // Default if no vote count available
    if (source.voteField) {
      const votes = ratings[source.voteField];
      if (votes !== null && votes !== undefined && votes > 0) {
        voteConfidence = Math.min(1, votes / source.voteThreshold);
      }
    } else {
      // Sources without vote counts (RT, Metacritic) get moderate confidence
      voteConfidence = 0.7;
    }

    // Apply weight with vote confidence modifier
    // Base weight is scaled by 0.5 to 1.0 based on vote confidence
    const effectiveWeight = source.weight * (0.5 + 0.5 * voteConfidence);

    weightedSum += normalizedScore * effectiveWeight;
    totalWeight += effectiveWeight;
    confidenceSum += voteConfidence;
    sourceCount++;
  }

  // Calculate final aggregate
  const aggregateScore = totalWeight > 0 ? weightedSum / totalWeight : null;
  const confidenceScore = sourceCount > 0 ? confidenceSum / sourceCount : 0;
  const isTrusted = sourceCount >= 2;

  return {
    aggregateScore: aggregateScore !== null ? Math.round(aggregateScore * 10) / 10 : null,
    sourceCount,
    confidenceScore: Math.round(confidenceScore * 100) / 100,
    isTrusted,
    aggregatedAt: new Date(),
  };
}

/**
 * Get Prisma update data for aggregate fields
 */
export function getAggregateUpdateData(
  ratings: RatingData
): Prisma.MediaRatingsUpdateInput {
  const result = calculateAggregateScore(ratings);
  return {
    aggregateScore: result.aggregateScore,
    sourceCount: result.sourceCount,
    confidenceScore: result.confidenceScore,
    isTrusted: result.isTrusted,
    aggregatedAt: result.aggregatedAt,
  };
}
