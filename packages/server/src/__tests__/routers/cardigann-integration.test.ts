import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "../../db/client.js";
import { cardigannRouter } from "../../routers/cardigann.js";
import { cardigannRepository } from "../../services/cardigann/repository.js";

describe("Cardigann Router Integration", () => {
  let tempDir: string;
  let originalFetch: typeof global.fetch;
  let caller: ReturnType<typeof cardigannRouter.createCaller>;

  beforeEach(async () => {
    originalFetch = global.fetch;
    tempDir = mkdtempSync(join(tmpdir(), "cardigann-router-test-"));

    // Mock the repository storage dir for testing
    (cardigannRepository as any).storageDir = tempDir;
    await cardigannRepository.initialize();

    // Create test definition
    const testDefinition = `
id: test-tracker
name: Test Tracker
description: A test tracker for integration testing
language: en
type: public
links:
  - https://test-tracker.example.com
settings:
  - name: username
    type: text
    label: Username
  - name: password
    type: password
    label: Password
caps:
  categorymappings:
    - {id: 2000, cat: Movies, desc: "Movies"}
    - {id: 5000, cat: TV, desc: "TV Shows"}
  modes:
    movie-search:
      - q
      - imdbid
    tv-search:
      - q
      - tvdbid
search:
  paths:
    - path: /search.php
      inputs:
        q: "{{.Keywords}}"
      rows:
        selector: "tr.result"
      fields:
        title:
          selector: ".title"
        download:
          selector: ".download"
          attribute: "href"
        size:
          selector: ".size"
        seeders:
          selector: ".seeders"
        leechers:
          selector: ".leechers"
`;

    await cardigannRepository.saveDefinition("test-tracker", testDefinition);

    // Create router caller
    caller = cardigannRouter.createCaller({} as any);
  });

  afterEach(async () => {
    global.fetch = originalFetch;

    // Clean up database
    await prisma.indexer.deleteMany({ where: { type: "CARDIGANN" } });
    await prisma.cardigannIndexer.deleteMany({});

    // Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    cardigannRepository.clearCache();
  });

  describe("Definition Management", () => {
    it("lists definitions", async () => {
      const definitions = await caller.listDefinitions({});

      expect(definitions.length).toBeGreaterThanOrEqual(1);
      const testDef = definitions.find((d) => d.id === "test-tracker");
      expect(testDef).toBeDefined();
      expect(testDef?.name).toBe("Test Tracker");
      expect(testDef?.language).toBe("en");
      expect(testDef?.type).toBe("public");
      expect(testDef?.supportsMovieSearch).toBe(true);
      expect(testDef?.supportsTvSearch).toBe(true);
    });

    it("filters definitions by search query", async () => {
      const definitions = await caller.listDefinitions({ search: "Test" });

      expect(definitions.length).toBeGreaterThanOrEqual(1);
      expect(definitions[0].id).toBe("test-tracker");
    });

    it("filters definitions by language", async () => {
      const definitions = await caller.listDefinitions({ language: "en" });

      expect(definitions.length).toBeGreaterThanOrEqual(1);
      expect(definitions.every((d) => d.language === "en")).toBe(true);
    });

    it("filters definitions by type", async () => {
      const definitions = await caller.listDefinitions({ type: "public" });

      expect(definitions.length).toBeGreaterThanOrEqual(1);
      expect(definitions.every((d) => d.type === "public")).toBe(true);
    });

    it("gets definition by id", async () => {
      const definition = await caller.getDefinition({ id: "test-tracker" });

      expect(definition).toBeDefined();
      expect(definition.definition.id).toBe("test-tracker");
      expect(definition.definition.name).toBe("Test Tracker");
      expect(definition.definition.settings).toBeDefined();
      expect(definition.definition.settings?.length).toBe(2);
    });

    it("throws error for non-existent definition", async () => {
      await expect(caller.getDefinition({ id: "nonexistent" })).rejects.toThrow(
        "Definition not found: nonexistent"
      );
    });

    it("returns repository info", async () => {
      const info = await caller.info();

      expect(info.totalDefinitions).toBeGreaterThanOrEqual(1);
      expect(info.storageDir).toBe(tempDir);
    });
  });

  describe("Indexer CRUD Operations", () => {
    it("creates indexer with corresponding Indexer record", async () => {
      const result = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "My Test Tracker",
        settings: {
          username: "testuser",
          password: "testpass",
        },
        categoriesMovies: [2000],
        categoriesTv: [5000],
        priority: 75,
        enabled: true,
        rateLimitEnabled: true,
        rateLimitMax: 10,
        rateLimitWindowSecs: 60,
      });

      expect(result.id).toBeDefined();
      expect(result.name).toBe("My Test Tracker");
      expect(result.definitionId).toBe("test-tracker");
      expect(result.priority).toBe(75);

      // Verify corresponding Indexer record was created
      const indexer = await prisma.indexer.findFirst({
        where: {
          type: "CARDIGANN",
          apiKey: result.id,
        },
      });

      expect(indexer).not.toBeNull();
      expect(indexer?.name).toBe("My Test Tracker");
      expect(indexer?.priority).toBe(75);
      expect(indexer?.enabled).toBe(true);
      expect(indexer?.categoriesMovies).toEqual([2000]);
      expect(indexer?.categoriesTv).toEqual([5000]);
    });

    it("throws error when creating indexer with invalid definition", async () => {
      await expect(
        caller.createIndexer({
          definitionId: "nonexistent",
          name: "Invalid",
        })
      ).rejects.toThrow("Definition not found: nonexistent");
    });

    it("lists indexers", async () => {
      await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Indexer 1",
        priority: 50,
      });

      await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Indexer 2",
        priority: 75,
      });

      const indexers = await caller.listIndexers();

      expect(indexers.length).toBe(2);
      // Should be ordered by enabled desc, priority desc, name asc
      expect(indexers[0].priority).toBe(75);
      expect(indexers[1].priority).toBe(50);
    });

    it("gets indexer by id", async () => {
      const created = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Test Indexer",
        settings: { username: "test" },
      });

      const retrieved = await caller.getIndexer({ id: created.id });

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.name).toBe("Test Indexer");
    });

    it("throws error for non-existent indexer", async () => {
      await expect(caller.getIndexer({ id: "nonexistent" })).rejects.toThrow(
        "Indexer not found: nonexistent"
      );
    });

    it("updates indexer and corresponding Indexer record", async () => {
      const created = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Original Name",
        priority: 50,
      });

      const updated = await caller.updateIndexer({
        id: created.id,
        name: "Updated Name",
        priority: 75,
        enabled: false,
      });

      expect(updated.name).toBe("Updated Name");
      expect(updated.priority).toBe(75);
      expect(updated.enabled).toBe(false);

      // Verify corresponding Indexer record was updated
      const indexer = await prisma.indexer.findFirst({
        where: {
          type: "CARDIGANN",
          apiKey: created.id,
        },
      });

      expect(indexer?.name).toBe("Updated Name");
      expect(indexer?.priority).toBe(75);
      expect(indexer?.enabled).toBe(false);
    });

    it("deletes indexer and corresponding Indexer record", async () => {
      const created = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "To Delete",
      });

      await caller.deleteIndexer({ id: created.id });

      // Verify CardigannIndexer is deleted
      const cardigannIndexer = await prisma.cardigannIndexer.findUnique({
        where: { id: created.id },
      });
      expect(cardigannIndexer).toBeNull();

      // Verify corresponding Indexer is deleted
      const indexer = await prisma.indexer.findFirst({
        where: {
          type: "CARDIGANN",
          apiKey: created.id,
        },
      });
      expect(indexer).toBeNull();
    });
  });

  describe("Search Operations", () => {
    it("searches indexer and returns results", async () => {
      const indexer = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Search Test Indexer",
        settings: {
          username: "test",
          password: "pass",
        },
        categoriesMovies: [2000],
      });

      // Mock fetch for search request
      const mockHtml = `
        <table>
          <tr class="result">
            <td class="title">Test Movie 2024</td>
            <td class="download"><a href="/download/123">Download</a></td>
            <td class="size">1.5 GB</td>
            <td class="seeders">10</td>
            <td class="leechers">5</td>
          </tr>
        </table>
      `;

      global.fetch = mock(async () => ({
        text: async () => mockHtml,
        headers: new Headers(),
      })) as any;

      const results = await caller.searchIndexer({
        id: indexer.id,
        query: "test",
      });

      expect(results.indexerName).toBe("Search Test Indexer");
      expect(results.resultCount).toBe(1);
      expect(results.results.length).toBe(1);
      expect(results.results[0].title).toBe("Test Movie 2024");
      expect(results.results[0].seeders).toBe(10);
    });

    it("throws error when searching disabled indexer", async () => {
      const indexer = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Disabled Indexer",
        enabled: false,
      });

      await expect(
        caller.searchIndexer({
          id: indexer.id,
          query: "test",
        })
      ).rejects.toThrow("Indexer is disabled");
    });

    it("throws error when searching non-existent indexer", async () => {
      await expect(
        caller.searchIndexer({
          id: "nonexistent",
          query: "test",
        })
      ).rejects.toThrow("Indexer not found: nonexistent");
    });

    it("tests indexer connection", async () => {
      const indexer = await caller.createIndexer({
        definitionId: "test-tracker",
        name: "Test Connection",
        settings: {
          username: "test",
          password: "pass",
        },
      });

      // Mock fetch for test request
      const mockHtml = `
        <table>
          <tr class="result">
            <td class="title">Test Result</td>
            <td class="download"><a href="/download/123">Download</a></td>
            <td class="size">1.0 GB</td>
            <td class="seeders">5</td>
          </tr>
        </table>
      `;

      global.fetch = mock(async () => ({
        text: async () => mockHtml,
        headers: new Headers(),
      })) as any;

      const result = await caller.testIndexer({ id: indexer.id });

      expect(result.success).toBe(true);
      expect(result.indexerName).toBe("Test Connection");
      expect(result.testResults?.resultCount).toBe(1);
      expect(result.testResults?.sample.length).toBe(1);
    });
  });

  describe("Sync Operations", () => {
    it("syncs definitions from GitHub", async () => {
      const mockListResponse = [
        {
          name: "new-tracker.yml",
          type: "file",
          download_url: "https://raw.github.com/new-tracker.yml",
        },
      ];

      const mockYml = `
id: new-tracker
name: New Tracker
links:
  - https://new.com
search:
  paths:
    - path: /search
`;

      global.fetch = mock(async (url: string) => {
        if (typeof url === "string" && url.includes("api.github.com")) {
          return {
            ok: true,
            json: async () => mockListResponse,
          };
        }
        return {
          ok: true,
          text: async () => mockYml,
        };
      }) as any;

      const result = await caller.sync();

      expect(result.success).toBe(true);
      expect(result.added).toBeGreaterThanOrEqual(1);
      expect(result.message).toContain("Synced");
    });

    it("clears definition cache", async () => {
      // Load a definition to populate cache
      await caller.getDefinition({ id: "test-tracker" });

      const result = await caller.clearCache();

      expect(result.success).toBe(true);
      expect(result.message).toBe("Cache cleared");
    });
  });
});
