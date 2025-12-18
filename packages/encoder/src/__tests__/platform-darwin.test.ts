/**
 * Tests for Darwin (macOS) platform setup
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";

describe("platform/darwin", () => {
  describe("setupDarwin", () => {
    describe("happy path", () => {
      test("function exists and is callable", async () => {
        const { setupDarwin } = await import("../platform/darwin.js");
        expect(typeof setupDarwin).toBe("function");
      });

      test("generates launchd plist file", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");
        const consoleSpy = spyOn(console, "log");

        const { setupDarwin } = await import("../platform/darwin.js");

        await setupDarwin({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        expect(writeFileSyncSpy).toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalled();

        const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
        expect(output).toContain("macOS launchd Setup");

        writeFileSyncSpy.mockRestore();
        consoleSpy.mockRestore();
      });

      test("generated plist contains service configuration", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupDarwin } = await import("../platform/darwin.js");

        await setupDarwin({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const plistContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes(".plist")
        )?.[1] as string;

        expect(plistContent).toContain("<?xml version");
        expect(plistContent).toContain("<plist version");
        expect(plistContent).toContain("com.annex.encoder");
        expect(plistContent).toContain("ProgramArguments");
        expect(plistContent).toContain("RunAtLoad");

        writeFileSyncSpy.mockRestore();
      });

      test("generates environment variables in plist", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupDarwin } = await import("../platform/darwin.js");

        await setupDarwin({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const plistContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes(".plist")
        )?.[1] as string;

        expect(plistContent).toContain("EnvironmentVariables");
        expect(plistContent).toContain("ANNEX_SERVER_URL");
        expect(plistContent).toContain("ANNEX_ENCODER_ID");
        expect(plistContent).toContain("ANNEX_GPU_DEVICE");

        writeFileSyncSpy.mockRestore();
      });

      test("includes hostname in encoder ID", async () => {
        const hostnameSpyResult = "test-mac";
        const hostnameSpy = spyOn(os, "hostname").mockReturnValue(hostnameSpyResult);
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupDarwin } = await import("../platform/darwin.js");

        await setupDarwin({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const plistContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes(".plist")
        )?.[1] as string;

        expect(plistContent).toContain(`encoder-${hostnameSpyResult}`);

        hostnameSpy.mockRestore();
        writeFileSyncSpy.mockRestore();
      });

      test("generates installation instructions", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");
        const consoleSpy = spyOn(console, "log");

        const { setupDarwin } = await import("../platform/darwin.js");

        await setupDarwin({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
        expect(output).toContain("launchctl");
        expect(output).toContain("com.annex.encoder");

        writeFileSyncSpy.mockRestore();
        consoleSpy.mockRestore();
      });
    });
  });
});
