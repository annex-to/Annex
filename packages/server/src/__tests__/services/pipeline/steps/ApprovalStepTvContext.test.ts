import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../setup";

const mockPrisma = createMockPrisma();
mock.module("../../../../db/client", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Re-import after mock
const { ApprovalStep } = await import("../../../../services/pipeline/steps/ApprovalStep");

mock.module("../../../../services/approvals/ApprovalService", () => ({
  getApprovalService: () => ({
    createApproval: async (opts: { context: unknown }) => {
      capturedContext = opts.context as Record<string, unknown>;
      return "approval-id";
    },
  }),
}));

let capturedContext: Record<string, unknown> = {};

describe("ApprovalStep TV context", () => {
  beforeEach(() => {
    mockPrisma._clear();
    capturedContext = {};
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  test("builds per-season per-episode context for TV requests", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 1, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    await mockPrisma.pipelineExecution.create({
      data: { requestId: req.id, status: "RUNNING", currentStep: 1, parentExecutionId: null },
    });

    // Two episodes in season 1, sharing one season pack release
    const packRelease = {
      title: "Show.S01.1080p.Pack",
      resolution: "1080p",
      source: "WEB-DL",
      codec: "H264",
      size: 8_000_000_000,
      seeders: 100,
      indexerName: "test-indexer",
    };
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "Pilot",
        season: 1,
        episode: 1,
        status: "DISCOVERED",
        stepContext: { selectedRelease: packRelease, qualityMet: true },
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "Second",
        season: 1,
        episode: 2,
        status: "DISCOVERED",
        stepContext: { selectedRelease: packRelease, qualityMet: true },
      },
    });
    // One unmatched episode (no release)
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "Missing",
        season: 1,
        episode: 3,
        status: "FOUND",
        stepContext: { qualityMet: false, alternativeReleases: [] },
      },
    });

    const step = new ApprovalStep();
    await step.execute(
      {
        requestId: req.id,
        mediaType: "TV" as any,
        tmdbId: 1,
        title: "Show",
        year: 2020,
        targets: [],
      },
      {}
    );

    const tv = capturedContext.tv as any;
    expect(tv).toBeDefined();
    expect(tv.totalSeasons).toBe(1);
    expect(tv.totalEpisodes).toBe(3);
    expect(tv.matchedEpisodes).toBe(2);
    expect(tv.seasons[0].season).toBe(1);
    expect(tv.seasons[0].pack).not.toBeNull();
    expect(tv.seasons[0].pack.title).toBe("Show.S01.1080p.Pack");
    expect(tv.seasons[0].episodes).toHaveLength(3);
    expect(tv.seasons[0].matchedEpisodes).toBe(2);
  });

  test("does not flag pack when each episode has a unique release", async () => {
    const req = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 2, type: "TV", title: "Show", year: 2020, status: "PROCESSING" },
    });
    await mockPrisma.pipelineExecution.create({
      data: { requestId: req.id, status: "RUNNING", currentStep: 1, parentExecutionId: null },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 2,
        title: "E1",
        season: 1,
        episode: 1,
        status: "DISCOVERED",
        stepContext: {
          selectedRelease: { title: "Show.S01E01.1080p", size: 2_000_000_000 },
          qualityMet: true,
        },
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: req.id,
        type: "EPISODE",
        tmdbId: 2,
        title: "E2",
        season: 1,
        episode: 2,
        status: "DISCOVERED",
        stepContext: {
          selectedRelease: { title: "Show.S01E02.1080p", size: 2_000_000_000 },
          qualityMet: true,
        },
      },
    });

    const step = new ApprovalStep();
    await step.execute(
      {
        requestId: req.id,
        mediaType: "TV" as any,
        tmdbId: 2,
        title: "Show",
        year: 2020,
        targets: [],
      },
      {}
    );

    const tv = capturedContext.tv as any;
    expect(tv.seasons[0].pack).toBeNull();
    expect(tv.matchedEpisodes).toBe(2);
    expect(tv.totalSizeBytes).toBe(4_000_000_000);
  });
});
