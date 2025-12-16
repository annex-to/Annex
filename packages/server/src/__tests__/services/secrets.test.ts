/**
 * Secrets Service Tests
 *
 * Comprehensive tests for the secrets storage service including:
 * - Happy path functionality
 * - Encryption verification
 * - Cache behavior
 * - Event emission
 * - Edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretsService, resetSecretsService } from "../../services/secrets.js";
import { CryptoService, resetCryptoService } from "../../services/crypto.js";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { createMockPrisma } from "../setup.js";

describe("SecretsService", () => {
  let tempDir: string;
  let keyPath: string;
  let cryptoService: CryptoService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;
  let secretsService: SecretsService;

  beforeEach(async () => {
    // Create fresh temp directory
    tempDir = mkdtempSync(join(tmpdir(), "secrets-test-"));
    keyPath = join(tempDir, ".annex-key");

    // Reset singletons
    resetCryptoService();
    resetSecretsService();

    // Initialize crypto service with test key path
    cryptoService = new CryptoService(keyPath);
    await cryptoService.initialize();

    // Create mock Prisma client
    mockPrisma = createMockPrisma();

    // Create secrets service with injected dependencies
    secretsService = new SecretsService({
      cacheTTL: 100, // Short TTL for testing
      prismaClient: mockPrisma as any,
      cryptoProvider: () => cryptoService,
    });
  });

  afterEach(() => {
    // Clean up
    cryptoService.reset();
    resetSecretsService();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe("Basic Operations", () => {
    it("setSecret stores encrypted value in database", async () => {
      await secretsService.setSecret("test.key", "secret-value");

      // Check that upsert was called
      expect(mockPrisma.setting.upsert).toHaveBeenCalledTimes(1);

      // Get raw value from mock store
      const rawValue = mockPrisma._store.get("test.key")?.value;
      expect(rawValue).toBeDefined();

      // Raw value should be encrypted (not plaintext)
      expect(rawValue).not.toBe("secret-value");
      expect(rawValue).toContain(":"); // Encrypted format has colons
    });

    it("getSecret retrieves and decrypts value", async () => {
      await secretsService.setSecret("test.key", "my-secret");

      // Clear cache to force DB read
      secretsService.clearCache();

      const value = await secretsService.getSecret("test.key");
      expect(value).toBe("my-secret");
    });

    it("hasSecret returns true for existing secret", async () => {
      await secretsService.setSecret("exists.key", "value");

      const exists = await secretsService.hasSecret("exists.key");
      expect(exists).toBe(true);
    });

    it("hasSecret returns false for missing secret", async () => {
      const exists = await secretsService.hasSecret("missing.key");
      expect(exists).toBe(false);
    });

    it("deleteSecret removes from database", async () => {
      await secretsService.setSecret("delete.me", "value");

      // Verify it exists
      expect(await secretsService.hasSecret("delete.me")).toBe(true);

      // Delete it
      await secretsService.deleteSecret("delete.me");

      // Verify it's gone
      secretsService.clearCache();
      const value = await secretsService.getSecret("delete.me");
      expect(value).toBeNull();
    });

    it("listSecretKeys returns all keys", async () => {
      await secretsService.setSecret("first.key", "value1");
      await secretsService.setSecret("second.key", "value2");
      await secretsService.setSecret("third.key", "value3");

      const keys = await secretsService.listSecretKeys();
      expect(keys).toHaveLength(3);
      expect(keys).toContain("first.key");
      expect(keys).toContain("second.key");
      expect(keys).toContain("third.key");
    });

    it("listSecretKeys filters by prefix", async () => {
      await secretsService.setSecret("api.key1", "value1");
      await secretsService.setSecret("api.key2", "value2");
      await secretsService.setSecret("db.password", "value3");

      const apiKeys = await secretsService.listSecretKeys("api.");
      expect(apiKeys).toHaveLength(2);
      expect(apiKeys).toContain("api.key1");
      expect(apiKeys).toContain("api.key2");
      expect(apiKeys).not.toContain("db.password");
    });

    it("setSecret updates existing secret", async () => {
      await secretsService.setSecret("update.key", "original");
      await secretsService.setSecret("update.key", "updated");

      secretsService.clearCache();
      const value = await secretsService.getSecret("update.key");
      expect(value).toBe("updated");
    });

    it("getSecret returns null for missing secret", async () => {
      const value = await secretsService.getSecret("nonexistent");
      expect(value).toBeNull();
    });
  });

  describe("Cache Behavior", () => {
    it("cache returns value without DB query on repeated reads", async () => {
      await secretsService.setSecret("cached.key", "value");

      // Reset mock call count
      vi.clearAllMocks();

      // Read multiple times
      await secretsService.getSecret("cached.key");
      await secretsService.getSecret("cached.key");
      await secretsService.getSecret("cached.key");

      // Should only hit cache, not DB (first setSecret already cached it)
      expect(mockPrisma.setting.findUnique).toHaveBeenCalledTimes(0);
    });

    it("cache invalidates after TTL expires", async () => {
      await secretsService.setSecret("ttl.key", "value");

      // Wait for cache to expire (TTL is 100ms in test)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Reset mock call count
      vi.clearAllMocks();

      // Read again - should hit DB
      await secretsService.getSecret("ttl.key");
      expect(mockPrisma.setting.findUnique).toHaveBeenCalledTimes(1);
    });

    it("clearCache removes all cached entries", async () => {
      await secretsService.setSecret("key1", "value1");
      await secretsService.setSecret("key2", "value2");

      secretsService.clearCache();
      vi.clearAllMocks();

      // Both should hit DB now
      await secretsService.getSecret("key1");
      await secretsService.getSecret("key2");

      expect(mockPrisma.setting.findUnique).toHaveBeenCalledTimes(2);
    });

    it("invalidateCache removes specific entry", async () => {
      await secretsService.setSecret("keep.key", "value1");
      await secretsService.setSecret("invalidate.key", "value2");

      secretsService.invalidateCache("invalidate.key");
      vi.clearAllMocks();

      // keep.key should be cached
      await secretsService.getSecret("keep.key");
      expect(mockPrisma.setting.findUnique).toHaveBeenCalledTimes(0);

      // invalidate.key should hit DB
      await secretsService.getSecret("invalidate.key");
      expect(mockPrisma.setting.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe("Event Emission", () => {
    it("emits change event when secret is set", async () => {
      const changeHandler = vi.fn();
      secretsService.on("change", changeHandler);

      await secretsService.setSecret("event.key", "value");

      expect(changeHandler).toHaveBeenCalledWith("event.key");
    });

    it("emits change event when secret is deleted", async () => {
      await secretsService.setSecret("delete.key", "value");

      const changeHandler = vi.fn();
      secretsService.on("change", changeHandler);

      await secretsService.deleteSecret("delete.key");

      expect(changeHandler).toHaveBeenCalledWith("delete.key");
    });

    it("emits delete event when secret is deleted", async () => {
      await secretsService.setSecret("delete.key", "value");

      const deleteHandler = vi.fn();
      secretsService.on("delete", deleteHandler);

      await secretsService.deleteSecret("delete.key");

      expect(deleteHandler).toHaveBeenCalledWith("delete.key");
    });
  });

  describe("Security Tests", () => {
    it("stored value in DB is encrypted (not plaintext)", async () => {
      const plaintext = "super-secret-api-key";
      await secretsService.setSecret("api.key", plaintext);

      // Get raw value from mock store
      const rawValue = mockPrisma._store.get("api.key")?.value;

      // Should not contain plaintext
      expect(rawValue).not.toContain(plaintext);

      // Should be in encrypted format (iv:tag:data)
      expect(rawValue?.split(":").length).toBe(3);

      // But decryption should return original
      secretsService.clearCache();
      const decrypted = await secretsService.getSecret("api.key");
      expect(decrypted).toBe(plaintext);
    });

    it("different secrets have different ciphertexts", async () => {
      await secretsService.setSecret("key1", "same-value");
      await secretsService.setSecret("key2", "same-value");

      const raw1 = mockPrisma._store.get("key1")?.value;
      const raw2 = mockPrisma._store.get("key2")?.value;

      // Even same value should encrypt differently (random IV)
      expect(raw1).not.toBe(raw2);
    });

    it("getRawValue returns encrypted value", async () => {
      await secretsService.setSecret("raw.test", "secret");

      const raw = await secretsService.getRawValue("raw.test");
      expect(raw).toBeDefined();
      expect(raw).not.toBe("secret");
      expect(raw?.split(":").length).toBe(3);
    });
  });

  describe("Bulk Operations", () => {
    it("getSecrets retrieves multiple secrets", async () => {
      await secretsService.setSecret("bulk.key1", "value1");
      await secretsService.setSecret("bulk.key2", "value2");
      await secretsService.setSecret("bulk.key3", "value3");

      const secrets = await secretsService.getSecrets([
        "bulk.key1",
        "bulk.key2",
        "bulk.key3",
        "missing.key",
      ]);

      expect(secrets["bulk.key1"]).toBe("value1");
      expect(secrets["bulk.key2"]).toBe("value2");
      expect(secrets["bulk.key3"]).toBe("value3");
      expect(secrets["missing.key"]).toBeNull();
    });

    it("setSecrets stores multiple secrets", async () => {
      await secretsService.setSecrets({
        "multi.key1": "value1",
        "multi.key2": "value2",
      });

      secretsService.clearCache();
      expect(await secretsService.getSecret("multi.key1")).toBe("value1");
      expect(await secretsService.getSecret("multi.key2")).toBe("value2");
    });
  });

  describe("Edge Cases", () => {
    it("handles empty string as secret value", async () => {
      await secretsService.setSecret("empty.key", "");

      secretsService.clearCache();
      const value = await secretsService.getSecret("empty.key");
      expect(value).toBe("");
    });

    it("handles very long secret values", async () => {
      const longValue = "x".repeat(10000);
      await secretsService.setSecret("long.key", longValue);

      secretsService.clearCache();
      const value = await secretsService.getSecret("long.key");
      expect(value).toBe(longValue);
    });

    it("handles unicode in secret values", async () => {
      const unicodeValue = "\u4e2d\u6587\u65e5\u672c\u8a9e\ud83d\ude00";
      await secretsService.setSecret("unicode.key", unicodeValue);

      secretsService.clearCache();
      const value = await secretsService.getSecret("unicode.key");
      expect(value).toBe(unicodeValue);
    });

    it("handles special characters in keys", async () => {
      await secretsService.setSecret("key.with.dots", "value1");
      await secretsService.setSecret("key_with_underscores", "value2");
      await secretsService.setSecret("key-with-dashes", "value3");

      expect(await secretsService.getSecret("key.with.dots")).toBe("value1");
      expect(await secretsService.getSecret("key_with_underscores")).toBe("value2");
      expect(await secretsService.getSecret("key-with-dashes")).toBe("value3");
    });

    it("getSecret returns null for deleted secret", async () => {
      await secretsService.setSecret("temp.key", "value");
      await secretsService.deleteSecret("temp.key");

      const value = await secretsService.getSecret("temp.key");
      expect(value).toBeNull();
    });

    it("delete non-existent secret does not throw", async () => {
      await expect(
        secretsService.deleteSecret("never.existed")
      ).resolves.not.toThrow();
    });

    it("concurrent setSecret calls don't corrupt data", async () => {
      const operations = Array.from({ length: 50 }, (_, i) => ({
        key: `concurrent.key${i}`,
        value: `value-${i}`,
      }));

      // Set all concurrently
      await Promise.all(
        operations.map((op) => secretsService.setSecret(op.key, op.value))
      );

      // Verify all values
      secretsService.clearCache();
      for (const op of operations) {
        const value = await secretsService.getSecret(op.key);
        expect(value).toBe(op.value);
      }
    });
  });

  describe("JSON Value Handling", () => {
    it("stores and retrieves JSON objects", async () => {
      const jsonValue = { apiKey: "secret", nested: { value: 123 } };
      await secretsService.setSecret("json.key", JSON.stringify(jsonValue));

      secretsService.clearCache();
      const retrieved = await secretsService.getSecret("json.key");
      expect(JSON.parse(retrieved!)).toEqual(jsonValue);
    });

    it("handles JSON with special characters", async () => {
      const jsonValue = { message: 'Hello "World"!\n\t' };
      await secretsService.setSecret("json.special", JSON.stringify(jsonValue));

      secretsService.clearCache();
      const retrieved = await secretsService.getSecret("json.special");
      expect(JSON.parse(retrieved!)).toEqual(jsonValue);
    });
  });
});
