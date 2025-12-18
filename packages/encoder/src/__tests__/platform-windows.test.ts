/**
 * Tests for Windows platform setup
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";

describe("platform/windows", () => {
  describe("setupWindows", () => {
    describe("happy path", () => {
      test("function exists and is callable", async () => {
        const { setupWindows } = await import("../platform/windows.js");
        expect(typeof setupWindows).toBe("function");
      });

      test("generates PowerShell installation script", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");
        const consoleSpy = spyOn(console, "log");

        const { setupWindows } = await import("../platform/windows.js");

        await setupWindows({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        expect(writeFileSyncSpy).toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalled();

        const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
        expect(output).toContain("Windows Service Setup");

        writeFileSyncSpy.mockRestore();
        consoleSpy.mockRestore();
      });

      test("generated script contains service configuration", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupWindows } = await import("../platform/windows.js");

        await setupWindows({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const scriptContent = writeFileSyncSpy.mock.calls[0]?.[1] as string;
        expect(scriptContent).toContain("$serviceName = \"AnnexEncoder\"");
        expect(scriptContent).toContain("sc.exe create");
        expect(scriptContent).toContain("ANNEX_SERVER_URL");
        expect(scriptContent).toContain("ANNEX_ENCODER_ID");

        writeFileSyncSpy.mockRestore();
      });

      test("includes hostname in encoder ID", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupWindows } = await import("../platform/windows.js");

        await setupWindows({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const scriptContent = writeFileSyncSpy.mock.calls[0]?.[1] as string;
        // Check that ANNEX_ENCODER_ID is set with encoder- prefix
        expect(scriptContent).toContain("ANNEX_ENCODER_ID");
        expect(scriptContent).toMatch(/encoder-[\w-]+/);

        writeFileSyncSpy.mockRestore();
      });

      test("includes admin check in script", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupWindows } = await import("../platform/windows.js");

        await setupWindows({
          command: "setup" as const,
          flags: {},
          unknown: [],
        });

        const scriptContent = writeFileSyncSpy.mock.calls[0]?.[1] as string;
        expect(scriptContent).toContain("Administrator");
        expect(scriptContent).toContain("$isAdmin");

        writeFileSyncSpy.mockRestore();
      });
    });
  });
});
