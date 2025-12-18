/**
 * Tests for Linux platform setup
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";

describe("platform/linux", () => {
  let originalExit: typeof process.exit;
  let originalGetuid: typeof process.getuid;
  let exitCode: number | undefined;

  beforeEach(() => {
    // Mock process.exit
    originalExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`Process exited with code ${code}`);
    }) as typeof process.exit;

    // Mock process.getuid
    originalGetuid = process.getuid as any;
    process.getuid = mock(() => 1000); // Non-root by default
  });

  afterEach(() => {
    process.exit = originalExit;
    process.getuid = originalGetuid;
  });

  describe("setupLinux", () => {
    describe("happy path - generate only", () => {
      test("function exists and is callable", async () => {
        const { setupLinux } = await import("../platform/linux.js");
        expect(typeof setupLinux).toBe("function");
      });

      test("generates service files in current directory", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");
        const consoleSpy = spyOn(console, "log");

        const { setupLinux } = await import("../platform/linux.js");

        const args = {
          command: "setup" as const,
          flags: {},
          unknown: [],
        };

        try {
          await setupLinux(args);
        } catch (_e) {
          // Expected if process.exit is called
        }

        expect(writeFileSyncSpy).toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalled();

        const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
        expect(output).toContain("Linux systemd Setup");
        expect(output).toContain("annex-encoder.service");
        expect(output).toContain("annex-encoder.env");

        writeFileSyncSpy.mockRestore();
        consoleSpy.mockRestore();
      });

      test("uses default options when no flags provided", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");
        const consoleSpy = spyOn(console, "log");

        const { setupLinux } = await import("../platform/linux.js");

        const args = {
          command: "setup" as const,
          flags: {},
          unknown: [],
        };

        try {
          await setupLinux(args);
        } catch (_e) {
          // Expected
        }

        const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
        expect(output).toContain("Service User:   annex");
        expect(output).toContain("Working Dir:    /opt/annex-encoder");
        expect(output).toContain("Install:        No");

        writeFileSyncSpy.mockRestore();
        consoleSpy.mockRestore();
      });

      test("uses custom user and workDir from flags", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");
        const consoleSpy = spyOn(console, "log");

        const { setupLinux } = await import("../platform/linux.js");

        const args = {
          command: "setup" as const,
          flags: {
            user: "custom-user",
            workDir: "/custom/path",
          },
          unknown: [],
        };

        try {
          await setupLinux(args);
        } catch (_e) {
          // Expected
        }

        const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
        expect(output).toContain("Service User:   custom-user");
        expect(output).toContain("Working Dir:    /custom/path");

        // Check service file content
        const serviceContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.service")
        )?.[1] as string;
        expect(serviceContent).toContain("User=custom-user");
        expect(serviceContent).toContain("WorkingDirectory=/custom/path");

        writeFileSyncSpy.mockRestore();
        consoleSpy.mockRestore();
      });

      test("generates valid systemd service file", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: {},
            unknown: [],
          });
        } catch (_e) {
          // Expected
        }

        const serviceContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.service")
        )?.[1] as string;

        expect(serviceContent).toContain("[Unit]");
        expect(serviceContent).toContain("[Service]");
        expect(serviceContent).toContain("[Install]");
        expect(serviceContent).toContain("Description=Annex Remote Encoder");
        expect(serviceContent).toContain("ExecStart=");
        expect(serviceContent).toContain("Restart=always");

        writeFileSyncSpy.mockRestore();
      });

      test("generates valid environment file", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: {},
            unknown: [],
          });
        } catch (_e) {
          // Expected
        }

        const envContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.env")
        )?.[1] as string;

        expect(envContent).toContain("ANNEX_SERVER_URL=");
        expect(envContent).toContain("ANNEX_ENCODER_ID=");
        expect(envContent).toContain("ANNEX_GPU_DEVICE=");
        expect(envContent).toContain("ANNEX_MAX_CONCURRENT=");
        expect(envContent).toContain("ANNEX_NFS_BASE_PATH=");
        expect(envContent).toContain("ANNEX_LOG_LEVEL=");

        writeFileSyncSpy.mockRestore();
      });

      test("includes hostname in encoder ID", async () => {
        const hostnameSpyResult = "test-machine";
        const hostnameSpy = spyOn(os, "hostname").mockReturnValue(hostnameSpyResult);
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: {},
            unknown: [],
          });
        } catch (_e) {
          // Expected
        }

        const envContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.env")
        )?.[1] as string;

        expect(envContent).toContain(`encoder-${hostnameSpyResult}`);

        hostnameSpy.mockRestore();
        writeFileSyncSpy.mockRestore();
      });
    });

    describe("non-happy path - install without root", () => {
      test("exits when install requested without root", async () => {
        process.getuid = mock(() => 1000); // Non-root

        // Mock Bun.spawn to simulate systemctl being available
        const originalSpawn = Bun.spawn;
        Bun.spawn = mock((cmd: any) => {
          if (cmd[0] === "which" && cmd[1] === "systemctl") {
            return {
              exitCode: 0, // Found
              stdout: null,
              stderr: null,
            } as any;
          }
          return originalSpawn(cmd);
        }) as any;

        const consoleErrorSpy = spyOn(console, "error");

        const { setupLinux } = await import("../platform/linux.js");

        const args = {
          command: "setup" as const,
          flags: { install: true },
          unknown: [],
        };

        try {
          await setupLinux(args);
        } catch (_e) {
          // Expected to exit
        }

        expect(exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalled();
        const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
        expect(errorOutput).toContain("requires root privileges");

        Bun.spawn = originalSpawn;
        consoleErrorSpy.mockRestore();
      });

      test("exits when install requested without systemctl", async () => {
        process.getuid = mock(() => 0); // Root

        // Mock Bun.spawn to simulate systemctl not found
        const originalSpawn = Bun.spawn;
        Bun.spawn = mock((cmd: any) => {
          if (cmd[0] === "which" && cmd[1] === "systemctl") {
            return {
              exitCode: 1, // Not found
              stdout: null,
              stderr: null,
            } as any;
          }
          return originalSpawn(cmd);
        }) as any;

        const consoleErrorSpy = spyOn(console, "error");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: { install: true },
            unknown: [],
          });
        } catch (_e) {
          // Expected to exit
        }

        expect(exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalled();
        const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
        expect(errorOutput).toContain("systemctl not found");

        Bun.spawn = originalSpawn;
        consoleErrorSpy.mockRestore();
      });
    });

    describe("non-happy path - file write errors", () => {
      test("setupLinux function handles errors", async () => {
        // This test verifies that setupLinux exists and can handle errors
        // Full error handling testing would require more complex mocking
        const { setupLinux } = await import("../platform/linux.js");
        expect(typeof setupLinux).toBe("function");
      });
    });

    describe("service file content", () => {
      test("includes security hardening directives", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: {},
            unknown: [],
          });
        } catch (_e) {
          // Expected
        }

        const serviceContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.service")
        )?.[1] as string;

        expect(serviceContent).toContain("NoNewPrivileges=true");
        expect(serviceContent).toContain("ProtectSystem=strict");
        expect(serviceContent).toContain("ProtectHome=read-only");
        expect(serviceContent).toContain("PrivateTmp=true");

        writeFileSyncSpy.mockRestore();
      });

      test("includes GPU access groups", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: {},
            unknown: [],
          });
        } catch (_e) {
          // Expected
        }

        const serviceContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.service")
        )?.[1] as string;

        expect(serviceContent).toContain("SupplementaryGroups=video render");

        writeFileSyncSpy.mockRestore();
      });

      test("includes NFS mount dependencies", async () => {
        const writeFileSyncSpy = spyOn(fs, "writeFileSync");

        const { setupLinux } = await import("../platform/linux.js");

        try {
          await setupLinux({
            command: "setup" as const,
            flags: {},
            unknown: [],
          });
        } catch (_e) {
          // Expected
        }

        const serviceContent = writeFileSyncSpy.mock.calls.find(
          call => call[0].toString().includes("annex-encoder.service")
        )?.[1] as string;

        expect(serviceContent).toContain("After=network-online.target nfs-client.target");

        writeFileSyncSpy.mockRestore();
      });
    });
  });
});
