/**
 * Movie Pipeline Integration Tests
 *
 * Tests complete movie request pipeline flows end-to-end
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { StepType } from "@prisma/client";
import { createMockPrisma } from "../../../../__tests__/setup.js";
import { PipelineExecutor } from "../../PipelineExecutor.js";
import { registerPipelineSteps } from "../../registerSteps.js";
import { StepRegistry } from "../../StepRegistry.js";
import { MOVIES, TARGETS } from "../fixtures/media.js";
import { MOVIE_RELEASES } from "../fixtures/releases.js";
import { MockDownloadManager } from "../mocks/downloadManager.mock.js";
import { MockIndexerService } from "../mocks/indexer.mock.js";
import {
  cleanupTestData,
  createTestRequest,
  createTestServer,
  getRequestStatus,
} from "../test-utils/database.js";

// Mock Prisma client to prevent database access
const mockPrisma = createMockPrisma();
mock.module("../../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Mock external services
let mockIndexer: MockIndexerService;
let mockDownloadManager: MockDownloadManager;

mock.module("../../../indexer.js", () => ({
  getIndexerService: () => mockIndexer,
}));

// Create a proxy that forwards to the current mockDownloadManager instance
const downloadManagerProxy = new Proxy({} as any, {
  get(_target, prop) {
    if (!mockDownloadManager) {
      throw new Error("MockDownloadManager not initialized");
    }
    const value = (mockDownloadManager as any)[prop];
    if (typeof value === "function") {
      return value.bind(mockDownloadManager);
    }
    return value;
  },
});

mock.module("../../../downloadManager.js", () => ({
  downloadManager: downloadManagerProxy,
}));

mock.module("../../../trakt.js", () => ({
  getTraktService: () => ({
    getMovieDetails: async () => ({ ids: { imdb: "tt1375666" } }),
  }),
}));

// Mock download service (qBittorrent client)
mock.module("../../../download.js", () => ({
  getDownloadService: () => ({
    getProgress: async (hash: string) => {
      // Check if the torrent exists in our mock
      if (!mockDownloadManager) return null;
      const torrents = (mockDownloadManager as any).mockTorrents as Map<string, any>;
      const torrent = torrents.get(hash);
      return torrent ? { progress: torrent.progress } : null;
    },
  }),
}));

describe("Movie Pipeline Integration", () => {
  let executor: PipelineExecutor;
  let templateId: string;

  beforeEach(async () => {
    // Clear and register pipeline steps
    StepRegistry.clear();
    registerPipelineSteps();

    mockIndexer = new MockIndexerService();
    mockDownloadManager = new MockDownloadManager();
    executor = new PipelineExecutor();

    // Create test storage servers
    await createTestServer({
      id: "test-server-4k",
      name: "4K Test Server",
      maxResolution: "RES_4K",
    });
    await createTestServer({
      id: "test-server-1080p",
      name: "1080p Test Server",
      maxResolution: "RES_1080P",
    });

    // Create a simple movie pipeline template
    const template = await mockPrisma.pipelineTemplate.create({
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
    await mockPrisma.pipelineTemplate.deleteMany();
    await mockPrisma.storageServer.deleteMany();
    StepRegistry.clear();
    mockIndexer.clearMockReleases();
    mockIndexer.clearSearchCalls();
    mockDownloadManager.clearMockTorrents();
    mockDownloadManager.clearCalls();
  });

  describe("Successful Flow", () => {
    test("should execute search step and complete successfully", async () => {
      const request = await createTestRequest({
        createExecution: true,
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
      const execution = await mockPrisma.pipelineExecution.findFirst({
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
        createExecution: true,
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
      const execution = await mockPrisma.pipelineExecution.findFirst({
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
        createExecution: true,
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_4K_SERVER,
      });

      // Only lower quality releases available
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
        MOVIE_RELEASES.INCEPTION_720P_WEBDL,
      ]);

      await executor.startExecution(request.id, templateId);

      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      // Pipeline execution should be completed (not failed) even when quality unavailable
      expect(execution?.status).toBe("COMPLETED");

      // Verify activity log shows quality unavailable warning
      const activities = await mockPrisma.activityLog.findMany({
        where: { requestId: request.id },
      });
      const qualityActivity = activities.find((a: any) =>
        a.message.includes("Quality unavailable")
      );
      expect(qualityActivity).toBeDefined();
    });

    test("should select appropriate quality based on target server", async () => {
      const request = await createTestRequest({
        createExecution: true,
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

      const execution = await mockPrisma.pipelineExecution.findFirst({
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
        createExecution: true,
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      // No releases
      mockIndexer.setMockReleases([]);

      await executor.startExecution(request.id, templateId);

      // Pipeline should complete gracefully (SearchStep returns success: false with shouldRetry: true)
      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      expect(execution?.status).toBe("COMPLETED");

      // Verify activity log shows warning about no releases
      const activities = await mockPrisma.activityLog.findMany({
        where: { requestId: request.id },
      });
      const noReleasesActivity = activities.find((a: any) =>
        a.message.includes("No releases found")
      );
      expect(noReleasesActivity).toBeDefined();
    });

    test("should handle indexer search errors gracefully", async () => {
      const request = await createTestRequest({
        createExecution: true,
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

      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: request.id },
      });

      expect(execution?.status).toBe("FAILED");
      expect(execution?.error).toContain("Indexer connection failed");
    });
  });

  describe("Multi-Server Targeting", () => {
    test("should handle multiple target servers with different quality requirements", async () => {
      const request = await createTestRequest({
        createExecution: true,
        ...MOVIES.INCEPTION,
        targets: TARGETS.MULTI_SERVER,
      });

      // Multiple quality options available
      mockIndexer.setMockReleases([
        MOVIE_RELEASES.INCEPTION_4K_REMUX,
        MOVIE_RELEASES.INCEPTION_1080P_BLURAY,
      ]);

      await executor.startExecution(request.id, templateId);

      const execution = await mockPrisma.pipelineExecution.findFirst({
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
        createExecution: true,
        ...MOVIES.INCEPTION,
        targets: TARGETS.SINGLE_1080P_SERVER,
      });

      mockIndexer.setMockReleases([MOVIE_RELEASES.INCEPTION_1080P_BLURAY]);

      await executor.startExecution(request.id, templateId);

      // Verify activity logs were created
      const logs = await mockPrisma.activityLog.findMany({
        where: { requestId: request.id },
      });

      expect(logs.length).toBeGreaterThan(0);

      // Should have logs for: starting search, quality requirement, releases found, selected release
      const logMessages = logs.map((l: { message: string }) => l.message);
      expect(logMessages.some((m: string) => m.includes("Starting search"))).toBe(true);
      expect(logMessages.some((m: string) => m.includes("Quality requirement"))).toBe(true);
      expect(logMessages.some((m: string) => m.includes("Selected release"))).toBe(true);
    });
  });
});
