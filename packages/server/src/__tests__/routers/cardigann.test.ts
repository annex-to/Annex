import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../../db/client.js";
import { CardigannRepository } from "../../services/cardigann/repository.js";

describe("Cardigann Indexer Database Models", () => {
  let tempDir: string;
  let repository: CardigannRepository;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cardigann-indexer-test-"));
    repository = new CardigannRepository(tempDir);

    // Initialize repository with a test definition
    const testDefinition = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
settings:
  - name: username
    type: text
    label: Username
  - name: password
    type: password
    label: Password
caps:
  categorymappings:
    - {id: 1, cat: TV, desc: "TV Shows"}
    - {id: 2, cat: Movies, desc: "Movies"}
  modes:
    movie-search:
      - q
    tv-search:
      - q
search:
  paths:
    - path: /search
`;

    await repository.saveDefinition("test-indexer", testDefinition);
  });

  afterEach(async () => {
    // Clean up test indexers
    await prisma.cardigannIndexer.deleteMany({});

    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("CRUD Operations", () => {
    it("creates indexer", async () => {
      const result = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "My Test Indexer",
          settings: {
            username: "testuser",
            password: "testpass",
          },
          categoriesMovies: [2000, 2010],
          categoriesTv: [5000, 5030],
          priority: 75,
          enabled: true,
        },
      });

      expect(result.id).toBeDefined();
      expect(result.name).toBe("My Test Indexer");
      expect(result.definitionId).toBe("test-indexer");
      expect(result.priority).toBe(75);
      expect(result.enabled).toBe(true);
    });

    it("lists indexers with proper ordering", async () => {
      // Create two indexers
      await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Indexer 1",
          priority: 50,
        },
      });

      await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Indexer 2",
          priority: 75,
        },
      });

      const result = await prisma.cardigannIndexer.findMany({
        orderBy: [{ enabled: "desc" }, { priority: "desc" }, { name: "asc" }],
      });

      expect(result.length).toBe(2);
      // Should be ordered by priority desc
      expect(result[0].priority).toBe(75);
      expect(result[1].priority).toBe(50);
    });

    it("gets indexer by id", async () => {
      const created = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Test Indexer",
          settings: { username: "test" },
        },
      });

      const result = await prisma.cardigannIndexer.findUnique({
        where: { id: created.id },
      });

      expect(result).not.toBeNull();
      expect(result?.id).toBe(created.id);
      expect(result?.name).toBe("Test Indexer");
    });

    it("returns null for non-existent indexer", async () => {
      const result = await prisma.cardigannIndexer.findUnique({
        where: { id: "nonexistent" },
      });

      expect(result).toBeNull();
    });

    it("updates indexer", async () => {
      const created = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Original Name",
          priority: 50,
        },
      });

      const updated = await prisma.cardigannIndexer.update({
        where: { id: created.id },
        data: {
          name: "Updated Name",
          priority: 75,
          enabled: false,
        },
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.priority).toBe(75);
      expect(updated.enabled).toBe(false);
    });

    it("deletes indexer", async () => {
      const created = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "To Delete",
        },
      });

      await prisma.cardigannIndexer.delete({
        where: { id: created.id },
      });

      // Verify it's deleted
      const result = await prisma.cardigannIndexer.findUnique({
        where: { id: created.id },
      });

      expect(result).toBeNull();
    });

    it("creates indexer with rate limiting", async () => {
      const result = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Rate Limited Indexer",
          rateLimitEnabled: true,
          rateLimitMax: 10,
          rateLimitWindowSecs: 60,
        },
      });

      expect(result.rateLimitEnabled).toBe(true);
      expect(result.rateLimitMax).toBe(10);
      expect(result.rateLimitWindowSecs).toBe(60);
    });

    it("stores complex settings as JSON", async () => {
      const settings = {
        username: "user",
        password: "pass",
        apiKey: "abc123",
        cookies: "session=xyz",
      };

      const result = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "JSON Test",
          settings,
        },
      });

      expect(result.settings).toEqual(settings);
    });

    it("handles category arrays", async () => {
      const result = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Category Test",
          categoriesMovies: [2000, 2010, 2020, 2030],
          categoriesTv: [5000, 5030, 5040],
        },
      });

      expect(result.categoriesMovies).toEqual([2000, 2010, 2020, 2030]);
      expect(result.categoriesTv).toEqual([5000, 5030, 5040]);
    });
  });

  describe("Rate Limit Request Tracking", () => {
    it("creates rate limit request records", async () => {
      const indexer = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "Rate Limited",
          rateLimitEnabled: true,
          rateLimitMax: 5,
          rateLimitWindowSecs: 60,
        },
      });

      const request = await prisma.cardigannIndexerRateLimitRequest.create({
        data: {
          indexerId: indexer.id,
        },
      });

      expect(request.id).toBeDefined();
      expect(request.indexerId).toBe(indexer.id);
      expect(request.requestedAt).toBeInstanceOf(Date);
    });

    it("cascades delete when indexer is deleted", async () => {
      const indexer = await prisma.cardigannIndexer.create({
        data: {
          definitionId: "test-indexer",
          name: "To Delete",
        },
      });

      // Create some rate limit requests
      await prisma.cardigannIndexerRateLimitRequest.create({
        data: { indexerId: indexer.id },
      });
      await prisma.cardigannIndexerRateLimitRequest.create({
        data: { indexerId: indexer.id },
      });

      // Delete the indexer
      await prisma.cardigannIndexer.delete({
        where: { id: indexer.id },
      });

      // Verify rate limit requests were also deleted
      const requests = await prisma.cardigannIndexerRateLimitRequest.findMany({
        where: { indexerId: indexer.id },
      });

      expect(requests.length).toBe(0);
    });
  });
});
