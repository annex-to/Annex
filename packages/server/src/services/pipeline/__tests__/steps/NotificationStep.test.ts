/**
 * NotificationStep Unit Tests
 *
 * Tests notification step behavior in isolation without real notification providers
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MediaType } from "@prisma/client";
import { createMockPrisma } from "../../../../__tests__/setup.js";

// Mock Prisma client to prevent database access
const mockPrisma = createMockPrisma();
mock.module("../../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Mock notification dispatcher
let mockDispatchFn: any = mock(async () => [] as any[]);

mock.module("../../../notifications/NotificationDispatcher.js", () => ({
  getNotificationDispatcher: () => ({
    dispatch: mockDispatchFn,
  }),
}));

import { NotificationStep } from "../../steps/NotificationStep.js";
import { ContextBuilder } from "../test-utils/context-builder.js";

function createBaseContext() {
  return new ContextBuilder()
    .forMovie("Inception", 2010, 27205)
    .withRequestId("test-request-1")
    .withTargets([{ serverId: "server-1" }])
    .build();
}

describe("NotificationStep", () => {
  let step: NotificationStep;

  beforeEach(() => {
    step = new NotificationStep();
    mockDispatchFn = mock(async () => []);
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  describe("Config Validation", () => {
    test("should throw when config is null", () => {
      expect(() => step.validateConfig(null)).toThrow("NotificationStep config must be an object");
    });

    test("should throw when config is undefined", () => {
      expect(() => step.validateConfig(undefined)).toThrow(
        "NotificationStep config must be an object"
      );
    });

    test("should throw when config has no event", () => {
      expect(() => step.validateConfig({})).toThrow(
        "NotificationStep config must have an 'event' string"
      );
    });

    test("should throw when event is empty string", () => {
      expect(() => step.validateConfig({ event: "" })).toThrow(
        "NotificationStep config must have an 'event' string"
      );
    });

    test("should throw when event is not a string", () => {
      expect(() => step.validateConfig({ event: 123 })).toThrow(
        "NotificationStep config must have an 'event' string"
      );
    });

    test("should pass with valid config", () => {
      expect(() => step.validateConfig({ event: "request.completed" })).not.toThrow();
    });
  });

  describe("Successful Dispatch", () => {
    test("should return success with all providers succeeding", async () => {
      mockDispatchFn = mock(async () => [
        { success: true, provider: "DISCORD" },
        { success: true, provider: "WEBHOOK" },
      ]);

      const context = createBaseContext();
      const result = await step.execute(context, { event: "request.completed" });

      expect(result.success).toBe(true);
      expect(result.data?.sent).toBe(true);
      expect(result.data?.providers).toEqual(["DISCORD", "WEBHOOK"]);
      expect(result.data?.errors).toBeUndefined();
      expect(result.error).toBeUndefined();
    });
  });

  describe("All Providers Fail", () => {
    test("should return success=true when continueOnError defaults to true", async () => {
      mockDispatchFn = mock(async () => [
        { success: false, provider: "DISCORD", error: "Connection refused" },
        { success: false, provider: "WEBHOOK", error: "Timeout" },
      ]);

      const context = createBaseContext();
      const result = await step.execute(context, { event: "request.completed" });

      expect(result.success).toBe(true);
      expect(result.data?.sent).toBe(false);
      expect(result.data?.providers).toEqual([]);
      expect(result.data?.errors).toEqual([
        { provider: "DISCORD", error: "Connection refused" },
        { provider: "WEBHOOK", error: "Timeout" },
      ]);
      expect(result.error).toBeUndefined();
    });

    test("should return success=false when continueOnError is explicitly false", async () => {
      mockDispatchFn = mock(async () => [
        { success: false, provider: "DISCORD", error: "Connection refused" },
        { success: false, provider: "WEBHOOK", error: "Timeout" },
      ]);

      const context = createBaseContext();
      const result = await step.execute(context, {
        event: "request.completed",
        continueOnError: false,
      });

      expect(result.success).toBe(false);
      expect(result.data?.sent).toBe(false);
      expect(result.error).toBe("All notifications failed: Connection refused, Timeout");
    });
  });

  describe("Partial Provider Failure", () => {
    test("should return success=true with partial results", async () => {
      mockDispatchFn = mock(async () => [
        { success: true, provider: "DISCORD" },
        { success: false, provider: "WEBHOOK", error: "Timeout" },
      ]);

      const context = createBaseContext();
      const result = await step.execute(context, { event: "request.completed" });

      expect(result.success).toBe(true);
      expect(result.data?.sent).toBe(true);
      expect(result.data?.providers).toEqual(["DISCORD"]);
      expect(result.data?.errors).toEqual([{ provider: "WEBHOOK", error: "Timeout" }]);
    });
  });

  describe("Dispatcher Exception", () => {
    test("should return success=true when continueOnError defaults to true", async () => {
      mockDispatchFn = mock(async () => {
        throw new Error("Network error");
      });

      const context = createBaseContext();
      const result = await step.execute(context, { event: "request.completed" });

      expect(result.success).toBe(true);
      expect(result.data?.sent).toBe(false);
      expect(result.data?.error).toBe("Network error");
    });

    test("should return success=false when continueOnError is false", async () => {
      mockDispatchFn = mock(async () => {
        throw new Error("Network error");
      });

      const context = createBaseContext();
      const result = await step.execute(context, {
        event: "request.completed",
        continueOnError: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network error");
      expect(result.data?.sent).toBe(false);
      expect(result.data?.error).toBe("Network error");
    });

    test("should handle non-Error exceptions", async () => {
      mockDispatchFn = mock(async () => {
        throw "string error";
      });

      const context = createBaseContext();
      const result = await step.execute(context, { event: "request.completed" });

      expect(result.success).toBe(true);
      expect(result.data?.sent).toBe(false);
      expect(result.data?.error).toBe("string error");
    });
  });

  describe("Context Data Passing", () => {
    test("should pass only title, year, tmdbId when includeContext is false", async () => {
      let capturedOptions: any;
      mockDispatchFn = mock(async (options: any) => {
        capturedOptions = options;
        return [{ success: true, provider: "DISCORD" }];
      });

      const context = createBaseContext();
      context.search = {
        selectedRelease: {
          title: "Inception.2010.1080p",
          size: 5000,
          seeders: 100,
          indexer: "test",
        },
      };

      await step.execute(context, { event: "request.completed", includeContext: false });

      expect(capturedOptions.data).toEqual({
        title: "Inception",
        year: 2010,
        tmdbId: 27205,
      });
      expect(capturedOptions.data.search).toBeUndefined();
    });

    test("should pass full context when includeContext is true", async () => {
      let capturedOptions: any;
      mockDispatchFn = mock(async (options: any) => {
        capturedOptions = options;
        return [{ success: true, provider: "DISCORD" }];
      });

      const context = createBaseContext();
      context.search = {
        selectedRelease: {
          title: "Inception.2010.1080p",
          size: 5000,
          seeders: 100,
          indexer: "test",
        },
      };
      context.download = { torrentHash: "abc123" };

      await step.execute(context, { event: "request.completed", includeContext: true });

      expect(capturedOptions.data.title).toBe("Inception");
      expect(capturedOptions.data.year).toBe(2010);
      expect(capturedOptions.data.tmdbId).toBe(27205);
      expect(capturedOptions.data.search).toBeDefined();
      expect(capturedOptions.data.download).toBeDefined();
      expect(capturedOptions.data.download.torrentHash).toBe("abc123");
    });

    test("should pass event, requestId, and mediaType to dispatcher", async () => {
      let capturedOptions: any;
      mockDispatchFn = mock(async (options: any) => {
        capturedOptions = options;
        return [];
      });

      const context = createBaseContext();
      await step.execute(context, { event: "request.started" });

      expect(capturedOptions.event).toBe("request.started");
      expect(capturedOptions.requestId).toBe("test-request-1");
      expect(capturedOptions.mediaType).toBe(MediaType.MOVIE);
    });
  });

  describe("Failed Provider Error Messages", () => {
    test("should use 'Unknown error' when provider error is undefined", async () => {
      mockDispatchFn = mock(async () => [
        { success: false, provider: "DISCORD", error: undefined },
      ]);

      const context = createBaseContext();
      const result = await step.execute(context, { event: "request.completed" });

      expect(result.data?.errors).toEqual([{ provider: "DISCORD", error: "Unknown error" }]);
    });
  });

  describe("Activity Logging", () => {
    test("should log success activity when providers succeed", async () => {
      mockDispatchFn = mock(async () => [{ success: true, provider: "DISCORD" }]);

      const context = createBaseContext();
      await step.execute(context, { event: "request.completed" });

      expect(mockPrisma.activityLog.create).toHaveBeenCalled();
    });

    test("should log warning activity when providers fail", async () => {
      mockDispatchFn = mock(async () => [{ success: false, provider: "DISCORD", error: "Failed" }]);

      const context = createBaseContext();
      await step.execute(context, { event: "request.completed" });

      expect(mockPrisma.activityLog.create).toHaveBeenCalled();
    });

    test("should log error activity when dispatcher throws", async () => {
      mockDispatchFn = mock(async () => {
        throw new Error("Dispatcher crash");
      });

      const context = createBaseContext();
      await step.execute(context, { event: "request.completed" });

      expect(mockPrisma.activityLog.create).toHaveBeenCalled();
    });
  });
});
