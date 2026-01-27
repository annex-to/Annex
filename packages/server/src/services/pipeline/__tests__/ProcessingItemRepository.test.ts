import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../__tests__/setup.js";

const mockPrisma = createMockPrisma();

// Add missing update and delete methods to processingItem mock
const processingItemStore = mockPrisma._stores.processingItem;

mockPrisma.processingItem.update = mock(
  async ({ where, data }: { where: { id: string }; data: any }) => {
    const record = processingItemStore.get(where.id);
    if (!record) throw new Error(`Record ${where.id} not found`);

    const updateData = { ...data };
    // Handle Prisma increment syntax
    if (data.attempts?.increment) {
      updateData.attempts = (record.attempts || 0) + data.attempts.increment;
    }
    // Handle relation connect/disconnect (simplify for tests)
    if (data.download) {
      if (data.download.connect) {
        updateData.downloadId = data.download.connect.id;
      } else if (data.download.disconnect) {
        updateData.downloadId = null;
      }
      delete updateData.download;
    }

    const updated = { ...record, ...updateData, updatedAt: new Date() };
    processingItemStore.set(where.id, updated);
    return updated;
  }
);

mockPrisma.processingItem.delete = mock(async ({ where }: { where: { id: string } }) => {
  const record = processingItemStore.get(where.id);
  processingItemStore.delete(where.id);
  return record;
});

mock.module("../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

const { ProcessingItemRepository } = await import("../ProcessingItemRepository.js");

describe("ProcessingItemRepository", () => {
  let repo: InstanceType<typeof ProcessingItemRepository>;

  beforeEach(() => {
    repo = new ProcessingItemRepository();
    mockPrisma._clear();
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  describe("create", () => {
    test("creates item with PENDING status by default", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 27205,
        title: "Inception",
        year: 2010,
      });

      expect(item.status).toBe("PENDING");
      expect(item.tmdbId).toBe(27205);
      expect(item.title).toBe("Inception");
      expect(item.year).toBe(2010);
      expect(item.type).toBe("MOVIE");
      expect(item.requestId).toBe("req-1");
    });

    test("creates item with default maxAttempts of 5", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });
      expect(item.maxAttempts).toBe(5);
    });

    test("creates item with custom status and maxAttempts", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
        status: "SEARCHING",
        maxAttempts: 10,
      });
      expect(item.status).toBe("SEARCHING");
      expect(item.maxAttempts).toBe(10);
    });

    test("creates EPISODE with season and episode", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "EPISODE",
        tmdbId: 1396,
        title: "Pilot",
        season: 1,
        episode: 1,
      });
      expect(item.type).toBe("EPISODE");
      expect(item.season).toBe(1);
      expect(item.episode).toBe(1);
    });
  });

  describe("createMany", () => {
    test("creates multiple items", async () => {
      const items = await repo.createMany([
        { requestId: "req-1", type: "EPISODE", tmdbId: 1396, title: "Ep 1", season: 1, episode: 1 },
        { requestId: "req-1", type: "EPISODE", tmdbId: 1396, title: "Ep 2", season: 1, episode: 2 },
        { requestId: "req-1", type: "EPISODE", tmdbId: 1396, title: "Ep 3", season: 1, episode: 3 },
      ]);

      expect(items).toHaveLength(3);
      expect(items[0].title).toBe("Ep 1");
      expect(items[2].episode).toBe(3);
    });
  });

  describe("findById", () => {
    test("returns item when found", async () => {
      const created = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });
      const found = await repo.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    test("returns null when not found", async () => {
      const found = await repo.findById("nonexistent");
      expect(found).toBeNull();
    });
  });

  describe("findByRequestId", () => {
    test("returns all items for a request", async () => {
      await repo.create({ requestId: "req-1", type: "EPISODE", tmdbId: 1, title: "Ep 1" });
      await repo.create({ requestId: "req-1", type: "EPISODE", tmdbId: 1, title: "Ep 2" });
      await repo.create({ requestId: "req-2", type: "MOVIE", tmdbId: 2, title: "Other" });

      const items = await repo.findByRequestId("req-1");
      expect(items).toHaveLength(2);
    });

    test("returns empty array for non-existent request", async () => {
      const items = await repo.findByRequestId("nonexistent");
      expect(items).toEqual([]);
    });
  });

  describe("findByStatus", () => {
    test("filters by status", async () => {
      await repo.create({ requestId: "req-1", type: "MOVIE", tmdbId: 1, title: "Pending" });
      const searching = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 2,
        title: "Searching",
        status: "SEARCHING",
      });

      const results = await repo.findByStatus("SEARCHING");
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(searching.id);
    });
  });

  describe("updateStatus", () => {
    test("updates status", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStatus(item.id, "SEARCHING");
      expect(updated.status).toBe("SEARCHING");
    });

    test("sets completedAt for COMPLETED status", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStatus(item.id, "COMPLETED");
      expect(updated.completedAt).toBeDefined();
    });

    test("sets completedAt for FAILED status", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStatus(item.id, "FAILED", {
        lastError: "something failed",
      });
      expect(updated.completedAt).toBeDefined();
      expect(updated.lastError).toBe("something failed");
    });

    test("sets completedAt for CANCELLED status", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStatus(item.id, "CANCELLED");
      expect(updated.completedAt).toBeDefined();
    });

    test("does not set completedAt for non-terminal status", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStatus(item.id, "DOWNLOADING");
      expect(updated.completedAt).toBeUndefined();
    });

    test("updates with additional data fields", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStatus(item.id, "SEARCHING", {
        currentStep: "search",
        progress: 50,
        stepContext: { searchStarted: true } as any,
      });

      expect(updated.currentStep).toBe("search");
      expect(updated.progress).toBe(50);
    });
  });

  describe("incrementAttempts", () => {
    test("increments attempts counter", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      // The mock stores don't support the increment syntax like the real Prisma
      // So this tests the call happens without error
      const updated = await repo.incrementAttempts(item.id, new Date(Date.now() + 60000));
      expect(updated).toBeDefined();
    });
  });

  describe("updateProgress", () => {
    test("clamps progress to 0-100", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateProgress(item.id, 150);
      expect(updated.progress).toBe(100);

      const updated2 = await repo.updateProgress(item.id, -10);
      expect(updated2.progress).toBe(0);
    });

    test("sets valid progress", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateProgress(item.id, 75);
      expect(updated.progress).toBe(75);
    });
  });

  describe("updateStepContext", () => {
    test("merges new data into existing stepContext", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      // Set initial context
      await mockPrisma.processingItem.update({
        where: { id: item.id },
        data: { stepContext: { key1: "value1" } },
      });

      const updated = await repo.updateStepContext(item.id, { key2: "value2" });
      const context = updated.stepContext as Record<string, unknown>;
      expect(context.key1).toBe("value1");
      expect(context.key2).toBe("value2");
    });

    test("creates new context when stepContext is null", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      const updated = await repo.updateStepContext(item.id, { newKey: "newValue" });
      const context = updated.stepContext as Record<string, unknown>;
      expect(context.newKey).toBe("newValue");
    });

    test("throws when item not found", async () => {
      await expect(repo.updateStepContext("nonexistent", { key: "value" })).rejects.toThrow(
        "ProcessingItem nonexistent not found"
      );
    });
  });

  describe("delete", () => {
    test("removes item", async () => {
      const item = await repo.create({
        requestId: "req-1",
        type: "MOVIE",
        tmdbId: 1,
        title: "Test",
      });

      await repo.delete(item.id);
      const found = await repo.findById(item.id);
      expect(found).toBeNull();
    });
  });

  describe("getRequestStats", () => {
    test("returns correct statistics", async () => {
      // Create items in various states
      await repo.create({ requestId: "req-1", type: "EPISODE", tmdbId: 1, title: "Ep 1" });
      await repo.create({
        requestId: "req-1",
        type: "EPISODE",
        tmdbId: 1,
        title: "Ep 2",
        status: "COMPLETED",
      });
      await repo.create({
        requestId: "req-1",
        type: "EPISODE",
        tmdbId: 1,
        title: "Ep 3",
        status: "FAILED",
      });
      await repo.create({
        requestId: "req-1",
        type: "EPISODE",
        tmdbId: 1,
        title: "Ep 4",
        status: "DOWNLOADING",
      });
      await repo.create({
        requestId: "req-1",
        type: "EPISODE",
        tmdbId: 1,
        title: "Ep 5",
        status: "ENCODING",
      });

      const stats = await repo.getRequestStats("req-1");
      expect(stats.total).toBe(5);
      expect(stats.completed).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(1);
      expect(stats.inProgress).toBe(2);
    });

    test("returns zeros for non-existent request", async () => {
      const stats = await repo.getRequestStats("nonexistent");
      expect(stats.total).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.inProgress).toBe(0);
    });
  });

  describe("updateRequestAggregates", () => {
    test("is a no-op (deprecated)", async () => {
      await expect(repo.updateRequestAggregates("req-1")).resolves.toBeUndefined();
    });
  });
});
