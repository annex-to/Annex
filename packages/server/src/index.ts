import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { Server, ServerWebSocket } from "bun";
import { initConfig } from "./config/index.js";
import { appRouter } from "./routers/index.js";
import { registerAuthTasks, verifySession } from "./services/auth.js";
import { getCryptoService } from "./services/crypto.js";
import {
  type EncoderWebSocketData,
  getEncoderDispatchService,
} from "./services/encoderDispatch.js";
import { getIrcAnnounceMonitor } from "./services/ircAnnounce.js";
import { getJobQueueService } from "./services/jobQueue.js";
import { registerPipelineSteps } from "./services/pipeline/registerSteps.js";
import { getRssAnnounceMonitor } from "./services/rssAnnounce.js";
import { getSchedulerService } from "./services/scheduler.js";
import { migrateEnvSecretsIfNeeded } from "./services/secrets.js";
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

function handleEncoderPackage(req: Request, url: URL): Response {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const clientIp = req.headers.get("x-forwarded-for") || "unknown";
  const pathname = url.pathname;

  // Route: /api/encoder/package/info - return package version info
  if (pathname === "/api/encoder/package/info") {
    const manifestPath = findFile("packages/encoder/dist-binaries/manifest.json");

    if (!manifestPath || !fs.existsSync(manifestPath)) {
      return new Response(
        JSON.stringify({
          error: "Encoder binaries not built. Run: bun run --filter @annex/encoder build",
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      console.log(`[Encoder] Serving manifest info to ${clientIp}`);
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("[Encoder] Failed to read manifest:", error);
      return new Response(JSON.stringify({ error: "Failed to read manifest" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Route: /api/encoder/binary/:platform - serve platform-specific binary
  const binaryMatch = pathname.match(/^\/api\/encoder\/binary\/([a-z0-9-]+)$/);
  if (binaryMatch) {
    const platform = binaryMatch[1];
    const validPlatforms = [
      "linux-x64",
      "linux-arm64",
      "windows-x64",
      "darwin-x64",
      "darwin-arm64",
    ];

    if (!validPlatforms.includes(platform)) {
      return new Response(
        JSON.stringify({
          error: `Invalid platform: ${platform}. Valid platforms: ${validPlatforms.join(", ")}`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const ext = platform.startsWith("windows") ? ".exe" : "";
    const binaryFilename = `annex-encoder-${platform}${ext}`;
    const binaryPath = findFile(`packages/encoder/dist-binaries/${binaryFilename}`);

    if (!binaryPath) {
      return new Response(
        JSON.stringify({
          error: `Binary not found for platform: ${platform}. Run: bun run --filter @annex/encoder build`,
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    try {
      const file = Bun.file(binaryPath);
      console.log(
        `[Encoder] Serving ${platform} binary to ${clientIp} (${(file.size / 1024 / 1024).toFixed(1)} MB)`
      );

      return new Response(file, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": file.size.toString(),
          "Content-Disposition": `attachment; filename="${binaryFilename}"`,
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      console.error(`[Encoder] Failed to serve ${platform} binary:`, error);
      return new Response(JSON.stringify({ error: "Failed to serve binary" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Unknown sub-route
  return new Response("Not found", { status: 404 });
}

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

    // Custom routes
    if (url.pathname.startsWith("/api/encoder/package")) {
      const response = handleEncoderPackage(req, url);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        response.headers.set(key, value);
      });
      return response;
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

Encoder Binaries:
  Package info: http://${host}:${port}/api/encoder/package/info
  Binary download: http://${host}:${port}/api/encoder/binary/{platform}
  Platforms: linux-x64, linux-arm64, windows-x64, darwin-x64, darwin-arm64

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

// Start the job queue worker (recovers any stuck jobs from previous run)
jobQueue.start().catch((error) => {
  console.error("[JobQueue] Failed to start:", error);
});

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
