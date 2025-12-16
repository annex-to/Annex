/**
 * Cryptographic Service
 *
 * Provides AES-256-GCM encryption for secrets management.
 * Master key is auto-generated on first run and stored locally.
 *
 * Security features:
 * - AES-256-GCM (authenticated encryption)
 * - Random IV for each encryption
 * - Key file permissions restricted to owner (0600)
 * - Constant-time comparison for auth tags
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "crypto";
import { readFile, writeFile, chmod, access, stat, constants } from "fs/promises";
import { join } from "path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const REQUIRED_PERMISSIONS = 0o600;

export class CryptoService {
  private masterKey: Buffer | null = null;
  private keyPath: string;
  private initialized = false;

  constructor(keyPath?: string) {
    this.keyPath = keyPath || process.env.ANNEX_KEY_PATH || join(process.cwd(), ".annex-key");
  }

  /**
   * Initialize the crypto service.
   * Loads existing key or generates a new one.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Check if key file exists
      await access(this.keyPath, constants.R_OK);

      // Verify file permissions (Unix only)
      if (process.platform !== "win32") {
        const stats = await stat(this.keyPath);
        const permissions = stats.mode & 0o777;

        if (permissions !== REQUIRED_PERMISSIONS) {
          throw new Error(
            `Key file has insecure permissions (${permissions.toString(8)}). ` +
            `Expected ${REQUIRED_PERMISSIONS.toString(8)}. ` +
            `Fix with: chmod 600 ${this.keyPath}`
          );
        }
      }

      // Load existing key
      this.masterKey = await readFile(this.keyPath);

      // Validate key length
      if (this.masterKey.length !== KEY_LENGTH) {
        throw new Error(
          `Invalid key length: ${this.masterKey.length} bytes. Expected ${KEY_LENGTH} bytes.`
        );
      }

      console.log("[Crypto] Master key loaded from file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Key file doesn't exist - generate new key
        await this.generateKey();
      } else {
        throw error;
      }
    }

    this.initialized = true;
  }

  /**
   * Generate a new master key and save to file.
   */
  private async generateKey(): Promise<void> {
    this.masterKey = randomBytes(KEY_LENGTH);

    await writeFile(this.keyPath, this.masterKey);

    // Set restrictive permissions (Unix only)
    if (process.platform !== "win32") {
      await chmod(this.keyPath, REQUIRED_PERMISSIONS);
    }

    console.log("[Crypto] Generated new master key");
  }

  /**
   * Check if the service is initialized.
   */
  isInitialized(): boolean {
    return this.initialized && this.masterKey !== null;
  }

  /**
   * Encrypt a plaintext string.
   * Returns format: {iv}:{authTag}:{ciphertext} (all base64)
   */
  encrypt(plaintext: string): string {
    if (!this.masterKey) {
      throw new Error("Crypto service not initialized. Call initialize() first.");
    }

    // Generate random IV for each encryption
    const iv = randomBytes(IV_LENGTH);

    // Create cipher
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv);

    // Encrypt
    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);

    // Get auth tag
    const authTag = cipher.getAuthTag();

    // Combine: iv:authTag:ciphertext
    return [
      iv.toString("base64"),
      authTag.toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }

  /**
   * Decrypt a ciphertext string.
   * Expects format: {iv}:{authTag}:{ciphertext} (all base64)
   */
  decrypt(ciphertext: string): string {
    if (!this.masterKey) {
      throw new Error("Crypto service not initialized. Call initialize() first.");
    }

    // Parse format
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid ciphertext format");
    }

    const [ivB64, authTagB64, dataB64] = parts;

    // Decode from base64
    let iv: Buffer;
    let authTag: Buffer;
    let encrypted: Buffer;

    try {
      iv = Buffer.from(ivB64, "base64");
      authTag = Buffer.from(authTagB64, "base64");
      encrypted = Buffer.from(dataB64, "base64");
    } catch {
      throw new Error("Invalid base64 encoding in ciphertext");
    }

    // Validate lengths
    if (iv.length !== IV_LENGTH) {
      throw new Error("Invalid IV length");
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error("Invalid auth tag length");
    }

    // Create decipher
    const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    try {
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);

      return decrypted.toString("utf8");
    } catch {
      // Don't reveal details about decryption failure
      throw new Error("Decryption failed: authentication error");
    }
  }

  /**
   * Verify that a ciphertext can be decrypted (without returning the value).
   * Useful for validation without exposing secrets.
   */
  verify(ciphertext: string): boolean {
    try {
      this.decrypt(ciphertext);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the key file path (for testing/debugging only).
   */
  getKeyPath(): string {
    return this.keyPath;
  }

  /**
   * Reset the service (for testing only).
   * Clears the master key from memory.
   */
  reset(): void {
    if (this.masterKey) {
      // Overwrite key in memory before clearing
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    this.initialized = false;
  }
}

// Singleton instance
let cryptoInstance: CryptoService | null = null;

/**
 * Get the singleton CryptoService instance.
 */
export function getCryptoService(): CryptoService {
  if (!cryptoInstance) {
    cryptoInstance = new CryptoService();
  }
  return cryptoInstance;
}

/**
 * Reset the singleton instance (for testing only).
 */
export function resetCryptoService(): void {
  if (cryptoInstance) {
    cryptoInstance.reset();
    cryptoInstance = null;
  }
}
