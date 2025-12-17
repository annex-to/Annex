/**
 * Tests for platform detection
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import * as os from "os";

describe("platform/index", () => {
  describe("detectPlatform", () => {
    describe("happy path", () => {
      test("detects linux platform", () => {
        const mockPlatform = mock(() => "linux");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: () => "x64",
          hostname: () => "test",
        }));

        const { detectPlatform } = require("../platform/index.js");
        expect(detectPlatform()).toBe("linux");
      });

      test("detects windows platform from win32", () => {
        const mockPlatform = mock(() => "win32");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: () => "x64",
          hostname: () => "test",
        }));

        const { detectPlatform } = require("../platform/index.js");
        expect(detectPlatform()).toBe("windows");
      });

      test("detects darwin platform", () => {
        const mockPlatform = mock(() => "darwin");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: () => "arm64",
          hostname: () => "test",
        }));

        const { detectPlatform } = require("../platform/index.js");
        expect(detectPlatform()).toBe("darwin");
      });
    });

    describe("non-happy path", () => {
      test("returns unknown for unsupported platform", () => {
        const mockPlatform = mock(() => "freebsd");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: () => "x64",
          hostname: () => "test",
        }));

        const { detectPlatform } = require("../platform/index.js");
        expect(detectPlatform()).toBe("unknown");
      });

      test("returns unknown for aix", () => {
        const mockPlatform = mock(() => "aix");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: () => "ppc64",
          hostname: () => "test",
        }));

        const { detectPlatform } = require("../platform/index.js");
        expect(detectPlatform()).toBe("unknown");
      });

      test("returns unknown for sunos", () => {
        const mockPlatform = mock(() => "sunos");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: () => "x64",
          hostname: () => "test",
        }));

        const { detectPlatform } = require("../platform/index.js");
        expect(detectPlatform()).toBe("unknown");
      });
    });
  });

  describe("getPlatformBinaryName", () => {
    describe("happy path", () => {
      test("returns non-empty string", () => {
        const { getPlatformBinaryName } = require("../platform/index.js");
        const result = getPlatformBinaryName();
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
        // Can be either "platform-arch" or "unknown"
        expect(result === "unknown" || result.includes("-")).toBe(true);
      });
    });

    describe("non-happy path", () => {
      test("handles unknown platforms gracefully", () => {
        const mockPlatform = mock(() => "openbsd");
        const mockArch = mock(() => "x64");
        mock.module("os", () => ({
          platform: mockPlatform,
          arch: mockArch,
          hostname: () => "test",
        }));

        const { getPlatformBinaryName } = require("../platform/index.js");
        expect(getPlatformBinaryName()).toBe("unknown");
      });
    });
  });
});
