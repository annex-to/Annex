import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../__tests__/setup.js";

const mockPrisma = createMockPrisma();

// Add circuit breaker + settings stores
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

// Add processingItem.delete to the mock (missing from base setup)
const originalProcessingItemStore = mockPrisma._stores.processingItem;
if (!mockPrisma.processingItem.delete) {
  mockPrisma.processingItem.delete = mock(async ({ where }: { where: { id: string } }) => {
    const record = originalProcessingItemStore.get(where.id);
    if (!record) throw new Error(`ProcessingItem ${where.id} not found`);
    originalProcessingItemStore.delete(where.id);
    return record;
  });
}

// Add processingItem.update to the mock
if (!mockPrisma.processingItem.update) {
  mockPrisma.processingItem.update = mock(
    async ({ where, data }: { where: { id: string }; data: any }) => {
      const record = originalProcessingItemStore.get(where.id);
      if (!record) throw new Error(`ProcessingItem ${where.id} not found`);
      const updated = { ...record, ...data, updatedAt: new Date() };
      // Handle increment syntax
      if (data.attempts?.increment) {
        updated.attempts = (record.attempts || 0) + data.attempts.increment;
      }
      originalProcessingItemStore.set(where.id, updated);
      return updated;
    }
  );
}

// Add mediaRequest.delete
if (!mockPrisma.mediaRequest.delete) {
  mockPrisma.mediaRequest.delete = mock(async ({ where }: { where: { id: string } }) => {
    const record = mockPrisma._stores.mediaRequest.get(where.id);
    mockPrisma._stores.mediaRequest.delete(where.id);
    return record;
  });
}

mock.module("../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

const { PipelineOrchestrator } = await import("../PipelineOrchestrator.js");
const { StateTransitionError } = await import("../StateMachine.js");
const { ValidationError } = await import("../ValidationFramework.js");

describe("PipelineOrchestrator", () => {
  let orchestrator: InstanceType<typeof PipelineOrchestrator>;

  beforeEach(() => {
    orchestrator = new PipelineOrchestrator();
    mockPrisma._clear();
    circuitBreakerStore.clear();
    settingsStore.clear();
  });

  afterEach(() => {
    mockPrisma._clear();
    circuitBreakerStore.clear();
    settingsStore.clear();
  });

  function seedTemplate(type: string = "movie") {
    const id = type === "movie" ? "default-movie-pipeline" : "default-tv-pipeline";
    mockPrisma._stores.pipelineTemplate.set(id, {
      id,
      name: `Default ${type} pipeline`,
      mediaType: type.toUpperCase(),
      steps: [{ type: "SEARCH", name: "Search", config: {} }],
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  describe("createRequest", () => {
    test("creates a movie request with 1 ProcessingItem", async () => {
      seedTemplate("movie");

      const result = await orchestrator.createRequest({
        type: "movie",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        targetServers: ["server-1"],
      });

      expect(result.requestId).toBeDefined();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].type).toBe("MOVIE");
      expect(result.items[0].tmdbId).toBe(27205);
      expect(result.items[0].status).toBe("PENDING");
    });

    test("creates a TV request with multiple ProcessingItems", async () => {
      seedTemplate("tv");

      const result = await orchestrator.createRequest({
        type: "tv",
        tmdbId: 1396,
        title: "Breaking Bad",
        year: 2008,
        episodes: [
          { season: 1, episode: 1, title: "Pilot" },
          { season: 1, episode: 2, title: "Cat's in the Bag..." },
          { season: 1, episode: 3, title: "...And the Bag's in the River" },
        ],
        targetServers: ["server-1"],
      });

      expect(result.items).toHaveLength(3);
      expect(result.items[0].type).toBe("EPISODE");
      expect(result.items[0].season).toBe(1);
      expect(result.items[0].episode).toBe(1);
      expect(result.items[2].episode).toBe(3);
    });

    test("throws when pipeline template not found", async () => {
      await expect(
        orchestrator.createRequest({
          type: "movie",
          tmdbId: 1,
          title: "Test",
          targetServers: ["s1"],
        })
      ).rejects.toThrow("Pipeline template");
    });

    test("throws when TV request has no episodes", async () => {
      seedTemplate("tv");

      await expect(
        orchestrator.createRequest({
          type: "tv",
          tmdbId: 1,
          title: "Test",
          episodes: [],
          targetServers: ["s1"],
        })
      ).rejects.toThrow("must include episodes");
    });

    test("creates MediaRequest in database", async () => {
      seedTemplate("movie");

      const result = await orchestrator.createRequest({
        type: "movie",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        targetServers: ["server-1"],
      });

      const request = mockPrisma._stores.mediaRequest.get(result.requestId);
      expect(request).toBeDefined();
      expect(request.type).toBe("MOVIE");
      expect(request.status).toBe("PENDING");
    });

    test("creates PipelineExecution for compatibility", async () => {
      seedTemplate("movie");

      const result = await orchestrator.createRequest({
        type: "movie",
        tmdbId: 1,
        title: "Test",
        targetServers: ["s1"],
      });

      const executions = Array.from(mockPrisma._stores.pipelineExecution.values());
      const exec = executions.find((e: any) => e.requestId === result.requestId);
      expect(exec).toBeDefined();
      expect((exec as any).status).toBe("RUNNING");
    });
  });

  describe("transitionStatus", () => {
    async function createItemInDb(status: string, stepContext: any = null) {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        status,
        stepContext,
        attempts: 0,
        maxAttempts: 5,
        currentStep: null,
        lastError: null,
        nextRetryAt: null,
        skipUntil: null,
        progress: 0,
        downloadId: null,
        encodingJobId: null,
        cooldownEndsAt: null,
        discoveredAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    }

    test("valid transition updates status", async () => {
      const itemId = await createItemInDb("PENDING");

      const updated = await orchestrator.transitionStatus(itemId, "SEARCHING");
      expect(updated.status).toBe("SEARCHING");
    });

    test("invalid transition throws StateTransitionError", async () => {
      const itemId = await createItemInDb("COMPLETED");

      await expect(orchestrator.transitionStatus(itemId, "PENDING")).rejects.toThrow(
        StateTransitionError
      );
    });

    test("validation failure throws ValidationError", async () => {
      const itemId = await createItemInDb("SEARCHING", {});

      // FOUND requires selectedRelease in context - transition will fail at exit validation
      await expect(orchestrator.transitionStatus(itemId, "FOUND")).rejects.toThrow(ValidationError);
    });

    test("passes validation with correct context", async () => {
      const itemId = await createItemInDb("PENDING");

      const updated = await orchestrator.transitionStatus(itemId, "FOUND", {
        stepContext: { selectedRelease: { title: "test" } },
      });
      expect(updated.status).toBe("FOUND");
    });

    test("throws when item not found", async () => {
      await expect(orchestrator.transitionStatus("nonexistent", "SEARCHING")).rejects.toThrow(
        "not found"
      );
    });
  });

  describe("handleError", () => {
    async function createItemInDb(status: string, overrides: any = {}) {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        status,
        stepContext: null,
        attempts: 0,
        maxAttempts: 5,
        currentStep: null,
        lastError: null,
        nextRetryAt: null,
        skipUntil: null,
        progress: 0,
        errorHistory: null,
        downloadId: null,
        encodingJobId: null,
        cooldownEndsAt: null,
        discoveredAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      });
      return id;
    }

    test("transient error sets retry with nextRetryAt", async () => {
      settingsStore.set("default", { searchRetryIntervalHours: 6 });
      const itemId = await createItemInDb("DOWNLOADING");

      const updated = await orchestrator.handleError(itemId, "503 service unavailable");
      expect(updated.status).toBe("DOWNLOADING"); // Stays in processing status
      expect(updated.nextRetryAt).toBeDefined();
      expect(updated.attempts).toBe(1);
    });

    test("permanent error transitions to FAILED", async () => {
      const itemId = await createItemInDb("DOWNLOADING");

      const updated = await orchestrator.handleError(itemId, "404 not found");
      expect(updated.status).toBe("FAILED");
      expect(updated.completedAt).toBeDefined();
    });

    test("max attempts exceeded transitions to FAILED", async () => {
      const itemId = await createItemInDb("DOWNLOADING", {
        attempts: 5,
        maxAttempts: 5,
      });

      const updated = await orchestrator.handleError(itemId, "network error");
      expect(updated.status).toBe("FAILED");
    });

    test("network error with open circuit uses skipUntil", async () => {
      circuitBreakerStore.set("qbit", {
        service: "qbit",
        state: "OPEN",
        failures: 5,
        lastFailure: new Date(),
        opensAt: new Date(Date.now() + 300000),
      });

      const itemId = await createItemInDb("DOWNLOADING");
      const updated = await orchestrator.handleError(itemId, "econnrefused", "qbit");
      expect(updated.skipUntil).toBeDefined();
      // Should NOT increment attempts for service outage
      expect(updated.attempts).toBe(0);
    });

    test("keeps processing status for items already in processing state", async () => {
      settingsStore.set("default", { searchRetryIntervalHours: 6 });
      const itemId = await createItemInDb("ENCODING");

      const updated = await orchestrator.handleError(itemId, "502 bad gateway");
      expect(updated.status).toBe("ENCODING");
    });

    test("throws when item not found", async () => {
      await expect(orchestrator.handleError("nonexistent", "error")).rejects.toThrow("not found");
    });

    test("builds error history", async () => {
      settingsStore.set("default", { searchRetryIntervalHours: 6 });
      const itemId = await createItemInDb("DOWNLOADING");

      await orchestrator.handleError(itemId, "first error");

      const item = mockPrisma._stores.processingItem.get(itemId);
      expect(item.errorHistory).toBeDefined();
      const history = item.errorHistory as any[];
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].error).toBe("first error");
    });
  });

  describe("cancel", () => {
    async function createItemInDb(status: string) {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        status,
        stepContext: null,
        attempts: 0,
        maxAttempts: 5,
        currentStep: null,
        lastError: null,
        nextRetryAt: null,
        skipUntil: null,
        progress: 0,
        downloadId: null,
        encodingJobId: null,
        cooldownEndsAt: null,
        discoveredAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return id;
    }

    test("cancels PENDING item", async () => {
      const itemId = await createItemInDb("PENDING");
      const updated = await orchestrator.cancel(itemId);
      expect(updated.status).toBe("CANCELLED");
    });

    test("cancels DOWNLOADING item", async () => {
      const itemId = await createItemInDb("DOWNLOADING");
      const updated = await orchestrator.cancel(itemId);
      expect(updated.status).toBe("CANCELLED");
    });

    test("throws for COMPLETED item", async () => {
      const itemId = await createItemInDb("COMPLETED");
      await expect(orchestrator.cancel(itemId)).rejects.toThrow("Cannot cancel");
    });

    test("throws for FAILED item", async () => {
      const itemId = await createItemInDb("FAILED");
      await expect(orchestrator.cancel(itemId)).rejects.toThrow("Cannot cancel");
    });

    test("throws for non-existent item", async () => {
      await expect(orchestrator.cancel("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("retry", () => {
    async function createItemInDb(status: string, overrides: any = {}) {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
        status,
        stepContext: null,
        attempts: 3,
        maxAttempts: 5,
        currentStep: null,
        lastError: "previous error",
        nextRetryAt: null,
        skipUntil: null,
        progress: 50,
        downloadId: null,
        encodingJobId: null,
        cooldownEndsAt: null,
        discoveredAt: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      });
      return id;
    }

    test("resets FAILED item to PENDING", async () => {
      const itemId = await createItemInDb("FAILED");
      const updated = await orchestrator.retry(itemId);
      expect(updated.status).toBe("PENDING");
      expect(updated.attempts).toBe(0);
      expect(updated.lastError).toBeNull();
      expect(updated.progress).toBe(0);
    });

    test("preserves selectedRelease in stepContext on retry", async () => {
      const itemId = await createItemInDb("FAILED", {
        stepContext: {
          selectedRelease: { title: "Inception.2010.1080p" },
          alternativeReleases: [{ title: "alt" }],
          download: { torrentHash: "abc" },
        },
      });

      const updated = await orchestrator.retry(itemId);
      const context = updated.stepContext as Record<string, unknown>;
      expect(context.selectedRelease).toBeDefined();
      expect(context.qualityMet).toBe(true);
      // download data should be cleared
      expect(context.download).toBeUndefined();
    });

    test("throws for non-FAILED item", async () => {
      const itemId = await createItemInDb("DOWNLOADING");
      await expect(orchestrator.retry(itemId)).rejects.toThrow("Cannot retry");
    });

    test("throws for COMPLETED item", async () => {
      const itemId = await createItemInDb("COMPLETED");
      await expect(orchestrator.retry(itemId)).rejects.toThrow("Cannot retry");
    });

    test("throws for non-existent item", async () => {
      await expect(orchestrator.retry("nonexistent")).rejects.toThrow("not found");
    });
  });

  describe("getItemsForProcessing", () => {
    test("filters out items with future nextRetryAt", async () => {
      const id1 = crypto.randomUUID();
      const id2 = crypto.randomUUID();

      mockPrisma._stores.processingItem.set(id1, {
        id: id1,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Ready",
        status: "DOWNLOADING",
        nextRetryAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      mockPrisma._stores.processingItem.set(id2, {
        id: id2,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 2,
        title: "Not ready",
        status: "DOWNLOADING",
        nextRetryAt: new Date(Date.now() + 300000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const items = await orchestrator.getItemsForProcessing("DOWNLOADING");
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(id1);
    });

    test("includes items with past nextRetryAt", async () => {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Past retry",
        status: "DOWNLOADING",
        nextRetryAt: new Date(Date.now() - 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const items = await orchestrator.getItemsForProcessing("DOWNLOADING");
      expect(items).toHaveLength(1);
    });
  });

  describe("updateProgress", () => {
    test("updates progress value", async () => {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
        status: "DOWNLOADING",
        progress: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await orchestrator.updateProgress(id, 75);
      expect(updated.progress).toBe(75);
    });
  });

  describe("updateContext", () => {
    test("merges context into stepContext", async () => {
      const id = crypto.randomUUID();
      mockPrisma._stores.processingItem.set(id, {
        id,
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
        status: "DOWNLOADING",
        stepContext: { existing: true },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const updated = await orchestrator.updateContext(id, { newField: "value" });
      const context = updated.stepContext as Record<string, unknown>;
      expect(context.existing).toBe(true);
      expect(context.newField).toBe("value");
    });
  });
});
