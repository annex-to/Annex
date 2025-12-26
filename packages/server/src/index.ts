import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { Server, ServerWebSocket } from "bun";
import { initConfig } from "./config/index.js";
import { appRouter } from "./routers/index.js";
import { registerAuthTasks, verifySession } from "./services/auth.js";
import { getCryptoService } from "./services/crypto.js";
import { recoverStuckDeliveries } from "./services/deliveryRecovery.js";
import {
  type EncoderWebSocketData,
  getEncoderDispatchService,
} from "./services/encoderDispatch.js";
import { recoverStuckEncodings } from "./services/encodingRecovery.js";
import { recoverFailedJobs } from "./services/failedJobRecovery.js";
import { getIrcAnnounceMonitor } from "./services/ircAnnounce.js";
import { getJobQueueService } from "./services/jobQueue.js";
import { registerPipelineSteps } from "./services/pipeline/registerSteps.js";
import { getRssAnnounceMonitor } from "./services/rssAnnounce.js";
import { getSchedulerService } from "./services/scheduler.js";
import { migrateEnvSecretsIfNeeded } from "./services/secrets.js";
import { getSshKeyService } from "./services/ssh.js";
import type { Context } from "./trpc.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize configuration early to catch errors
const config = initConfig();

// Initialize crypto service and migrate env secrets to encrypted storage
// This must happen before any service that might use secrets
const secretsInitPromise = (async () => {
  try {
    const crypto = getCryptoService();
    await crypto.initialize();
    console.log("[Startup] Crypto service initialized");

    // Migrate any secrets from env/config to encrypted storage
    const { migrated, skipped } = await migrateEnvSecretsIfNeeded();
    if (migrated.length > 0 || skipped.length > 0) {
      console.log(
        `[Startup] Secrets migration complete: ${migrated.length} migrated, ${skipped.length} skipped`
      );
    }

    // Initialize SSH keys for server connections
    const sshKeys = getSshKeyService();
    await sshKeys.initialize();
    const keyInfo = sshKeys.getKeyInfo();
    console.log(`[Startup] SSH key initialized: ${keyInfo.fingerprint}`);
  } catch (error) {
    console.error("[Startup] Failed to initialize crypto/secrets:", error);
    // Don't exit - the app can still work with env vars
  }
})();

// Initialize job queue (will be started after server is ready)
const jobQueue = getJobQueueService();

// Initialize scheduler (will be started after server is ready)
const scheduler = getSchedulerService();

// Register pipeline steps
registerPipelineSteps();

// Cookie name for auth token
const AUTH_COOKIE_NAME = "annex_session";

// =============================================================================
// WebSocket Data Types
// =============================================================================

type WebSocketData = EncoderWebSocketData;

// =============================================================================
// Helper Functions
// =============================================================================

function parseCookies(cookieHeader: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(";").forEach((cookie) => {
    const [name, ...rest] = cookie.split("=");
    if (name && rest.length > 0) {
      cookies[name.trim()] = rest.join("=").trim();
    }
  });

  return cookies;
}

function getSessionTokenFromRequest(req: Request): string | null {
  // First, check Authorization header (Bearer token)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  // Then check cookies
  const cookies = parseCookies(req.headers.get("cookie"));
  return cookies[AUTH_COOKIE_NAME] || null;
}

async function createContext(req: Request): Promise<Context> {
  const sessionToken = getSessionTokenFromRequest(req);

  // Try to verify the session and get user
  let user = null;
  if (sessionToken) {
    try {
      user = await verifySession(sessionToken);
    } catch {
      // Invalid session, continue without user
    }
  }

  return {
    config,
    sessionToken,
    user,
  };
}

function findFile(filename: string): string | null {
  const possiblePaths = [
    path.resolve(__dirname, `../../../${filename}`),
    path.resolve(__dirname, `../../../../${filename}`),
    path.resolve(process.cwd(), filename),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

// =============================================================================
// HTTP Route Handlers
// =============================================================================

// CORS headers for responses
const corsHeaders = {
  "Access-Control-Allow-Origin": "http://localhost:5173",
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// =============================================================================
// Encoder Dispatch Integration
// =============================================================================

const encoderDispatch = getEncoderDispatchService();

// =============================================================================
// Bun Server
// =============================================================================

// Wait for secrets migration before starting server
await secretsInitPromise;

const { port, host } = config.server;

const server = Bun.serve<WebSocketData>({
  port,
  hostname: host,

  async fetch(req: Request, server: Server<WebSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // WebSocket upgrade handling (only for encoder connections)
    if (req.headers.get("upgrade") === "websocket") {
      if (url.pathname === "/encoder") {
        const success = server.upgrade(req, {
          data: {
            type: "encoder",
            encoderId: null,
          } as EncoderWebSocketData,
        });
        return success ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
      }
      // Reject other WebSocket connections
      return new Response("WebSocket only available at /encoder", { status: 404 });
    }

    // SSH public key download endpoint
    if (url.pathname === "/ssh-public-key" || url.pathname === "/ssh-public-key.pub") {
      try {
        const sshKeys = getSshKeyService();
        const publicKey = sshKeys.getPublicKey();
        return new Response(publicKey, {
          headers: {
            "Content-Type": "text/plain",
            "Content-Disposition": 'inline; filename="annex_id_ed25519.pub"',
            ...corsHeaders,
          },
        });
      } catch (error) {
        return new Response(
          `Error retrieving SSH public key: ${error instanceof Error ? error.message : "Unknown error"}`,
          { status: 500 }
        );
      }
    }

    // tRPC HTTP handler
    if (url.pathname.startsWith("/trpc")) {
      const response = await fetchRequestHandler({
        endpoint: "/trpc",
        req,
        router: appRouter,
        createContext: () => createContext(req),
        responseMeta() {
          return { headers: corsHeaders };
        },
      });
      return response;
    }

    // Static file serving for client
    const clientDistPath = findFile("packages/client/dist");
    if (clientDistPath) {
      let filePath = url.pathname;

      // Default to index.html for root and directories
      if (filePath === "/" || filePath === "") {
        filePath = "/index.html";
      }

      const fullPath = path.join(clientDistPath, filePath);

      // Security: ensure the path is within client dist directory
      if (fullPath.startsWith(clientDistPath)) {
        try {
          const file = Bun.file(fullPath);
          if (await file.exists()) {
            return new Response(file);
          }
        } catch {
          // File doesn't exist, fall through to SPA fallback
        }
      }

      // SPA fallback - serve index.html for non-API routes
      if (!url.pathname.startsWith("/api")) {
        const indexFile = Bun.file(path.join(clientDistPath, "index.html"));
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { "Content-Type": "text/html" },
          });
        }
      }
    }

    // Not found
    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(_ws: ServerWebSocket<WebSocketData>) {
      encoderDispatch.handleConnection();
    },

    message(ws: ServerWebSocket<WebSocketData>, message: string | Buffer) {
      encoderDispatch.handleMessage(ws as ServerWebSocket<EncoderWebSocketData>, message);
    },

    close(ws: ServerWebSocket<WebSocketData>) {
      encoderDispatch.handleClose(ws as ServerWebSocket<EncoderWebSocketData>);
    },
  },
});

// Initialize encoder dispatch
encoderDispatch.initialize();

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     █████╗ ███╗   ██╗███╗   ██╗███████╗██╗  ██╗               ║
║    ██╔══██╗████╗  ██║████╗  ██║██╔════╝╚██╗██╔╝               ║
║    ███████║██╔██╗ ██║██╔██╗ ██║█████╗   ╚███╔╝                ║
║    ██╔══██║██║╚██╗██║██║╚██╗██║██╔══╝   ██╔██╗                ║
║    ██║  ██║██║ ╚████║██║ ╚████║███████╗██╔╝ ██╗               ║
║    ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝               ║
║                                                               ║
║    Media Acquisition & Delivery Platform                      ║
║    Powered by Bun                                             ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Server running at http://${host}:${port}
Remote encoder WebSocket at ws://${host}:${port}/encoder

Log level: ${config.logging.level}
`);

// Start the scheduler (main process loop)
scheduler.start();

// Register misc cleanup tasks with scheduler
registerAuthTasks();

// Register rate limit cleanup task (runs hourly)
scheduler.register(
  "ratelimit-cleanup",
  "Rate Limit Cleanup",
  60 * 60 * 1000, // 1 hour
  async () => {
    const { getRateLimiter } = await import("./services/rateLimiter.js");
    const rateLimiter = getRateLimiter();
    await rateLimiter.cleanupOldRecords();
  }
);

// Register download progress sync task (runs every 500ms)
scheduler.register(
  "download-progress-sync",
  "Download Progress Sync",
  500, // 500ms
  async () => {
    const { prisma } = await import("./db/client.js");
    const { getDownloadService } = await import("./services/download.js");
    const { DownloadStatus } = await import("@prisma/client");

    // Get all downloads that are actively downloading
    const activeDownloads = await prisma.download.findMany({
      where: { status: DownloadStatus.DOWNLOADING },
    });

    // Skip if no active downloads
    if (activeDownloads.length === 0) return;

    const qb = getDownloadService();

    // Update progress for each active download
    for (const download of activeDownloads) {
      try {
        const progress = await qb.getProgress(download.torrentHash);
        if (!progress) continue;

        // Update database with current progress
        await prisma.download.update({
          where: { id: download.id },
          data: {
            progress: progress.progress,
            lastProgressAt: new Date(),
            seedCount: progress.seeds,
            peerCount: progress.peers,
            savePath: progress.savePath || null,
            contentPath: progress.contentPath || null,
            ...(progress.isComplete && {
              status: DownloadStatus.COMPLETED,
              progress: 100,
              completedAt: new Date(),
            }),
          },
        });

        // Update the associated request's progress
        if (download.requestId) {
          const speed =
            progress.downloadSpeed > 0
              ? `${(progress.downloadSpeed / (1024 * 1024)).toFixed(1)} MB/s`
              : "";
          const eta =
            progress.eta > 0 ? `ETA: ${Math.floor(progress.eta / 60)}m ${progress.eta % 60}s` : "";

          if (progress.isComplete) {
            // Download completed - process and continue pipeline
            const request = await prisma.mediaRequest.findUnique({
              where: { id: download.requestId },
              select: { type: true },
            });

            if (request?.type === "TV") {
              // TV show - extract episode files and continue to encoding
              console.log(
                `[DownloadSync] TV download completed for ${download.requestId}, extracting episodes`
              );

              // Extract episode files from the completed download
              // This updates episode statuses to DOWNLOADED
              const { extractEpisodeFilesFromDownload } = await import(
                "./services/pipeline/downloadHelper.js"
              );
              const episodeFiles = await extractEpisodeFilesFromDownload(
                download.torrentHash,
                download.requestId
              );

              console.log(
                `[DownloadSync] Extracted ${episodeFiles.length} episodes, continuing pipeline`
              );

              await prisma.mediaRequest.update({
                where: { id: download.requestId },
                data: {
                  progress: 50,
                  currentStep: `Download complete (${episodeFiles.length} episodes)`,
                },
              });

              // Continue pipeline to encoding
              const execution = await prisma.pipelineExecution.findFirst({
                where: { requestId: download.requestId },
                orderBy: { startedAt: "desc" },
                select: { id: true, templateId: true },
              });

              if (execution) {
                // Restart pipeline to continue to encoding
                const { getPipelineExecutor } = await import(
                  "./services/pipeline/PipelineExecutor.js"
                );
                const executor = getPipelineExecutor();

                // Use setTimeout to avoid blocking the sync loop
                setTimeout(() => {
                  executor
                    .startExecution(download.requestId, execution.templateId)
                    .catch((error) => {
                      console.error(
                        `[DownloadSync] Failed to continue pipeline for ${download.requestId}:`,
                        error
                      );
                    });
                }, 1000);
              }
            } else {
              // Movie - simple path update
              const videoFile = await qb.getMainVideoFile(download.torrentHash);
              await prisma.mediaRequest.update({
                where: { id: download.requestId },
                data: {
                  sourceFilePath: videoFile?.path,
                  progress: 50,
                  currentStep: "Download complete",
                },
              });
            }
          } else {
            // Download in progress
            const overallProgress = 20 + progress.progress * 0.3; // 20-50%
            await prisma.mediaRequest.update({
              where: { id: download.requestId },
              data: {
                progress: overallProgress,
                currentStep: `Downloading: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`,
              },
            });
          }
        }
      } catch (_error) {
        // Ignore errors for individual downloads, continue syncing others
      }
    }
  }
);

// Start the job queue worker (recovers any stuck jobs from previous run)
jobQueue.start().catch((error) => {
  console.error("[JobQueue] Failed to start:", error);
});

// Recover stuck and failed requests from server restarts
Promise.all([
  recoverFailedJobs().catch((error) => {
    console.error("[FailedJobRecovery] Failed to recover failed jobs:", error);
  }),
  recoverStuckEncodings().catch((error) => {
    console.error("[EncodingRecovery] Failed to recover stuck encodings:", error);
  }),
  recoverStuckDeliveries().catch((error) => {
    console.error("[DeliveryRecovery] Failed to recover stuck deliveries:", error);
  }),
]);

// Start the IRC announce monitor (if enabled)
const ircMonitor = getIrcAnnounceMonitor();
ircMonitor.start().catch((error) => {
  console.error("[IRC] Failed to start:", error);
});

// Start the RSS announce monitor (if enabled)
const rssMonitor = getRssAnnounceMonitor();
rssMonitor.start().catch((error) => {
  console.error("[RSS] Failed to start:", error);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  encoderDispatch.shutdown();
  await scheduler.stop();
  await jobQueue.stop();
  ircMonitor.stop();
  rssMonitor.stop();
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down...");
  encoderDispatch.shutdown();
  await scheduler.stop();
  await jobQueue.stop();
  ircMonitor.stop();
  rssMonitor.stop();
  server.stop();
  process.exit(0);
});
