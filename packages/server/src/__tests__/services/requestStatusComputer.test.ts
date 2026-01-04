import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { MediaType, ProcessingStatus, RequestStatus } from "@prisma/client";
import { createMockPrisma } from "../setup.js";

// Mock the db/client module
const mockPrisma = createMockPrisma();
mock.module("../../db/client.js", () => ({
  prisma: mockPrisma,
}));

// Import after mocking
import { RequestStatusComputer } from "../../services/requestStatusComputer.js";

describe("RequestStatusComputer", () => {
  const computer = new RequestStatusComputer();

  beforeEach(async () => {
    // Clear mock data
    mockPrisma._clear();
  });

  describe("computeStatus", () => {
    test("returns COMPLETED when all items are completed", async () => {
      // Create test request
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-completed",
          type: "MOVIE" as MediaType,
          tmdbId: 123,
          title: "Test Movie",
          year: 2024,
          status: "PENDING" as RequestStatus, // Old field, should be ignored
          progress: 0,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
        },
      });

      // Create completed processing items
      await mockPrisma.processingItem.createMany({
        data: [
          {
            id: "test-item-1",
            requestId: request.id,
            type: "MOVIE",
            tmdbId: 123,
            title: "Test Movie",
            status: "COMPLETED" as ProcessingStatus,
            progress: 100,
            currentStep: null,
          },
          {
            id: "test-item-2",
            requestId: request.id,
            type: "MOVIE",
            tmdbId: 123,
            title: "Test Movie",
            status: "COMPLETED" as ProcessingStatus,
            progress: 100,
            currentStep: null,
          },
        ],
      });

      const result = await computer.computeStatus(request.id);

      expect(result.status).toBe("COMPLETED");
      expect(result.progress).toBe(100);
      expect(result.totalItems).toBe(2);
      expect(result.completedItems).toBe(2);
      expect(result.failedItems).toBe(0);
      expect(result.error).toBeNull();
    });

    test("returns FAILED when all items are failed", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-failed",
          type: "MOVIE" as MediaType,
          tmdbId: 124,
          title: "Test Movie 2",
          year: 2024,
          status: "PENDING" as RequestStatus,
          progress: 0,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
        },
      });

      await mockPrisma.processingItem.create({
        data: {
          id: "test-item-3",
          requestId: request.id,
          type: "MOVIE",
          tmdbId: 124,
          title: "Test Movie 2",
          status: "FAILED" as ProcessingStatus,
          progress: 50,
          lastError: "Test error message",
          currentStep: "DOWNLOAD",
        },
      });

      const result = await computer.computeStatus(request.id);

      expect(result.status).toBe("FAILED");
      expect(result.totalItems).toBe(1);
      expect(result.failedItems).toBe(1);
      expect(result.error).toBe("Test error message");
    });

    test("returns PARTIAL when some items completed and some failed", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-partial",
          type: "TV" as MediaType,
          tmdbId: 125,
          title: "Test Show",
          year: 2024,
          status: "PENDING" as RequestStatus,
          progress: 0,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
        },
      });

      await mockPrisma.processingItem.createMany({
        data: [
          {
            id: "test-item-4",
            requestId: request.id,
            type: "EPISODE",
            tmdbId: 125,
            title: "Episode 1",
            season: 1,
            episode: 1,
            status: "COMPLETED" as ProcessingStatus,
            progress: 100,
          },
          {
            id: "test-item-5",
            requestId: request.id,
            type: "EPISODE",
            tmdbId: 125,
            title: "Episode 2",
            season: 1,
            episode: 2,
            status: "FAILED" as ProcessingStatus,
            progress: 75,
            lastError: "Download failed",
          },
        ],
      });

      const result = await computer.computeStatus(request.id);

      expect(result.status).toBe("PARTIAL");
      expect(result.totalItems).toBe(2);
      expect(result.completedItems).toBe(1);
      expect(result.failedItems).toBe(1);
      expect(result.progress).toBe(87.5); // Average of 100 and 75
    });

    test("returns DOWNLOADING when any item is downloading", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-downloading",
          type: "MOVIE" as MediaType,
          tmdbId: 126,
          title: "Test Movie 3",
          year: 2024,
          status: "PENDING" as RequestStatus,
          progress: 0,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
        },
      });

      await mockPrisma.processingItem.create({
        data: {
          id: "test-item-6",
          requestId: request.id,
          type: "MOVIE",
          tmdbId: 126,
          title: "Test Movie 3",
          status: "DOWNLOADING" as ProcessingStatus,
          progress: 45,
          currentStep: "DOWNLOAD",
        },
      });

      const result = await computer.computeStatus(request.id);

      expect(result.status).toBe("DOWNLOADING");
      expect(result.progress).toBe(45);
      expect(result.currentStep).toBe("DOWNLOAD");
      expect(result.currentStepStartedAt).not.toBeNull();
    });

    test("falls back to MediaRequest fields when no ProcessingItems exist", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-legacy",
          type: "MOVIE" as MediaType,
          tmdbId: 127,
          title: "Legacy Movie",
          year: 2024,
          status: "COMPLETED" as RequestStatus,
          progress: 100,
          currentStep: "DELIVER",
          error: null,
          totalItems: 1,
          completedItems: 1,
          failedItems: 0,
        },
      });

      // No ProcessingItems created - legacy request

      const result = await computer.computeStatus(request.id);

      expect(result.status).toBe("COMPLETED");
      expect(result.progress).toBe(100);
      expect(result.currentStep).toBe("DELIVER");
      expect(result.totalItems).toBe(1);
      expect(result.completedItems).toBe(1);
    });
  });

  describe("batchComputeStatus", () => {
    test("computes status for multiple requests efficiently", async () => {
      // Create multiple test requests
      const requests = await Promise.all([
        mockPrisma.mediaRequest.create({
          data: {
            id: "test-batch-1",
            type: "MOVIE" as MediaType,
            tmdbId: 201,
            title: "Batch Test 1",
            year: 2024,
            status: "PENDING" as RequestStatus,
            progress: 0,
            totalItems: 0,
            completedItems: 0,
            failedItems: 0,
          },
        }),
        mockPrisma.mediaRequest.create({
          data: {
            id: "test-batch-2",
            type: "MOVIE" as MediaType,
            tmdbId: 202,
            title: "Batch Test 2",
            year: 2024,
            status: "PENDING" as RequestStatus,
            progress: 0,
            totalItems: 0,
            completedItems: 0,
            failedItems: 0,
          },
        }),
      ]);

      // Create items for first request
      await mockPrisma.processingItem.create({
        data: {
          id: "test-batch-item-1",
          requestId: requests[0].id,
          type: "MOVIE",
          tmdbId: 201,
          title: "Batch Test 1",
          status: "COMPLETED" as ProcessingStatus,
          progress: 100,
        },
      });

      // Create items for second request
      await mockPrisma.processingItem.create({
        data: {
          id: "test-batch-item-2",
          requestId: requests[1].id,
          type: "MOVIE",
          tmdbId: 202,
          title: "Batch Test 2",
          status: "DOWNLOADING" as ProcessingStatus,
          progress: 50,
          currentStep: "DOWNLOAD",
        },
      });

      const results = await computer.batchComputeStatus([requests[0].id, requests[1].id]);

      expect(results.size).toBe(2);

      const result1 = results.get(requests[0].id);
      expect(result1?.status).toBe("COMPLETED");
      expect(result1?.progress).toBe(100);

      const result2 = results.get(requests[1].id);
      expect(result2?.status).toBe("DOWNLOADING");
      expect(result2?.progress).toBe(50);
    });
  });

  describe("getReleaseMetadata", () => {
    test("returns metadata from Download model", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-metadata",
          type: "MOVIE" as MediaType,
          tmdbId: 301,
          title: "Test Metadata Movie",
          year: 2024,
          status: "COMPLETED" as RequestStatus,
          progress: 100,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
        },
      });

      await mockPrisma.download.create({
        data: {
          id: "test-download-1",
          requestId: request.id,
          torrentHash: "test-hash-123",
          torrentName: "Test.Movie.2024.1080p.BluRay.x264",
          mediaType: "MOVIE" as MediaType,
          status: "COMPLETED",
          progress: 100,
          size: BigInt(5000000000), // 5GB
          indexerName: "TestIndexer",
          resolution: "1080p",
          source: "BluRay",
          codec: "x264",
          qualityScore: 95,
          seedCount: 50,
          peerCount: 10,
          publishDate: new Date("2024-01-15"),
        },
      });

      const metadata = await computer.getReleaseMetadata(request.id);

      expect(metadata).not.toBeNull();
      expect(metadata?.indexerName).toBe("TestIndexer");
      expect(metadata?.resolution).toBe("1080p");
      expect(metadata?.source).toBe("BluRay");
      expect(metadata?.codec).toBe("x264");
      expect(metadata?.score).toBe(95);
      expect(metadata?.seeders).toBe(50);
      expect(metadata?.leechers).toBe(10);
      expect(metadata?.fileSize).toBe(5000000000);
    });

    test("falls back to MediaRequest fields when Download has no metadata", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-metadata-legacy",
          type: "MOVIE" as MediaType,
          tmdbId: 302,
          title: "Legacy Metadata Movie",
          year: 2024,
          status: "COMPLETED" as RequestStatus,
          progress: 100,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
          releaseIndexerName: "LegacyIndexer",
          releaseResolution: "720p",
          releaseSource: "WEB-DL",
          releaseCodec: "HEVC",
          releaseScore: 85,
          releaseSeeders: 100,
          releaseLeechers: 20,
          releaseFileSize: BigInt(2500000000),
          releaseName: "Legacy.Movie.720p.WEB-DL.HEVC",
        },
      });

      const metadata = await computer.getReleaseMetadata(request.id);

      expect(metadata).not.toBeNull();
      expect(metadata?.indexerName).toBe("LegacyIndexer");
      expect(metadata?.resolution).toBe("720p");
      expect(metadata?.source).toBe("WEB-DL");
      expect(metadata?.codec).toBe("HEVC");
      expect(metadata?.score).toBe(85);
      expect(metadata?.seeders).toBe(100);
      expect(metadata?.leechers).toBe(20);
    });

    test("returns null when no metadata exists", async () => {
      const request = await mockPrisma.mediaRequest.create({
        data: {
          id: "test-no-metadata",
          type: "MOVIE" as MediaType,
          tmdbId: 303,
          title: "No Metadata Movie",
          year: 2024,
          status: "PENDING" as RequestStatus,
          progress: 0,
          totalItems: 0,
          completedItems: 0,
          failedItems: 0,
        },
      });

      const metadata = await computer.getReleaseMetadata(request.id);

      expect(metadata).toBeNull();
    });
  });
});
