/**
 * Comprehensive tests for platform detection and setup
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as os from "node:os";

describe("platform - comprehensive testing", () => {
  let platformSpy: ReturnType<typeof spyOn> | undefined;
  let archSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    platformSpy?.mockRestore();
    archSpy?.mockRestore();
    platformSpy = undefined;
    archSpy = undefined;
  });

  describe("runSetup platform routing", () => {
    test("function exists", async () => {
      const { runSetup } = await import("../platform/index.js");
      expect(typeof runSetup).toBe("function");
    });

    test("delegates to correct platform - linux", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("linux");
      archSpy = spyOn(os, "arch").mockReturnValue("x64");

      const { runSetup } = await import("../platform/index.js");
      const setupLinux = await import("../platform/linux.js");
      const setupSpy = spyOn(setupLinux, "setupLinux").mockResolvedValue(undefined);

      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      expect(setupSpy).toHaveBeenCalled();
      setupSpy.mockRestore();
    });

    test("handles setup for windows platform", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("win32");
      archSpy = spyOn(os, "arch").mockReturnValue("x64");

      const { runSetup } = await import("../platform/index.js");
      const setupWindows = await import("../platform/windows.js");
      const setupSpy = spyOn(setupWindows, "setupWindows").mockResolvedValue(undefined);

      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      expect(setupSpy).toHaveBeenCalled();
      setupSpy.mockRestore();
    });

    test("handles setup for darwin platform", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("darwin");
      archSpy = spyOn(os, "arch").mockReturnValue("arm64");

      const { runSetup } = await import("../platform/index.js");
      const setupDarwin = await import("../platform/darwin.js");
      const setupSpy = spyOn(setupDarwin, "setupDarwin").mockResolvedValue(undefined);

      await runSetup({
        command: "setup" as const,
        flags: {},
        unknown: [],
      });

      expect(setupSpy).toHaveBeenCalled();
      setupSpy.mockRestore();
    });
  });

  describe("detectPlatform variations", () => {
    test("detects linux", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("linux");

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("linux");
    });

    test("detects windows from win32", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("win32");

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("windows");
    });

    test("detects darwin", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("darwin");

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("darwin");
    });

    test("returns unknown for freebsd", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("freebsd");

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
    });

    test("returns unknown for sunos", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("sunos");

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
    });

    test("returns unknown for aix", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("aix");

      const { detectPlatform } = await import("../platform/index.js");
      expect(detectPlatform()).toBe("unknown");
    });
  });

  describe("getPlatformBinaryName variations", () => {
    test("returns linux-x64", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("linux");
      archSpy = spyOn(os, "arch").mockReturnValue("x64");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-x64");
    });

    test("returns linux-arm64", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("linux");
      archSpy = spyOn(os, "arch").mockReturnValue("arm64");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-arm64");
    });

    test("returns windows-x64", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("win32");
      archSpy = spyOn(os, "arch").mockReturnValue("x64");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("windows-x64");
    });

    test("returns darwin-x64", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("darwin");
      archSpy = spyOn(os, "arch").mockReturnValue("x64");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("darwin-x64");
    });

    test("returns darwin-arm64", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("darwin");
      archSpy = spyOn(os, "arch").mockReturnValue("arm64");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("darwin-arm64");
    });

    test("returns unknown for unsupported platform", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("openbsd");
      archSpy = spyOn(os, "arch").mockReturnValue("x64");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("unknown");
    });

    test("defaults to x64 for unsupported architectures on linux", async () => {
      platformSpy = spyOn(os, "platform").mockReturnValue("linux");
      archSpy = spyOn(os, "arch").mockReturnValue("ia32");

      const { getPlatformBinaryName } = await import("../platform/index.js");
      expect(getPlatformBinaryName()).toBe("linux-x64");
    });
  });
});
