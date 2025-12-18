/**
 * Tests for CLI argument parsing
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect } from "bun:test";
import { parseArgs } from "../cli.js";

describe("parseArgs", () => {
  describe("happy path - help command", () => {
    test("parses --help flag", () => {
      const result = parseArgs(["--help"]);
      expect(result.command).toBe("help");
      expect(result.flags.help).toBe(true);
      expect(result.unknown).toEqual([]);
    });

    test("parses -h flag", () => {
      const result = parseArgs(["-h"]);
      expect(result.command).toBe("help");
      expect(result.flags.help).toBe(true);
      expect(result.unknown).toEqual([]);
    });
  });

  describe("happy path - version command", () => {
    test("parses --version flag", () => {
      const result = parseArgs(["--version"]);
      expect(result.command).toBe("version");
      expect(result.flags.version).toBe(true);
      expect(result.unknown).toEqual([]);
    });

    test("parses -v flag", () => {
      const result = parseArgs(["-v"]);
      expect(result.command).toBe("version");
      expect(result.flags.version).toBe(true);
      expect(result.unknown).toEqual([]);
    });
  });

  describe("happy path - update command", () => {
    test("parses --update flag", () => {
      const result = parseArgs(["--update"]);
      expect(result.command).toBe("update");
      expect(result.unknown).toEqual([]);
    });

    test("parses --update with --force flag", () => {
      const result = parseArgs(["--update", "--force"]);
      expect(result.command).toBe("update");
      expect(result.flags.force).toBe(true);
      expect(result.unknown).toEqual([]);
    });

    test("parses --update with -f flag", () => {
      const result = parseArgs(["--update", "-f"]);
      expect(result.command).toBe("update");
      expect(result.flags.force).toBe(true);
      expect(result.unknown).toEqual([]);
    });

    test("parses --update with --server flag", () => {
      const result = parseArgs(["--update", "--server", "http://example.com"]);
      expect(result.command).toBe("update");
      expect(result.flags.server).toBe("http://example.com");
      expect(result.unknown).toEqual([]);
    });

    test("parses --update with both --force and --server", () => {
      const result = parseArgs(["--update", "--force", "--server", "http://example.com"]);
      expect(result.command).toBe("update");
      expect(result.flags.force).toBe(true);
      expect(result.flags.server).toBe("http://example.com");
      expect(result.unknown).toEqual([]);
    });
  });

  describe("happy path - setup command", () => {
    test("parses --setup flag", () => {
      const result = parseArgs(["--setup"]);
      expect(result.command).toBe("setup");
      expect(result.unknown).toEqual([]);
    });

    test("parses --setup with --install flag", () => {
      const result = parseArgs(["--setup", "--install"]);
      expect(result.command).toBe("setup");
      expect(result.flags.install).toBe(true);
      expect(result.unknown).toEqual([]);
    });

    test("parses --setup with --user flag", () => {
      const result = parseArgs(["--setup", "--user", "annex"]);
      expect(result.command).toBe("setup");
      expect(result.flags.user).toBe("annex");
      expect(result.unknown).toEqual([]);
    });

    test("parses --setup with --work-dir flag", () => {
      const result = parseArgs(["--setup", "--work-dir", "/opt/encoder"]);
      expect(result.command).toBe("setup");
      expect(result.flags.workDir).toBe("/opt/encoder");
      expect(result.unknown).toEqual([]);
    });

    test("parses --setup with all flags", () => {
      const result = parseArgs(["--setup", "--install", "--user", "annex", "--work-dir", "/opt/encoder"]);
      expect(result.command).toBe("setup");
      expect(result.flags.install).toBe(true);
      expect(result.flags.user).toBe("annex");
      expect(result.flags.workDir).toBe("/opt/encoder");
      expect(result.unknown).toEqual([]);
    });
  });

  describe("happy path - run command (default)", () => {
    test("parses empty args as run command", () => {
      const result = parseArgs([]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual([]);
    });

    test("no flags set for run command", () => {
      const result = parseArgs([]);
      expect(result.flags).toEqual({});
    });
  });

  describe("non-happy path - unknown arguments", () => {
    test("collects unknown single argument", () => {
      const result = parseArgs(["--unknown"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["--unknown"]);
    });

    test("collects multiple unknown arguments", () => {
      const result = parseArgs(["--unknown", "--another", "value"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["--unknown", "--another", "value"]);
    });

    test("collects unknown positional arguments", () => {
      const result = parseArgs(["random", "arguments"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["random", "arguments"]);
    });

    test("mixes known and unknown arguments", () => {
      const result = parseArgs(["--update", "--unknown", "--force"]);
      expect(result.command).toBe("update");
      expect(result.flags.force).toBe(true);
      expect(result.unknown).toEqual(["--unknown"]);
    });
  });

  describe("non-happy path - missing flag values", () => {
    test("throws error for --server without value", () => {
      expect(() => parseArgs(["--update", "--server"])).toThrow("--server requires a value");
    });

    test("throws error for --user without value", () => {
      expect(() => parseArgs(["--setup", "--user"])).toThrow("--user requires a value");
    });

    test("throws error for --work-dir without value", () => {
      expect(() => parseArgs(["--setup", "--work-dir"])).toThrow("--work-dir requires a value");
    });
  });

  describe("non-happy path - conflicting commands", () => {
    test("last command wins when multiple commands specified", () => {
      const result = parseArgs(["--help", "--version"]);
      expect(result.command).toBe("version");
      expect(result.flags.help).toBe(true);
      expect(result.flags.version).toBe(true);
    });

    test("handles --update and --setup together", () => {
      const result = parseArgs(["--update", "--setup"]);
      expect(result.command).toBe("setup");
    });
  });

  describe("non-happy path - edge cases", () => {
    test("handles empty string arguments", () => {
      const result = parseArgs([""]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual([""]);
    });

    test("handles arguments with special characters", () => {
      const result = parseArgs(["--server", "ws://example.com:3000/encoder"]);
      expect(result.flags.server).toBe("ws://example.com:3000/encoder");
    });

    test("handles arguments with spaces in values", () => {
      const result = parseArgs(["--work-dir", "/path with spaces/"]);
      expect(result.flags.workDir).toBe("/path with spaces/");
    });

    test("handles very long argument list", () => {
      const longArgs = Array(100).fill("--unknown");
      const result = parseArgs(longArgs);
      expect(result.unknown.length).toBe(100);
    });
  });

  describe("non-happy path - case sensitivity", () => {
    test("does not recognize uppercase --HELP", () => {
      const result = parseArgs(["--HELP"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["--HELP"]);
    });

    test("does not recognize mixed case --Help", () => {
      const result = parseArgs(["--Help"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["--Help"]);
    });
  });

  describe("non-happy path - malformed flags", () => {
    test("handles flags with equals sign", () => {
      const result = parseArgs(["--server=http://example.com"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["--server=http://example.com"]);
    });

    test("handles single dash with long flag", () => {
      const result = parseArgs(["-help"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["-help"]);
    });

    test("handles double dash with short flag", () => {
      const result = parseArgs(["--h"]);
      expect(result.command).toBe("run");
      expect(result.unknown).toEqual(["--h"]);
    });
  });
});
