/**
 * Tests for setup command
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect, mock } from "bun:test";
import type { CliArgs } from "../cli.js";

describe("commands/setup", () => {
  describe("happy path", () => {
    test("setup function exists and is callable", async () => {
      const { setup } = await import("../commands/setup.js");
      expect(typeof setup).toBe("function");
    });

    test("delegates to platform runSetup", async () => {
      const runSetupMock = mock(async () => {});

      mock.module("../platform/index.js", () => ({
        runSetup: runSetupMock,
        detectPlatform: mock(() => "linux"),
        getPlatformBinaryName: mock(() => "linux-x64"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {},
        unknown: [],
      };

      await setup(args);

      expect(runSetupMock).toHaveBeenCalledWith(args);
    });

    test("passes through all CLI args", async () => {
      const runSetupMock = mock(async () => {});

      mock.module("../platform/index.js", () => ({
        runSetup: runSetupMock,
        detectPlatform: mock(() => "linux"),
        getPlatformBinaryName: mock(() => "linux-x64"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {
          install: true,
          user: "annex",
          workDir: "/opt/encoder",
        },
        unknown: [],
      };

      await setup(args);

      expect(runSetupMock).toHaveBeenCalledWith(args);
      const firstCall = runSetupMock.mock.calls[0]! as unknown as [CliArgs];
      expect(firstCall[0].flags.install).toBe(true);
      expect(firstCall[0].flags.user).toBe("annex");
      expect(firstCall[0].flags.workDir).toBe("/opt/encoder");
    });

    test("handles setup without install flag", async () => {
      const runSetupMock = mock(async () => {});

      mock.module("../platform/index.js", () => ({
        runSetup: runSetupMock,
        detectPlatform: mock(() => "linux"),
        getPlatformBinaryName: mock(() => "linux-x64"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {},
        unknown: [],
      };

      await setup(args);

      expect(runSetupMock).toHaveBeenCalledWith(args);
      const firstCall = runSetupMock.mock.calls[0]! as unknown as [CliArgs];
      expect(firstCall[0].flags.install).toBeUndefined();
    });
  });

  describe("non-happy path", () => {
    test("propagates errors from runSetup", async () => {
      const testError = new Error("Setup failed");
      const runSetupMock = mock(async () => {
        throw testError;
      });

      mock.module("../platform/index.js", () => ({
        runSetup: runSetupMock,
        detectPlatform: mock(() => "linux"),
        getPlatformBinaryName: mock(() => "linux-x64"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {},
        unknown: [],
      };

      await expect(setup(args)).rejects.toThrow("Setup failed");
    });

    test("handles platform detection failure", async () => {
      const runSetupMock = mock(async () => {
        throw new Error("Unsupported platform");
      });

      mock.module("../platform/index.js", () => ({
        runSetup: runSetupMock,
        detectPlatform: mock(() => "unknown"),
        getPlatformBinaryName: mock(() => "unknown"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {},
        unknown: [],
      };

      await expect(setup(args)).rejects.toThrow();
    });
  });

  describe("integration", () => {
    test("works with empty flags object", async () => {
      const runSetupMock = mock(async () => {});

      mock.module("../platform/index.js", () => ({
        runSetup: runSetupMock,
        detectPlatform: mock(() => "linux"),
        getPlatformBinaryName: mock(() => "linux-x64"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {},
        unknown: [],
      };

      await expect(setup(args)).resolves.toBeUndefined();
      expect(runSetupMock).toHaveBeenCalled();
    });

    test("returns undefined on success", async () => {
      mock.module("../platform/index.js", () => ({
        runSetup: mock(async () => {}),
        detectPlatform: mock(() => "linux"),
        getPlatformBinaryName: mock(() => "linux-x64"),
      }));

      const { setup } = await import("../commands/setup.js");

      const args = {
        command: "setup" as const,
        flags: {},
        unknown: [],
      };

      const result = await setup(args);
      expect(result).toBeUndefined();
    });
  });
});
