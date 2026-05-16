import { describe, expect, it } from "bun:test";
import { dedupeReleases } from "../../../services/searchPlanner/dedupe";

const r = (overrides: Partial<{ id: string; magnetUri: string; score: number; title: string }>) =>
  ({
    id: "x",
    title: "x",
    indexerId: "i1",
    indexerName: "i1",
    indexerPriority: 5,
    resolution: "1080p",
    source: "WEB-DL",
    codec: "H264",
    size: 1_000_000_000,
    seeders: 10,
    leechers: 0,
    publishDate: new Date(),
    score: 50,
    categories: [],
    ...overrides,
  }) as never;

describe("dedupeReleases", () => {
  it("dedupes by infohash extracted from magnet URI", () => {
    const sameHash = "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567";
    const out = dedupeReleases([
      r({ id: "a", magnetUri: sameHash, score: 50 }),
      r({ id: "b", magnetUri: sameHash, score: 70 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(70);
  });

  it("keeps releases with different infohashes", () => {
    const out = dedupeReleases([
      r({
        id: "a",
        magnetUri: "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567",
      }),
      r({
        id: "b",
        magnetUri: "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("does NOT dedupe by normalized title", () => {
    // Two releases with the same parsed title but different infohashes
    // (e.g., re-uploads) — both should survive.
    const out = dedupeReleases([
      r({
        id: "a",
        title: "Show S01E01 1080p",
        magnetUri: "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567",
      }),
      r({
        id: "b",
        title: "Show.S01E01.1080p",
        magnetUri: "magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("falls back to indexerId:id when no magnet URI", () => {
    const out = dedupeReleases([
      r({ id: "a", title: "Foo" }),
      r({ id: "a", title: "Foo" }), // same indexerId+id collapses
    ]);
    expect(out).toHaveLength(1);
  });
});
