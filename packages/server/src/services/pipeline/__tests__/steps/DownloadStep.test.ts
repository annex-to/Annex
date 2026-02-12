/**
 * DownloadStep Unit Tests
 *
 * Tests download step behavior in isolation without real qBittorrent calls
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MediaType, ProcessingStatus } from "@prisma/client";
import { createMockPrisma } from "../../../../__tests__/setup.js";
import { MOVIES, TARGETS, TV_SHOWS } from "../fixtures/media.js";
import { assertStepData, assertStepFailure, assertStepSuccess } from "../test-utils/assertions.js";
import { ContextBuilder } from "../test-utils/context-builder.js";
import { cleanupTestData, createTestRequest, createTestServer } from "../test-utils/database.js";

// Mock Prisma client to prevent database access
const mockPrisma = createMockPrisma();
mock.module("../../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Mock download service (qBittorrent client)
const mockDownloadService = {
  createDownload: mock(async () => ({
    id: "dl-1",
    torrentHash: "abc123",
    torrentName: "Test.Download",
  })),
  waitForCompletion: mock(async () => ({
    success: true,
    progress: {
      progress: 100,
      savePath: "/downloads",
      contentPath: "/downloads/Test.Download",
      seeds: 10,
      peers: 5,
    },
  })),
  getProgress: mock(async () => ({
    progress: 100,
    savePath: "/downloads",
    contentPath: "/downloads/Test.Download",
  })),
  getMainVideoFile: mock(async () => ({
    path: "/downloads/Test.Download/movie.mkv",
    size: 5_000_000_000,
    name: "movie.mkv",
  })),
  getTorrentFiles: mock(async () => []),
};

mock.module("../../../download.js", () => ({
  getDownloadService: () => mockDownloadService,
}));

// Mock download manager
const mockDownloadManager = {
  createDownload: mock(async () => ({
    id: "dl-1",
    torrentHash: "abc123",
    torrentName: "Test.Download.1080p",
  })),
  createDownloadFromExisting: mock(async () => ({
    id: "dl-existing",
    torrentHash: "existing-hash",
    torrentName: "Existing.Download",
  })),
  findExistingMovieDownload: mock(async () => ({ found: false, isComplete: false })),
  handleStalledDownload: mock(async () => {}),
};

mock.module("../../../downloadManager.js", () => ({
  downloadManager: mockDownloadManager,
}));

// Mock archive utilities
mock.module("../../../archive.js", () => ({
  detectRarArchive: () => ({ hasArchive: false, archivePath: null }),
  extractRar: async () => ({ success: true, extractedFiles: [] }),
  isSampleFile: () => false,
}));

// Mock pipeline orchestrator
mock.module("../../PipelineOrchestrator.js", () => ({
  pipelineOrchestrator: {
    transitionStatus: mock(async () => ({})),
  },
}));

// Import the step under test AFTER all mock.module calls
import { DownloadStep } from "../../steps/DownloadStep.js";

describe("DownloadStep", () => {
  beforeEach(async () => {
    await createTestServer({
      id: "test-server-1080p",
      name: "1080p Test Server",
      maxResolution: "RES_1080P",
    });
  });

  afterEach(async () => {
    await cleanupTestData();
    await mockPrisma.storageServer.deleteMany();
    mockDownloadService.createDownload.mockClear();
    mockDownloadService.waitForCompletion.mockClear();
    mockDownloadService.getProgress.mockClear();
    mockDownloadService.getMainVideoFile.mockClear();
    mockDownloadService.getTorrentFiles.mockClear();
    mockDownloadManager.createDownload.mockClear();
    mockDownloadManager.createDownloadFromExisting.mockClear();
    mockDownloadManager.findExistingMovieDownload.mockClear();
    mockDownloadManager.handleStalledDownload.mockClear();
  });

  describe("Recovery", () => {
    test("should skip download when context already has sourceFilePath", async () => {
      const request = await createTestRequest({
        createExecution: true,
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .withDownloadResult({
          torrentHash: "recovered-hash",
          sourceFilePath: "/downloads/Inception.2010.1080p/movie.mkv",
        })
        .build();

      const step = new DownloadStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);
      assertStepData(result, "download");

      const downloadData = result.data?.download as Record<string, unknown>;
      expect(downloadData.sourceFilePath).toBe("/downloads/Inception.2010.1080p/movie.mkv");
      expect(downloadData.torrentHash).toBe("recovered-hash");

      // Should NOT have created a new download
      expect(mockDownloadManager.createDownload).not.toHaveBeenCalled();
      expect(mockDownloadManager.createDownloadFromExisting).not.toHaveBeenCalled();
    });

    test("should skip download when episode processingItem already has sourceFilePath", async () => {
      const request = await createTestRequest({
        createExecution: true,
        type: MediaType.TV,
        tmdbId: TV_SHOWS.BREAKING_BAD.tmdbId,
        title: TV_SHOWS.BREAKING_BAD.title,
        year: TV_SHOWS.BREAKING_BAD.year,
        requestedSeasons: [1],
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // Create a processingItem record with a sourceFilePath already set
      const processingItem = await mockPrisma.processingItem.create({
        data: {
          id: "episode-item-1",
          requestId: request.id,
          type: "EPISODE",
          season: 1,
          episode: 1,
          status: ProcessingStatus.DOWNLOADED,
          sourceFilePath: "/downloads/Breaking.Bad.S01E01.mkv",
        },
      });

      const context = new ContextBuilder()
        .forTvShow(
          TV_SHOWS.BREAKING_BAD.title,
          TV_SHOWS.BREAKING_BAD.year,
          TV_SHOWS.BREAKING_BAD.tmdbId,
          [1]
        )
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      // Set episodeId on context (accessed via index signature)
      (context as Record<string, unknown>).episodeId = processingItem.id;

      const step = new DownloadStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);
      assertStepData(result, "download");

      const downloadData = result.data?.download as Record<string, unknown>;
      expect(downloadData.sourceFilePath).toBe("/downloads/Breaking.Bad.S01E01.mkv");

      // Should NOT have created a new download
      expect(mockDownloadManager.createDownload).not.toHaveBeenCalled();
    });
  });

  describe("No Download Source", () => {
    test("should fail when neither selectedRelease nor existingDownload is present", async () => {
      const request = await createTestRequest({
        createExecution: true,
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .withSearchResult({})
        .build();

      const step = new DownloadStep();
      const result = await step.execute(context, {});

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
      assertStepFailure(result, "No download source available");
    });
  });

  describe("Configuration", () => {
    test("should accept undefined config as valid", () => {
      const step = new DownloadStep();
      expect(() => step.validateConfig(undefined)).not.toThrow();
    });

    test("should accept object config as valid", () => {
      const step = new DownloadStep();
      expect(() => step.validateConfig({ pollInterval: 1000, timeout: 60000 })).not.toThrow();
    });

    test("should throw on non-object config", () => {
      const step = new DownloadStep();
      expect(() => step.validateConfig("invalid")).toThrow("DownloadStep config must be an object");
      expect(() => step.validateConfig(42)).toThrow("DownloadStep config must be an object");
      expect(() => step.validateConfig(true)).toThrow("DownloadStep config must be an object");
    });
  });

  describe("Skipped Search with TV", () => {
    // When running in the full suite, mock.module conflicts mean DownloadStep.ts
    // may use a different prisma instance than our local mockPrisma. We import the
    // actual prisma that DownloadStep.ts uses and seed data into THAT store.
    let activePrisma: any;

    beforeEach(async () => {
      const dbModule = await import("../../../../db/client.js");
      activePrisma = dbModule.prisma;
      // Clear only processingItem store to avoid wiping servers/requests from outer beforeEach
      if (activePrisma._stores?.processingItem) {
        activePrisma._stores.processingItem.clear();
      }
    });

    afterEach(() => {
      if (activePrisma._stores?.processingItem) {
        activePrisma._stores.processingItem.clear();
      }
    });

    test("should handle skippedSearch flag with downloaded episodes", async () => {
      const request = await createTestRequest({
        createExecution: true,
        type: MediaType.TV,
        tmdbId: TV_SHOWS.BREAKING_BAD.tmdbId,
        title: TV_SHOWS.BREAKING_BAD.title,
        year: TV_SHOWS.BREAKING_BAD.year,
        requestedSeasons: [1],
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // Create processingItem records that are already downloaded
      // Use activePrisma to ensure we write to the same store DownloadStep.ts reads from
      await activePrisma.processingItem.create({
        data: {
          id: "ep-1",
          requestId: request.id,
          type: "EPISODE",
          season: 1,
          episode: 1,
          status: ProcessingStatus.DOWNLOADED,
          sourceFilePath: "/downloads/Breaking.Bad.S01E01.mkv",
        },
      });

      await activePrisma.processingItem.create({
        data: {
          id: "ep-2",
          requestId: request.id,
          type: "EPISODE",
          season: 1,
          episode: 2,
          status: ProcessingStatus.DOWNLOADED,
          sourceFilePath: "/downloads/Breaking.Bad.S01E02.mkv",
        },
      });

      const context = new ContextBuilder()
        .forTvShow(
          TV_SHOWS.BREAKING_BAD.title,
          TV_SHOWS.BREAKING_BAD.year,
          TV_SHOWS.BREAKING_BAD.tmdbId,
          [1]
        )
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .withSearchResult({ skippedSearch: true } as any)
        .build();

      const step = new DownloadStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      const downloadData = result.data?.download as Record<string, unknown>;
      expect(downloadData.episodesQueued).toBe(true);
      expect(downloadData.queuedCount).toBe(2);

      // Should NOT have created any new downloads
      expect(mockDownloadManager.createDownload).not.toHaveBeenCalled();
    });

    test("should fail when skippedSearch is set but no downloaded episodes exist", async () => {
      const request = await createTestRequest({
        createExecution: true,
        type: MediaType.TV,
        tmdbId: TV_SHOWS.BREAKING_BAD.tmdbId,
        title: TV_SHOWS.BREAKING_BAD.title,
        year: TV_SHOWS.BREAKING_BAD.year,
        requestedSeasons: [1],
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forTvShow(
          TV_SHOWS.BREAKING_BAD.title,
          TV_SHOWS.BREAKING_BAD.year,
          TV_SHOWS.BREAKING_BAD.tmdbId,
          [1]
        )
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .withSearchResult({ skippedSearch: true } as any)
        .build();

      const step = new DownloadStep();
      const result = await step.execute(context, {});

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
      assertStepFailure(result, "No downloaded episodes found");
    });
  });
});
