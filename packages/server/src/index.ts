import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { WebSocketServer } from "ws";
import type { IncomingMessage, ServerResponse } from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { appRouter } from "./routers/index.js";
import type { Context } from "./trpc.js";
import { initConfig } from "./config/index.js";
import { getJobQueueService } from "./services/jobQueue.js";
import { verifySession, registerAuthTasks } from "./services/auth.js";
import { registerPipelineHandlers } from "./services/pipeline.js";
import { registerTvPipelineHandlers } from "./services/tvPipeline.js";
import { getIrcAnnounceMonitor } from "./services/ircAnnounce.js";
import { getRssAnnounceMonitor } from "./services/rssAnnounce.js";
import { getEncoderDispatchService } from "./services/encoderDispatch.js";
import { getSchedulerService } from "./services/scheduler.js";
import { getTasteProfileService } from "./services/tasteProfile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize configuration early to catch errors
const config = initConfig();

// Initialize job queue (will be started after server is ready)
const jobQueue = getJobQueueService();

// Initialize scheduler (will be started after server is ready)
const scheduler = getSchedulerService();

// Register pipeline handlers for request processing
registerPipelineHandlers();
registerTvPipelineHandlers();

// Cookie name for auth token
const AUTH_COOKIE_NAME = "annex_session";

/**
 * Parse cookies from request header
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
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

/**
 * Extract session token from request (cookie or Authorization header)
 */
function getSessionToken(req: IncomingMessage): string | null {
  // First, check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  // Then check cookies
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE_NAME] || null;
}

async function createContext({ req }: { req: IncomingMessage }): Promise<Context> {
  const sessionToken = getSessionToken(req);

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

/**
 * Find a file in possible locations
 */
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

/**
 * Handle /deploy-encoder route - serves the encoder setup script
 */
function handleDeployEncoder(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "", `http://${config.server.host}:${config.server.port}`);

  if (url.pathname !== "/deploy-encoder") {
    return false; // Not our route, let tRPC handle it
  }

  // Only allow GET requests
  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return true;
  }

  const scriptPath = findFile("scripts/setup-remote-encoder.sh");

  if (!scriptPath) {
    console.error("[Deploy] Setup script not found");
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Encoder setup script not found");
    return true;
  }

  try {
    const script = fs.readFileSync(scriptPath, "utf-8");

    // Log the deployment request
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    console.log(`[Deploy] Serving encoder setup script to ${clientIp}`);

    res.writeHead(200, {
      "Content-Type": "text/x-shellscript",
      "Content-Disposition": "inline; filename=\"setup-remote-encoder.sh\"",
      "Cache-Control": "no-cache",
    });
    res.end(script);
    return true;
  } catch (error) {
    console.error("[Deploy] Failed to read setup script:", error);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to read setup script");
    return true;
  }
}

/**
 * Handle /api/encoder/package/* routes - serves encoder package for updates
 */
function handleEncoderPackage(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || "", `http://${config.server.host}:${config.server.port}`);

  if (!url.pathname.startsWith("/api/encoder/package")) {
    return false;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method not allowed");
    return true;
  }

  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // Route: /api/encoder/package/info - return package version info
  if (url.pathname === "/api/encoder/package/info") {
    const tarballPath = findFile("packages/encoder/annex-encoder-latest.tar.gz");
    const packagePath = findFile("packages/encoder/package.json");

    if (!tarballPath || !packagePath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Encoder package not built. Run: pnpm --filter @annex/encoder build:dist" }));
      return true;
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      const stats = fs.statSync(tarballPath);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        version: pkg.version,
        size: stats.size,
        buildTime: stats.mtime.toISOString(),
      }));
      return true;
    } catch (error) {
      console.error("[Encoder] Failed to read package info:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to read package info" }));
      return true;
    }
  }

  // Route: /api/encoder/package/update-script - serve just the update.sh
  if (url.pathname === "/api/encoder/package/update-script") {
    const distDir = findFile("packages/encoder/dist-package");
    const scriptPath = distDir ? `${distDir}/update.sh` : null;

    if (!scriptPath || !fs.existsSync(scriptPath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Update script not found. Run: pnpm --filter @annex/encoder build:dist");
      return true;
    }

    try {
      const script = fs.readFileSync(scriptPath, "utf-8");
      console.log(`[Encoder] Serving update script to ${clientIp}`);

      res.writeHead(200, {
        "Content-Type": "text/x-shellscript",
        "Content-Disposition": "inline; filename=\"update.sh\"",
        "Cache-Control": "no-cache",
      });
      res.end(script);
      return true;
    } catch (error) {
      console.error("[Encoder] Failed to serve update script:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to serve update script");
      return true;
    }
  }

  // Route: /api/encoder/package/download - serve the tarball
  if (url.pathname === "/api/encoder/package/download") {
    const tarballPath = findFile("packages/encoder/annex-encoder-latest.tar.gz");

    if (!tarballPath) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Encoder package not built. Run: pnpm --filter @annex/encoder build:dist");
      return true;
    }

    try {
      const stats = fs.statSync(tarballPath);
      const stream = fs.createReadStream(tarballPath);

      console.log(`[Encoder] Serving package to ${clientIp} (${(stats.size / 1024).toFixed(1)} KB)`);

      res.writeHead(200, {
        "Content-Type": "application/gzip",
        "Content-Length": stats.size.toString(),
        "Content-Disposition": "attachment; filename=\"annex-encoder.tar.gz\"",
        "Cache-Control": "no-cache",
      });

      stream.pipe(res);
      return true;
    } catch (error) {
      console.error("[Encoder] Failed to serve package:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Failed to serve encoder package");
      return true;
    }
  }

  // Unknown sub-route
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
  return true;
}

const server = createHTTPServer({
  router: appRouter,
  createContext,
  middleware: (req, res, next) => {
    // Handle custom routes before tRPC
    if (handleDeployEncoder(req, res)) {
      return;
    }
    if (handleEncoderPackage(req, res)) {
      return;
    }
    next(); // Pass to tRPC
  },
  responseMeta() {
    return {
      headers: {
        // Allow credentials for cookie-based auth
        "Access-Control-Allow-Origin": "http://localhost:5173", // Vite dev server
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    };
  },
});

const { port, host } = config.server;

server.listen(port, host);

// Create WebSocket servers without attaching to HTTP server (we'll route manually)
const wss = new WebSocketServer({ noServer: true });
const encoderWss = new WebSocketServer({ noServer: true });

// Apply tRPC WebSocket handler
const wssHandler = applyWSSHandler({
  wss,
  router: appRouter,
  createContext: async ({ req }) => {
    // For WebSocket connections, extract session from query params or cookies
    const url = new URL(req.url || "", `http://${host}:${port}`);
    const sessionToken = url.searchParams.get("token") || null;

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
  },
});

// Initialize remote encoder dispatch service with its own WebSocket server
const encoderDispatch = getEncoderDispatchService();
encoderDispatch.initializeWithWss(encoderWss);

// Manually route WebSocket upgrades based on path
server.server.on("upgrade", (req, socket, head) => {
  const pathname = req.url ? new URL(req.url, `http://${host}:${port}`).pathname : "/";

  if (pathname === "/encoder") {
    // Route to encoder WebSocket server
    encoderWss.handleUpgrade(req, socket, head, (ws) => {
      encoderWss.emit("connection", ws, req);
    });
  } else {
    // Route to tRPC WebSocket server (for subscriptions)
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

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
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Server running at http://${host}:${port}
WebSocket subscriptions enabled at ws://${host}:${port}
Remote encoder WebSocket at ws://${host}:${port}/encoder

Encoder Deployment:
  Setup script: curl -fsSL http://${host}:${port}/deploy-encoder | sudo bash
  Package info: http://${host}:${port}/api/encoder/package/info
  Package download: http://${host}:${port}/api/encoder/package/download

Log level: ${config.logging.level}
`);

// Start the scheduler (main process loop)
scheduler.start();

// Register misc cleanup tasks with scheduler
registerAuthTasks();
getTasteProfileService().registerTasks();

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
  wssHandler.broadcastReconnectNotification();
  wss.close();
  encoderWss.close();
  encoderDispatch.shutdown();
  await scheduler.stop();
  await jobQueue.stop();
  ircMonitor.stop();
  rssMonitor.stop();
  server.server.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nShutting down...");
  wssHandler.broadcastReconnectNotification();
  wss.close();
  encoderWss.close();
  encoderDispatch.shutdown();
  await scheduler.stop();
  await jobQueue.stop();
  ircMonitor.stop();
  rssMonitor.stop();
  server.server.close();
  process.exit(0);
});
