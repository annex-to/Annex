import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaServerType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { getCryptoService } from "../../services/crypto.js";
import { fetchEmbyWatchedItems } from "../../services/emby.js";
import { fetchPlexWatchedItems } from "../../services/plex.js";

interface WatchedItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  viewCount: number;
  lastViewedAt?: string;
  serverName: string;
}

function decryptApiKey(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const crypto = getCryptoService();
    return crypto.decrypt(value);
  } catch {
    return value;
  }
}

export function registerWatchHistoryTools(server: McpServer) {
  server.tool(
    "get_watch_history",
    "Get watch history from Plex/Emby media servers. Returns movies and TV shows the user has watched, sorted by most recently viewed. Useful for understanding viewing preferences and making recommendations.",
    {
      type: z.enum(["movie", "tv"]).optional().describe("Filter by media type"),
      serverId: z.string().optional().describe("Limit to a specific server ID"),
      limit: z.number().min(1).max(500).default(50).describe("Maximum items to return"),
    },
    async ({ type, serverId, limit = 50 }) => {
      const where: Record<string, unknown> = {
        enabled: true,
        mediaServerType: { not: MediaServerType.NONE },
        mediaServerUrl: { not: null },
        mediaServerApiKey: { not: null },
      };
      if (serverId) {
        where.id = serverId;
      }

      const servers = await prisma.storageServer.findMany({ where });

      if (servers.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No servers with media server connections (Plex/Emby) found.",
            },
          ],
          isError: true,
        };
      }

      const allItems: WatchedItem[] = [];

      type ServerRow = (typeof servers)[number];
      for (const srv of servers) {
        const s = srv as ServerRow;
        const apiKey = decryptApiKey(s.mediaServerApiKey);
        if (!s.mediaServerUrl || !apiKey) continue;

        try {
          if (s.mediaServerType === MediaServerType.PLEX) {
            const items = await fetchPlexWatchedItems(s.mediaServerUrl, apiKey);
            for (const item of items) {
              allItems.push({
                tmdbId: item.tmdbId,
                type: item.type,
                title: item.title,
                viewCount: item.viewCount,
                lastViewedAt: item.lastViewedAt?.toISOString(),
                serverName: s.name,
              });
            }
          } else if (s.mediaServerType === MediaServerType.EMBY) {
            const items = await fetchEmbyWatchedItems(s.mediaServerUrl, apiKey, "");
            for (const item of items) {
              allItems.push({
                tmdbId: item.tmdbId,
                type: item.type,
                title: item.title,
                viewCount: item.playCount,
                lastViewedAt: item.lastPlayedAt?.toISOString(),
                serverName: s.name,
              });
            }
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[MCP] Failed to fetch watch history from ${s.name}:`, msg);
        }
      }

      // Filter by type if requested
      let filtered = type ? allItems.filter((i) => i.type === type) : allItems;

      // Sort by last viewed (most recent first), items without dates last
      filtered.sort((a, b) => {
        if (!a.lastViewedAt && !b.lastViewedAt) return 0;
        if (!a.lastViewedAt) return 1;
        if (!b.lastViewedAt) return -1;
        return new Date(b.lastViewedAt).getTime() - new Date(a.lastViewedAt).getTime();
      });

      filtered = filtered.slice(0, limit);

      const response = {
        totalItems: filtered.length,
        ...(type && { type }),
        items: filtered,
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    }
  );
}
