import type { ParsedFile } from "./types";

export interface MatcherFile {
  relativePath: string;
  parsed: ParsedFile;
}

export interface MatcherItem {
  id: string;
  season?: number | null;
  episode?: number | null;
}

export interface MatchResult {
  assignments: Array<{ relativePath: string; processingItemId: string }>;
  orphans: string[];
  misses: string[];
}

// v1: DownloadFile.processingItemId is @unique, so each file links to exactly one PI.
// Multi-episode files attach to the lowest-numbered PI in their range; the rest become misses.
// See "Open questions" in the spec for the future multi-PI design.
export function matchFilesToItems(input: {
  files: MatcherFile[];
  items: MatcherItem[];
}): MatchResult {
  const assignments: MatchResult["assignments"] = [];
  const matchedItemIds = new Set<string>();
  const orphans: string[] = [];

  for (const file of input.files) {
    const { season, episode } = file.parsed;
    if (season === undefined || episode === undefined) {
      orphans.push(file.relativePath);
      continue;
    }
    const item = input.items.find((i) => i.season === season && i.episode === episode);
    if (item) {
      assignments.push({ relativePath: file.relativePath, processingItemId: item.id });
      matchedItemIds.add(item.id);
    } else {
      orphans.push(file.relativePath);
    }
  }

  const misses = input.items.filter((i) => !matchedItemIds.has(i.id)).map((i) => i.id);
  return { assignments, orphans, misses };
}
