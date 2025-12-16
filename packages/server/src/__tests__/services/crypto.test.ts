/**
 * Crypto Service Tests
 *
 * Comprehensive tests for the cryptographic service including:
 * - Happy path functionality
 * - Security verification
 * - Edge cases
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CryptoService, resetCryptoService } from "../../services/crypto.js";
import { writeFileSync, readFileSync, chmodSync, existsSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";

describe("CryptoService", () => {
  let tempDir: string;
  let keyPath: string;
  let service: CryptoService;

  beforeEach(() => {
    // Create fresh temp directory for each test
    tempDir = mkdtempSync(join(tmpdir(), "crypto-test-"));
    keyPath = join(tempDir, ".annex-key");
    service = new CryptoService(keyPath);
    resetCryptoService();
  });

  afterEach(() => {
    // Clean up
    service.reset();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("Key Generation and Loading", () => {
    it("generates 32-byte master key on first run", async () => {
      await service.initialize();

      expect(existsSync(keyPath)).toBe(true);

      const key = readFileSync(keyPath);
      expect(key.length).toBe(32);
    });

    it("loads existing key from file", async () => {
      // Create a known key
      const existingKey = randomBytes(32);
      writeFileSync(keyPath, existingKey);
      if (process.platform !== "win32") {
        chmodSync(keyPath, 0o600);
      }

      await service.initialize();

      // Verify it uses the existing key by encrypting/decrypting
      const plaintext = "test message";
      const encrypted = service.encrypt(plaintext);
      expect(service.decrypt(encrypted)).toBe(plaintext);
    });

    it("sets correct file permissions (0600) on key file", async () => {
      if (process.platform === "win32") {
        return; // Skip on Windows
      }

      await service.initialize();

      const stats = statSync(keyPath);
      const permissions = stats.mode & 0o777;
      expect(permissions).toBe(0o600);
    });

    it("produces different ciphertext for same plaintext (random IV)", async () => {
      await service.initialize();

      const plaintext = "same message";
      const encrypted1 = service.encrypt(plaintext);
      const encrypted2 = service.encrypt(plaintext);

      // Ciphertexts should differ due to random IV
      expect(encrypted1).not.toBe(encrypted2);

      // But both should decrypt to same value
      expect(service.decrypt(encrypted1)).toBe(plaintext);
      expect(service.decrypt(encrypted2)).toBe(plaintext);
    });

    it("is idempotent - multiple initialize calls are safe", async () => {
      await service.initialize();
      const encrypted1 = service.encrypt("test");

      await service.initialize();
      const encrypted2 = service.encrypt("test");

      // Should still work after multiple initializations
      expect(service.decrypt(encrypted1)).toBe("test");
      expect(service.decrypt(encrypted2)).toBe("test");
    });
  });

  describe("Encryption and Decryption", () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it("encrypts and decrypts string correctly", () => {
      const plaintext = "Hello, World!";
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("encrypts and decrypts unicode/emoji correctly", () => {
      const plaintext = "Hello, \u4e16\u754c! \u{1F600}\u{1F389}\u{1F680}";
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("encrypts and decrypts empty string", () => {
      const plaintext = "";
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("encrypts and decrypts very long strings (1MB+)", () => {
      const plaintext = "x".repeat(1024 * 1024); // 1MB
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles null bytes in plaintext", () => {
      const plaintext = "before\x00after";
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles newlines and special characters", () => {
      const plaintext = "line1\nline2\r\nline3\ttab";
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("handles JSON content", () => {
      const plaintext = JSON.stringify({
        apiKey: "secret123",
        nested: { value: 42 },
        array: [1, 2, 3],
      });
      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
      expect(JSON.parse(decrypted)).toEqual(JSON.parse(plaintext));
    });
  });

  describe("Security Tests", () => {
    it("rejects key file with wrong permissions (readable by others)", async () => {
      if (process.platform === "win32") {
        return; // Skip on Windows
      }

      // Create key with insecure permissions
      const key = randomBytes(32);
      writeFileSync(keyPath, key);
      chmodSync(keyPath, 0o644); // World-readable

      await expect(service.initialize()).rejects.toThrow(/insecure permissions/);
    });

    it("rejects key file shorter than 32 bytes", async () => {
      const shortKey = randomBytes(16);
      writeFileSync(keyPath, shortKey);
      if (process.platform !== "win32") {
        chmodSync(keyPath, 0o600);
      }

      await expect(service.initialize()).rejects.toThrow(/Invalid key length/);
    });

    it("rejects key file longer than 32 bytes", async () => {
      const longKey = randomBytes(64);
      writeFileSync(keyPath, longKey);
      if (process.platform !== "win32") {
        chmodSync(keyPath, 0o600);
      }

      await expect(service.initialize()).rejects.toThrow(/Invalid key length/);
    });

    it("decrypt fails on tampered ciphertext (modified data)", async () => {
      await service.initialize();

      const encrypted = service.encrypt("secret message");
      const parts = encrypted.split(":");
      // Tamper with the encrypted data (last part)
      const tamperedData = Buffer.from(parts[2], "base64");
      tamperedData[0] ^= 0xff; // Flip bits
      parts[2] = tamperedData.toString("base64");
      const tampered = parts.join(":");

      expect(() => service.decrypt(tampered)).toThrow(/authentication error/);
    });

    it("decrypt fails on tampered auth tag", async () => {
      await service.initialize();

      const encrypted = service.encrypt("secret message");
      const parts = encrypted.split(":");
      // Tamper with auth tag (second part)
      const tamperedTag = Buffer.from(parts[1], "base64");
      tamperedTag[0] ^= 0xff;
      parts[1] = tamperedTag.toString("base64");
      const tampered = parts.join(":");

      expect(() => service.decrypt(tampered)).toThrow(/authentication error/);
    });

    it("decrypt fails on tampered IV", async () => {
      await service.initialize();

      const encrypted = service.encrypt("secret message");
      const parts = encrypted.split(":");
      // Tamper with IV (first part)
      const tamperedIv = Buffer.from(parts[0], "base64");
      tamperedIv[0] ^= 0xff;
      parts[0] = tamperedIv.toString("base64");
      const tampered = parts.join(":");

      expect(() => service.decrypt(tampered)).toThrow(/authentication error/);
    });

    it("decrypt fails on truncated ciphertext", async () => {
      await service.initialize();

      const encrypted = service.encrypt("secret message");
      const parts = encrypted.split(":");
      parts[2] = parts[2].slice(0, 5); // Truncate data
      const truncated = parts.join(":");

      expect(() => service.decrypt(truncated)).toThrow();
    });

    it("decrypt fails on malformed format (missing colons)", async () => {
      await service.initialize();

      expect(() => service.decrypt("notvalidformat")).toThrow(/Invalid ciphertext format/);
    });

    it("decrypt fails on non-base64 input", async () => {
      await service.initialize();

      expect(() => service.decrypt("!!!:###:$$$")).toThrow();
    });

    it("throws if used before initialization", () => {
      const uninitService = new CryptoService(join(tempDir, "new-key"));

      expect(() => uninitService.encrypt("test")).toThrow(/not initialized/);
      expect(() => uninitService.decrypt("test")).toThrow(/not initialized/);
    });

    it("key file is not world-readable after creation", async () => {
      if (process.platform === "win32") {
        return;
      }

      await service.initialize();

      const stats = statSync(keyPath);
      // Check that others have no permissions
      const otherPerms = stats.mode & 0o007;
      expect(otherPerms).toBe(0);
    });

    it("error messages do not contain key material", async () => {
      const key = randomBytes(32);
      writeFileSync(keyPath, key);
      if (process.platform !== "win32") {
        chmodSync(keyPath, 0o644); // Insecure
      }

      try {
        await service.initialize();
      } catch (error) {
        const message = (error as Error).message;
        // Key should not appear in error
        expect(message).not.toContain(key.toString("hex"));
        expect(message).not.toContain(key.toString("base64"));
      }
    });

    it("decryption error messages do not reveal plaintext", async () => {
      await service.initialize();

      try {
        service.decrypt("invalid:data:here");
      } catch (error) {
        const message = (error as Error).message;
        // Should be generic error
        expect(message).not.toContain("invalid");
        expect(message).not.toContain("data");
        expect(message).not.toContain("here");
      }
    });
  });

  describe("Edge Cases", () => {
    it("handles concurrent encrypt/decrypt operations", async () => {
      await service.initialize();

      const operations = Array.from({ length: 100 }, (_, i) => ({
        plaintext: `message-${i}`,
      }));

      // Encrypt all concurrently
      const encrypted = await Promise.all(
        operations.map(async (op) => ({
          ...op,
          encrypted: service.encrypt(op.plaintext),
        }))
      );

      // Decrypt all concurrently
      const decrypted = await Promise.all(
        encrypted.map(async (op) => ({
          ...op,
          decrypted: service.decrypt(op.encrypted),
        }))
      );

      // All should match
      for (const op of decrypted) {
        expect(op.decrypted).toBe(op.plaintext);
      }
    });

    it("works with binary-like content in strings", async () => {
      await service.initialize();

      // Create a string with various byte values
      const chars = Array.from({ length: 256 }, (_, i) => String.fromCharCode(i));
      const plaintext = chars.join("");

      const encrypted = service.encrypt(plaintext);
      const decrypted = service.decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it("verify method returns true for valid ciphertext", async () => {
      await service.initialize();

      const encrypted = service.encrypt("test");
      expect(service.verify(encrypted)).toBe(true);
    });

    it("verify method returns false for invalid ciphertext", async () => {
      await service.initialize();

      expect(service.verify("invalid:data:format")).toBe(false);
      expect(service.verify("tampered")).toBe(false);
    });

    it("reset clears key from memory", async () => {
      await service.initialize();

      const encrypted = service.encrypt("test");
      service.reset();

      expect(service.isInitialized()).toBe(false);
      expect(() => service.decrypt(encrypted)).toThrow(/not initialized/);
    });

    it("can reinitialize after reset", async () => {
      await service.initialize();
      const encrypted = service.encrypt("test");

      service.reset();
      await service.initialize();

      // Should still decrypt (same key file)
      expect(service.decrypt(encrypted)).toBe("test");
    });
  });

  describe("Cryptographic Properties", () => {
    it("IV is unique for each encryption (statistical test)", async () => {
      await service.initialize();

      const ivs = new Set<string>();
      const iterations = 1000;

      for (let i = 0; i < iterations; i++) {
        const encrypted = service.encrypt("same");
        const iv = encrypted.split(":")[0];
        ivs.add(iv);
      }

      // All IVs should be unique
      expect(ivs.size).toBe(iterations);
    });

    it("auth tag length is 16 bytes", async () => {
      await service.initialize();

      const encrypted = service.encrypt("test");
      const authTagB64 = encrypted.split(":")[1];
      const authTag = Buffer.from(authTagB64, "base64");

      expect(authTag.length).toBe(16);
    });

    it("ciphertext format has exactly 3 parts", async () => {
      await service.initialize();

      const encrypted = service.encrypt("test message with various content");
      const parts = encrypted.split(":");

      expect(parts.length).toBe(3);
    });

    it("IV length is 16 bytes", async () => {
      await service.initialize();

      const encrypted = service.encrypt("test");
      const ivB64 = encrypted.split(":")[0];
      const iv = Buffer.from(ivB64, "base64");

      expect(iv.length).toBe(16);
    });
  });
});
