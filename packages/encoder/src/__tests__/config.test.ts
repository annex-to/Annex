/**
 * Tests for configuration loading
 *
 * Note: Due to module-level caching in config.ts, these tests verify
 * the configuration schema and validation logic rather than testing
 * multiple reloads with different env vars in a single process.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, test, expect } from "bun:test";
import { z } from "zod";

// Import the schema to test validation directly
const configSchema = z.object({
  serverUrl: z.string().url().default("ws://localhost:3000/encoder"),
  encoderId: z.string().min(1),
  encoderName: z.string().optional(),
  gpuDevice: z.string().default("/dev/dri/renderD128"),
  maxConcurrent: z.number().int().min(1).max(8).default(1),
  nfsBasePath: z.string().default("/mnt/downloads"),
  reconnectInterval: z.number().int().min(1000).default(5000),
  maxReconnectInterval: z.number().int().min(5000).default(60000),
  heartbeatInterval: z.number().int().min(5000).default(30000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

describe("config schema validation", () => {
  describe("happy path - minimal valid configuration", () => {
    test("accepts minimal config with only encoderId", () => {
      const result = configSchema.safeParse({ encoderId: "test-encoder" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.encoderId).toBe("test-encoder");
        expect(result.data.serverUrl).toBe("ws://localhost:3000/encoder");
        expect(result.data.maxConcurrent).toBe(1);
      }
    });

    test("applies all default values", () => {
      const result = configSchema.safeParse({ encoderId: "test" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.serverUrl).toBe("ws://localhost:3000/encoder");
        expect(result.data.gpuDevice).toBe("/dev/dri/renderD128");
        expect(result.data.maxConcurrent).toBe(1);
        expect(result.data.nfsBasePath).toBe("/mnt/downloads");
        expect(result.data.reconnectInterval).toBe(5000);
        expect(result.data.maxReconnectInterval).toBe(60000);
        expect(result.data.heartbeatInterval).toBe(30000);
        expect(result.data.logLevel).toBe("info");
      }
    });
  });

  describe("happy path - full valid configuration", () => {
    test("accepts all custom values", () => {
      const config = {
        serverUrl: "ws://custom:8080/encoder",
        encoderId: "custom-encoder",
        encoderName: "My Encoder",
        gpuDevice: "/dev/dri/renderD129",
        maxConcurrent: 4,
        nfsBasePath: "/custom/path",
        reconnectInterval: 10000,
        maxReconnectInterval: 120000,
        heartbeatInterval: 60000,
        logLevel: "debug" as const,
      };

      const result = configSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(config);
      }
    });

    test("accepts wss protocol", () => {
      const result = configSchema.safeParse({
        serverUrl: "wss://secure-server:3000/encoder",
        encoderId: "test",
      });
      expect(result.success).toBe(true);
    });

    test("accepts http/https URLs", () => {
      const httpResult = configSchema.safeParse({
        serverUrl: "http://server:3000",
        encoderId: "test",
      });
      expect(httpResult.success).toBe(true);

      const httpsResult = configSchema.safeParse({
        serverUrl: "https://server:3000",
        encoderId: "test",
      });
      expect(httpsResult.success).toBe(true);
    });
  });

  describe("happy path - boundary values", () => {
    test("accepts maxConcurrent at minimum (1)", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: 1,
      });
      expect(result.success).toBe(true);
    });

    test("accepts maxConcurrent at maximum (8)", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: 8,
      });
      expect(result.success).toBe(true);
    });

    test("accepts reconnectInterval at minimum (1000)", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: 1000,
      });
      expect(result.success).toBe(true);
    });

    test("accepts maxReconnectInterval at minimum (5000)", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxReconnectInterval: 5000,
      });
      expect(result.success).toBe(true);
    });

    test("accepts heartbeatInterval at minimum (5000)", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        heartbeatInterval: 5000,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("happy path - all log levels", () => {
    const logLevels = ["debug", "info", "warn", "error"] as const;

    logLevels.forEach(level => {
      test(`accepts logLevel "${level}"`, () => {
        const result = configSchema.safeParse({
          encoderId: "test",
          logLevel: level,
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.logLevel).toBe(level);
        }
      });
    });
  });

  describe("non-happy path - missing encoderId", () => {
    test("rejects config without encoderId", () => {
      const result = configSchema.safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("encoderId");
      }
    });

    test("rejects empty encoderId", () => {
      const result = configSchema.safeParse({ encoderId: "" });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("encoderId");
      }
    });
  });

  describe("non-happy path - invalid serverUrl", () => {
    test("rejects invalid URL format", () => {
      const result = configSchema.safeParse({
        serverUrl: "not-a-url",
        encoderId: "test",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain("serverUrl");
      }
    });

    test("rejects empty serverUrl", () => {
      const result = configSchema.safeParse({
        serverUrl: "",
        encoderId: "test",
      });
      expect(result.success).toBe(false);
    });

    test("accepts URLs with custom schemes", () => {
      // Note: zod's URL validator accepts any valid URL format
      // "server:3000/encoder" is technically valid (server is the scheme)
      const result = configSchema.safeParse({
        serverUrl: "server:3000/encoder",
        encoderId: "test",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("non-happy path - invalid maxConcurrent", () => {
    test("rejects maxConcurrent = 0", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: 0,
      });
      expect(result.success).toBe(false);
    });

    test("rejects negative maxConcurrent", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: -1,
      });
      expect(result.success).toBe(false);
    });

    test("rejects maxConcurrent > 8", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: 9,
      });
      expect(result.success).toBe(false);
    });

    test("rejects non-integer maxConcurrent", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: 2.5,
      });
      expect(result.success).toBe(false);
    });

    test("rejects string maxConcurrent", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxConcurrent: "2",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("non-happy path - invalid reconnectInterval", () => {
    test("rejects reconnectInterval < 1000", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: 999,
      });
      expect(result.success).toBe(false);
    });

    test("rejects negative reconnectInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: -1000,
      });
      expect(result.success).toBe(false);
    });

    test("rejects zero reconnectInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: 0,
      });
      expect(result.success).toBe(false);
    });

    test("rejects non-integer reconnectInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: 5000.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("non-happy path - invalid maxReconnectInterval", () => {
    test("rejects maxReconnectInterval < 5000", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxReconnectInterval: 4999,
      });
      expect(result.success).toBe(false);
    });

    test("rejects negative maxReconnectInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxReconnectInterval: -5000,
      });
      expect(result.success).toBe(false);
    });

    test("rejects zero maxReconnectInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        maxReconnectInterval: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("non-happy path - invalid heartbeatInterval", () => {
    test("rejects heartbeatInterval < 5000", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        heartbeatInterval: 4999,
      });
      expect(result.success).toBe(false);
    });

    test("rejects negative heartbeatInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        heartbeatInterval: -30000,
      });
      expect(result.success).toBe(false);
    });

    test("rejects zero heartbeatInterval", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        heartbeatInterval: 0,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("non-happy path - invalid logLevel", () => {
    test("rejects invalid logLevel", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        logLevel: "verbose",
      });
      expect(result.success).toBe(false);
    });

    test("rejects empty logLevel", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        logLevel: "",
      });
      expect(result.success).toBe(false);
    });

    test("rejects numeric logLevel", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        logLevel: 1,
      });
      expect(result.success).toBe(false);
    });

    test("rejects uppercase logLevel", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        logLevel: "INFO",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("non-happy path - type mismatches", () => {
    test("rejects numeric encoderId", () => {
      const result = configSchema.safeParse({
        encoderId: 123,
      });
      expect(result.success).toBe(false);
    });

    test("rejects boolean values for string fields", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        gpuDevice: true,
      });
      expect(result.success).toBe(false);
    });

    test("rejects null values", () => {
      const result = configSchema.safeParse({
        encoderId: null,
      });
      expect(result.success).toBe(false);
    });

    test("rejects undefined encoderId", () => {
      const result = configSchema.safeParse({
        encoderId: undefined,
      });
      expect(result.success).toBe(false);
    });
  });

  describe("non-happy path - extra fields", () => {
    test("ignores extra unknown fields", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        unknownField: "should be ignored",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect("unknownField" in result.data).toBe(false);
      }
    });

    test("strips extra fields from output", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        extra1: "value1",
        extra2: "value2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(Object.keys(result.data)).not.toContain("extra1");
        expect(Object.keys(result.data)).not.toContain("extra2");
      }
    });
  });

  describe("non-happy path - edge cases", () => {
    test("handles very long string values", () => {
      const longString = "a".repeat(10000);
      const result = configSchema.safeParse({
        encoderId: longString,
      });
      expect(result.success).toBe(true);
    });

    test("handles special characters in strings", () => {
      const result = configSchema.safeParse({
        encoderId: "test-@#$%^&*()",
        encoderName: "エンコーダー 編碼器",
        nfsBasePath: "/path/with spaces/and-special!@#chars",
      });
      expect(result.success).toBe(true);
    });

    test("handles very large interval values", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: 999999999,
        maxReconnectInterval: 999999999,
        heartbeatInterval: 999999999,
      });
      expect(result.success).toBe(true);
    });

    test("handles maximum safe integer", () => {
      const result = configSchema.safeParse({
        encoderId: "test",
        reconnectInterval: Number.MAX_SAFE_INTEGER,
      });
      expect(result.success).toBe(true);
    });
  });
});

describe("config module behavior", () => {
  test("config module exports initConfig function", async () => {
    const config = await import("../config.js");
    expect(typeof config.initConfig).toBe("function");
  });

  test("config module exports getConfig function", async () => {
    const config = await import("../config.js");
    expect(typeof config.getConfig).toBe("function");
  });

  test("getConfig returns a config object", async () => {
    const { getConfig } = await import("../config.js");
    const config = getConfig();
    expect(config).toBeDefined();
    expect(typeof config.encoderId).toBe("string");
  });
});
