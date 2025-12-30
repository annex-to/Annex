/**
 * Library Status Service
 *
 * Efficiently batch-queries library and request status for multiple media items.
 * Used by discovery router to hydrate status without client-side batch requests.
 */

import { MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";

export interface LibraryServerInfo {
  id: string;
  name: string;
  type: string;
  quality?: string;
  episodeCount?: number;
  totalEpisodes?: number;
  isComplete?: boolean;
}

export interface LibraryInfo {
  servers: LibraryServerInfo[];
}

export interface RequestInfo {
  status: string;
}

export interface LibraryStatusBatch {
  inLibrary: Record<string, LibraryInfo>;
  requestStatus: Record<string, RequestInfo>;
}

/**
 * Convert MediaServerType enum to string representation
 */
function fromMediaServerType(type: string): string {
  const typeMap: Record<string, string> = {
    PLEX: "plex",
    EMBY: "emby",
    JELLYFIN: "jellyfin",
    NONE: "none",
  };
  return typeMap[type] || type.toLowerCase();
}

class LibraryStatusService {
  /**
   * Batch query library and request status for multiple items
   * Uses efficient IN queries with grouping by type
   */
  async getBatchStatus(
    items: Array<{ tmdbId: number; type: "movie" | "tv" }>
  ): Promise<LibraryStatusBatch> {
    if (items.length === 0) {
      return { inLibrary: {}, requestStatus: {} };
    }

    // Group by type for efficient querying
    const movieIds = items.filter((i) => i.type === "movie").map((i) => i.tmdbId);
    const tvIds = items.filter((i) => i.type === "tv").map((i) => i.tmdbId);

    // Parallel queries
    const [libraryItems, requests, episodeCounts, totalEpisodeCounts] = await Promise.all([
      this.queryLibraryItems(movieIds, tvIds),
      this.queryActiveRequests(movieIds, tvIds),
      this.queryTvEpisodeCounts(tvIds),
      this.queryTotalEpisodeCounts(tvIds),
    ]);

    // Build response maps
    return this.buildStatusMaps(libraryItems, requests, episodeCounts, totalEpisodeCounts);
  }

  /**
   * Query library items (movies and TV shows at series level)
   */
  private async queryLibraryItems(movieIds: number[], tvIds: number[]) {
    return prisma.libraryItem.findMany({
      where: {
        OR: [
          movieIds.length > 0
            ? { tmdbId: { in: movieIds }, type: MediaType.MOVIE }
            : { tmdbId: -1 }, // Never matches
          tvIds.length > 0 ? { tmdbId: { in: tvIds }, type: MediaType.TV } : { tmdbId: -1 },
        ],
      },
      include: {
        server: {
          select: {
            id: true,
            name: true,
            mediaServerType: true,
          },
        },
      },
    });
  }

  /**
   * Query active requests (not completed/failed)
   */
  private async queryActiveRequests(movieIds: number[], tvIds: number[]) {
    return prisma.mediaRequest.findMany({
      where: {
        OR: [
          movieIds.length > 0
            ? { tmdbId: { in: movieIds }, type: MediaType.MOVIE }
            : { tmdbId: -1 },
          tvIds.length > 0 ? { tmdbId: { in: tvIds }, type: MediaType.TV } : { tmdbId: -1 },
        ],
        status: {
          notIn: ["COMPLETED", "FAILED"],
        },
      },
      select: {
        tmdbId: true,
        type: true,
        status: true,
      },
    });
  }

  /**
   * Get episode counts from EpisodeLibraryItem grouped by tmdbId and serverId
   */
  private async queryTvEpisodeCounts(tvIds: number[]): Promise<Map<string, number>> {
    const episodeCounts = new Map<string, number>();

    if (tvIds.length === 0) {
      return episodeCounts;
    }

    const episodeData = await prisma.episodeLibraryItem.groupBy({
      by: ["tmdbId", "serverId"],
      where: { tmdbId: { in: tvIds } },
      _count: { id: true },
    });

    for (const item of episodeData) {
      const key = `${item.tmdbId}-${item.serverId}`;
      episodeCounts.set(key, item._count.id);
    }

    return episodeCounts;
  }

  /**
   * Get total episode counts from cached MediaItem data
   */
  private async queryTotalEpisodeCounts(tvIds: number[]): Promise<Map<number, number>> {
    const totalEpisodeCounts = new Map<number, number>();

    if (tvIds.length === 0) {
      return totalEpisodeCounts;
    }

    const mediaItems = await prisma.mediaItem.findMany({
      where: {
        tmdbId: { in: tvIds },
        type: MediaType.TV,
      },
      select: {
        tmdbId: true,
        seasons: {
          select: {
            _count: { select: { episodes: true } },
          },
        },
      },
    });

    for (const item of mediaItems) {
      const totalEps = item.seasons.reduce(
        (sum: number, s: { _count: { episodes: number } }) => sum + s._count.episodes,
        0
      );
      if (totalEps > 0) {
        totalEpisodeCounts.set(item.tmdbId, totalEps);
      }
    }

    return totalEpisodeCounts;
  }

  /**
   * Build status maps from query results
   */
  private buildStatusMaps(
    libraryItems: Awaited<ReturnType<typeof this.queryLibraryItems>>,
    requests: Awaited<ReturnType<typeof this.queryActiveRequests>>,
    episodeCounts: Map<string, number>,
    totalEpisodeCounts: Map<number, number>
  ): LibraryStatusBatch {
    // Build inLibrary map
    const inLibrary: Record<string, LibraryInfo> = {};

    for (const item of libraryItems) {
      const key = `${item.type.toLowerCase()}-${item.tmdbId}`;
      if (!inLibrary[key]) {
        inLibrary[key] = { servers: [] };
      }

      const serverInfo: LibraryServerInfo = {
        id: item.server.id,
        name: item.server.name,
        type: fromMediaServerType(item.server.mediaServerType),
        quality: item.quality || undefined,
      };

      // Add episode info for TV shows
      if (item.type === MediaType.TV) {
        const epKey = `${item.tmdbId}-${item.server.id}`;
        const epCount = episodeCounts.get(epKey) || 0;
        const totalEps = totalEpisodeCounts.get(item.tmdbId);

        if (epCount > 0) {
          serverInfo.episodeCount = epCount;
          if (totalEps !== undefined) {
            serverInfo.totalEpisodes = totalEps;
            serverInfo.isComplete = epCount >= totalEps;
          }
        }
      }

      inLibrary[key].servers.push(serverInfo);
    }

    // Build requestStatus map
    const requestStatus: Record<string, RequestInfo> = {};

    for (const req of requests) {
      const key = `${req.type.toLowerCase()}-${req.tmdbId}`;
      requestStatus[key] = { status: req.status };
    }

    return { inLibrary, requestStatus };
  }
}

// Singleton instance
let libraryStatusServiceInstance: LibraryStatusService | null = null;

export function getLibraryStatusService(): LibraryStatusService {
  if (!libraryStatusServiceInstance) {
    libraryStatusServiceInstance = new LibraryStatusService();
  }
  return libraryStatusServiceInstance;
}
