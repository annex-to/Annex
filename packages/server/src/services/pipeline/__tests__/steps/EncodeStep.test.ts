/**
 * EncodeStep Unit Tests
 *
 * Tests encoding step behavior in isolation without real encoder calls
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../../__tests__/setup.js";

// Mock Prisma client to prevent database access
const mockPrisma = createMockPrisma();

// Add findFirst for encoderAssignment (not in default mock)
mockPrisma.encoderAssignment.findFirst = mock(async () => null);

// Track what findUnique should return for encoder assignments
// Override default since EncodeStep uses where.id but the mock expects where.jobId
let mockAssignmentStatus: any = null;
mockPrisma.encoderAssignment.findUnique = mock(async () => mockAssignmentStatus);

mock.module("../../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Mock encoder dispatch service
const mockEncoderService = {
  queueEncodingJob: mock(async () => ({
    id: "test-assignment-id",
    jobId: "test-job-id",
    status: "PENDING",
    progress: 0,
    outputPath: null,
    outputSize: null,
    compressionRatio: null,
    error: null,
    speed: null,
    eta: null,
    assignedAt: new Date(),
    completedAt: null,
  })),
};

mock.module("../../../encoderDispatch.js", () => ({
  getEncoderDispatchService: () => mockEncoderService,
}));

// Mock pipeline orchestrator
const mockOrchestrator = {
  transitionStatus: mock(async () => ({})),
  updateProgress: mock(async () => ({})),
};

mock.module("../../PipelineOrchestrator.js", () => ({
  pipelineOrchestrator: mockOrchestrator,
}));

// Import AFTER all mock.module calls
import { EncodeStep } from "../../steps/EncodeStep.js";
import { assertStepData, assertStepFailure, assertStepSuccess } from "../test-utils/assertions.js";
import { ContextBuilder } from "../test-utils/context-builder.js";

// Store original Bun.file for restoration
const originalBunFile = Bun.file.bind(Bun);
let mockFileExists = true;

describe("EncodeStep", () => {
  beforeEach(() => {
    mockFileExists = true;
    mockAssignmentStatus = null;

    // Mock Bun.file().exists() to control file existence checks
    (Bun as any).file = (path: string) => ({
      exists: async () => mockFileExists,
      name: path,
    });
  });

  afterEach(() => {
    (Bun as any).file = originalBunFile;
    mockPrisma._clear();
    mockEncoderService.queueEncodingJob.mockClear();
    mockOrchestrator.transitionStatus.mockClear();
    mockOrchestrator.updateProgress.mockClear();
  });

  describe("Config Validation", () => {
    test("should accept undefined config", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig(undefined)).not.toThrow();
    });

    test("should accept null config", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig(null)).not.toThrow();
    });

    test("should throw on non-object config", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig("invalid")).toThrow("EncodeStep config must be an object");
      expect(() => step.validateConfig(42)).toThrow("EncodeStep config must be an object");
      expect(() => step.validateConfig(true)).toThrow("EncodeStep config must be an object");
    });

    test("should accept valid CRF values (0-51)", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ crf: 0 })).not.toThrow();
      expect(() => step.validateConfig({ crf: 28 })).not.toThrow();
      expect(() => step.validateConfig({ crf: 51 })).not.toThrow();
    });

    test("should throw on invalid CRF values", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ crf: -1 })).toThrow(
        "crf must be a number between 0 and 51"
      );
      expect(() => step.validateConfig({ crf: 52 })).toThrow(
        "crf must be a number between 0 and 51"
      );
      expect(() => step.validateConfig({ crf: "high" })).toThrow(
        "crf must be a number between 0 and 51"
      );
    });

    test("should accept valid preset values", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ preset: "fast" })).not.toThrow();
      expect(() => step.validateConfig({ preset: "medium" })).not.toThrow();
      expect(() => step.validateConfig({ preset: "slow" })).not.toThrow();
    });

    test("should throw on invalid preset", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ preset: "ultrafast" })).toThrow(
        "preset must be one of: fast, medium, slow"
      );
      expect(() => step.validateConfig({ preset: "veryslow" })).toThrow(
        "preset must be one of: fast, medium, slow"
      );
    });

    test("should accept valid maxResolution values", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ maxResolution: "480p" })).not.toThrow();
      expect(() => step.validateConfig({ maxResolution: "720p" })).not.toThrow();
      expect(() => step.validateConfig({ maxResolution: "1080p" })).not.toThrow();
      expect(() => step.validateConfig({ maxResolution: "2160p" })).not.toThrow();
    });

    test("should throw on invalid maxResolution", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ maxResolution: "4K" })).toThrow(
        "maxResolution must be one of: 480p, 720p, 1080p, 2160p"
      );
      expect(() => step.validateConfig({ maxResolution: "360p" })).toThrow(
        "maxResolution must be one of: 480p, 720p, 1080p, 2160p"
      );
    });

    test("should accept valid hwAccel values", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ hwAccel: "NONE" })).not.toThrow();
      expect(() => step.validateConfig({ hwAccel: "QSV" })).not.toThrow();
      expect(() => step.validateConfig({ hwAccel: "NVENC" })).not.toThrow();
      expect(() => step.validateConfig({ hwAccel: "VAAPI" })).not.toThrow();
      expect(() => step.validateConfig({ hwAccel: "AMF" })).not.toThrow();
      expect(() => step.validateConfig({ hwAccel: "VIDEOTOOLBOX" })).not.toThrow();
    });

    test("should throw on invalid hwAccel", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ hwAccel: "CUDA" })).toThrow(
        "hwAccel must be one of: NONE, QSV, NVENC, VAAPI, AMF, VIDEOTOOLBOX"
      );
    });

    test("should accept valid subtitlesMode values", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ subtitlesMode: "COPY" })).not.toThrow();
      expect(() => step.validateConfig({ subtitlesMode: "COPY_TEXT" })).not.toThrow();
      expect(() => step.validateConfig({ subtitlesMode: "EXTRACT" })).not.toThrow();
      expect(() => step.validateConfig({ subtitlesMode: "NONE" })).not.toThrow();
    });

    test("should throw on invalid subtitlesMode", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ subtitlesMode: "BURN" })).toThrow(
        "subtitlesMode must be one of: COPY, COPY_TEXT, EXTRACT, NONE"
      );
    });

    test("should accept valid container values", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ container: "MKV" })).not.toThrow();
      expect(() => step.validateConfig({ container: "MP4" })).not.toThrow();
      expect(() => step.validateConfig({ container: "WEBM" })).not.toThrow();
    });

    test("should throw on invalid container", () => {
      const step = new EncodeStep();
      expect(() => step.validateConfig({ container: "AVI" })).toThrow(
        "container must be one of: MKV, MP4, WEBM"
      );
    });
  });

  describe("Recovery", () => {
    test("should skip encoding when context already has encodedFiles", async () => {
      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("test-request-recovery")
        .withTargets([{ serverId: "server-1" }])
        .withEncodeResult({
          encodedFiles: [
            {
              profileId: "default",
              path: "/encoded/inception.mkv",
              targetServerIds: ["server-1"],
              resolution: "1080p",
              codec: "AV1",
            },
          ],
        })
        .build();

      const step = new EncodeStep();
      const result = await step.execute(context, {});

      assertStepSuccess(result);
      assertStepData(result, "encode");

      const encodeData = result.data?.encode as Record<string, unknown>;
      const files = encodeData.encodedFiles as Array<Record<string, unknown>>;
      expect(files.length).toBe(1);
      expect(files[0].path).toBe("/encoded/inception.mkv");

      // Should NOT have created any encoding job
      expect(mockEncoderService.queueEncodingJob).not.toHaveBeenCalled();
    });
  });

  describe("No Source File", () => {
    test("should fail when context has no download.sourceFilePath", async () => {
      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("test-request-nosource")
        .withTargets([{ serverId: "server-1" }])
        .build();

      const step = new EncodeStep();
      const result = await step.execute(context, {});

      assertStepFailure(
        result,
        "No source file path or episode files available from download step"
      );
    });

    test("should fail when source file does not exist on disk", async () => {
      mockFileExists = false;

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("test-request-nofile")
        .withTargets([{ serverId: "server-1" }])
        .withDownloadResult({
          torrentHash: "abc123",
          sourceFilePath: "/downloads/nonexistent.mkv",
        })
        .build();

      const step = new EncodeStep();
      const result = await step.execute(context, {});

      assertStepFailure(result, "Source file not found");
    });
  });

  describe("Happy Path", () => {
    test("should create encoding job and return encoded file on completion", async () => {
      mockFileExists = true;

      // Set up the assignment status to return COMPLETED on first poll
      mockAssignmentStatus = {
        id: "test-assignment-id",
        jobId: "test-job-id",
        status: "COMPLETED",
        progress: 100,
        outputPath: "/downloads/encoded_output.mkv",
        outputSize: BigInt(2_000_000_000),
        compressionRatio: 0.4,
        error: null,
        speed: null,
        eta: null,
      };

      const context = new ContextBuilder()
        .forMovie("Inception", 2010, 27205)
        .withRequestId("test-request-happy")
        .withTargets([{ serverId: "server-1", encodingProfileId: "profile-1" }])
        .withDownloadResult({
          torrentHash: "abc123",
          sourceFilePath: "/downloads/Inception.2010.1080p.BluRay/movie.mkv",
        })
        .build();

      const step = new EncodeStep();
      const result = await step.execute(context, {
        pollInterval: 1,
        timeout: 5000,
      });

      assertStepSuccess(result);
      assertStepData(result, "encode");

      const encodeData = result.data?.encode as Record<string, unknown>;
      const files = encodeData.encodedFiles as Array<Record<string, unknown>>;
      expect(files.length).toBe(1);
      expect(files[0].path).toBe("/downloads/encoded_output.mkv");
      expect(files[0].targetServerIds).toEqual(["server-1"]);
      expect(files[0].codec).toBe("AV1");
      expect(files[0].resolution).toBe("1080p");
      expect(files[0].profileId).toBe("profile-1");
      expect(files[0].size).toBe(2_000_000_000);
      expect(files[0].compressionRatio).toBe(0.4);

      // Verify encoder service was called
      expect(mockEncoderService.queueEncodingJob).toHaveBeenCalledTimes(1);
    });
  });
});
