/**
 * Tests for update command
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

describe("commands/update", () => {
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  beforeEach(() => {
    // Mock process.exit
    originalExit = process.exit;
    exitCode = undefined;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`Process exited with code ${code}`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
  });

  describe("happy path", () => {
    test("update function exists and is callable", async () => {
      const { update } = await import("../commands/update.js");
      expect(typeof update).toBe("function");
    });

    test("displays update banner", async () => {
      // Mock all dependencies
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      // Mock fetch to return manifest
      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          version: "0.1.0",
          buildDate: "2025-12-17",
          platforms: {
            "linux-x64": { size: 1024000, sha256: "abc123" },
          },
        }),
        arrayBuffer: async () => new ArrayBuffer(8),
      })) as any;

      const consoleSpy = spyOn(console, "log");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected if versions match
      }

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Annex Encoder - Self Update");
      expect(output).toContain("Current Version:");
      expect(output).toContain("Platform:");

      consoleSpy.mockRestore();
    });

    test("exits early if already up to date", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      mock.module("../version.js", () => ({
        VERSION: "0.1.0",
        BUILD_DATE: "2025-12-17",
        BUILD_TIMESTAMP: Date.now(),
      }));

      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          version: "0.1.0", // Same version
          buildDate: "2025-12-17",
          platforms: {
            "linux-x64": { size: 1024000, sha256: "abc123" },
          },
        }),
      })) as any;

      const consoleSpy = spyOn(console, "log");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      await update(args);

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Already up to date");
      expect(output).toContain("Use --force to reinstall anyway");

      consoleSpy.mockRestore();
    });

    test("proceeds with update when --force is used", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      mock.module("../version.js", () => ({
        VERSION: "0.1.0",
        BUILD_DATE: "2025-12-17",
        BUILD_TIMESTAMP: Date.now(),
      }));

      const testBinaryContent = Buffer.from("test binary");
      const testChecksum = createHash("sha256").update(testBinaryContent).digest("hex");

      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("/info")) {
          return {
            ok: true,
            json: async () => ({
              version: "0.1.0", // Same version
              buildDate: "2025-12-17",
              platforms: {
                "linux-x64": { size: testBinaryContent.length, sha256: testChecksum },
              },
            }),
          };
        } else {
          return {
            ok: true,
            arrayBuffer: async () => testBinaryContent.buffer,
          };
        }
      }) as any;

      const writeFileSyncSpy = spyOn(fs, "writeFileSync");
      const chmodSyncSpy = spyOn(fs, "chmodSync");
      const existsSyncSpy = spyOn(fs, "existsSync").mockReturnValue(false);
      const renameSyncSpy = spyOn(fs, "renameSync");

      const consoleSpy = spyOn(console, "log");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: { force: true },
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // May exit after completion
      }

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Force update requested");

      writeFileSyncSpy.mockRestore();
      chmodSyncSpy.mockRestore();
      existsSyncSpy.mockRestore();
      renameSyncSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    test("uses --server flag for custom server URL", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      let fetchedUrl: string | undefined;
      globalThis.fetch = mock(async (url: string) => {
        fetchedUrl = url;
        return {
          ok: true,
          json: async () => ({
            version: "0.1.0",
            buildDate: "2025-12-17",
            platforms: {
              "linux-x64": { size: 1024000, sha256: "abc123" },
            },
          }),
        };
      }) as any;

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: { server: "http://custom-server:8080" },
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected
      }

      expect(fetchedUrl).toContain("custom-server:8080");
    });

    test("converts WebSocket URL to HTTP", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      let fetchedUrl: string | undefined;
      globalThis.fetch = mock(async (url: string) => {
        fetchedUrl = url;
        return {
          ok: true,
          json: async () => ({
            version: "0.1.0",
            buildDate: "2025-12-17",
            platforms: {
              "linux-x64": { size: 1024000, sha256: "abc123" },
            },
          }),
        };
      }) as any;

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected
      }

      expect(fetchedUrl).toContain("http://");
      expect(fetchedUrl).not.toContain("ws://");
    });
  });

  describe("non-happy path - network failures", () => {
    test("exits if manifest fetch fails", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      globalThis.fetch = mock(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })) as any;

      const consoleErrorSpy = spyOn(console, "error");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });

    test("exits if platform not in manifest", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "unsupported-platform"),
        detectPlatform: mock(() => "unsupported"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      globalThis.fetch = mock(async () => ({
        ok: true,
        json: async () => ({
          version: "0.2.0",
          buildDate: "2025-12-17",
          platforms: {
            "linux-x64": { size: 1024000, sha256: "abc123" },
          },
        }),
      })) as any;

      const consoleErrorSpy = spyOn(console, "error");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
      expect(errorOutput).toContain("not available in manifest");

      consoleErrorSpy.mockRestore();
    });

    test("handles binary download failure", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("/info")) {
          return {
            ok: true,
            json: async () => ({
              version: "0.2.0",
              buildDate: "2025-12-17",
              platforms: {
                "linux-x64": { size: 1024000, sha256: "abc123" },
              },
            }),
          };
        } else {
          // Binary download fails
          return {
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
          };
        }
      }) as any;

      const consoleErrorSpy = spyOn(console, "error");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
    });
  });

  describe("non-happy path - checksum verification", () => {
    test("exits if checksum mismatch", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      const testBinaryContent = Buffer.from("test binary");
      const wrongChecksum = "0000000000000000000000000000000000000000000000000000000000000000";

      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("/info")) {
          return {
            ok: true,
            json: async () => ({
              version: "0.2.0",
              buildDate: "2025-12-17",
              platforms: {
                "linux-x64": { size: testBinaryContent.length, sha256: wrongChecksum },
              },
            }),
          };
        } else {
          return {
            ok: true,
            arrayBuffer: async () => testBinaryContent.buffer,
          };
        }
      }) as any;

      const writeFileSyncSpy = spyOn(fs, "writeFileSync");
      const unlinkSyncSpy = spyOn(fs, "unlinkSync");

      const consoleErrorSpy = spyOn(console, "error");

      const { update } = await import("../commands/update.js");

      const args = {
        command: "update" as const,
        flags: {},
        unknown: [],
      };

      try {
        await update(args);
      } catch (_e) {
        // Expected to exit
      }

      expect(exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorOutput = consoleErrorSpy.mock.calls.map(call => call[0]).join("\n");
      expect(errorOutput).toContain("Checksum mismatch");
      expect(unlinkSyncSpy).toHaveBeenCalled(); // Temp file should be deleted

      writeFileSyncSpy.mockRestore();
      unlinkSyncSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });
  });

  describe("URL conversion", () => {
    test("converts ws:// to http://", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://example.com:3000/encoder",
        })),
      }));

      let fetchedUrl: string | undefined;
      globalThis.fetch = mock(async (url: string) => {
        fetchedUrl = url;
        return {
          ok: true,
          json: async () => ({
            version: "0.1.0",
            buildDate: "2025-12-17",
            platforms: {
              "linux-x64": { size: 1024000, sha256: "abc123" },
            },
          }),
        };
      }) as any;

      const { update } = await import("../commands/update.js");

      try {
        await update({
          command: "update" as const,
          flags: {},
          unknown: [],
        });
      } catch (_e) {
        // Expected
      }

      expect(fetchedUrl).toContain("http://example.com:3000");
      expect(fetchedUrl).not.toContain("ws://");
    });

    test("converts wss:// to https://", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "wss://example.com:3000/encoder",
        })),
      }));

      let fetchedUrl: string | undefined;
      globalThis.fetch = mock(async (url: string) => {
        fetchedUrl = url;
        return {
          ok: true,
          json: async () => ({
            version: "0.1.0",
            buildDate: "2025-12-17",
            platforms: {
              "linux-x64": { size: 1024000, sha256: "abc123" },
            },
          }),
        };
      }) as any;

      const { update } = await import("../commands/update.js");

      try {
        await update({
          command: "update" as const,
          flags: {},
          unknown: [],
        });
      } catch (_e) {
        // Expected
      }

      expect(fetchedUrl).toContain("https://example.com:3000");
      expect(fetchedUrl).not.toContain("wss://");
    });

    test("removes /encoder suffix from URL", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
          getConfig: mock(() => ({
          serverUrl: "ws://example.com:3000/encoder",
        })),
      }));

      let fetchedUrl: string | undefined;
      globalThis.fetch = mock(async (url: string) => {
        fetchedUrl = url;
        return {
          ok: true,
          json: async () => ({
            version: "0.1.0",
            buildDate: "2025-12-17",
            platforms: {
              "linux-x64": { size: 1024000, sha256: "abc123" },
            },
          }),
        };
      }) as any;

      const { update } = await import("../commands/update.js");

      try {
        await update({
          command: "update" as const,
          flags: {},
          unknown: [],
        });
      } catch (_e) {
        // Expected
      }

      expect(fetchedUrl).toContain("http://example.com:3000/api/encoder");
      expect(fetchedUrl).not.toContain("/encoder/api");
    });
  });

  describe("logging", () => {
    test("shows progress through all update steps", async () => {
      mock.module("../platform/index.js", () => ({
        getPlatformBinaryName: mock(() => "linux-x64"),
        detectPlatform: mock(() => "linux"),
      }));

      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          serverUrl: "ws://localhost:3000/encoder",
        })),
      }));

      const testBinaryContent = Buffer.from("test binary");
      const testChecksum = createHash("sha256").update(testBinaryContent).digest("hex");

      globalThis.fetch = mock(async (url: string) => {
        if (url.includes("/info")) {
          return {
            ok: true,
            json: async () => ({
              version: "0.2.0",
              buildDate: "2025-12-17",
              platforms: {
                "linux-x64": { size: testBinaryContent.length, sha256: testChecksum },
              },
            }),
          };
        } else {
          return {
            ok: true,
            arrayBuffer: async () => testBinaryContent.buffer,
          };
        }
      }) as any;

      spyOn(fs, "writeFileSync");
      spyOn(fs, "chmodSync");
      spyOn(fs, "existsSync").mockReturnValue(false);
      spyOn(fs, "renameSync");

      const consoleSpy = spyOn(console, "log");

      const { update } = await import("../commands/update.js");

      try {
        await update({
          command: "update" as const,
          flags: {},
          unknown: [],
        });
      } catch (_e) {
        // Expected
      }

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("[1/7] Checking for updates");
      expect(output).toContain("[2/7] Downloading new binary");
      expect(output).toContain("[3/7] Verifying checksum");
      expect(output).toContain("[4/7] Stopping service");
      expect(output).toContain("[5/7] Backing up current binary");
      expect(output).toContain("[6/7] Installing new binary");
      expect(output).toContain("[7/7] Starting service");

      consoleSpy.mockRestore();
    });
  });
});
