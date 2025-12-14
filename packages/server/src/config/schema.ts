import { z } from "zod";

/**
 * Configuration schema for Annex server
 * All configuration values are validated at startup
 */

/**
 * Custom boolean schema that properly handles string "false"/"true" from env vars
 * z.coerce.boolean() uses Boolean() which treats any non-empty string as true
 */
const booleanFromEnv = z.preprocess((val) => {
  if (typeof val === "string") {
    const lower = val.toLowerCase().trim();
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return false;
    }
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return true;
    }
  }
  return val;
}, z.coerce.boolean());

// Server configuration
const serverSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default("0.0.0.0"),
});

// Database configuration (PostgreSQL)
const databaseSchema = z.object({
  url: z.string().url().describe("PostgreSQL connection string"),
});

// Job queue configuration
const jobsSchema = z.object({
  concurrency: z.coerce.number().int().min(1).max(32).default(2),
  pollInterval: z.coerce.number().int().min(1000).max(60000).default(5000),
});

// TMDB API configuration
const tmdbSchema = z
  .object({
    apiKey: z.string().min(1).optional().describe("TMDB API key"),
    rateLimit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .default({});

// OMDB API configuration (for IMDB/RT/Metacritic ratings)
const omdbSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
  })
  .default({});

// MDBList API configuration (aggregated ratings from multiple sources)
const mdblistSchema = z
  .object({
    apiKey: z.string().min(1).optional().describe("MDBList API key"),
    // Cloudflare rate limits MDBList API to ~10 req/sec regardless of API quota
    // The 250k/day quota is daily, but Cloudflare enforces a per-second limit
    rateLimit: z.coerce.number().int().min(1).max(20).default(10), // requests per second (Cloudflare limited)
    batchSize: z.coerce.number().int().min(1).max(200).default(200), // items per batch request
    // Number of parallel batch requests - keep low to avoid Cloudflare 429s
    // Each batch = 200 items, so 2 parallel = 400 items per "round"
    parallelBatches: z.coerce.number().int().min(1).max(5).default(2),
  })
  .default({});

// Trakt API configuration
const traktSchema = z
  .object({
    clientId: z.string().min(1).optional(),
  })
  .default({});

// qBittorrent configuration
const qbittorrentSchema = z.object({
  url: z.string().url().default("http://localhost:8080"),
  username: z.string().optional(),
  password: z.string().optional(),
  // Base directory where qBittorrent downloads files (for path mapping)
  // If set, this path prefix will be used instead of qBittorrent's reported content_path
  baseDir: z.string().optional(),
});

// Encoding configuration
const encodingSchema = z.object({
  ffmpegPath: z.string().default("ffmpeg"),
  ffprobePath: z.string().default("ffprobe"),
  tempDir: z.string().default("/tmp/annex"),
  maxConcurrent: z.coerce.number().int().min(1).max(8).default(1),
});

// Download configuration
const downloadsSchema = z.object({
  directory: z.string().default("./downloads"),
  seedRatioLimit: z.coerce.number().min(0).default(1.0),
  seedTimeLimit: z.coerce.number().int().min(0).default(86400), // 24 hours in seconds
});

// Logging configuration
const loggingSchema = z.object({
  level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  pretty: booleanFromEnv.default(process.env.NODE_ENV !== "production"),
});

// Authentication configuration
const authSchema = z.object({
  // Session settings
  sessionSecret: z
    .string()
    .min(32)
    .default("change-me-in-production-32-char-min"), // Used for signing session tokens
  sessionMaxAge: z.coerce
    .number()
    .int()
    .min(3600)
    .default(30 * 24 * 60 * 60), // 30 days in seconds

  // Plex OAuth settings
  plexClientId: z.string().optional(), // Will be auto-generated if not provided
  plexProduct: z.string().default("Annex"),
  plexDevice: z.string().default("Web Browser"),
});

// Plex API configuration (for server integration, separate from auth)
const plexSchema = z
  .object({
    // For admin-level Plex server integration (library sync, etc.)
    serverUrl: z.string().url().optional(),
    serverToken: z.string().optional(),
  })
  .default({});

// Emby API configuration (for server integration, separate from auth)
const embySchema = z
  .object({
    // For admin-level Emby server integration (library sync, etc.)
    serverUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
  })
  .default({});

// IRC announce monitor configuration (currently disabled, use RSS instead)
const ircSchema = z
  .object({
    enabled: booleanFromEnv.default(false),
    server: z.string().default("irc.torrentleech.org"),
    port: z.coerce.number().int().min(1).max(65535).default(7011),
    ssl: booleanFromEnv.default(true),
    nickname: z.string().optional(),
    channels: z.array(z.string()).default(["#tlannounces"]),
    // Reconnect settings
    reconnect: booleanFromEnv.default(true),
    reconnectDelay: z.coerce.number().int().min(1000).default(5000), // ms
    reconnectMaxRetries: z.coerce.number().int().min(0).default(10), // 0 = infinite
  })
  .default({});

// RSS announce monitor configuration
const rssSchema = z
  .object({
    enabled: booleanFromEnv.default(true),
    pollInterval: z.coerce.number().int().min(10000).default(600000), // 10 minutes default
  })
  .default({});

// Scheduler configuration
const schedulerSchema = z
  .object({
    intervalMs: z.coerce.number().int().min(100).max(10000).default(1000), // Main loop interval
  })
  .default({});

// Full configuration schema
export const configSchema = z.object({
  server: serverSchema.default({}),
  database: databaseSchema,
  jobs: jobsSchema.default({}),
  tmdb: tmdbSchema.default({}),
  omdb: omdbSchema,
  mdblist: mdblistSchema,
  trakt: traktSchema,
  qbittorrent: qbittorrentSchema.default({}),
  encoding: encodingSchema.default({}),
  downloads: downloadsSchema.default({}),
  logging: loggingSchema.default({}),
  auth: authSchema.default({}),
  plex: plexSchema,
  emby: embySchema,
  irc: ircSchema,
  rss: rssSchema,
  scheduler: schedulerSchema,
});

// Export the inferred type
export type Config = z.infer<typeof configSchema>;

// Export individual section types for convenience
export type ServerConfig = z.infer<typeof serverSchema>;
export type DatabaseConfig = z.infer<typeof databaseSchema>;
export type JobsConfig = z.infer<typeof jobsSchema>;
export type TmdbConfig = z.infer<typeof tmdbSchema>;
export type OmdbConfig = z.infer<typeof omdbSchema>;
export type MdblistConfig = z.infer<typeof mdblistSchema>;
export type TraktConfig = z.infer<typeof traktSchema>;
export type QBittorrentConfig = z.infer<typeof qbittorrentSchema>;
export type EncodingConfig = z.infer<typeof encodingSchema>;
export type DownloadsConfig = z.infer<typeof downloadsSchema>;
export type LoggingConfig = z.infer<typeof loggingSchema>;
export type AuthConfig = z.infer<typeof authSchema>;
export type PlexConfig = z.infer<typeof plexSchema>;
export type EmbyConfig = z.infer<typeof embySchema>;
export type IrcConfig = z.infer<typeof ircSchema>;
export type RssConfig = z.infer<typeof rssSchema>;
export type SchedulerConfig = z.infer<typeof schedulerSchema>;
