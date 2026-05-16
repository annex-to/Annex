import type { Release } from "../indexer";

export interface ParsedReleaseEpisodes {
  season: number;
  episodes: number[]; // empty = full season pack; multiple = multi-ep file
}

/**
 * Detect what season/episodes a release covers from its title.
 * Returns null when the title doesn't parse to the requested season.
 */
export function parseEpisodesFromTitle(
  title: string,
  expectedSeason: number
): ParsedReleaseEpisodes | null {
  // Multi-season pack: "S01-S05" or "Complete.Series" with no single S##
  const range = title.match(/S(\d{1,2})\s*[-–]\s*S(\d{1,2})/i);
  if (range) {
    const lo = Number.parseInt(range[1], 10);
    const hi = Number.parseInt(range[2], 10);
    if (expectedSeason >= lo && expectedSeason <= hi) {
      return { season: expectedSeason, episodes: [] };
    }
    return null;
  }

  // Multi-episode: S01E01E02 or S01E01-E03 or S01E01-02
  const multi = title.match(/S(\d{1,2})E(\d{1,2})(?:[-E]+)(\d{1,2})/i);
  if (multi) {
    const season = Number.parseInt(multi[1], 10);
    const start = Number.parseInt(multi[2], 10);
    const end = Number.parseInt(multi[3], 10);
    if (season !== expectedSeason || end <= start) return null;
    const episodes: number[] = [];
    for (let i = start; i <= end; i++) episodes.push(i);
    return { season, episodes };
  }

  // Single episode: S01E01
  const single = title.match(/S(\d{1,2})E(\d{1,2})(?!\d)/i);
  if (single) {
    const season = Number.parseInt(single[1], 10);
    const episode = Number.parseInt(single[2], 10);
    if (season !== expectedSeason) return null;
    return { season, episodes: [episode] };
  }

  // Season pack: S01 with no E##
  const pack = title.match(/S(\d{1,2})(?!\d|E)/i);
  if (pack) {
    const season = Number.parseInt(pack[1], 10);
    if (season !== expectedSeason) return null;
    return { season, episodes: [] }; // empty = full pack
  }

  return null;
}

export interface CategorizedReleases {
  packs: Release[];
  perEpisode: Map<number, Release[]>; // keyed by episode number
}

export function categorizeReleases(releases: Release[], season: number): CategorizedReleases {
  const packs: Release[] = [];
  const perEpisode = new Map<number, Release[]>();

  for (const release of releases) {
    const parsed = parseEpisodesFromTitle(release.title, season);
    if (!parsed) continue;

    if (parsed.episodes.length === 0) {
      packs.push(release);
      continue;
    }

    for (const ep of parsed.episodes) {
      if (!perEpisode.has(ep)) perEpisode.set(ep, []);
      perEpisode.get(ep)?.push(release);
    }
  }

  return { packs, perEpisode };
}
