/**
 * Comprehensive tests for platform detection and setup
 */

import { describe, test, expect, mock } from "bun:test";

describe("platform - comprehensive testing", () => {
  describe("runSetup platform routing", () => {
    test("function exists", () => {
      const { runSetup } = require("../platform/index.js");
      expect(typeof runSetup).toBe("function");
    });

    test("delegates to correct platform - linux", async () => {
      // Mock detectPlatform to return linux
      mock.module("os", () => ({
        platform: () => "linux",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const setupLinuxMock = mock(async () => {});
      mock.module("../platform/linux.js", () => ({
        setupLinux: setupLinuxMock,
      }));

      const { runSetup } = require("../platform/index.js");

      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      expect(setupLinuxMock).toHaveBeenCalled();
    });

    test("handles setup for windows platform", async () => {
      mock.module("os", () => ({
        platform: () => "win32",
        arch: () => "x64",
        hostname: () => "test-pc",
      }));

      const setupWindowsMock = mock(async () => {});
      mock.module("../platform/windows.js", () => ({
        setupWindows: setupWindowsMock,
      }));

      const { runSetup } = require("../platform/index.js");

      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      expect(setupWindowsMock).toHaveBeenCalled();
    });

    test("handles setup for darwin platform", async () => {
      mock.module("os", () => ({
        platform: () => "darwin",
        arch: () => "arm64",
        hostname: () => "test-mac",
      }));

      const setupDarwinMock = mock(async () => {});
      mock.module("../platform/darwin.js", () => ({
        setupDarwin: setupDarwinMock,
      }));

      const { runSetup } = require("../platform/index.js");

      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      expect(setupDarwinMock).toHaveBeenCalled();
    });
  });

  describe("detectPlatform variations", () => {
    test("detects linux", () => {
      mock.module("os", () => ({
        platform: () => "linux",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { detectPlatform } = require("../platform/index.js");
      expect(detectPlatform()).toBe("linux");
    });

    test("detects windows from win32", () => {
      mock.module("os", () => ({
        platform: () => "win32",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { detectPlatform } = require("../platform/index.js");
      expect(detectPlatform()).toBe("windows");
    });

    test("detects darwin", () => {
      mock.module("os", () => ({
        platform: () => "darwin",
        arch: () => "arm64",
        hostname: () => "test",
      }));

      const { detectPlatform } = require("../platform/index.js");
      expect(detectPlatform()).toBe("darwin");
    });

    test("returns unknown for freebsd", () => {
      mock.module("os", () => ({
        platform: () => "freebsd",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { detectPlatform } = require("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
    });

    test("returns unknown for sunos", () => {
      mock.module("os", () => ({
        platform: () => "sunos",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { detectPlatform } = require("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
    });

    test("returns unknown for aix", () => {
      mock.module("os", () => ({
        platform: () => "aix",
        arch: () => "ppc64",
        hostname: () => "test",
      }));

      const { detectPlatform } = require("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
    });
  });

  describe("getPlatformBinaryName variations", () => {
    test("returns linux-x64", () => {
      mock.module("os", () => ({
        platform: () => "linux",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-x64");
    });

    test("returns linux-arm64", () => {
      mock.module("os", () => ({
        platform: () => "linux",
        arch: () => "arm64",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-arm64");
    });

    test("returns windows-x64", () => {
      mock.module("os", () => ({
        platform: () => "win32",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("windows-x64");
    });

    test("returns darwin-x64", () => {
      mock.module("os", () => ({
        platform: () => "darwin",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("darwin-x64");
    });

    test("returns darwin-arm64", () => {
      mock.module("os", () => ({
        platform: () => "darwin",
        arch: () => "arm64",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("darwin-arm64");
    });

    test("returns unknown for unsupported platform", () => {
      mock.module("os", () => ({
        platform: () => "openbsd",
        arch: () => "x64",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("unknown");
    });

    test("defaults to x64 for unsupported architectures on linux", () => {
      mock.module("os", () => ({
        platform: () => "linux",
        arch: () => "ia32",
        hostname: () => "test",
      }));

      const { getPlatformBinaryName } = require("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-x64");
    });
  });
});
