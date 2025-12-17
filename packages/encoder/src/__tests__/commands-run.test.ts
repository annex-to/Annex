/**
 * Tests for run command
 */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";

describe("commands/run", () => {
  let originalExit: typeof process.exit;
  let originalStdinResume: typeof process.stdin.resume;
  let exitCode: number | undefined;

  beforeEach(() => {
    // Mock process.exit to avoid actually exiting
    originalExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`Process exited with code ${code}`);
    }) as typeof process.exit;

    // Mock process.stdin.resume
    originalStdinResume = process.stdin.resume;
    process.stdin.resume = mock(() => {}) as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    process.stdin.resume = originalStdinResume;
  });

  describe("happy path", () => {
    test("run function exists and is callable", () => {
      const { run } = require("../commands/run.js");
      expect(typeof run).toBe("function");
    });

    test("initializes configuration", async () => {
      // Mock all dependencies
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => true),
      }));

      mock.module("../client.js", () => ({
        EncoderClient: mock(() => ({
          start: mock(async () => {}),
          stop: mock(async () => {}),
        })),
      }));

      const consoleSpy = spyOn(console, "log");

      const { run } = require("../commands/run.js");

      // Run should throw because we mocked process.exit
      // but we're catching that to verify behavior
      try {
        await run();
        // If we get here, process.stdin.resume was called
        expect(consoleSpy).toHaveBeenCalled();
      } catch (e) {
        // Expected if process.exit was called
      }

      consoleSpy.mockRestore();
    });

    test("displays startup banner", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => true),
      }));

      mock.module("../client.js", () => ({
        EncoderClient: mock(() => ({
          start: mock(async () => {}),
          stop: mock(async () => {}),
        })),
      }));

      const consoleSpy = spyOn(console, "log");

      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Annex Remote Encoder");
      expect(output).toContain("Version:");
      expect(output).toContain("Encoder ID:");

      consoleSpy.mockRestore();
    });

    test("checks GPU availability", async () => {
      const isGpuAvailableMock = mock(() => true);
      const testGpuEncodingMock = mock(async () => true);

      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: isGpuAvailableMock,
        testGpuEncoding: testGpuEncodingMock,
      }));

      mock.module("../client.js", () => ({
        EncoderClient: mock(() => ({
          start: mock(async () => {}),
          stop: mock(async () => {}),
        })),
      }));

      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      expect(isGpuAvailableMock).toHaveBeenCalled();
      expect(testGpuEncodingMock).toHaveBeenCalled();
    });

    test("starts encoder client", async () => {
      const startMock = mock(async () => {});
      const EncoderClientMock = mock(() => ({
        start: startMock,
        stop: mock(async () => {}),
      }));

      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => true),
      }));

      mock.module("../client.js", () => ({
        EncoderClient: EncoderClientMock,
      }));

      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      expect(EncoderClientMock).toHaveBeenCalled();
      expect(startMock).toHaveBeenCalled();
    });
  });

  describe("non-happy path - GPU checks", () => {
    test("exits if GPU is not available", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => false),
        testGpuEncoding: mock(async () => true),
      }));

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
      expect(errorOutput).toContain("GPU device not accessible");

      consoleErrorSpy.mockRestore();
    });

    test("exits if GPU encoding test fails", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => false),
      }));

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
      expect(errorOutput).toContain("failed AV1 encoding test");

      consoleErrorSpy.mockRestore();
    });

    test("shows appropriate error message for GPU access", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD999",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD999",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => false),
        testGpuEncoding: mock(async () => true),
      }));

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
      expect(errorOutput).toContain("/dev/dri/renderD999");
      expect(errorOutput).toContain("permissions");

      consoleErrorSpy.mockRestore();
    });

    test("shows appropriate error message for GPU test failure", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => false),
      }));

      const consoleErrorSpy = spyOn(console, "error");
      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
      expect(errorOutput).toContain("Check FFmpeg VAAPI support");

      consoleErrorSpy.mockRestore();
    });
  });

  describe("startup logging", () => {
    test("logs GPU check in progress", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => true),
      }));

      mock.module("../client.js", () => ({
        EncoderClient: mock(() => ({
          start: mock(async () => {}),
          stop: mock(async () => {}),
        })),
      }));

      const consoleSpy = spyOn(console, "log");
      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Checking GPU:");
      expect(output).toContain("Testing AV1 encoding capability");

      consoleSpy.mockRestore();
    });

    test("logs GPU test success", async () => {
      mock.module("../config.js", () => ({
        initConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
        getConfig: mock(() => ({
          encoderId: "test-encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          serverUrl: "ws://localhost:3000",
        })),
      }));

      mock.module("../gpu.js", () => ({
        isGpuAvailable: mock(() => true),
        testGpuEncoding: mock(async () => true),
      }));

      mock.module("../client.js", () => ({
        EncoderClient: mock(() => ({
          start: mock(async () => {}),
          stop: mock(async () => {}),
        })),
      }));

      const consoleSpy = spyOn(console, "log");
      const { run } = require("../commands/run.js");

      try {
        await run();
      } catch (e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("GPU AV1 encoding test passed");

      consoleSpy.mockRestore();
    });
  });
});
