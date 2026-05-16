import { prisma } from "../../db/client";
import type { Resolution } from "../../types/download";
import { getIndexerService, type Release } from "../indexer";
import { rankReleasesWithQualityFilter } from "../qualityService";
import { dedupeReleases } from "./dedupe";
import { categorizeReleases } from "./packDetection";
import type { PlannerItem, PlanResult, SeasonPlan } from "./types";

export interface PlanForRequestInput {
  requestId: string;
  requiredResolution: Resolution;
  minSeeders?: number;
}

/**
 * Plan the search for a TV request.
 *
 * For each requested season:
 *   1. Issue one indexer query (passes tmdbId/imdbId/tvdbId where supported)
 *   2. Dedupe by infohash
 *   3. Categorize releases into season-packs and per-episode
 *   4. If a pack meets the quality bar, assign it to every PI in the season
 *   5. Otherwise, fall back to per-episode releases
 *   6. Write the chosen release into each PI's stepContext.selectedRelease
 *
 * Returns a PlanResult describing what was found and what wasn't.
 */
export async function planForRequest(input: PlanForRequestInput): Promise<PlanResult> {
  const { requestId, requiredResolution, minSeeders = 1 } = input;

  const request = await prisma.mediaRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { id: true, tmdbId: true, title: true, year: true, type: true },
  });

  if (request.type !== "TV") {
    throw new Error(`planForRequest is TV-only; got ${request.type}`);
  }

  const items = await prisma.processingItem.findMany({
    where: {
      requestId,
      type: "EPISODE",
      status: { in: ["PENDING", "SEARCHING", "FOUND", "DISCOVERED"] },
    },
    select: { id: true, season: true, episode: true, status: true },
  });

  const plannerItems: PlannerItem[] = items
    .filter(
      (i: { season: number | null; episode: number | null }) =>
        i.season !== null && i.episode !== null
    )
    .map((i: { id: string; season: number | null; episode: number | null; status: string }) => ({
      id: i.id,
      season: i.season as number,
      episode: i.episode as number,
      status: i.status,
    }));

  const bySeasonId = groupBy(plannerItems, (i) => i.season);
  const indexer = getIndexerService();
  let totalQueries = 0;

  const mediaItem = request.tmdbId
    ? await prisma.mediaItem.findUnique({
        where: { id: `tv:${request.tmdbId}` },
        select: { imdbId: true },
      })
    : null;

  const seasons: SeasonPlan[] = [];

  for (const [season, itemsInSeason] of bySeasonId.entries()) {
    totalQueries += 1;
    const searchResult = await indexer.searchTvSeason({
      tmdbId: request.tmdbId,
      imdbId: mediaItem?.imdbId ?? undefined,
      title: request.title,
      year: request.year ?? undefined,
      season,
    });

    const deduped = dedupeReleases(searchResult.releases);
    const yearFiltered = filterByYearWhenPresent(deduped, request.year);
    const seederFiltered = yearFiltered.filter((r) => r.seeders >= minSeeders);
    const categorized = categorizeReleases(seederFiltered, season);

    const plan: SeasonPlan = {
      season,
      perEpisode: new Map(),
      unmatchedEpisodes: [],
      alternatives: seederFiltered,
    };

    // Step 1: season pack wins if any meets the quality bar
    const packCandidates = rankReleasesWithQualityFilter(categorized.packs, requiredResolution);
    if (packCandidates.matching.length > 0) {
      plan.pack = packCandidates.matching[0].release as Release;
      const chosenPack = plan.pack;
      for (const item of itemsInSeason) {
        await assignReleaseToItem(item.id, chosenPack);
      }
      seasons.push(plan);
      continue;
    }

    // Step 2: per-episode fallback
    for (const item of itemsInSeason) {
      const candidates = categorized.perEpisode.get(item.episode) ?? [];
      const ranked = rankReleasesWithQualityFilter(candidates, requiredResolution);
      const chosen = ranked.matching[0]?.release as Release | undefined;
      if (chosen) {
        plan.perEpisode.set(item.episode, chosen);
        await assignReleaseToItem(item.id, chosen);
      } else {
        plan.unmatchedEpisodes.push(item.episode);
        const alts = [
          ...ranked.belowQuality.map((b: { release: unknown }) => b.release as Release),
          ...ranked.rejected.map((b: { release: unknown }) => b.release as Release),
        ];
        await markItemQualityUnavailable(item.id, alts);
      }
    }

    seasons.push(plan);
  }

  return { requestId, seasons, totalQueries };
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k)?.push(item);
  }
  return out;
}

/**
 * If we know the show's year, filter out releases that parse to a different year.
 * Helps disambiguate "The Office (2005)" from "The Office (2001)".
 */
function filterByYearWhenPresent<T extends { title: string }>(releases: T[], year: number | null) {
  if (!year) return releases;
  const yearRe = /\b(19\d{2}|20\d{2})\b/g;
  return releases.filter((r) => {
    const matches = Array.from(r.title.matchAll(yearRe)).map((m) => Number.parseInt(m[1], 10));
    if (matches.length === 0) return true;
    return matches.some((y) => y === year);
  });
}

async function assignReleaseToItem(
  itemId: string,
  release: import("../indexer").Release
): Promise<void> {
  const existing = await prisma.processingItem.findUnique({
    where: { id: itemId },
    select: { stepContext: true },
  });
  const stepContext = (existing?.stepContext as Record<string, unknown> | null) ?? {};
  await prisma.processingItem.update({
    where: { id: itemId },
    data: {
      stepContext: {
        ...stepContext,
        selectedRelease: release as unknown as import("@prisma/client").Prisma.JsonObject,
        qualityMet: true,
      } as import("@prisma/client").Prisma.InputJsonValue,
    },
  });
}

async function markItemQualityUnavailable(
  itemId: string,
  alternatives: import("../indexer").Release[]
): Promise<void> {
  const existing = await prisma.processingItem.findUnique({
    where: { id: itemId },
    select: { stepContext: true },
  });
  const stepContext = (existing?.stepContext as Record<string, unknown> | null) ?? {};
  await prisma.processingItem.update({
    where: { id: itemId },
    data: {
      stepContext: {
        ...stepContext,
        qualityMet: false,
        alternativeReleases: alternatives as unknown as import("@prisma/client").Prisma.JsonArray,
      } as import("@prisma/client").Prisma.InputJsonValue,
    },
  });
}
