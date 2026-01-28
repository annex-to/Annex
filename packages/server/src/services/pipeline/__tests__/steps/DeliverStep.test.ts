/**
 * DeliverStep Unit Tests
 *
 * Tests delivery step behavior in isolation without real server transfers
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../../__tests__/setup.js";
import { assertStepFailure, assertStepSuccess } from "../test-utils/assertions.js";
import { ContextBuilder } from "../test-utils/context-builder.js";

// Mock Prisma client to prevent database access
const mockPrisma = createMockPrisma();

// Add libraryItem model to mock prisma (not in default createMockPrisma)
const libraryItemStore = new Map<string, any>();
mockPrisma.libraryItem = {
  upsert: mock(async ({ where, create, update }: { where: any; create: any; update: any }) => {
    const key = `${where.tmdbId_type_serverId.tmdbId}-${where.tmdbId_type_serverId.type}-${where.tmdbId_type_serverId.serverId}`;
    const existing = libraryItemStore.get(key);
    const record = existing
      ? { ...existing, ...update, updatedAt: new Date() }
      : { id: key, ...create, createdAt: new Date(), updatedAt: new Date() };
    libraryItemStore.set(key, record);
    return record;
  }),
  deleteMany: mock(async () => {
    const count = libraryItemStore.size;
    libraryItemStore.clear();
    return { count };
  }),
};

mock.module("../../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Mock delivery service
let mockDeliveryService: {
  deliver: ReturnType<typeof mock>;
  fileExists: ReturnType<typeof mock>;
};

mock.module("../../../delivery.js", () => ({
  getDeliveryService: () => mockDeliveryService,
}));

// Mock naming service
let mockNamingService: {
  getMovieDestinationPath: ReturnType<typeof mock>;
  getTvDestinationPath: ReturnType<typeof mock>;
};

mock.module("../../../naming.js", () => ({
  getNamingService: () => mockNamingService,
}));

// Mock pipeline orchestrator
const mockTransitionStatus = mock(async () => ({}));

mock.module("../../PipelineOrchestrator.js", () => ({
  pipelineOrchestrator: {
    transitionStatus: mockTransitionStatus,
  },
}));

// Mock Bun.file for cleanup operations
const mockFileExists = mock(() => Promise.resolve(true));
const mockFileDelete = mock(() => Promise.resolve());
const originalBunFile = Bun.file;

// Import after mocks are set up
import { DeliverStep } from "../../steps/DeliverStep.js";

describe("DeliverStep", () => {
  beforeEach(async () => {
    mockDeliveryService = {
      deliver: mock(async () => ({
        success: true,
        serverId: "server-1",
        serverName: "Test Server",
        localPath: "/tmp/encoded.mkv",
        remotePath: "/movies/Test Movie (2020)/Test Movie (2020) [1080p AV1].mkv",
        bytesTransferred: 1024 * 1024 * 100,
        duration: 30,
        libraryScanTriggered: true,
      })),
      fileExists: mock(async () => false),
    };

    mockNamingService = {
      getMovieDestinationPath: mock(
        () => "/movies/Inception (2010) [tmdb-27205]/Inception (2010) [tmdb-27205] [1080p AV1].mkv"
      ),
      getTvDestinationPath: mock(
        () => "/tv/Breaking Bad (2008)/Season 01/Breaking Bad - S01E01 - Pilot [1080p AV1].mkv"
      ),
    };

    // Create test storage servers
    await mockPrisma.storageServer.create({
      data: {
        id: "server-1",
        name: "Server One",
        host: "localhost",
        port: 22,
        protocol: "SFTP",
        username: "test",
        encryptedPassword: "test",
        pathMovies: "/movies",
        pathTv: "/tv",
        maxResolution: "RES_4K",
        preferredCodec: "AV1",
        enabled: true,
      },
    });

    await mockPrisma.storageServer.create({
      data: {
        id: "server-2",
        name: "Server Two",
        host: "remote",
        port: 22,
        protocol: "SFTP",
        username: "test",
        encryptedPassword: "test",
        pathMovies: "/movies",
        pathTv: "/tv",
        maxResolution: "RES_1080P",
        preferredCodec: "AV1",
        enabled: true,
      },
    });

    // Mock Bun.file for cleanup tests
    mockFileExists.mockImplementation(() => Promise.resolve(true));
    mockFileDelete.mockImplementation(() => Promise.resolve());

    // @ts-expect-error - override Bun.file for tests
    Bun.file = mock((_path: string) => ({
      exists: mockFileExists,
      delete: mockFileDelete,
    }));
  });

  afterEach(async () => {
    mockPrisma._clear();
    libraryItemStore.clear();
    mockTransitionStatus.mockClear();
    mockFileExists.mockClear();
    mockFileDelete.mockClear();
    (Bun as any).file = originalBunFile;
  });

  describe("Config Validation", () => {
    test("should accept undefined config", () => {
      const step = new DeliverStep();
      expect(() => step.validateConfig(undefined)).not.toThrow();
    });

    test("should accept object config", () => {
      const step = new DeliverStep();
      expect(() => step.validateConfig({ requireAllServersSuccess: true })).not.toThrow();
    });

    test("should throw on non-object config", () => {
      const step = new DeliverStep();
      expect(() => step.validateConfig("invalid")).toThrow("DeliverStep config must be an object");
      expect(() => step.validateConfig(42)).toThrow("DeliverStep config must be an object");
      expect(() => step.validateConfig(true)).toThrow("DeliverStep config must be an object");
    });
  });

  describe("No Encoded Files", () => {
    test("should fail when encode.encodedFiles is missing", async () => {
      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-1")
        .withTargets([{ serverId: "server-1" }])
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, {});

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.error).toBe("No encoded files available for delivery");
    });

    test("should fail when encode.encodedFiles is empty array", async () => {
      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-2")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({ encodedFiles: [] })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, {});

      expect(result.success).toBe(false);
      expect(result.shouldRetry).toBe(false);
      expect(result.error).toBe("No encoded files available for delivery");
    });
  });

  describe("Movie Delivery", () => {
    test("should generate path via naming service and deliver to servers", async () => {
      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-movie")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Verify naming service was called
      expect(mockNamingService.getMovieDestinationPath).toHaveBeenCalled();

      // Verify delivery service was called
      expect(mockDeliveryService.deliver).toHaveBeenCalled();

      // Verify output data
      const deliverData = result.data?.deliver as Record<string, unknown>;
      expect(deliverData).toBeDefined();
      expect(deliverData.deliveredServers).toEqual(["server-1"]);
      expect(deliverData.failedServers).toEqual([]);
      expect(deliverData.completedAt).toBeDefined();
    });
  });

  describe("Recovery", () => {
    test("should skip delivery when all files already exist on servers", async () => {
      // All files already exist on the target servers
      mockDeliveryService.fileExists.mockImplementation(async () => true);

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-recovery")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Should NOT have called deliver (skipped)
      expect(mockDeliveryService.deliver).not.toHaveBeenCalled();

      // Verify recovery data
      const deliverData = result.data?.deliver as Record<string, unknown>;
      expect(deliverData.recovered).toBe(true);
      expect(deliverData.deliveredServers).toEqual(["server-1"]);
      expect(deliverData.failedServers).toEqual([]);
    });
  });

  describe("Partial Failure with requireAllServersSuccess=true", () => {
    test("should return success=true in failure branch when some servers succeed (known bug at line 562)", async () => {
      // This documents a known bug: when requireAllServersSuccess is true and some
      // servers fail, the code enters the failure branch (line 516+) but then returns
      // success = deliveredServers.length > 0 (line 562), which is true when partial
      // delivery succeeds. This means even though the config requires all servers to
      // succeed, the final return still reports success if at least one delivered.

      // Server-1 succeeds, server-2 fails
      let callCount = 0;
      mockDeliveryService.deliver.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            serverId: "server-1",
            serverName: "Server One",
            localPath: "/tmp/encoded/inception.mkv",
            remotePath: "/movies/inception.mkv",
            bytesTransferred: 1024 * 1024,
            duration: 10,
            libraryScanTriggered: true,
          };
        }
        return {
          success: false,
          serverId: "server-2",
          serverName: "Server Two",
          localPath: "/tmp/encoded/inception.mkv",
          remotePath: "/movies/inception.mkv",
          bytesTransferred: 0,
          duration: 0,
          error: "Connection refused",
          libraryScanTriggered: false,
        };
      });

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-partial-1")
        .withTargets([{ serverId: "server-1" }, { serverId: "server-2" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1", "server-2"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, { requireAllServersSuccess: true });

      // Known bug: the failure branch (line 562) returns success based on
      // deliveredServers.length > 0, so partial delivery still returns success=true
      expect(result.success).toBe(true);
      expect(result.shouldRetry).toBe(true);
      expect(result.error).toContain("Delivered to 1 servers, failed 1");

      const deliverData = result.data?.deliver as Record<string, unknown>;
      expect((deliverData.deliveredServers as string[]).length).toBe(1);
      expect((deliverData.failedServers as string[]).length).toBe(1);
    });
  });

  describe("Partial Failure with requireAllServersSuccess=false", () => {
    test("should return success=true when some servers succeed and requireAllServersSuccess is false", async () => {
      // When requireAllServersSuccess is false, partial success is expected.
      // The success path (line 369) evaluates to true because deliveredServers.length > 0.

      let callCount = 0;
      mockDeliveryService.deliver.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            serverId: "server-1",
            serverName: "Server One",
            localPath: "/tmp/encoded/inception.mkv",
            remotePath: "/movies/inception.mkv",
            bytesTransferred: 1024 * 1024,
            duration: 10,
            libraryScanTriggered: true,
          };
        }
        return {
          success: false,
          serverId: "server-2",
          serverName: "Server Two",
          localPath: "/tmp/encoded/inception.mkv",
          remotePath: "/movies/inception.mkv",
          bytesTransferred: 0,
          duration: 0,
          error: "Timeout",
          libraryScanTriggered: false,
        };
      });

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-partial-2")
        .withTargets([{ serverId: "server-1" }, { serverId: "server-2" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1", "server-2"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, { requireAllServersSuccess: false });

      // With requireAllServersSuccess=false, success = deliveredServers.length > 0 -> true
      // This enters the success branch (line 371)
      expect(result.success).toBe(true);

      const deliverData = result.data?.deliver as Record<string, unknown>;
      expect(deliverData.deliveredServers).toEqual(["server-1"]);
      expect((deliverData.failedServers as any[]).length).toBe(1);
    });
  });

  describe("Total Failure", () => {
    test("should return success=false when no servers succeed", async () => {
      mockDeliveryService.deliver.mockImplementation(async () => ({
        success: false,
        serverId: "server-1",
        serverName: "Server One",
        localPath: "/tmp/encoded/inception.mkv",
        remotePath: "/movies/inception.mkv",
        bytesTransferred: 0,
        duration: 0,
        error: "Disk full",
        libraryScanTriggered: false,
      }));

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-fail")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, {});

      assertStepFailure(result, "Failed to deliver to all servers");
      expect(result.shouldRetry).toBe(true);

      const deliverData = result.data?.deliver as Record<string, unknown>;
      expect(deliverData.deliveredServers).toEqual([]);
      expect((deliverData.failedServers as string[]).length).toBe(1);
    });

    test("should transition episode status to FAILED on total failure", async () => {
      mockDeliveryService.deliver.mockImplementation(async () => ({
        success: false,
        serverId: "server-1",
        serverName: "Server One",
        localPath: "/tmp/encoded/ep.mkv",
        remotePath: "/tv/show.mkv",
        bytesTransferred: 0,
        duration: 0,
        error: "Connection lost",
        libraryScanTriggered: false,
      }));

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-fail-ep")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/ep.mkv",
              targetServerIds: ["server-1"],
              resolution: "1080p",
              codec: "AV1",
              episodeId: "episode-1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      await step.execute(context, {});

      // Should have called transitionStatus for the failed episode
      expect(mockTransitionStatus).toHaveBeenCalledWith(
        "episode-1",
        "FAILED",
        expect.objectContaining({
          currentStep: "delivery_failed",
        })
      );
    });
  });

  describe("File Cleanup", () => {
    test("should delete encoded files on complete success", async () => {
      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-cleanup")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);

      // Verify Bun.file was called for cleanup
      expect(mockFileExists).toHaveBeenCalled();
      expect(mockFileDelete).toHaveBeenCalled();
    });

    test("should preserve encoded files when some servers failed", async () => {
      let callCount = 0;
      mockDeliveryService.deliver.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            serverId: "server-1",
            serverName: "Server One",
            localPath: "/tmp/encoded/inception.mkv",
            remotePath: "/movies/inception.mkv",
            bytesTransferred: 1024,
            duration: 5,
            libraryScanTriggered: true,
          };
        }
        return {
          success: false,
          serverId: "server-2",
          serverName: "Server Two",
          localPath: "/tmp/encoded/inception.mkv",
          remotePath: "/movies/inception.mkv",
          bytesTransferred: 0,
          duration: 0,
          error: "Timeout",
          libraryScanTriggered: false,
        };
      });

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("req-no-cleanup")
        .withTargets([{ serverId: "server-1" }, { serverId: "server-2" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "profile-1",
              path: "/tmp/encoded/inception.mkv",
              targetServerIds: ["server-1", "server-2"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new DeliverStep();
      // requireAllServersSuccess=false so it enters the success branch with partial failure
      const result = await step.execute(context, { requireAllServersSuccess: false });

      expect(result.success).toBe(true);

      // Files should NOT be deleted because some servers failed (failedServers.length > 0)
      expect(mockFileDelete).not.toHaveBeenCalled();
    });
  });
});
