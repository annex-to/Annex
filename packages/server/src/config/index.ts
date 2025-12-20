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

export { loadConfig, validateConfig } from "./loader.js";
export type {
  Config,
  DatabaseConfig,
  DownloadsConfig,
  EncodingConfig,
  IrcConfig,
  JobsConfig,
  LoggingConfig,
  OmdbConfig,
  QBittorrentConfig,
  SchedulerConfig,
  ServerConfig,
  TraktConfig,
} from "./schema.js";
// Re-export types and schema
export { configSchema } from "./schema.js";
