/**
 * Tests for version command
 */

import { describe, test, expect, spyOn } from "bun:test";
import * as os from "os";

describe("commands/version", () => {
  describe("happy path", () => {
    test("version function exists and is callable", () => {
      const { version } = require("../commands/version.js");
      expect(typeof version).toBe("function");
    });

    test("outputs version information to console", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");

      expect(output).toContain("Annex Encoder");

      consoleSpy.mockRestore();
    });

    test("includes version number", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      const { VERSION } = require("../version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain(VERSION);

      consoleSpy.mockRestore();
    });

    test("includes build date", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Build Date:");

      consoleSpy.mockRestore();
    });

    test("includes build timestamp", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Build Time:");

      consoleSpy.mockRestore();
    });

    test("includes platform information", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Platform:");
      expect(output).toContain(os.platform());
      expect(output).toContain(os.arch());

      consoleSpy.mockRestore();
    });

    test("includes node version", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");
      expect(output).toContain("Node Version:");
      expect(output).toContain(process.version);

      consoleSpy.mockRestore();
    });

    test("displays formatted output", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");

      // Check that all required sections are present
      const requiredSections = [
        "Annex Encoder",
        "Build Date:",
        "Build Time:",
        "Platform:",
        "Node Version:",
      ];

      for (const section of requiredSections) {
        expect(output).toContain(section);
      }

      consoleSpy.mockRestore();
    });

    test("does not throw errors", () => {
      const { version } = require("../commands/version.js");
      expect(() => version()).not.toThrow();
    });
  });

  describe("non-happy path", () => {
    test("handles console.log failure gracefully", () => {
      const originalLog = console.log;
      let callCount = 0;
      console.log = () => {
        callCount++;
        throw new Error("Console write error");
      };

      const { version } = require("../commands/version.js");
      expect(() => version()).toThrow("Console write error");
      expect(callCount).toBe(1);

      console.log = originalLog;
    });
  });

  describe("output format", () => {
    test("produces consistent multiline output", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0];

      // Verify it's a multiline string
      expect(output).toContain("\n");

      // Verify multiple sections
      const lines = output.split("\n").filter((l: string) => l.trim());
      expect(lines.length).toBeGreaterThan(3);

      consoleSpy.mockRestore();
    });

    test("includes proper labels with colons", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");

      // Check for consistent label format
      const labels = ["Build Date:", "Build Time:", "Platform:", "Node Version:"];
      for (const label of labels) {
        expect(output).toContain(label);
      }

      consoleSpy.mockRestore();
    });
  });

  describe("platform variations", () => {
    test("handles different platform names", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");

      // Should include current platform
      const validPlatforms = ["linux", "darwin", "win32", "freebsd", "openbsd"];
      const hasValidPlatform = validPlatforms.some(p => output.includes(p));
      expect(hasValidPlatform).toBe(true);

      consoleSpy.mockRestore();
    });

    test("handles different architectures", () => {
      const consoleSpy = spyOn(console, "log");

      const { version } = require("../commands/version.js");
      version();

      const output = consoleSpy.mock.calls.map(call => call[0]).join("\n");

      // Should include current architecture
      const validArchs = ["x64", "arm64", "arm", "ia32"];
      const hasValidArch = validArchs.some(a => output.includes(a));
      expect(hasValidArch).toBe(true);

      consoleSpy.mockRestore();
    });
  });
});
