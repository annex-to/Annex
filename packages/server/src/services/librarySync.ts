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

export interface LibrarySyncResult {
  serverId: string;
  serverName: string;
  synced: number;
  skipped: number;
  episodesSynced?: number;
  error?: string;
}

/**
 * Sync a single server's library
 */
export async function syncServerLibrary(serverId: string): Promise<LibrarySyncResult> {
  const server = await prisma.storageServer.findUnique({
    where: { id: serverId },
  });

  if (!server) {
    return {
      serverId,
      serverName: "Unknown",
      synced: 0,
      skipped: 0,
      error: "Server not found",
    };
  }

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

    if (server.mediaServerType === MediaServerType.EMBY) {
      items = await fetchEmbyLibraryForSync(
        server.mediaServerUrl,
        server.mediaServerApiKey
      );
    } else if (server.mediaServerType === MediaServerType.PLEX) {
      items = await fetchPlexLibraryForSync(
        server.mediaServerUrl,
        server.mediaServerApiKey
      );
    }

    // Upsert all items to LibraryItem table
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
    }

    // Sync episode-level data for TV shows
    try {
      episodesSynced = await syncServerEpisodes(server.id, server.mediaServerType, server.mediaServerUrl, server.mediaServerApiKey);
    } catch (episodeError) {
      console.error(`[LibrarySync] Error syncing episodes for ${server.name}:`, episodeError);
    }

    console.log(
      `[LibrarySync] Synced ${server.name}: ${syncedCount} items, ${episodesSynced} episodes, ${skippedCount} skipped`
    );

    return {
      serverId: server.id,
      serverName: server.name,
      synced: syncedCount,
      skipped: skippedCount,
      episodesSynced,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[LibrarySync] Error syncing ${server.name}:`, errorMessage);

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
  apiKey: string
): Promise<number> {
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
    showsWithEpisodes = await fetchEmbyShowsWithEpisodes(serverUrl, apiKey);
  } else if (mediaServerType === MediaServerType.PLEX) {
    showsWithEpisodes = await fetchPlexShowsWithEpisodes(serverUrl, apiKey);
  }

  let episodeCount = 0;

  for (const show of showsWithEpisodes) {
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
  }

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
