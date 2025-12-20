import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardigannRepository } from "../../../services/cardigann/repository";

describe("CardigannRepository", () => {
  let tempDir: string;
  let repository: CardigannRepository;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    tempDir = mkdtempSync(join(tmpdir(), "cardigann-repo-test-"));
    repository = new CardigannRepository(tempDir);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("initialize", () => {
    it("creates storage directory if it doesn't exist", async () => {
      const newTempDir = join(tempDir, "nested", "dir");
      const newRepo = new CardigannRepository(newTempDir);

      expect(existsSync(newTempDir)).toBe(false);

      await newRepo.initialize();

      expect(existsSync(newTempDir)).toBe(true);
    });
  });

  describe("saveDefinition and getDefinition", () => {
    it("saves and retrieves definition", async () => {
      await repository.initialize();

      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-indexer", yml);

      const retrieved = await repository.getDefinition("test-indexer");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.definition.id).toBe("test-indexer");
      expect(retrieved?.definition.name).toBe("Test Indexer");
    });

    it("returns null for non-existent definition", async () => {
      await repository.initialize();

      const result = await repository.getDefinition("nonexistent");

      expect(result).toBeNull();
    });

    it("caches parsed definitions", async () => {
      await repository.initialize();

      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-indexer", yml);

      const first = await repository.getDefinition("test-indexer");
      const second = await repository.getDefinition("test-indexer");

      expect(first).toBe(second);
    });
  });

  describe("hasDefinition", () => {
    it("returns true for existing definition", async () => {
      await repository.initialize();

      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-indexer", yml);

      const has = await repository.hasDefinition("test-indexer");

      expect(has).toBe(true);
    });

    it("returns false for non-existent definition", async () => {
      await repository.initialize();

      const has = await repository.hasDefinition("nonexistent");

      expect(has).toBe(false);
    });
  });

  describe("listDefinitions", () => {
    it("returns empty array when no definitions exist", async () => {
      await repository.initialize();

      const definitions = await repository.listDefinitions();

      expect(definitions).toEqual([]);
    });

    it("lists all definitions with metadata", async () => {
      await repository.initialize();

      const yml1 = `
id: indexer-1
name: Indexer One
links:
  - https://one.com
caps:
  modes:
    movie-search:
      - q
    tv-search:
      - q
search:
  paths:
    - path: /search
`;

      const yml2 = `
id: indexer-2
name: Indexer Two
links:
  - https://two.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("indexer-1", yml1);
      await repository.saveDefinition("indexer-2", yml2);

      const definitions = await repository.listDefinitions();

      expect(definitions.length).toBe(2);

      const indexer1 = definitions.find((d) => d.id === "indexer-1");
      const indexer2 = definitions.find((d) => d.id === "indexer-2");

      expect(indexer1).toBeDefined();
      expect(indexer1?.name).toBe("Indexer One");
      expect(indexer1?.supportsMovieSearch).toBe(true);
      expect(indexer1?.supportsTvSearch).toBe(true);
      expect(indexer2).toBeDefined();
      expect(indexer2?.supportsMovieSearch).toBe(false);
    });
  });

  describe("searchDefinitions", () => {
    it("finds definitions by name", async () => {
      await repository.initialize();

      const yml1 = `
id: test-one
name: Test Indexer One
links:
  - https://one.com
search:
  paths:
    - path: /search
`;

      const yml2 = `
id: test-two
name: Another Indexer
links:
  - https://two.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-one", yml1);
      await repository.saveDefinition("test-two", yml2);

      const results = await repository.searchDefinitions("One");

      expect(results.length).toBe(1);
      expect(results[0].id).toBe("test-one");
    });

    it("search is case-insensitive", async () => {
      await repository.initialize();

      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-indexer", yml);

      const results = await repository.searchDefinitions("TEST");

      expect(results.length).toBe(1);
    });
  });

  describe("getRepositoryInfo", () => {
    it("returns repository information", async () => {
      await repository.initialize();

      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-indexer", yml);

      const info = await repository.getRepositoryInfo();

      expect(info.totalDefinitions).toBe(1);
      expect(info.storageDir).toBe(tempDir);
    });
  });

  describe("clearCache", () => {
    it("clears cached definitions", async () => {
      await repository.initialize();

      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
search:
  paths:
    - path: /search
`;

      await repository.saveDefinition("test-indexer", yml);

      await repository.getDefinition("test-indexer");

      repository.clearCache();

      const retrieved = await repository.getDefinition("test-indexer");

      expect(retrieved).not.toBeNull();
      expect(retrieved?.definition.id).toBe("test-indexer");
    });
  });

  describe("syncFromGitHub", () => {
    it("syncs definitions from GitHub", async () => {
      const mockListResponse = [
        { name: "indexer1.yml", type: "file", download_url: "https://raw.github.com/indexer1.yml" },
        { name: "indexer2.yml", type: "file", download_url: "https://raw.github.com/indexer2.yml" },
      ];

      const mockYml = `
id: test-indexer
name: Test Indexer
links:
  - https://test.com
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
        } else {
          return {
            ok: true,
            text: async () => mockYml,
          };
        }
      }) as any;

      const stats = await repository.syncFromGitHub();

      expect(stats.added).toBe(2);
      expect(stats.updated).toBe(0);
      expect(stats.errors.length).toBe(0);
    });

    it("handles GitHub API errors gracefully", async () => {
      global.fetch = mock(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
      })) as any;

      await expect(repository.syncFromGitHub()).rejects.toThrow("GitHub API error");
    });
  });
});
