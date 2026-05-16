import type { Release } from "../indexer";

export interface PlannerItem {
  id: string;
  season: number;
  episode: number;
  status: string;
}

export interface SeasonPlan {
  season: number;
  pack?: Release;
  perEpisode: Map<number, Release>;
  unmatchedEpisodes: number[];
  alternatives: Release[];
}

export interface PlanResult {
  requestId: string;
  seasons: SeasonPlan[];
  totalQueries: number;
}
