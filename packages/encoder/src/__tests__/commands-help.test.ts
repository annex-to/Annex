/**
 * Tests for help command
 */

import { describe, expect, mock, spyOn, test } from "bun:test";

describe("commands/help", () => {
  describe("happy path", () => {
    test("help function exists and is callable", async () => {
      const { help } = await import("../commands/help.js");
      expect(typeof help).toBe("function");
    });

    test("outputs help text to console", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      // Verify key sections are present
      expect(output).toContain("Annex Remote Encoder");
      expect(output).toContain("USAGE:");
      expect(output).toContain("COMMANDS:");
      expect(output).toContain("ENVIRONMENT VARIABLES:");
      expect(output).toContain("EXAMPLES:");

      consoleSpy.mockRestore();
    });

    test("includes all command documentation", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      // Verify all commands are documented
      expect(output).toContain("--help");
      expect(output).toContain("--version");
      expect(output).toContain("--update");
      expect(output).toContain("--setup");

      consoleSpy.mockRestore();
    });

    test("includes update command flags", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(output).toContain("--server");
      expect(output).toContain("--force");

      consoleSpy.mockRestore();
    });

    test("includes setup command flags", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(output).toContain("--install");
      expect(output).toContain("--user");
      expect(output).toContain("--work-dir");

      consoleSpy.mockRestore();
    });

    test("includes environment variable documentation", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(output).toContain("ANNEX_SERVER_URL");
      expect(output).toContain("ANNEX_ENCODER_ID");
      expect(output).toContain("ANNEX_GPU_DEVICE");
      expect(output).toContain("ANNEX_MAX_CONCURRENT");
      expect(output).toContain("ANNEX_NFS_BASE_PATH");
      expect(output).toContain("ANNEX_LOG_LEVEL");

      consoleSpy.mockRestore();
    });

    test("includes usage examples", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(output).toContain("annex-encoder --version");
      expect(output).toContain("annex-encoder --update");
      expect(output).toContain("annex-encoder --setup");

      consoleSpy.mockRestore();
    });

    test("includes GitHub repository link", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      expect(output).toContain("github.com/annex-to/annex");

      consoleSpy.mockRestore();
    });

    test("does not throw errors", async () => {
      const { help } = await import("../commands/help.js");
      expect(() => help()).not.toThrow();
    });
  });

  describe("non-happy path", () => {
    test("handles console.log failure gracefully", async () => {
      const originalLog = console.log;
      console.log = mock(() => {
        throw new Error("Console write error");
      });

      const { help } = await import("../commands/help.js");
      expect(() => help()).toThrow("Console write error");

      console.log = originalLog;
    });
  });

  describe("output format", () => {
    test("uses consistent formatting", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      // Check for consistent section headers
      const sectionHeaders = output.match(/^[A-Z ]+:$/gm);
      expect(sectionHeaders).toBeTruthy();
      expect(sectionHeaders?.length).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });

    test("includes ASCII art banner", async () => {
      const consoleSpy = spyOn(console, "log");

      const { help } = await import("../commands/help.js");
      help();

      const output = consoleSpy.mock.calls.map((call) => call[0]).join("\n");

      // Check for box drawing characters
      expect(output).toContain("╔");
      expect(output).toContain("╚");
      expect(output).toContain("║");

      consoleSpy.mockRestore();
    });
  });
});
