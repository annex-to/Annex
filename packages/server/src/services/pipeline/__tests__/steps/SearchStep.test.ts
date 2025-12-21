/**
 * SearchStep Unit Tests
 *
 * Tests search step behavior in isolation without real indexer calls
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MediaType } from "@prisma/client";
import { SearchStep } from "../../steps/SearchStep.js";
import { MOVIES, TARGETS } from "../fixtures/media.js";
import { MOVIE_RELEASES } from "../fixtures/releases.js";
import { createMockTorrent, MockDownloadManager } from "../mocks/downloadManager.mock.js";
import { createQualityVariants, MockIndexerService } from "../mocks/indexer.mock.js";
import { assertStepData, assertStepRetry, assertStepSuccess } from "../test-utils/assertions.js";
import { ContextBuilder } from "../test-utils/context-builder.js";
import { cleanupTestData, createTestRequest } from "../test-utils/database.js";

// Mock the external services
let mockIndexer: MockIndexerService;
let mockDownloadManager: MockDownloadManager;

// Replace the real services with mocks
mock.module("../../../indexer.js", () => ({
  getIndexerService: () => mockIndexer,
}));

mock.module("../../../downloadManager.js", () => ({
  downloadManager: mockDownloadManager,
}));

mock.module("../../../trakt.js", () => ({
  getTraktService: () => ({
    getMovieDetails: async () => ({ ids: { imdb: "tt1375666" } }),
    getTvShowDetails: async () => ({ ids: { imdb: "tt0903747" } }),
  }),
}));

describe("SearchStep", () => {
  beforeEach(() => {
    mockIndexer = new MockIndexerService();
    mockDownloadManager = new MockDownloadManager();
  });

  afterEach(async () => {
    await cleanupTestData();
    mockIndexer.clearMockReleases();
    mockIndexer.clearSearchCalls();
    mockDownloadManager.clearMockTorrents();
    mockDownloadManager.clearCalls();
  });

  describe("Movie Search", () => {
    test("should find and select best quality release that meets requirements", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      // Mock indexer returns multiple quality options
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_4K_REMUX,
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
      ]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);
      assertStepData(result, "search");

      // Should select 1080p (meets requirement, good seeders)
      expect(result.data?.search).toBeDefined();
      const searchData = result.data?.search as Record<string, unknown>;
      expect((searchData.selectedRelease as Record<string, unknown>).resolution).toBe("1080p");
      expect(searchData.qualityMet).toBe(true);
    });

    test("should skip lower quality releases when higher quality is available", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_4K_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_4K_SERVER)
        .build();

      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_4K_REMUX,
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
        MOVIE_RELEASES.INCEPTION_480P_DVDRIP,
      ]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      const searchData = result.data?.search as Record<string, unknown>;
      expect((searchData.selectedRelease as Record<string, unknown>).resolution).toBe("2160p");
      expect(searchData.qualityMet).toBe(true);
    });

    test("should handle no releases found and set retry flag", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      // No releases
      mockIndexer.setMockReleases([]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepRetry(result);
      expect(result.success).toBe(false);
      expect(result.error).toBe("No releases found");
    });

    test("should store alternative releases when quality unavailable", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_4K_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_4K_SERVER)
        .build();

      // Only lower quality releases available
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
      ]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      // Should succeed but not proceed to download
      expect(result.success).toBe(true);
      expect(result.nextStep).toBe(null);

      const searchData = result.data as Record<string, unknown>;
      expect(searchData.qualityMet).toBe(false);
      expect(searchData.alternativeReleases).toBeDefined();
      expect((searchData.alternativeReleases as unknown[]).length).toBeGreaterThan(0);
    });

    test("should find existing download in qBittorrent if available", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      // Add existing download to qBittorrent
      mockDownloadManager.addMockTorrent(
        createMockTorrent("Inception.2010.1080p.BluRay.x264-GROUP", {
          isComplete: true,
          hash: "existing-hash",
        })
      );

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Should return existing download info
      const searchData = result.data?.search as Record<string, unknown>;
      const existingDownload = searchData.existingDownload as Record<string, unknown>;
      expect(existingDownload).toBeDefined();
      expect(existingDownload.torrentHash).toBe("existing-hash");
      expect(existingDownload.isComplete).toBe(true);

      // Verify it checked qBittorrent
      const calls = mockDownloadManager.getFindMovieCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].title).toBe(MOVIES.INCEPTION.title);
      expect(calls[0].year).toBe(MOVIES.INCEPTION.year);
    });

    test("should skip low quality existing downloads", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_4K_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_4K_SERVER)
        .build();

      // Existing 720p download (too low for 4K target)
      mockDownloadManager.addMockTorrent(
        createMockTorrent("Inception.2010.720p.WEB-DL.H264-GROUP", {
          isComplete: true,
        })
      );

      // Better quality available from indexer
      mockIndexer.setMockReleases([MOVIE_RELEASES.INCEPTION_4K_REMUX]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Should not use existing download
      const searchData = result.data?.search as Record<string, unknown>;
      expect(searchData.existingDownload).toBeUndefined();
      expect(searchData.selectedRelease).toBeDefined();
      expect((searchData.selectedRelease as Record<string, unknown>).resolution).toBe("2160p");
    });
  });

  describe("TV Show Search", () => {
    test("should search for TV season", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        type: MediaType.TV,
        tmdbId: 1396,
        title: "Breaking Bad",
        year: 2008,
        requestedSeasons: [1],
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forTvShow("Breaking Bad", 2008, 1396, [1])
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      const variants = createQualityVariants("Breaking.Bad.S01");
      mockIndexer.setMockReleases([variants.fullHd, variants.hd]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Verify it searched for season 1
      const calls = mockIndexer.getSearchCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].type).toBe("tv");
      expect(calls[0].season).toBe(1);
    });

    test("should search for first season when multiple seasons requested", async () => {
      const request = await createTestRequest({
        type: MediaType.TV,
        tmdbId: 1396,
        title: "Breaking Bad",
        year: 2008,
        requestedSeasons: [1, 2, 3],
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forTvShow("Breaking Bad", 2008, 1396, [1, 2, 3])
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      const variants = createQualityVariants("Breaking.Bad.S01");
      mockIndexer.setMockReleases([variants.fullHd]);

      const step = new SearchStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Currently only searches for first season
      // This is a known limitation documented in the test
      const calls = mockIndexer.getSearchCalls();
      expect(calls.length).toBe(1);
      expect(calls[0].season).toBe(1);
    });
  });

  describe("Configuration", () => {
    test("should respect checkExistingDownloads config", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      mockIndexer.setMockReleases([MOVIE_RELEASES.INCEPTION_1080P_BLURAY]);

      const step = new SearchStep();
      const result = await step.execute(context, { checkExistingDownloads: false });

      assertStepSuccess(result);

      // Should not have checked qBittorrent
      const calls = mockDownloadManager.getFindMovieCalls();
      expect(calls.length).toBe(0);
    });

    test("should limit results based on maxResults config", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      const context = new ContextBuilder()
        .forMovie(MOVIES.INCEPTION.title, MOVIES.INCEPTION.year, MOVIES.INCEPTION.tmdbId)
        .withRequestId(request.id)
        .withTargets(TARGETS.SINGLE_1080P_SERVER)
        .build();

      // Many releases
      const variants = createQualityVariants("Inception.2010");
      mockIndexer.setMockReleases([
        variants.uhd,
        variants.fullHd,
        variants.hd,
        variants.sd,
        variants.fullHd, // duplicate
        variants.hd, // duplicate
      ]);

      const step = new SearchStep();
      const result = await step.execute(context, { maxResults: 2 });

      assertStepSuccess(result);

      const searchData = result.data?.search as Record<string, unknown>;
      // Should have selected release plus alternatives
      expect((searchData.alternativeReleases as unknown[]).length).toBeLessThanOrEqual(1);
    });
  });
});
