import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { prisma } from "../db/client.js";
import type { AuthUser } from "../trpc.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerLibraryTools } from "./tools/library.js";
import { registerRequestTools } from "./tools/requests.js";
import { registerServerTools } from "./tools/servers.js";
import { registerWatchHistoryTools } from "./tools/watchHistory.js";

// Active sessions: sessionId -> transport
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

function createMcpServer(user: AuthUser): McpServer {
  const server = new McpServer(
    {
      name: "annex",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerServerTools(server);
  registerLibraryTools(server);
  registerDiscoveryTools(server);
  registerRequestTools(server, user.id);
  registerWatchHistoryTools(server);

  return server;
}

async function authenticateToken(rawToken: string): Promise<AuthUser | null> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawToken);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const tokenHash = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  const mcpToken = await prisma.mcpToken.findUnique({
    where: { token: tokenHash },
    include: {
      user: {
        include: {
          plexAccount: true,
          embyAccount: true,
        },
      },
    },
  });

  if (!mcpToken) return null;
  if (!mcpToken.user.enabled) return null;

  // Update last used timestamp (fire and forget)
  prisma.mcpToken
    .update({
      where: { id: mcpToken.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  return mcpToken.user;
}

export async function handleMcpRequest(req: Request): Promise<Response> {
  // Extract token from query string
  const url = new URL(req.url);
  const rawToken = url.searchParams.get("token");

  if (!rawToken) {
    return new Response(JSON.stringify({ error: "Missing token parameter" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const user = await authenticateToken(rawToken);
  if (!user) {
    return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sessionId = req.headers.get("mcp-session-id");

  // POST: handle tool calls or initialization
  if (req.method === "POST") {
    let transport: WebStandardStreamableHTTPServerTransport;

    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      transport = existing;
    } else {
      // New session
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport);
        },
        onsessionclosed: (sid) => {
          sessions.delete(sid);
        },
      });

      const server = createMcpServer(user);
      await server.connect(transport);
    }

    return transport.handleRequest(req);
  }

  // GET: SSE stream
  if (req.method === "GET") {
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (transport) {
      return transport.handleRequest(req);
    }
    return new Response("Session not found", { status: 404 });
  }

  // DELETE: close session
  if (req.method === "DELETE") {
    const transport = sessionId ? sessions.get(sessionId) : undefined;
    if (transport) {
      await transport.close();
      if (sessionId) sessions.delete(sessionId);
      return new Response(null, { status: 200 });
    }
    return new Response("Session not found", { status: 404 });
  }

  return new Response("Method not allowed", { status: 405 });
}
