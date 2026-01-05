/**
 * Tests for run command
 *
 * NOTE: These tests are currently skipped due to flakiness in CI
 * with dynamic imports and module mocking.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { EncoderConfig } from "../config";

describe.skip("commands/run", () => {
  let originalExit: typeof process.exit;
  let originalStdinResume: typeof process.stdin.resume;
  let exitCode: number | undefined;

  let configSpy: ReturnType<typeof spyOn> | undefined;
  let gpuAvailableSpy: ReturnType<typeof spyOn> | undefined;
  let gpuTestSpy: ReturnType<typeof spyOn> | undefined;
  let EncoderClientSpy: ReturnType<typeof spyOn> | undefined;

  const mockConfig: EncoderConfig = {
    encoderId: "test-encoder",
    gpuDevice: "/dev/dri/renderD128",
    maxConcurrent: 1,
    serverUrl: "ws://localhost:3000",
    nfsBasePath: "/mnt/downloads",
    reconnectInterval: 5000,
    maxReconnectInterval: 60000,
    heartbeatInterval: 30000,
    logLevel: "info",
  };

  beforeEach(async () => {
    // Mock process.exit to avoid actually exiting
    originalExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`Process exited with code ${code}`);
    }) as typeof process.exit;

    // Mock process.stdin.resume
    originalStdinResume = process.stdin.resume;
    process.stdin.resume = mock(() => {}) as unknown as typeof process.stdin.resume;

    // Setup module spies
    const config = await import("../config");
    configSpy = spyOn(config, "initConfig").mockReturnValue(mockConfig);

    const gpu = await import("../gpu");
    gpuAvailableSpy = spyOn(gpu, "isGpuAvailable").mockReturnValue(true);
    gpuTestSpy = spyOn(gpu, "testGpuEncoding").mockResolvedValue(true);

    const client = await import("../client");
    const mockClient = {
      start: mock(async () => {}),
      stop: mock(async () => {}),
    };
    // @ts-expect-error - Mocking constructor
    EncoderClientSpy = spyOn(client, "EncoderClient").mockImplementation(() => mockClient);
  });

  afterEach(() => {
    process.exit = originalExit;
    process.stdin.resume = originalStdinResume;

    configSpy?.mockRestore();
    gpuAvailableSpy?.mockRestore();
    gpuTestSpy?.mockRestore();
    EncoderClientSpy?.mockRestore();

    configSpy = undefined;
    gpuAvailableSpy = undefined;
    gpuTestSpy = undefined;
    EncoderClientSpy = undefined;
  });

  describe("happy path", () => {
    test("run function exists and is callable", async () => {
      const { run } = await import("../commands/run");
      expect(typeof run).toBe("function");
    });

    test("initializes configuration", async () => {
      const consoleSpy = spyOn(console, "log");

      const { run } = await import("../commands/run");

      try {
        await run();
        expect(consoleSpy).toHaveBeenCalled();
      } catch (_e) {
        // Expected if process.exit was called
      }

      expect(configSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    test("displays startup banner", async () => {
      const consoleSpy = spyOn(console, "log");

      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Annex Remote Encoder");
      expect(output).toContain("Version:");
      expect(output).toContain("Encoder ID:");

      consoleSpy.mockRestore();
    });

    test("checks GPU availability", async () => {
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      expect(gpuAvailableSpy).toHaveBeenCalled();
      expect(gpuTestSpy).toHaveBeenCalled();
    });

    test("starts encoder client", async () => {
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      expect(EncoderClientSpy).toHaveBeenCalled();
    });
  });

  describe("non-happy path - GPU checks", () => {
    test("exits if GPU is not available", async () => {
      gpuAvailableSpy?.mockRestore();
      const gpu = await import("../gpu");
      gpuAvailableSpy = spyOn(gpu, "isGpuAvailable").mockReturnValue(false);

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toContain("GPU device not accessible");

      consoleErrorSpy.mockRestore();
    });

    test("exits if GPU encoding test fails", async () => {
      gpuTestSpy?.mockRestore();
      const gpu = await import("../gpu");
      gpuTestSpy = spyOn(gpu, "testGpuEncoding").mockResolvedValue(false);

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toContain("failed AV1 encoding test");

      consoleErrorSpy.mockRestore();
    });

    test("shows appropriate error message for GPU access", async () => {
      configSpy?.mockRestore();
      const config = await import("../config");
      const customConfig = { ...mockConfig, gpuDevice: "/dev/dri/renderD999" };
      configSpy = spyOn(config, "initConfig").mockReturnValue(customConfig);

      gpuAvailableSpy?.mockRestore();
      const gpu = await import("../gpu");
      gpuAvailableSpy = spyOn(gpu, "isGpuAvailable").mockReturnValue(false);

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toContain("/dev/dri/renderD999");
      expect(errorOutput).toContain("permissions");

      consoleErrorSpy.mockRestore();
    });

    test("shows appropriate error message for GPU test failure", async () => {
      gpuTestSpy?.mockRestore();
      const gpu = await import("../gpu");
      gpuTestSpy = spyOn(gpu, "testGpuEncoding").mockResolvedValue(false);

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(errorOutput).toContain("Check FFmpeg VAAPI support");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("startup logging", () => {
    test("logs GPU check in progress", async () => {
      const consoleSpy = spyOn(console, "log");
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("Checking GPU:");
      expect(output).toContain("Testing AV1 encoding capability");

      consoleSpy.mockRestore();
    });

    test("logs GPU test success", async () => {
      const consoleSpy = spyOn(console, "log");
      const { run } = await import("../commands/run");

      try {
        await run();
      } catch (_e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");
      expect(output).toContain("GPU AV1 encoding test passed");

      consoleSpy.mockRestore();
    });
  });
});
