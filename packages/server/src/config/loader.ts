import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ZodError } from "zod";
import { type Config, configSchema } from "./schema.js";

/**
 * Environment variable to config path mapping
 * Format: ENV_VAR -> config.path
 * Supports both ANNEX_ prefixed and non-prefixed versions
 */
const ENV_MAPPING: Record<string, string> = {
  // Server
  PORT: "server.port",
  ANNEX_PORT: "server.port",
  HOST: "server.host",
  ANNEX_HOST: "server.host",

  // Database
  DATABASE_URL: "database.url",

  // Jobs
  JOB_CONCURRENCY: "jobs.concurrency",
  ANNEX_JOB_CONCURRENCY: "jobs.concurrency",
  JOB_POLL_INTERVAL: "jobs.pollInterval",
  ANNEX_JOB_POLL_INTERVAL: "jobs.pollInterval",

  // OMDB
  OMDB_API_KEY: "omdb.apiKey",
  ANNEX_OMDB_API_KEY: "omdb.apiKey",

  // MDBList
  MDBLIST_API_KEY: "mdblist.apiKey",
  ANNEX_MDBLIST_API_KEY: "mdblist.apiKey",
  MDBLIST_RATE_LIMIT: "mdblist.rateLimit",
  ANNEX_MDBLIST_RATE_LIMIT: "mdblist.rateLimit",

  // Trakt
  TRAKT_CLIENT_ID: "trakt.clientId",
  ANNEX_TRAKT_CLIENT_ID: "trakt.clientId",

  // Encoding
  FFMPEG_PATH: "encoding.ffmpegPath",
  ANNEX_FFMPEG_PATH: "encoding.ffmpegPath",
  FFPROBE_PATH: "encoding.ffprobePath",
  ANNEX_FFPROBE_PATH: "encoding.ffprobePath",
  ENCODING_TEMP_DIR: "encoding.tempDir",
  ANNEX_ENCODING_TEMP_DIR: "encoding.tempDir",
  ENCODING_MAX_CONCURRENT: "encoding.maxConcurrent",
  ANNEX_ENCODING_MAX_CONCURRENT: "encoding.maxConcurrent",

  // Downloads
  DOWNLOADS_DIR: "downloads.directory",
  ANNEX_DOWNLOADS_DIR: "downloads.directory",
  ANNEX_DOWNLOADS_DIRECTORY: "downloads.directory",
  SEED_RATIO_LIMIT: "downloads.seedRatioLimit",
  ANNEX_SEED_RATIO_LIMIT: "downloads.seedRatioLimit",
  SEED_TIME_LIMIT: "downloads.seedTimeLimit",
  ANNEX_SEED_TIME_LIMIT: "downloads.seedTimeLimit",

  // Logging
  LOG_LEVEL: "logging.level",
  ANNEX_LOG_LEVEL: "logging.level",
  LOG_PRETTY: "logging.pretty",
  ANNEX_LOG_PRETTY: "logging.pretty",

  // Auth
  SESSION_SECRET: "auth.sessionSecret",
  ANNEX_SESSION_SECRET: "auth.sessionSecret",
  SESSION_MAX_AGE: "auth.sessionMaxAge",
  ANNEX_SESSION_MAX_AGE: "auth.sessionMaxAge",
  PLEX_CLIENT_ID: "auth.plexClientId",
  ANNEX_PLEX_CLIENT_ID: "auth.plexClientId",
  PLEX_PRODUCT: "auth.plexProduct",
  ANNEX_PLEX_PRODUCT: "auth.plexProduct",

  // Plex Server Integration
  PLEX_SERVER_URL: "plex.serverUrl",
  ANNEX_PLEX_SERVER_URL: "plex.serverUrl",
  PLEX_SERVER_TOKEN: "plex.serverToken",
  ANNEX_PLEX_SERVER_TOKEN: "plex.serverToken",

  // Emby Server Integration
  EMBY_SERVER_URL: "emby.serverUrl",
  ANNEX_EMBY_SERVER_URL: "emby.serverUrl",
  EMBY_API_KEY: "emby.apiKey",
  ANNEX_EMBY_API_KEY: "emby.apiKey",

  // IRC Announce Monitor
  IRC_ENABLED: "irc.enabled",
  ANNEX_IRC_ENABLED: "irc.enabled",
  IRC_SERVER: "irc.server",
  ANNEX_IRC_SERVER: "irc.server",
  IRC_PORT: "irc.port",
  ANNEX_IRC_PORT: "irc.port",
  IRC_SSL: "irc.ssl",
  ANNEX_IRC_SSL: "irc.ssl",
  IRC_NICKNAME: "irc.nickname",
  ANNEX_IRC_NICKNAME: "irc.nickname",
  IRC_RECONNECT: "irc.reconnect",
  ANNEX_IRC_RECONNECT: "irc.reconnect",
  IRC_RECONNECT_DELAY: "irc.reconnectDelay",
  ANNEX_IRC_RECONNECT_DELAY: "irc.reconnectDelay",

  // RSS Announce Monitor
  RSS_ENABLED: "rss.enabled",
  ANNEX_RSS_ENABLED: "rss.enabled",
  RSS_POLL_INTERVAL: "rss.pollInterval",
  ANNEX_RSS_POLL_INTERVAL: "rss.pollInterval",

  // Scheduler
  SCHEDULER_INTERVAL_MS: "scheduler.intervalMs",
  ANNEX_SCHEDULER_INTERVAL_MS: "scheduler.intervalMs",
};

/**
 * Set a nested value in an object using dot notation path
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
}

/**
 * Load configuration from a JSON or YAML file
 */
function loadConfigFile(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) {
    return {};
  }

  const content = readFileSync(configPath, "utf-8");

  if (configPath.endsWith(".json")) {
    return JSON.parse(content);
  }

  // For YAML support, we'd need to add a yaml parser dependency
  // For now, only JSON is supported
  throw new Error(`Unsupported config file format: ${configPath}. Use .json format.`);
}

/**
 * Load configuration from environment variables
 */
function loadFromEnv(): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (const [envVar, configPath] of Object.entries(ENV_MAPPING)) {
    const value = process.env[envVar];
    if (value !== undefined && value !== "") {
      setNestedValue(config, configPath, value);
    }
  }

  return config;
}

/**
 * Deep merge two objects
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      key in target &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Format Zod validation errors for display
 */
function formatValidationErrors(error: ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `  - ${path}: ${issue.message}`;
  });

  return `Configuration validation failed:\n${issues.join("\n")}`;
}

/**
 * Find the configuration file path
 * Searches in order: ANNEX_CONFIG env var, ./config.json, ./annex.config.json
 */
function findConfigFile(): string | null {
  // Check environment variable first
  if (process.env.ANNEX_CONFIG) {
    const configPath = resolve(process.env.ANNEX_CONFIG);
    if (existsSync(configPath)) {
      return configPath;
    }
    console.warn(`Config file specified in ANNEX_CONFIG not found: ${configPath}`);
  }

  // Check default locations
  const defaultPaths = ["./config.json", "./annex.config.json", "./config/annex.json"];

  for (const path of defaultPaths) {
    const resolved = resolve(path);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  return null;
}

/**
 * Load and validate configuration
 * Priority: Environment variables > Config file > Defaults
 */
export function loadConfig(): Config {
  // Start with empty config
  let config: Record<string, unknown> = {};

  // Load from config file if it exists
  const configFile = findConfigFile();
  if (configFile) {
    console.log(`Loading configuration from: ${configFile}`);
    const fileConfig = loadConfigFile(configFile);
    config = deepMerge(config, fileConfig);
  }

  // Override with environment variables
  const envConfig = loadFromEnv();
  config = deepMerge(config, envConfig);

  // Validate with Zod schema
  const result = configSchema.safeParse(config);

  if (!result.success) {
    console.error(formatValidationErrors(result.error));
    process.exit(1);
  }

  return result.data;
}

/**
 * Validate a partial configuration (useful for testing)
 */
export function validateConfig(config: unknown): Config {
  return configSchema.parse(config);
}
