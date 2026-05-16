import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../setup";

const mockPrisma = createMockPrisma();
mock.module("../../../db/client", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

let nextReleases: any[] = [];
let queryCount = 0;

mock.module("../../../services/indexer", () => ({
  getIndexerService: () => ({
    searchTvSeason: async () => {
      queryCount += 1;
      return { releases: nextReleases, indexersQueried: 1, indexersFailed: 0, errors: [] };
    },
  }),
}));

const { planForRequest } = await import("../../../services/searchPlanner");

const release = (overrides: Partial<{ title: string; score: number; seeders: number }>) =>
  ({
    id: `rel-${Math.random()}`,
    title: "x",
    indexerId: "i1",
    indexerName: "i1",
    indexerPriority: 5,
    resolution: "1080p",
    source: "WEB-DL",
    codec: "H264",
    size: 5_000_000_000,
    seeders: 50,
    leechers: 0,
    magnetUri: `magnet:?xt=urn:btih:${Math.random().toString(36).padEnd(40, "a").slice(0, 40)}`,
    publishDate: new Date(),
    score: 80,
    categories: [],
    ...overrides,
  }) as any;

describe("planForRequest", () => {
  beforeEach(() => {
    mockPrisma._clear();
    nextReleases = [];
    queryCount = 0;
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  test("issues one indexer query per requested season", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 1, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "S",
        season: 1,
        episode: 1,
        status: "SEARCHING",
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "S",
        season: 2,
        episode: 1,
        status: "SEARCHING",
      },
    });

    nextReleases = [release({ title: "Show.S01.1080p.Pack" })];
    const result = await planForRequest({ requestId: req.id, requiredResolution: "1080p" as any });
    // Two seasons -> two queries
    expect(queryCount).toBe(2);
    expect(result.seasons).toHaveLength(2);
  });

  test("season pack wins over individual episodes", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 2, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    const e1 = await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 2,
        title: "S",
        season: 1,
        episode: 1,
        status: "SEARCHING",
      },
    });
    const e2 = await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 2,
        title: "S",
        season: 1,
        episode: 2,
        status: "SEARCHING",
      },
    });

    nextReleases = [
      release({ title: "Show.S01.1080p.Pack" }),
      release({ title: "Show.S01E01.1080p" }),
      release({ title: "Show.S01E02.1080p" }),
    ];

    const result = await planForRequest({ requestId: req.id, requiredResolution: "1080p" as any });
    expect(result.seasons[0].pack).toBeDefined();
    expect(result.seasons[0].pack?.title).toMatch(/Pack/);

    // Both PIs got the pack as selected release
    const piE1 = await mockPrisma.processingItem.findUnique({ where: { id: e1.id } });
    const piE2 = await mockPrisma.processingItem.findUnique({ where: { id: e2.id } });
    const ctx1 = piE1.stepContext as Record<string, unknown>;
    const ctx2 = piE2.stepContext as Record<string, unknown>;
    expect((ctx1.selectedRelease as any).title).toMatch(/Pack/);
    expect((ctx2.selectedRelease as any).title).toMatch(/Pack/);
  });

  test("falls back to per-episode when no pack meets quality", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 3, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    const e1 = await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 3,
        title: "S",
        season: 1,
        episode: 1,
        status: "SEARCHING",
      },
    });

    nextReleases = [
      release({ title: "Show.S01.720p.Pack", score: 30 }), // pack below 1080p
      release({ title: "Show.S01E01.1080p", score: 70 }),
    ];

    const result = await planForRequest({ requestId: req.id, requiredResolution: "1080p" as any });
    expect(result.seasons[0].pack).toBeUndefined();
    expect(result.seasons[0].perEpisode.get(1)).toBeDefined();

    const pi = await mockPrisma.processingItem.findUnique({ where: { id: e1.id } });
    const ctx = pi.stepContext as Record<string, unknown>;
    expect((ctx.selectedRelease as any).title).toMatch(/E01/);
  });

  test("marks unmatched episodes QUALITY_UNAVAILABLE-style with alternatives", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 4, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    const e1 = await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 4,
        title: "S",
        season: 1,
        episode: 1,
        status: "SEARCHING",
      },
    });

    nextReleases = [release({ title: "Show.S01E01.720p", score: 30, resolution: "720p" } as any)];

    await planForRequest({ requestId: req.id, requiredResolution: "1080p" as any });

    const pi = await mockPrisma.processingItem.findUnique({ where: { id: e1.id } });
    const ctx = pi.stepContext as Record<string, unknown>;
    expect(ctx.qualityMet).toBe(false);
    expect((ctx.alternativeReleases as any[]).length).toBeGreaterThan(0);
  });

  test("concurrent calls for the same request dedupe to one indexer pass", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 99, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 99,
        title: "S",
        season: 1,
        episode: 1,
        status: "SEARCHING",
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 99,
        title: "S",
        season: 1,
        episode: 2,
        status: "SEARCHING",
      },
    });

    nextReleases = [release({ title: "Show.S01.1080p.Pack" })];
    queryCount = 0;

    // Three concurrent planner calls (simulating SearchWorker concurrency=3)
    const results = await Promise.all([
      planForRequest({ requestId: req.id, requiredResolution: "1080p" as any }),
      planForRequest({ requestId: req.id, requiredResolution: "1080p" as any }),
      planForRequest({ requestId: req.id, requiredResolution: "1080p" as any }),
    ]);

    // Only one season query should have been issued total
    expect(queryCount).toBe(1);
    // All callers see the same result object
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  test("year filter drops releases tagged with wrong year", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 5, type: "TV", title: "Show", year: 2005, status: "PROCESSING" },
    });
    const e1 = await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 5,
        title: "S",
        season: 1,
        episode: 1,
        status: "SEARCHING",
      },
    });

    nextReleases = [
      release({ title: "Show.2001.S01E01.1080p" }), // wrong year, dropped
      release({ title: "Show.2005.S01E01.1080p" }), // right year, kept
    ];

    const result = await planForRequest({ requestId: req.id, requiredResolution: "1080p" as any });
    expect(result.seasons[0].perEpisode.get(1)?.title).toMatch(/2005/);
  });
});
