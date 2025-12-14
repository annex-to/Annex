import { loadConfig } from "./loader.js";
import type { Config } from "./schema.js";

// Singleton config instance - loaded once at startup
let _config: Config | null = null;

/**
 * Get the application configuration
 * Configuration is loaded and validated on first access
 */
export function getConfig(): Config {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Initialize configuration explicitly
 * Call this early in the application startup to catch config errors early
 */
export function initConfig(): Config {
  _config = loadConfig();
  return _config;
}

/**
 * Reset config (useful for testing)
 */
export function resetConfig(): void {
  _config = null;
}

// Re-export types and schema
export { configSchema } from "./schema.js";
export type {
  Config,
  ServerConfig,
  DatabaseConfig,
  JobsConfig,
  TmdbConfig,
  OmdbConfig,
  TraktConfig,
  QBittorrentConfig,
  EncodingConfig,
  DownloadsConfig,
  LoggingConfig,
  IrcConfig,
} from "./schema.js";
export { loadConfig, validateConfig } from "./loader.js";
