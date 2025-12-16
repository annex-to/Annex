/**
 * Library Sync Service
 *
 * Handles syncing media libraries from Plex/Emby servers to the local database.
 * Supports both on-demand and scheduled syncing.
 */

import { prisma } from "../db/client.js";
import { MediaServerType, MediaType } from "@prisma/client";
import { fetchEmbyLibraryForSync, fetchEmbyShowsWithEpisodes } from "./emby.js";
import { fetchPlexLibraryForSync, fetchPlexShowsWithEpisodes } from "./plex.js";
import { getCryptoService } from "./crypto.js";

// Decrypt value, falling back to raw value for legacy unencrypted data
function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const crypto = getCryptoService();
    return crypto.decrypt(value);
  } catch {
    return value;
  }
}

export interface LibrarySyncResult {
  serverId: string;
  serverName: string;
  synced: number;
  skipped: number;
  episodesSynced?: number;
  error?: string;
  isIncremental?: boolean;
}

export interface LibrarySyncOptions {
  /** Only sync items added/modified after this date */
  sinceDate?: Date;
}

/**
 * Sync a single server's library
 * @param serverId - The server to sync
 * @param options.sinceDate - Only sync items added after this date (incremental sync)
 */
export async function syncServerLibrary(
  serverId: string,
  options: LibrarySyncOptions = {}
): Promise<LibrarySyncResult> {
  const isIncremental = !!options.sinceDate;
  console.log(`[LibrarySync] Starting ${isIncremental ? "incremental" : "full"} sync for server ${serverId}${isIncremental ? ` (since ${options.sinceDate?.toISOString()})` : ""}`);

  const server = await prisma.storageServer.findUnique({
    where: { id: serverId },
  });

  if (!server) {
    console.log(`[LibrarySync] Server ${serverId} not found`);
    return {
      serverId,
      serverName: "Unknown",
      synced: 0,
      skipped: 0,
      error: "Server not found",
    };
  }

  console.log(`[LibrarySync] Found server: ${server.name} (${server.mediaServerType})`);

  if (server.mediaServerType === MediaServerType.NONE) {
    return {
      serverId,
      serverName: server.name,
      synced: 0,
      skipped: 0,
      error: "No media server configured",
    };
  }

  if (!server.mediaServerUrl || !server.mediaServerApiKey) {
    return {
      serverId,
      serverName: server.name,
      synced: 0,
      skipped: 0,
      error: "Media server URL or API key not configured",
    };
  }

  // Decrypt the API key
  const apiKey = decryptIfPresent(server.mediaServerApiKey);
  if (!apiKey) {
    return {
      serverId,
      serverName: server.name,
      synced: 0,
      skipped: 0,
      error: "Failed to decrypt media server API key",
    };
  }

  let syncedCount = 0;
  let skippedCount = 0;
  let episodesSynced = 0;

  try {
    let items: Array<{
      tmdbId?: number;
      type: "movie" | "tv";
      quality?: string;
      addedAt?: Date;
    }> = [];

    console.log(`[LibrarySync] Fetching library from ${server.mediaServerType}${isIncremental ? " (incremental)" : ""}...`);
    const fetchStart = Date.now();

    if (server.mediaServerType === MediaServerType.EMBY) {
      items = await fetchEmbyLibraryForSync(
        server.mediaServerUrl,
        apiKey,
        { sinceDate: options.sinceDate }
      );
    } else if (server.mediaServerType === MediaServerType.PLEX) {
      items = await fetchPlexLibraryForSync(
        server.mediaServerUrl,
        apiKey,
        { sinceDate: options.sinceDate }
      );
    }

    console.log(`[LibrarySync] Fetched ${items.length} items in ${Date.now() - fetchStart}ms`);

    // Upsert all items to LibraryItem table
    console.log(`[LibrarySync] Upserting ${items.length} items to database...`);
    const upsertStart = Date.now();

    for (const item of items) {
      if (!item.tmdbId) {
        skippedCount++;
        continue;
      }

      await prisma.libraryItem.upsert({
        where: {
          tmdbId_type_serverId: {
            tmdbId: item.tmdbId,
            type: item.type === "movie" ? MediaType.MOVIE : MediaType.TV,
            serverId: server.id,
          },
        },
        create: {
          tmdbId: item.tmdbId,
          type: item.type === "movie" ? MediaType.MOVIE : MediaType.TV,
          quality: item.quality || null,
          addedAt: item.addedAt || null,
          serverId: server.id,
        },
        update: {
          quality: item.quality || null,
          addedAt: item.addedAt || null,
          syncedAt: new Date(),
        },
      });

      syncedCount++;

      // Log progress every 100 items
      if (syncedCount % 100 === 0) {
        console.log(`[LibrarySync] Progress: ${syncedCount}/${items.length} items synced`);
      }
    }

    console.log(`[LibrarySync] Upserted ${syncedCount} items in ${Date.now() - upsertStart}ms`);

    // Sync episode-level data for TV shows
    console.log(`[LibrarySync] Starting episode sync${isIncremental ? " (incremental)" : ""}...`);
    const episodeStart = Date.now();

    try {
      episodesSynced = await syncServerEpisodes(server.id, server.mediaServerType, server.mediaServerUrl, apiKey, options.sinceDate);
      console.log(`[LibrarySync] Episode sync completed: ${episodesSynced} episodes in ${Date.now() - episodeStart}ms`);
    } catch (episodeError) {
      console.error(`[LibrarySync] Error syncing episodes for ${server.name}:`, episodeError);
    }

    console.log(
      `[LibrarySync] ${isIncremental ? "Incremental sync" : "Synced"} ${server.name}: ${syncedCount} items, ${episodesSynced} episodes, ${skippedCount} skipped`
    );

    return {
      serverId: server.id,
      serverName: server.name,
      synced: syncedCount,
      skipped: skippedCount,
      episodesSynced,
      isIncremental,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[LibrarySync] Error syncing ${server.name}:`, errorMessage);
    console.error(`[LibrarySync] Stack trace:`, error);

    return {
      serverId: server.id,
      serverName: server.name,
      synced: syncedCount,
      skipped: skippedCount,
      episodesSynced,
      error: errorMessage,
    };
  }
}

/**
 * Sync episode-level library data for a server
 */
async function syncServerEpisodes(
  serverId: string,
  mediaServerType: MediaServerType,
  serverUrl: string,
  apiKey: string,
  sinceDate?: Date
): Promise<number> {
  const isIncremental = !!sinceDate;
  console.log(`[LibrarySync] Fetching shows with episodes from ${mediaServerType}${isIncremental ? " (incremental)" : ""}...`);
  const fetchStart = Date.now();

  let showsWithEpisodes: Array<{
    tmdbId: number;
    title: string;
    episodes: Array<{
      season: number;
      episode: number;
      quality?: string;
      addedAt?: Date;
    }>;
  }> = [];

  if (mediaServerType === MediaServerType.EMBY) {
    showsWithEpisodes = await fetchEmbyShowsWithEpisodes(serverUrl, apiKey, { sinceDate });
  } else if (mediaServerType === MediaServerType.PLEX) {
    showsWithEpisodes = await fetchPlexShowsWithEpisodes(serverUrl, apiKey, { sinceDate });
  }

  const totalEpisodes = showsWithEpisodes.reduce((sum, show) => sum + show.episodes.length, 0);
  console.log(`[LibrarySync] Fetched ${showsWithEpisodes.length} shows with ${totalEpisodes} episodes in ${Date.now() - fetchStart}ms`);

  let episodeCount = 0;
  let showCount = 0;
  const upsertStart = Date.now();

  for (const show of showsWithEpisodes) {
    showCount++;
    for (const ep of show.episodes) {
      await prisma.episodeLibraryItem.upsert({
        where: {
          tmdbId_season_episode_serverId: {
            tmdbId: show.tmdbId,
            season: ep.season,
            episode: ep.episode,
            serverId,
          },
        },
        create: {
          tmdbId: show.tmdbId,
          season: ep.season,
          episode: ep.episode,
          quality: ep.quality || null,
          addedAt: ep.addedAt || null,
          serverId,
        },
        update: {
          quality: ep.quality || null,
          addedAt: ep.addedAt || null,
          syncedAt: new Date(),
        },
      });

      episodeCount++;
    }

    // Log progress every 10 shows
    if (showCount % 10 === 0) {
      console.log(`[LibrarySync] Episode progress: ${showCount}/${showsWithEpisodes.length} shows, ${episodeCount} episodes`);
    }
  }

  console.log(`[LibrarySync] Upserted ${episodeCount} episodes in ${Date.now() - upsertStart}ms`);

  return episodeCount;
}

/**
 * Sync all servers with media server configured
 */
export async function syncAllLibraries(): Promise<{
  results: LibrarySyncResult[];
  totalSynced: number;
  totalSkipped: number;
  errors: number;
}> {
  const servers = await prisma.storageServer.findMany({
    where: {
      mediaServerType: { not: MediaServerType.NONE },
      enabled: true,
    },
  });

  console.log(`[LibrarySync] Starting sync for ${servers.length} servers`);

  const results: LibrarySyncResult[] = [];
  let totalSynced = 0;
  let totalSkipped = 0;
  let errors = 0;

  for (const server of servers) {
    const result = await syncServerLibrary(server.id);
    results.push(result);
    totalSynced += result.synced;
    totalSkipped += result.skipped;
    if (result.error) errors++;
  }

  console.log(
    `[LibrarySync] Completed: ${totalSynced} synced, ${totalSkipped} skipped, ${errors} errors`
  );

  return { results, totalSynced, totalSkipped, errors };
}
