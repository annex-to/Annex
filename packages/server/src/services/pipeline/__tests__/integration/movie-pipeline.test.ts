/**
 * Movie Pipeline Integration Tests
 *
 * Tests complete movie request pipeline flows end-to-end
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { RequestStatus, StepType } from "@prisma/client";
import { prisma } from "../../../../db/client.js";
import { PipelineExecutor } from "../../PipelineExecutor.js";
import { MOVIES, TARGETS } from "../fixtures/media.js";
import { MOVIE_RELEASES } from "../fixtures/releases.js";
import { MockDownloadManager } from "../mocks/downloadManager.mock.js";
import { MockIndexerService } from "../mocks/indexer.mock.js";
import { cleanupTestData, createTestRequest, getRequestStatus } from "../test-utils/database.js";

// Mock external services
let mockIndexer: MockIndexerService;
let mockDownloadManager: MockDownloadManager;

mock.module("../../../indexer.js", () => ({
  getIndexerService: () => mockIndexer,
}));

mock.module("../../../downloadManager.js", () => ({
  downloadManager: mockDownloadManager,
}));

mock.module("../../../trakt.js", () => ({
  getTraktService: () => ({
    getMovieDetails: async () => ({ ids: { imdb: "tt1375666" } }),
  }),
}));

describe("Movie Pipeline Integration", () => {
  let executor: PipelineExecutor;
  let templateId: string;

  beforeEach(async () => {
    mockIndexer = new MockIndexerService();
    mockDownloadManager = new MockDownloadManager();
    executor = new PipelineExecutor();

    // Create a simple movie pipeline template
    const template = await prisma.pipelineTemplate.create({
      data: {
        name: "Test Movie Pipeline",
        description: "Test template for integration tests",
        mediaType: "MOVIE",
        isDefault: false,
        steps: [
          {
            type: StepType.SEARCH,
            name: "search",
            config: {},
            required: true,
          },
        ] as any,
      },
    });

    templateId = template.id;
  });

  afterEach(async () => {
    await cleanupTestData();
    await prisma.pipelineTemplate.deleteMany({});
    mockIndexer.clearMockReleases();
    mockIndexer.clearSearchCalls();
    mockDownloadManager.clearMockTorrents();
    mockDownloadManager.clearCalls();
  });

  describe("Successful Flow", () => {
    test("should execute search step and complete successfully", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // Mock successful search
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
      ]);

      // Execute pipeline
      await executor.startExecution(request.id, templateId);

      // Verify request was updated
      const status = await getRequestStatus(request.id);
      expect(status).toBeDefined();

      // Verify pipeline execution was created
      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      expect(execution).toBeDefined();
      expect(execution?.status).toBe("COMPLETED");
      expect(execution?.context).toBeDefined();

      // Verify search results were stored in context
      const context = execution?.context as Record<string, unknown>;
      const search = context.search as Record<string, unknown>;
      expect(search).toBeDefined();
      expect(search.selectedRelease).toBeDefined();
      expect((search.selectedRelease as Record<string, unknown>).resolution).toBe("1080p");
    });

    test("should reuse existing download if available and quality matches", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // Add existing complete download
      mockDownloadManager.addMockTorrent({
        hash: "existing-inception",
        name: "Inception.2010.1080p.BluRay.x264-GROUP",
        isComplete: true,
        progress: 1,
      });

      // Execute pipeline
      await executor.startExecution(request.id, templateId);

      // Verify pipeline completed
      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      expect(execution?.status).toBe("COMPLETED");

      // Verify it found existing download
      const context = execution?.context as Record<string, unknown>;
      const search = context.search as Record<string, unknown>;
      const existingDownload = search.existingDownload as Record<string, unknown>;
      expect(existingDownload).toBeDefined();
      expect(existingDownload.torrentHash).toBe("existing-inception");
    });
  });

  describe("Quality Handling", () => {
    test("should stop pipeline when quality unavailable and store alternatives", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_4K_SERVER,
      });

      // Only lower quality releases available
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
      ]);

      await executor.startExecution(request.id, templateId);

      // Pipeline should complete but request should be in QUALITY_UNAVAILABLE
      const updatedRequest = await prisma.mediaRequest.findUnique({
        where: { id: request.id },
      });

      expect(updatedRequest?.status).toBe(RequestStatus.QUALITY_UNAVAILABLE);
      expect(updatedRequest?.availableReleases).toBeDefined();

      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      // Pipeline execution should be completed (not failed)
      expect(execution?.status).toBe("COMPLETED");
    });

    test("should select appropriate quality based on target server", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_4K_SERVER,
      });

      // Multiple quality options
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_4K_REMUX,
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
      ]);

      await executor.startExecution(request.id, templateId);

      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      const context = execution?.context as Record<string, unknown>;
      const search = context.search as Record<string, unknown>;
      expect((search.selectedRelease as Record<string, unknown>).resolution).toBe("2160p");
    });
  });

  describe("Error Handling", () => {
    test("should set retry flag when no releases found", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // No releases
      mockIndexer.setMockReleases([]);

      await executor.startExecution(request.id, templateId);

      // Request should be in AWAITING status
      const updatedRequest = await prisma.mediaRequest.findUnique({
        where: { id: request.id },
      });

      expect(updatedRequest?.status).toBe(RequestStatus.AWAITING);
      expect(updatedRequest?.progress).toBe(0);

      // Pipeline should complete gracefully
      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      expect(execution?.status).toBe("COMPLETED");
    });

    test("should handle indexer search errors gracefully", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // Mock indexer to throw error
      mockIndexer.search = async () => {
        throw new Error("Indexer connection failed");
      };

      try {
        await executor.startExecution(request.id, templateId);
      } catch {
        // Expected to fail
      }

      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      expect(execution?.status).toBe("FAILED");
      expect(execution?.error).toContain("Indexer connection failed");
    });
  });

  describe("Multi-Server Targeting", () => {
    test("should handle multiple target servers with different quality requirements", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.MULTI_SERVER,
      });

      // Multiple quality options available
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_4K_REMUX,
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
      ]);

      await executor.startExecution(request.id, templateId);

      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      const context = execution?.context as Record<string, unknown>;
      const search = context.search as Record<string, unknown>;

      // Should select highest quality to satisfy all targets
      expect((search.selectedRelease as Record<string, unknown>).resolution).toBe("2160p");
      expect(execution?.status).toBe("COMPLETED");
    });
  });

  describe("Activity Logging", () => {
    test("should create activity logs during pipeline execution", async () => {
      const request = await createTestRequest({
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      mockIndexer.setMockReleases([MOVIE_RELEASES.INCEPTION_1080P_BLURAY]);

      await executor.startExecution(request.id, templateId);

      // Verify activity logs were created
      const logs = await prisma.activityLog.findMany({
        where: { requestId: request.id },
        orderBy: { id: "asc" },
      });

      expect(logs.length).toBeGreaterThan(0);

      // Should have logs for: starting search, quality requirement, releases found, selected release
      const logMessages = logs.map((l) => l.message);
      expect(logMessages.some((m) => m.includes("Starting search"))).toBe(true);
      expect(logMessages.some((m) => m.includes("Quality requirement"))).toBe(true);
      expect(logMessages.some((m) => m.includes("Selected release"))).toBe(true);
    });
  });
});
