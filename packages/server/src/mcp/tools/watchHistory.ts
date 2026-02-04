import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MediaServerType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import { getCryptoService } from "../../services/crypto.js";
import { fetchEmbyWatchedItems } from "../../services/emby.js";
import { fetchPlexWatchedItems } from "../../services/plex.js";
import type { AuthUser } from "../../trpc.js";

interface WatchedItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  viewCount: number;
  lastViewedAt?: string;
  duration?: number;
  serverName: string;
}

interface PlaybackReportItem {
  date: string;
  time: string;
  user_id: string;
  item_name: string;
  item_id: string;
  item_type: string;
  duration: number;
  remote_address: string;
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

async function fetchEmbyPlaybackReporting(
  serverUrl: string,
  apiKey: string,
  embyUserId: string,
  days: number
): Promise<WatchedItem[] | null> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const params = new URLSearchParams({
    user_id: embyUserId,
    days: String(days),
    aggregate_data: "true",
    filter: "movies,series",
  });

  try {
    const response = await fetch(`${baseUrl}/user_usage_stats/UserPlaylist?${params}`, {
      headers: { "X-Emby-Token": apiKey, Accept: "application/json" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as PlaybackReportItem[];
    if (!Array.isArray(data)) return null;

    // Group by ItemId to aggregate plays
    const itemMap = new Map<
      string,
      {
        name: string;
        itemType: string;
        playCount: number;
        totalDuration: number;
        lastPlayDate: string;
      }
    >();

    for (const entry of data) {
      const existing = itemMap.get(entry.item_id);
      if (existing) {
        existing.playCount += 1;
        existing.totalDuration += entry.duration;
        if (entry.date > existing.lastPlayDate) {
          existing.lastPlayDate = entry.date;
        }
      } else {
        itemMap.set(entry.item_id, {
          name: entry.item_name,
          itemType: entry.item_type,
          playCount: 1,
          totalDuration: entry.duration,
          lastPlayDate: entry.date,
        });
      }
    }

    // Resolve TMDB IDs from Emby item metadata
    const items: WatchedItem[] = [];
    for (const [itemId, info] of itemMap) {
      const isMovie = info.itemType === "Movie";
      const isEpisode = info.itemType === "Episode" || info.itemType === "Series";
      if (!isMovie && !isEpisode) continue;

      let tmdbId: number | undefined;

      try {
        // For episodes, try to get the series-level TMDB ID
        const lookupUrl = isEpisode
          ? `${baseUrl}/Items/${itemId}?Fields=ProviderIds,SeriesId`
          : `${baseUrl}/Items/${itemId}?Fields=ProviderIds`;

        const itemResp = await fetch(lookupUrl, {
          headers: {
            "X-Emby-Token": apiKey,
            Accept: "application/json",
          },
        });

        if (itemResp.ok) {
          const itemData = (await itemResp.json()) as {
            ProviderIds?: { Tmdb?: string };
            SeriesId?: string;
            Type?: string;
          };

          if (itemData.ProviderIds?.Tmdb) {
            tmdbId = Number.parseInt(itemData.ProviderIds.Tmdb, 10);
          } else if (isEpisode && itemData.SeriesId) {
            // Fetch series to get TMDB ID
            const seriesResp = await fetch(
              `${baseUrl}/Items/${itemData.SeriesId}?Fields=ProviderIds`,
              {
                headers: {
                  "X-Emby-Token": apiKey,
                  Accept: "application/json",
                },
              }
            );
            if (seriesResp.ok) {
              const seriesData = (await seriesResp.json()) as {
                ProviderIds?: { Tmdb?: string };
              };
              if (seriesData.ProviderIds?.Tmdb) {
                tmdbId = Number.parseInt(seriesData.ProviderIds.Tmdb, 10);
              }
            }
          }
        }
      } catch {
        continue;
      }

      if (!tmdbId || Number.isNaN(tmdbId)) continue;

      // Deduplicate: episodes of the same series should be grouped
      const existingItem = items.find(
        (i) => i.tmdbId === tmdbId && i.type === (isMovie ? "movie" : "tv")
      );
      if (existingItem) {
        existingItem.viewCount += info.playCount;
        existingItem.duration = (existingItem.duration ?? 0) + info.totalDuration;
        if (info.lastPlayDate > (existingItem.lastViewedAt ?? "")) {
          existingItem.lastViewedAt = info.lastPlayDate;
        }
      } else {
        items.push({
          tmdbId,
          type: isMovie ? "movie" : "tv",
          title: info.name,
          viewCount: info.playCount,
          lastViewedAt: info.lastPlayDate,
          duration: info.totalDuration,
          serverName: "",
        });
      }
    }

    return items;
  } catch {
    return null;
  }
}

export function registerWatchHistoryTools(server: McpServer, user: AuthUser) {
  server.tool(
    "get_watch_history",
    "Get watch history from Plex/Emby media servers. Returns movies and TV shows the user has watched, sorted by most recently viewed. For Emby servers with the playback_reporting plugin, returns richer data including play duration. Useful for understanding viewing preferences and making recommendations.",
    {
      type: z.enum(["movie", "tv"]).optional().describe("Filter by media type"),
      serverId: z.string().optional().describe("Limit to a specific server ID"),
      days: z
        .number()
        .min(1)
        .max(365)
        .default(90)
        .describe("Number of days of history to fetch (Emby playback reporting only)"),
      limit: z.number().min(1).max(500).default(50).describe("Maximum items to return"),
    },
    async ({ type, serverId, days = 90, limit = 50 }) => {
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
            const embyUserId = user.embyAccount?.embyId;
            if (!embyUserId) continue;

            // Try playback reporting plugin first for richer data
            const pluginItems = await fetchEmbyPlaybackReporting(
              s.mediaServerUrl,
              apiKey,
              embyUserId,
              days
            );

            if (pluginItems) {
              for (const item of pluginItems) {
                item.serverName = s.name;
                allItems.push(item);
              }
            } else {
              // Fall back to native Emby watched items API
              const items = await fetchEmbyWatchedItems(s.mediaServerUrl, apiKey, embyUserId);
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
