import { extractInfohashFromMagnet } from "../downloadClients/magnetInfohash";
import type { Release } from "../indexer";

/**
 * Dedupe releases by infohash where available, else by indexerId+id.
 * Critical: never dedupe by normalized title — that drops legitimate
 * alternatives that happen to share words.
 */
export function dedupeReleases(releases: Release[]): Release[] {
  const seen = new Map<string, Release>();
  for (const release of releases) {
    const hash = release.magnetUri ? extractInfohashFromMagnet(release.magnetUri) : null;
    const key = hash ? `ih:${hash}` : `id:${release.indexerId}:${release.id}`;
    const existing = seen.get(key);
    if (!existing || release.score > existing.score) {
      seen.set(key, release);
    }
  }
  return Array.from(seen.values());
}
