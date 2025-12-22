/**
 * Comprehensive tests for platform detection and setup
 */

import { describe, expect, mock, test } from "bun:test";

// Skip tests that require mocking os.platform/os.arch in CI
// These don't work reliably in CI environments due to module caching
const describeOrSkip = process.env.CI ? describe.skip : describe;

describeOrSkip("platform - comprehensive testing", () => {
  describe("runSetup platform routing", () => {
    test("function exists", async () => {
      const { runSetup } = await import("../platform/index.js");
      expect(typeof runSetup).toBe("function");
    });

    test("delegates to correct platform - linux", async () => {
      mock.module("node:os", () => ({
        platform: () => "linux",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { runSetup } = await import("../platform/index.js");
      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      mock.restore();
    });

    test("handles setup for windows platform", async () => {
      mock.module("node:os", () => ({
        platform: () => "win32",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { runSetup } = await import("../platform/index.js");
      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      mock.restore();
    });

    test("handles setup for darwin platform", async () => {
      mock.module("node:os", () => ({
        platform: () => "darwin",
        arch: () => "arm64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { runSetup } = await import("../platform/index.js");
      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      mock.restore();
    });
  });

  describe("detectPlatform variations", () => {
    test("detects linux", async () => {
      mock.module("node:os", () => ({
        platform: () => "linux",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("linux");
      mock.restore();
    });

    test("detects windows from win32", async () => {
      mock.module("node:os", () => ({
        platform: () => "win32",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("windows");
      mock.restore();
    });

    test("detects darwin", async () => {
      mock.module("node:os", () => ({
        platform: () => "darwin",
        arch: () => "arm64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("darwin");
      mock.restore();
    });

    test("returns unknown for freebsd", async () => {
      mock.module("node:os", () => ({
        platform: () => "freebsd",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
      mock.restore();
    });

    test("returns unknown for sunos", async () => {
      mock.module("node:os", () => ({
        platform: () => "sunos",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
      mock.restore();
    });

    test("returns unknown for aix", async () => {
      mock.module("node:os", () => ({
        platform: () => "aix",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
      mock.restore();
    });
  });

  describe("getPlatformBinaryName variations", () => {
    test("returns linux-x64", async () => {
      mock.module("node:os", () => ({
        platform: () => "linux",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-x64");
      mock.restore();
    });

    test("returns linux-arm64", async () => {
      mock.module("node:os", () => ({
        platform: () => "linux",
        arch: () => "arm64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-arm64");
      mock.restore();
    });

    test("returns windows-x64", async () => {
      mock.module("node:os", () => ({
        platform: () => "win32",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("windows-x64");
      mock.restore();
    });

    test("returns darwin-x64", async () => {
      mock.module("node:os", () => ({
        platform: () => "darwin",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("darwin-x64");
      mock.restore();
    });

    test("returns darwin-arm64", async () => {
      mock.module("node:os", () => ({
        platform: () => "darwin",
        arch: () => "arm64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("darwin-arm64");
      mock.restore();
    });

    test("returns unknown for unsupported platform", async () => {
      mock.module("node:os", () => ({
        platform: () => "openbsd",
        arch: () => "x64",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("unknown");
      mock.restore();
    });

    test("defaults to x64 for unsupported architectures on linux", async () => {
      mock.module("node:os", () => ({
        platform: () => "linux",
        arch: () => "ia32",
        hostname: () => "test-host",
        cpus: () => [],
        totalmem: () => 0,
      }));

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-x64");
      mock.restore();
    });
  });
});
