/**
 * Secrets Service
 *
 * Encrypted secrets storage using the Setting table.
 * All secrets are encrypted at rest using AES-256-GCM.
 *
 * Features:
 * - Encrypted storage in database
 * - In-memory cache with TTL
 * - Event emission on changes
 * - Migration support from environment variables
 */

import { EventEmitter } from "events";
import type { CryptoService } from "./crypto.js";
import { getConfig } from "../config/index.js";
import { prisma } from "../db/client.js";
import { getCryptoService } from "./crypto.js";

const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  value: string;
  expires: number;
}

// Minimal interface for the Prisma operations we need
interface SettingModel {
  findUnique(args: { where: { key: string } }): Promise<{ key: string; value: string; updatedAt: Date } | null>;
  findMany(args?: { select?: { key: boolean }; where?: { key?: { startsWith: string } } }): Promise<Array<{ key: string; value?: string }>>;
  upsert(args: {
    where: { key: string };
    create: { key: string; value: string };
    update: { value: string };
  }): Promise<{ key: string; value: string }>;
  delete(args: { where: { key: string } }): Promise<unknown>;
  count(args: { where: { key: string } }): Promise<number>;
}

interface PrismaLike {
  setting: SettingModel;
}

export class SecretsService extends EventEmitter {
  private cache: Map<string, CacheEntry> = new Map();
  private cacheTTL: number;
  private db: PrismaLike;
  private cryptoProvider: () => CryptoService;

  constructor(options?: {
    cacheTTL?: number;
    prismaClient?: PrismaLike;
    cryptoProvider?: () => CryptoService;
  }) {
    super();
    this.cacheTTL = options?.cacheTTL ?? DEFAULT_CACHE_TTL;

    // Use injected dependencies for testing, otherwise use real implementations
    this.db = options?.prismaClient ?? prisma;
    this.cryptoProvider = options?.cryptoProvider ?? getCryptoService;
  }

  /**
   * Get a secret value by key.
   * Returns null if the secret doesn't exist.
   */
  async getSecret(key: string): Promise<string | null> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }

    // Cache miss or expired - fetch from database
    const setting = await this.db.setting.findUnique({
      where: { key },
    });

    if (!setting) {
      // Remove from cache if it was there
      this.cache.delete(key);
      return null;
    }

    // Decrypt the value
    const crypto = this.cryptoProvider();
    let decrypted: string;

    try {
      decrypted = crypto.decrypt(setting.value);
    } catch (error) {
      // If decryption fails, the value might be corrupted
      console.error(`[Secrets] Failed to decrypt ${key}:`, (error as Error).message);
      return null;
    }

    // Update cache
    this.cache.set(key, {
      value: decrypted,
      expires: Date.now() + this.cacheTTL,
    });

    return decrypted;
  }

  /**
   * Set a secret value.
   * Creates new or updates existing secret.
   */
  async setSecret(key: string, value: string): Promise<void> {
    // Encrypt the value
    const crypto = this.cryptoProvider();
    const encrypted = crypto.encrypt(value);

    // Store in database
    await this.db.setting.upsert({
      where: { key },
      create: { key, value: encrypted },
      update: { value: encrypted },
    });

    // Update cache
    this.cache.set(key, {
      value,
      expires: Date.now() + this.cacheTTL,
    });

    // Emit change event
    this.emit("change", key);
  }

  /**
   * Delete a secret.
   */
  async deleteSecret(key: string): Promise<void> {
    // Remove from database
    try {
      await this.db.setting.delete({
        where: { key },
      });
    } catch (error) {
      // Ignore not found errors
      if ((error as { code?: string }).code !== "P2025") {
        throw error;
      }
    }

    // Remove from cache
    this.cache.delete(key);

    // Emit change event
    this.emit("delete", key);
    this.emit("change", key);
  }

  /**
   * Check if a secret exists.
   */
  async hasSecret(key: string): Promise<boolean> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return true;
    }

    // Check database
    const count = await this.db.setting.count({
      where: { key },
    });

    return count > 0;
  }

  /**
   * List all secret keys.
   * Optionally filter by prefix.
   */
  async listSecretKeys(prefix?: string): Promise<string[]> {
    const settings = await this.db.setting.findMany({
      select: { key: true },
      where: prefix
        ? {
            key: {
              startsWith: prefix,
            },
          }
        : undefined,
    });

    return settings.map((s) => s.key);
  }

  /**
   * Get multiple secrets at once.
   */
  async getSecrets(keys: string[]): Promise<Record<string, string | null>> {
    const results: Record<string, string | null> = {};

    await Promise.all(
      keys.map(async (key) => {
        results[key] = await this.getSecret(key);
      })
    );

    return results;
  }

  /**
   * Set multiple secrets at once.
   */
  async setSecrets(secrets: Record<string, string>): Promise<void> {
    await Promise.all(
      Object.entries(secrets).map(([key, value]) => this.setSecret(key, value))
    );
  }

  /**
   * Clear the in-memory cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Invalidate a specific cache entry.
   */
  invalidateCache(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Get the raw encrypted value (for debugging/testing).
   */
  async getRawValue(key: string): Promise<string | null> {
    const setting = await this.db.setting.findUnique({
      where: { key },
    });
    return setting?.value ?? null;
  }
}

// Singleton instance
let secretsInstance: SecretsService | null = null;

/**
 * Get the singleton SecretsService instance.
 */
export function getSecretsService(): SecretsService {
  if (!secretsInstance) {
    secretsInstance = new SecretsService();
  }
  return secretsInstance;
}

/**
 * Reset the singleton instance (for testing only).
 */
export function resetSecretsService(): void {
  if (secretsInstance) {
    secretsInstance.removeAllListeners();
    secretsInstance.clearCache();
    secretsInstance = null;
  }
}

/**
 * Environment variable to secret key mapping
 */
const ENV_TO_SECRET_MAP: Record<string, string> = {
  TMDB_API_KEY: "tmdb.apiKey",
  ANNEX_TMDB_API_KEY: "tmdb.apiKey",
  MDBLIST_API_KEY: "mdblist.apiKey",
  ANNEX_MDBLIST_API_KEY: "mdblist.apiKey",
  TRAKT_CLIENT_ID: "trakt.clientId",
  ANNEX_TRAKT_CLIENT_ID: "trakt.clientId",
  TRAKT_CLIENT_SECRET: "trakt.clientSecret",
  ANNEX_TRAKT_CLIENT_SECRET: "trakt.clientSecret",
  QBITTORRENT_URL: "qbittorrent.url",
  ANNEX_QBITTORRENT_URL: "qbittorrent.url",
  QBITTORRENT_USERNAME: "qbittorrent.username",
  ANNEX_QBITTORRENT_USERNAME: "qbittorrent.username",
  QBITTORRENT_PASSWORD: "qbittorrent.password",
  ANNEX_QBITTORRENT_PASSWORD: "qbittorrent.password",
  PLEX_SERVER_URL: "plex.serverUrl",
  ANNEX_PLEX_SERVER_URL: "plex.serverUrl",
  PLEX_SERVER_TOKEN: "plex.serverToken",
  ANNEX_PLEX_SERVER_TOKEN: "plex.serverToken",
  EMBY_SERVER_URL: "emby.serverUrl",
  ANNEX_EMBY_SERVER_URL: "emby.serverUrl",
  EMBY_API_KEY: "emby.apiKey",
  ANNEX_EMBY_API_KEY: "emby.apiKey",
  SESSION_SECRET: "auth.sessionSecret",
  ANNEX_SESSION_SECRET: "auth.sessionSecret",
};

/**
 * Migrate secrets from environment variables to encrypted storage.
 * Only migrates if the secret doesn't already exist in the database.
 */
export async function migrateEnvSecretsIfNeeded(): Promise<{
  migrated: string[];
  skipped: string[];
}> {
  const secrets = getSecretsService();
  const migrated: string[] = [];
  const skipped: string[] = [];

  // Also check config values
  const config = getConfig();

  // Build a map of secret key -> value from env/config
  const envValues: Record<string, string> = {};

  // First, get from env vars
  for (const [envKey, secretKey] of Object.entries(ENV_TO_SECRET_MAP)) {
    if (process.env[envKey]) {
      envValues[secretKey] = process.env[envKey]!;
    }
  }

  // Then, get from config (lower priority than env)
  // Note: only include properties that exist in the config schema
  const configMappings: Record<string, string | undefined> = {
    "tmdb.apiKey": config.tmdb?.apiKey,
    "mdblist.apiKey": config.mdblist?.apiKey,
    "trakt.clientId": config.trakt?.clientId,
    // trakt.clientSecret is only in env vars, not in config schema
    "qbittorrent.url": config.qbittorrent?.url,
    "qbittorrent.username": config.qbittorrent?.username,
    "qbittorrent.password": config.qbittorrent?.password,
    "plex.serverUrl": config.plex?.serverUrl,
    "plex.serverToken": config.plex?.serverToken,
    "emby.serverUrl": config.emby?.serverUrl,
    "emby.apiKey": config.emby?.apiKey,
    "auth.sessionSecret": config.auth?.sessionSecret,
  };

  for (const [secretKey, value] of Object.entries(configMappings)) {
    if (value && !envValues[secretKey]) {
      envValues[secretKey] = value;
    }
  }

  // Migrate each secret
  for (const [secretKey, value] of Object.entries(envValues)) {
    const exists = await secrets.hasSecret(secretKey);

    if (exists) {
      skipped.push(secretKey);
    } else {
      await secrets.setSecret(secretKey, value);
      migrated.push(secretKey);
    }
  }

  if (migrated.length > 0) {
    console.log(`[Secrets] Migrated ${migrated.length} secrets from env/config:`, migrated);
  }
  if (skipped.length > 0) {
    console.log(`[Secrets] Skipped ${skipped.length} secrets (already exist):`, skipped);
  }

  return { migrated, skipped };
}
