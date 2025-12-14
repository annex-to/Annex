/**
 * Encoder Configuration
 *
 * Loads configuration from environment variables.
 */

import { z } from "zod";

const configSchema = z.object({
  // Server connection
  serverUrl: z.string().url().default("ws://localhost:3000/encoder"),

  // Encoder identity
  encoderId: z.string().min(1),
  encoderName: z.string().optional(),

  // GPU configuration
  gpuDevice: z.string().default("/dev/dri/renderD128"),
  maxConcurrent: z.number().int().min(1).max(8).default(1),

  // NFS base path (where files are accessible)
  nfsBasePath: z.string().default("/mnt/downloads"),

  // Reconnection settings
  reconnectInterval: z.number().int().min(1000).default(5000),
  maxReconnectInterval: z.number().int().min(5000).default(60000),

  // Heartbeat interval
  heartbeatInterval: z.number().int().min(5000).default(30000),

  // Logging
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type EncoderConfig = z.infer<typeof configSchema>;

function loadConfig(): EncoderConfig {
  const rawConfig = {
    serverUrl: process.env.ANNEX_SERVER_URL,
    encoderId: process.env.ANNEX_ENCODER_ID || process.env.HOSTNAME || `encoder-${Date.now()}`,
    encoderName: process.env.ANNEX_ENCODER_NAME,
    gpuDevice: process.env.ANNEX_GPU_DEVICE,
    maxConcurrent: process.env.ANNEX_MAX_CONCURRENT
      ? parseInt(process.env.ANNEX_MAX_CONCURRENT, 10)
      : undefined,
    nfsBasePath: process.env.ANNEX_NFS_BASE_PATH,
    reconnectInterval: process.env.ANNEX_RECONNECT_INTERVAL
      ? parseInt(process.env.ANNEX_RECONNECT_INTERVAL, 10)
      : undefined,
    maxReconnectInterval: process.env.ANNEX_MAX_RECONNECT_INTERVAL
      ? parseInt(process.env.ANNEX_MAX_RECONNECT_INTERVAL, 10)
      : undefined,
    heartbeatInterval: process.env.ANNEX_HEARTBEAT_INTERVAL
      ? parseInt(process.env.ANNEX_HEARTBEAT_INTERVAL, 10)
      : undefined,
    logLevel: process.env.ANNEX_LOG_LEVEL,
  };

  // Remove undefined values to let defaults apply
  const cleanConfig = Object.fromEntries(
    Object.entries(rawConfig).filter(([, v]) => v !== undefined)
  );

  const result = configSchema.safeParse(cleanConfig);
  if (!result.success) {
    console.error("Invalid configuration:");
    for (const error of result.error.errors) {
      console.error(`  ${error.path.join(".")}: ${error.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

let config: EncoderConfig | null = null;

export function getConfig(): EncoderConfig {
  if (!config) {
    config = loadConfig();
  }
  return config;
}

export function initConfig(): EncoderConfig {
  config = loadConfig();
  return config;
}
