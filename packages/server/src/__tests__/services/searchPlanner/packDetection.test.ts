import { describe, expect, it } from "bun:test";
import {
  categorizeReleases,
  parseEpisodesFromTitle,
} from "../../../services/searchPlanner/packDetection";

const r = (overrides: Partial<{ title: string; score: number }> = {}) =>
  ({
    id: "x",
    title: "x",
    indexerId: "i",
    indexerName: "i",
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

describe("parseEpisodesFromTitle", () => {
  it("parses S01E01 as a single episode", () => {
    expect(parseEpisodesFromTitle("Show.S01E01.1080p.mkv", 1)).toEqual({
      season: 1,
      episodes: [1],
    });
  });

  it("parses S01E01E02 as multi-episode", () => {
    expect(parseEpisodesFromTitle("Show.S01E01E02.mkv", 1)).toEqual({
      season: 1,
      episodes: [1, 2],
    });
  });

  it("parses S01E01-E03 as multi-episode range", () => {
    expect(parseEpisodesFromTitle("Show.S01E01-E03.mkv", 1)).toEqual({
      season: 1,
      episodes: [1, 2, 3],
    });
  });

  it("parses S01 (no E##) as a season pack", () => {
    expect(parseEpisodesFromTitle("Show.S01.1080p.Pack.mkv", 1)).toEqual({
      season: 1,
      episodes: [],
    });
  });

  it("parses S01-S05 range as covering season 3", () => {
    expect(parseEpisodesFromTitle("Show.S01-S05.Complete.mkv", 3)).toEqual({
      season: 3,
      episodes: [],
    });
  });

  it("returns null for S01-S05 range when season is outside", () => {
    expect(parseEpisodesFromTitle("Show.S01-S05.Complete.mkv", 7)).toBeNull();
  });

  it("returns null when single-ep season mismatches", () => {
    expect(parseEpisodesFromTitle("Show.S02E01.mkv", 1)).toBeNull();
  });
});

describe("categorizeReleases", () => {
  it("splits packs from per-episode buckets", () => {
    const releases = [
      r({ title: "Show.S01.1080p.Pack" }),
      r({ title: "Show.S01E01.1080p" }),
      r({ title: "Show.S01E02.1080p" }),
      r({ title: "Show.S02E01.1080p" }),
    ];
    const cat = categorizeReleases(releases, 1);
    expect(cat.packs).toHaveLength(1);
    expect(cat.perEpisode.get(1)).toHaveLength(1);
    expect(cat.perEpisode.get(2)).toHaveLength(1);
    expect(cat.perEpisode.has(3)).toBe(false);
  });

  it("adds multi-episode files to every episode they cover", () => {
    const releases = [r({ title: "Show.S01E01E02.mkv" })];
    const cat = categorizeReleases(releases, 1);
    expect(cat.perEpisode.get(1)).toHaveLength(1);
    expect(cat.perEpisode.get(2)).toHaveLength(1);
  });
});
