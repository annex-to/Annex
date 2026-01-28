import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProcessingItem } from "@prisma/client";
import { createMockPrisma } from "../../../__tests__/setup.js";
import { ErrorType } from "../RetryStrategy.js";

const mockPrisma = createMockPrisma();
mock.module("../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

// Add missing stores to mock
const circuitBreakerStore = new Map<string, any>();
const settingsStore = new Map<string, any>();

mockPrisma.circuitBreaker = {
  findUnique: mock(async ({ where }: { where: { service: string } }) => {
    return circuitBreakerStore.get(where.service) || null;
  }),
  create: mock(async ({ data }: { data: any }) => {
    const record = { ...data, createdAt: new Date(), updatedAt: new Date() };
    circuitBreakerStore.set(data.service, record);
    return record;
  }),
  update: mock(async ({ where, data }: { where: { service: string }; data: any }) => {
    const record = circuitBreakerStore.get(where.service);
    if (!record) throw new Error(`CircuitBreaker ${where.service} not found`);
    const updated = { ...record, ...data, updatedAt: new Date() };
    circuitBreakerStore.set(where.service, updated);
    return updated;
  }),
  findMany: mock(async () => Array.from(circuitBreakerStore.values())),
};

mockPrisma.settings = {
  findUnique: mock(async ({ where }: { where: { id: string } }) => {
    return settingsStore.get(where.id) || null;
  }),
};

// Import after mocking
const { SmartRetryStrategy } = await import("../SmartRetryStrategy.js");

function createItem(overrides: Partial<ProcessingItem> = {}): ProcessingItem {
  return {
    id: "item-1",
    requestId: "req-1",
    type: "MOVIE",
    tmdbId: 27205,
    title: "Inception",
    year: 2010,
    season: null,
    episode: null,
    status: "DOWNLOADING",
    currentStep: null,
    stepContext: null,
    checkpoint: null,
    errorHistory: null,
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    nextRetryAt: null,
    skipUntil: null,
    progress: 0,
    lastProgressUpdate: null,
    lastProgressValue: null,
    downloadId: null,
    encodingJobId: null,
    sourceFilePath: null,
    downloadedAt: null,
    encodedAt: null,
    deliveredAt: null,
    airDate: null,
    discoveredAt: null,
    cooldownEndsAt: null,
    allSearchResults: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProcessingItem;
}

describe("SmartRetryStrategy", () => {
  let strategy: InstanceType<typeof SmartRetryStrategy>;

  beforeEach(() => {
    strategy = new SmartRetryStrategy();
    circuitBreakerStore.clear();
    settingsStore.clear();
  });

  afterEach(() => {
    circuitBreakerStore.clear();
    settingsStore.clear();
  });

  describe("classifyError", () => {
    test("classifies NETWORK errors", () => {
      // Note: classifyError does NOT lowercase string inputs, only Error.message
      expect(strategy.classifyError("econnrefused")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("enotfound")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("etimedout")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("connection lost")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("connection refused")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("network error")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("socket hang up")).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError("connection reset")).toBe(ErrorType.NETWORK);
    });

    test("classifies TIMEOUT errors", () => {
      expect(strategy.classifyError("timeout")).toBe(ErrorType.TIMEOUT);
      expect(strategy.classifyError("timed out")).toBe(ErrorType.TIMEOUT);
      expect(strategy.classifyError("Request timed out")).toBe(ErrorType.TIMEOUT);
    });

    test("classifies RATE_LIMIT errors", () => {
      expect(strategy.classifyError("429")).toBe(ErrorType.RATE_LIMIT);
      expect(strategy.classifyError("rate limit")).toBe(ErrorType.RATE_LIMIT);
      expect(strategy.classifyError("too many requests")).toBe(ErrorType.RATE_LIMIT);
    });

    test("classifies TRANSIENT errors", () => {
      expect(strategy.classifyError("503")).toBe(ErrorType.TRANSIENT);
      expect(strategy.classifyError("502")).toBe(ErrorType.TRANSIENT);
      expect(strategy.classifyError("504")).toBe(ErrorType.TRANSIENT);
      expect(strategy.classifyError("service unavailable")).toBe(ErrorType.TRANSIENT);
      expect(strategy.classifyError("temporarily unavailable")).toBe(ErrorType.TRANSIENT);
    });

    test("classifies PERMANENT errors", () => {
      expect(strategy.classifyError("404")).toBe(ErrorType.PERMANENT);
      expect(strategy.classifyError("not found")).toBe(ErrorType.PERMANENT);
      expect(strategy.classifyError("invalid")).toBe(ErrorType.PERMANENT);
      expect(strategy.classifyError("forbidden")).toBe(ErrorType.PERMANENT);
      expect(strategy.classifyError("unauthorized")).toBe(ErrorType.PERMANENT);
      expect(strategy.classifyError("no releases found")).toBe(ErrorType.PERMANENT);
    });

    test("classifies unknown errors as TRANSIENT", () => {
      expect(strategy.classifyError("some random error")).toBe(ErrorType.TRANSIENT);
      expect(strategy.classifyError("unexpected failure")).toBe(ErrorType.TRANSIENT);
    });

    test("classifies Error objects", () => {
      expect(strategy.classifyError(new Error("ECONNREFUSED"))).toBe(ErrorType.NETWORK);
      expect(strategy.classifyError(new Error("429 Too Many Requests"))).toBe(ErrorType.RATE_LIMIT);
    });
  });

  describe("decide", () => {
    test("max attempts reached for non-SEARCHING status returns no retry", async () => {
      const item = createItem({ attempts: 5, maxAttempts: 5, status: "DOWNLOADING" });
      const decision = await strategy.decide(item, "network error");
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain("Max attempts");
    });

    test("permanent error for non-SEARCHING status returns no retry", async () => {
      const item = createItem({ status: "DOWNLOADING" });
      const decision = await strategy.decide(item, "404 not found");
      expect(decision.shouldRetry).toBe(false);
      expect(decision.reason).toContain("Permanent error");
    });

    test("SEARCHING status retries indefinitely regardless of max attempts", async () => {
      settingsStore.set("default", { searchRetryIntervalHours: 6 });
      const item = createItem({ attempts: 100, maxAttempts: 5, status: "SEARCHING" });
      const decision = await strategy.decide(item, "no releases found");
      expect(decision.shouldRetry).toBe(true);
      expect(decision.useSkipUntil).toBe(false);
    });

    test("SEARCHING with not found uses search retry interval", async () => {
      settingsStore.set("default", { searchRetryIntervalHours: 12 });
      const item = createItem({ status: "SEARCHING" });
      const decision = await strategy.decide(item, "no releases found");
      expect(decision.shouldRetry).toBe(true);
      expect(decision.retryAt).toBeDefined();
      const hoursAway = ((decision.retryAt as Date).getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursAway).toBeGreaterThan(11);
      expect(hoursAway).toBeLessThan(13);
    });

    test("SEARCHING defaults to 6 hours when no settings", async () => {
      const item = createItem({ status: "SEARCHING" });
      const decision = await strategy.decide(item, "no releases found");
      expect(decision.shouldRetry).toBe(true);
      const hoursAway = ((decision.retryAt as Date).getTime() - Date.now()) / (1000 * 60 * 60);
      expect(hoursAway).toBeGreaterThan(5);
      expect(hoursAway).toBeLessThan(7);
    });

    test("transient error returns retry with backoff", async () => {
      const item = createItem({ attempts: 1, status: "DOWNLOADING" });
      const decision = await strategy.decide(item, "503 service unavailable");
      expect(decision.shouldRetry).toBe(true);
      expect(decision.useSkipUntil).toBe(false);
      expect(decision.retryAt).toBeDefined();
      expect(decision.retryAt?.getTime()).toBeGreaterThan(Date.now());
    });

    test("network error with circuit breaker open uses skipUntil", async () => {
      circuitBreakerStore.set("indexer", {
        service: "indexer",
        state: "OPEN",
        failures: 5,
        lastFailure: new Date(),
        opensAt: new Date(Date.now() + 300000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const item = createItem({ status: "DOWNLOADING" });
      const decision = await strategy.decide(item, "econnrefused", "indexer");
      expect(decision.shouldRetry).toBe(true);
      expect(decision.useSkipUntil).toBe(true);
      expect(decision.reason).toContain("unavailable");
    });

    test("network error with circuit breaker closed records failure", async () => {
      circuitBreakerStore.set("indexer", {
        service: "indexer",
        state: "CLOSED",
        failures: 0,
        lastFailure: null,
        opensAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const item = createItem({ status: "DOWNLOADING" });
      const decision = await strategy.decide(item, "econnrefused", "indexer");
      expect(decision.shouldRetry).toBe(true);
      expect(decision.useSkipUntil).toBe(false);
    });
  });

  describe("buildErrorHistory", () => {
    test("creates new history for item with no history", () => {
      const item = createItem({ errorHistory: null });
      const history = strategy.buildErrorHistory(item, "test error", ErrorType.TRANSIENT);
      expect(history).toHaveLength(1);
      expect(history[0].error).toBe("test error");
      expect(history[0].errorType).toBe(ErrorType.TRANSIENT);
      expect(history[0].attempts).toBe(1);
      expect(history[0].timestamp).toBeDefined();
    });

    test("appends to existing history", () => {
      const existing = [
        {
          timestamp: new Date().toISOString(),
          error: "old error",
          errorType: ErrorType.NETWORK,
          attempts: 1,
        },
      ];
      const item = createItem({ errorHistory: existing as any, attempts: 1 });
      const history = strategy.buildErrorHistory(item, "new error", ErrorType.TIMEOUT);
      expect(history).toHaveLength(2);
      expect(history[0].error).toBe("old error");
      expect(history[1].error).toBe("new error");
      expect(history[1].attempts).toBe(2);
    });

    test("caps history at 10 entries", () => {
      const existing = Array.from({ length: 12 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        error: `error-${i}`,
        errorType: ErrorType.TRANSIENT,
        attempts: i + 1,
      }));
      const item = createItem({ errorHistory: existing as any, attempts: 12 });
      const history = strategy.buildErrorHistory(item, "newest error", ErrorType.NETWORK);
      expect(history).toHaveLength(10);
      expect(history[history.length - 1].error).toBe("newest error");
    });

    test("handles Error objects", () => {
      const item = createItem();
      const history = strategy.buildErrorHistory(
        item,
        new Error("something broke"),
        ErrorType.TRANSIENT
      );
      expect(history[0].error).toBe("Error: something broke");
    });
  });

  describe("formatError", () => {
    test("returns string errors as-is", () => {
      expect(strategy.formatError("test error")).toBe("test error");
    });

    test("formats Error objects", () => {
      expect(strategy.formatError(new Error("test"))).toBe("Error: test");
    });

    test("formats custom error types", () => {
      class CustomError extends Error {
        constructor() {
          super("custom message");
          this.name = "CustomError";
        }
      }
      expect(strategy.formatError(new CustomError())).toBe("CustomError: custom message");
    });
  });

  describe("recordSuccess", () => {
    test("records success in circuit breaker when service provided", async () => {
      circuitBreakerStore.set("test-service", {
        service: "test-service",
        state: "CLOSED",
        failures: 2,
        lastFailure: new Date(),
        opensAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await strategy.recordSuccess("test-service");
      const breaker = circuitBreakerStore.get("test-service");
      expect(breaker.failures).toBe(0);
    });

    test("does nothing when no service provided", async () => {
      await strategy.recordSuccess();
      // Should not throw
    });
  });
});
