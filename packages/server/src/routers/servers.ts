import { Codec, MediaServerType, MediaType, Protocol, Resolution } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getCryptoService } from "../services/crypto.js";
import {
  fetchEmbyLibraryForSync,
  fetchEmbyMediaPaginated,
  fetchEmbyStats,
  testEmbyConnection,
} from "../services/emby.js";
import { getJobQueueService } from "../services/jobQueue.js";
import {
  fetchPlexLibraryForSync,
  fetchPlexMediaPaginated,
  fetchPlexStats,
  testPlexConnection,
} from "../services/plex.js";
import { publicProcedure, router } from "../trpc.js";

const mediaServerConfigSchema = z
  .object({
    type: z.enum(["plex", "emby", "none"]),
    url: z.string().url(),
    apiKey: z.string().optional(), // Optional on updates - omit to keep existing key
    libraryIds: z.object({
      movies: z.array(z.string()),
      tv: z.array(z.string()),
    }),
  })
  .nullable();

const restrictionsSchema = z.object({
  maxResolution: z.enum(["4K", "2K", "1080p", "720p", "480p"]),
  maxFileSize: z.number().nullable(),
  preferredCodec: z.enum(["av1", "hevc", "h264"]),
  maxBitrate: z.number().nullable(),
});

const librarySyncSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().min(1).max(1440).default(5),
});

const serverInputSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().min(1).max(65535),
  protocol: z.enum(["sftp", "rsync", "smb"]),
  username: z.string().min(1),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  paths: z.object({
    movies: z.string().min(1),
    tv: z.string().min(1),
  }),
  restrictions: restrictionsSchema,
  mediaServer: mediaServerConfigSchema,
  librarySync: librarySyncSchema.optional(),
  enabled: z.boolean().default(true),
});

// Map string values to Prisma enums
function toProtocol(value: string): Protocol {
  const map: Record<string, Protocol> = {
    sftp: Protocol.SFTP,
    rsync: Protocol.RSYNC,
    smb: Protocol.SMB,
  };
  return map[value] ?? Protocol.SFTP;
}

function toResolution(value: string): Resolution {
  const map: Record<string, Resolution> = {
    "4K": Resolution.RES_4K,
    "2K": Resolution.RES_2K,
    "1080p": Resolution.RES_1080P,
    "720p": Resolution.RES_720P,
    "480p": Resolution.RES_480P,
  };
  return map[value] ?? Resolution.RES_1080P;
}

function toCodec(value: string): Codec {
  const map: Record<string, Codec> = {
    av1: Codec.AV1,
    hevc: Codec.HEVC,
    h264: Codec.H264,
  };
  return map[value] ?? Codec.AV1;
}

function toMediaServerType(value: string | null): MediaServerType {
  if (!value || value === "none") return MediaServerType.NONE;
  const map: Record<string, MediaServerType> = {
    plex: MediaServerType.PLEX,
    emby: MediaServerType.EMBY,
  };
  return map[value] ?? MediaServerType.NONE;
}

// Map Prisma enums back to string values for API responses
function fromResolution(value: Resolution): string {
  const map: Record<Resolution, string> = {
    [Resolution.RES_4K]: "4K",
    [Resolution.RES_2K]: "2K",
    [Resolution.RES_1080P]: "1080p",
    [Resolution.RES_720P]: "720p",
    [Resolution.RES_480P]: "480p",
  };
  return map[value];
}

function fromCodec(value: Codec): string {
  const map: Record<Codec, string> = {
    [Codec.AV1]: "av1",
    [Codec.HEVC]: "hevc",
    [Codec.H264]: "h264",
  };
  return map[value];
}

function fromProtocol(value: Protocol): string {
  return value.toLowerCase();
}

function fromMediaServerType(value: MediaServerType): string {
  return value.toLowerCase();
}

// Encryption helpers for sensitive fields
function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  const crypto = getCryptoService();
  return crypto.encrypt(value);
}

function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const crypto = getCryptoService();
    return crypto.decrypt(value);
  } catch {
    // Return as-is if decryption fails (might be unencrypted legacy data)
    return value;
  }
}

export const serversRouter = router({
  /**
   * List all storage servers
   */
  list: publicProcedure.query(async () => {
    const results = await prisma.storageServer.findMany({
      orderBy: { name: "asc" },
    });

    return results.map((s) => ({
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      protocol: fromProtocol(s.protocol),
      username: s.username,
      paths: {
        movies: s.pathMovies,
        tv: s.pathTv,
      },
      restrictions: {
        maxResolution: fromResolution(s.maxResolution),
        maxFileSize: s.maxFileSize ? Number(s.maxFileSize) : null,
        preferredCodec: fromCodec(s.preferredCodec),
        maxBitrate: s.maxBitrate,
      },
      mediaServer:
        s.mediaServerType !== MediaServerType.NONE
          ? {
              type: fromMediaServerType(s.mediaServerType),
              url: s.mediaServerUrl ?? "",
              hasApiKey: !!s.mediaServerApiKey,
              libraryIds: {
                movies: s.mediaServerLibraryMovies,
                tv: s.mediaServerLibraryTv,
              },
            }
          : null,
      librarySync: {
        enabled: s.librarySyncEnabled,
        intervalMinutes: s.librarySyncInterval,
      },
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }),

  /**
   * Get a single server by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const s = await prisma.storageServer.findUnique({
      where: { id: input.id },
    });

    if (!s) {
      return null;
    }

    return {
      id: s.id,
      name: s.name,
      host: s.host,
      port: s.port,
      protocol: fromProtocol(s.protocol),
      username: s.username,
      paths: {
        movies: s.pathMovies,
        tv: s.pathTv,
      },
      restrictions: {
        maxResolution: fromResolution(s.maxResolution),
        maxFileSize: s.maxFileSize ? Number(s.maxFileSize) : null,
        preferredCodec: fromCodec(s.preferredCodec),
        maxBitrate: s.maxBitrate,
      },
      mediaServer:
        s.mediaServerType !== MediaServerType.NONE
          ? {
              type: fromMediaServerType(s.mediaServerType),
              url: s.mediaServerUrl ?? "",
              hasApiKey: !!s.mediaServerApiKey,
              libraryIds: {
                movies: s.mediaServerLibraryMovies,
                tv: s.mediaServerLibraryTv,
              },
            }
          : null,
      librarySync: {
        enabled: s.librarySyncEnabled,
        intervalMinutes: s.librarySyncInterval,
      },
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }),

  /**
   * Create a new storage server
   */
  create: publicProcedure.input(serverInputSchema).mutation(async ({ input }) => {
    const server = await prisma.storageServer.create({
      data: {
        name: input.name,
        host: input.host,
        port: input.port,
        protocol: toProtocol(input.protocol),
        username: input.username,
        encryptedPassword: encryptIfPresent(input.password),
        encryptedPrivateKey: encryptIfPresent(input.privateKey),
        pathMovies: input.paths.movies,
        pathTv: input.paths.tv,
        maxResolution: toResolution(input.restrictions.maxResolution),
        maxFileSize: input.restrictions.maxFileSize ? BigInt(input.restrictions.maxFileSize) : null,
        preferredCodec: toCodec(input.restrictions.preferredCodec),
        maxBitrate: input.restrictions.maxBitrate,
        mediaServerType: toMediaServerType(input.mediaServer?.type ?? null),
        mediaServerUrl: input.mediaServer?.url || null,
        mediaServerApiKey: encryptIfPresent(input.mediaServer?.apiKey),
        mediaServerLibraryMovies: input.mediaServer?.libraryIds.movies ?? [],
        mediaServerLibraryTv: input.mediaServer?.libraryIds.tv ?? [],
        librarySyncEnabled: input.librarySync?.enabled ?? true,
        librarySyncInterval: input.librarySync?.intervalMinutes ?? 5,
        enabled: input.enabled,
      },
    });

    // Start sync scheduler if media server is configured and sync is enabled
    if (
      input.mediaServer &&
      input.mediaServer.type !== "none" &&
      (input.librarySync?.enabled ?? true)
    ) {
      const jobQueue = getJobQueueService();
      jobQueue.startServerSyncScheduler(
        server.id,
        server.name,
        input.librarySync?.intervalMinutes ?? 5
      );
    }

    return { id: server.id };
  }),

  /**
   * Update a storage server
   */
  update: publicProcedure
    .input(z.object({ id: z.string() }).merge(serverInputSchema.partial()))
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      const data: Record<string, unknown> = {};

      if (updates.name !== undefined) data.name = updates.name;
      if (updates.host !== undefined) data.host = updates.host;
      if (updates.port !== undefined) data.port = updates.port;
      if (updates.protocol !== undefined) data.protocol = toProtocol(updates.protocol);
      if (updates.username !== undefined) data.username = updates.username;
      if (updates.password !== undefined)
        data.encryptedPassword = encryptIfPresent(updates.password);
      if (updates.privateKey !== undefined)
        data.encryptedPrivateKey = encryptIfPresent(updates.privateKey);
      if (updates.paths?.movies !== undefined) data.pathMovies = updates.paths.movies;
      if (updates.paths?.tv !== undefined) data.pathTv = updates.paths.tv;
      if (updates.restrictions?.maxResolution !== undefined)
        data.maxResolution = toResolution(updates.restrictions.maxResolution);
      if (updates.restrictions?.maxFileSize !== undefined)
        data.maxFileSize = updates.restrictions.maxFileSize
          ? BigInt(updates.restrictions.maxFileSize)
          : null;
      if (updates.restrictions?.preferredCodec !== undefined)
        data.preferredCodec = toCodec(updates.restrictions.preferredCodec);
      if (updates.restrictions?.maxBitrate !== undefined)
        data.maxBitrate = updates.restrictions.maxBitrate;
      if (updates.enabled !== undefined) data.enabled = updates.enabled;

      if (updates.mediaServer !== undefined) {
        if (updates.mediaServer === null) {
          data.mediaServerType = MediaServerType.NONE;
          data.mediaServerUrl = null;
          data.mediaServerApiKey = null;
          data.mediaServerLibraryMovies = [];
          data.mediaServerLibraryTv = [];
        } else {
          data.mediaServerType = toMediaServerType(updates.mediaServer.type);
          data.mediaServerUrl = updates.mediaServer.url;
          // Only update API key if a new one was provided (don't overwrite with null)
          if (updates.mediaServer.apiKey) {
            data.mediaServerApiKey = encryptIfPresent(updates.mediaServer.apiKey);
          }
          data.mediaServerLibraryMovies = updates.mediaServer.libraryIds.movies;
          data.mediaServerLibraryTv = updates.mediaServer.libraryIds.tv;
        }
      }

      // Handle library sync settings
      if (updates.librarySync !== undefined) {
        if (updates.librarySync.enabled !== undefined) {
          data.librarySyncEnabled = updates.librarySync.enabled;
        }
        if (updates.librarySync.intervalMinutes !== undefined) {
          data.librarySyncInterval = updates.librarySync.intervalMinutes;
        }
      }

      await prisma.storageServer.update({
        where: { id },
        data,
      });

      // Update the sync scheduler with new settings
      const jobQueue = getJobQueueService();
      await jobQueue.updateServerSyncScheduler(id);

      return { success: true };
    }),

  /**
   * Delete a storage server
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    // Stop the sync scheduler if running
    const jobQueue = getJobQueueService();
    jobQueue.stopServerSyncScheduler(input.id);

    await prisma.storageServer.delete({
      where: { id: input.id },
    });
    return { success: true };
  }),

  /**
   * Test connection to a storage server
   */
  test: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input: _input }) => {
    // TODO: Implement actual connection test using _input.id
    return {
      success: true,
      message: "Connection successful",
      latencyMs: 42,
    };
  }),

  /**
   * Sync library items from a storage server's media server (Emby/Plex)
   * Fetches all media from the media server and stores in LibraryItem table
   */
  syncLibrary: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const server = await prisma.storageServer.findUnique({
      where: { id: input.id },
    });

    if (!server) {
      throw new Error("Server not found");
    }

    if (server.mediaServerType === MediaServerType.NONE) {
      throw new Error("No media server configured for this storage server");
    }

    if (!server.mediaServerUrl || !server.mediaServerApiKey) {
      throw new Error("Media server URL or API key not configured");
    }

    // Decrypt the API key for use
    const apiKey = decryptIfPresent(server.mediaServerApiKey);
    if (!apiKey) {
      throw new Error("Failed to decrypt media server API key");
    }

    let syncedCount = 0;
    let skippedCount = 0;

    if (server.mediaServerType === MediaServerType.EMBY) {
      // Fetch all items from Emby
      const items = await fetchEmbyLibraryForSync(server.mediaServerUrl, apiKey);

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
    } else if (server.mediaServerType === MediaServerType.PLEX) {
      // Fetch all items from Plex
      const items = await fetchPlexLibraryForSync(server.mediaServerUrl, apiKey);

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
    }

    return {
      success: true,
      synced: syncedCount,
      skipped: skippedCount,
      message: `Synced ${syncedCount} items, skipped ${skippedCount} (no TMDB ID)`,
    };
  }),

  /**
   * Test media server connection (Emby/Plex)
   */
  testMediaServer: publicProcedure
    .input(
      z.object({
        type: z.enum(["emby", "plex"]),
        url: z.string().url(),
        apiKey: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      if (input.type === "emby") {
        return testEmbyConnection(input.url, input.apiKey);
      } else {
        return testPlexConnection(input.url, input.apiKey);
      }
    }),

  /**
   * Get library sync status for a server
   */
  libraryStatus: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const server = await prisma.storageServer.findUnique({
      where: { id: input.id },
    });

    if (!server) {
      return null;
    }

    const [movieCount, tvCount, lastSynced] = await Promise.all([
      prisma.libraryItem.count({
        where: { serverId: input.id, type: MediaType.MOVIE },
      }),
      prisma.libraryItem.count({
        where: { serverId: input.id, type: MediaType.TV },
      }),
      prisma.libraryItem.findFirst({
        where: { serverId: input.id },
        orderBy: { syncedAt: "desc" },
        select: { syncedAt: true },
      }),
    ]);

    return {
      movieCount,
      tvCount,
      totalCount: movieCount + tvCount,
      lastSyncedAt: lastSynced?.syncedAt || null,
      hasMediaServer: server.mediaServerType !== MediaServerType.NONE,
      mediaServerType: fromMediaServerType(server.mediaServerType),
    };
  }),

  /**
   * Bulk check if media items exist in any library
   * Used by Discover page to show "In Library" badges
   */
  checkInLibrary: publicProcedure
    .input(
      z.object({
        items: z.array(
          z.object({
            tmdbId: z.number(),
            type: z.enum(["movie", "tv"]),
          })
        ),
      })
    )
    .query(async ({ input }) => {
      if (input.items.length === 0) {
        return { inLibrary: {} };
      }

      // Group items by type for efficient querying
      const movieIds = input.items.filter((i) => i.type === "movie").map((i) => i.tmdbId);
      const tvIds = input.items.filter((i) => i.type === "tv").map((i) => i.tmdbId);

      // Query library items (movies and TV shows at series level)
      const libraryItems = await prisma.libraryItem.findMany({
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

      // For TV shows, also get episode counts per server
      const episodeCounts: Map<string, number> = new Map();
      const totalEpisodeCounts: Map<number, number> = new Map();

      if (tvIds.length > 0) {
        // Get episode counts from EpisodeLibraryItem grouped by tmdbId and serverId
        const episodeData = await prisma.episodeLibraryItem.groupBy({
          by: ["tmdbId", "serverId"],
          where: { tmdbId: { in: tvIds } },
          _count: { id: true },
        });

        for (const item of episodeData) {
          const key = `${item.tmdbId}-${item.serverId}`;
          episodeCounts.set(key, item._count.id);
        }

        // Get total episode counts from cached MediaItem data (if available)
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
          const totalEps = item.seasons.reduce((sum, s) => sum + s._count.episodes, 0);
          if (totalEps > 0) {
            totalEpisodeCounts.set(item.tmdbId, totalEps);
          }
        }
      }

      // Build a map of tmdbId-type -> server info
      const inLibrary: Record<
        string,
        {
          servers: Array<{
            id: string;
            name: string;
            type: string;
            quality?: string;
            episodeCount?: number;
            totalEpisodes?: number;
            isComplete?: boolean;
          }>;
        }
      > = {};

      for (const item of libraryItems) {
        const key = `${item.type.toLowerCase()}-${item.tmdbId}`;
        if (!inLibrary[key]) {
          inLibrary[key] = { servers: [] };
        }

        const serverInfo: {
          id: string;
          name: string;
          type: string;
          quality?: string;
          episodeCount?: number;
          totalEpisodes?: number;
          isComplete?: boolean;
        } = {
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

      return { inLibrary };
    }),

  /**
   * Check if media items have been requested (not yet in library)
   * Used by Discover page to show "Requested" badges
   */
  checkRequested: publicProcedure
    .input(
      z.object({
        items: z.array(
          z.object({
            tmdbId: z.number(),
            type: z.enum(["movie", "tv"]),
          })
        ),
      })
    )
    .query(async ({ input }) => {
      if (input.items.length === 0) {
        return { requested: {} };
      }

      // Group items by type for efficient querying
      const movieIds = input.items.filter((i) => i.type === "movie").map((i) => i.tmdbId);
      const tvIds = input.items.filter((i) => i.type === "tv").map((i) => i.tmdbId);

      // Query active requests (not completed/failed)
      const requests = await prisma.mediaRequest.findMany({
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

      // Build a map of tmdbId-type -> request status
      const requested: Record<string, { status: string }> = {};

      for (const req of requests) {
        const key = `${req.type.toLowerCase()}-${req.tmdbId}`;
        requested[key] = { status: req.status };
      }

      return { requested };
    }),

  /**
   * Get list of servers with media server configured (for library browser)
   */
  listWithMediaServer: publicProcedure.query(async () => {
    const servers = await prisma.storageServer.findMany({
      where: {
        mediaServerType: { not: MediaServerType.NONE },
        enabled: true,
      },
      orderBy: { name: "asc" },
    });

    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      mediaServerType: fromMediaServerType(s.mediaServerType),
      mediaServerUrl: s.mediaServerUrl,
    }));
  }),

  /**
   * Browse media from a specific server's media server (Emby/Plex)
   */
  browseMedia: publicProcedure
    .input(
      z.object({
        serverId: z.string(),
        type: z.enum(["movie", "tv"]).optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(24),
        sortBy: z
          .enum(["SortName", "DateCreated", "PremiereDate", "CommunityRating"])
          .default("SortName"),
        sortOrder: z.enum(["Ascending", "Descending"]).default("Ascending"),
        search: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const server = await prisma.storageServer.findUnique({
        where: { id: input.serverId },
      });

      if (!server) {
        throw new Error("Server not found");
      }

      if (server.mediaServerType === MediaServerType.NONE) {
        throw new Error("No media server configured for this storage server");
      }

      if (!server.mediaServerUrl || !server.mediaServerApiKey) {
        throw new Error("Media server URL or API key not configured");
      }

      // Decrypt the API key for use
      const apiKey = decryptIfPresent(server.mediaServerApiKey);
      if (!apiKey) {
        throw new Error("Failed to decrypt media server API key");
      }

      if (server.mediaServerType === MediaServerType.EMBY) {
        const startIndex = (input.page - 1) * input.limit;
        const result = await fetchEmbyMediaPaginated(server.mediaServerUrl, apiKey, {
          type: input.type,
          startIndex,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: input.sortOrder,
          searchTerm: input.search,
        });

        return {
          items: result.items,
          page: input.page,
          totalPages: Math.ceil(result.totalCount / input.limit),
          totalItems: result.totalCount,
          serverName: server.name,
          mediaServerType: "emby" as const,
        };
      } else if (server.mediaServerType === MediaServerType.PLEX) {
        const startIndex = (input.page - 1) * input.limit;
        // Convert sort order from Emby format to Plex format
        const plexSortOrder = input.sortOrder === "Ascending" ? "asc" : "desc";
        const result = await fetchPlexMediaPaginated(server.mediaServerUrl, apiKey, {
          type: input.type,
          startIndex,
          limit: input.limit,
          sortBy: input.sortBy,
          sortOrder: plexSortOrder,
          searchTerm: input.search,
        });

        return {
          items: result.items,
          page: input.page,
          totalPages: Math.ceil(result.totalCount / input.limit),
          totalItems: result.totalCount,
          serverName: server.name,
          mediaServerType: "plex" as const,
        };
      }

      throw new Error("Unknown media server type");
    }),

  /**
   * Get stats from a specific server's media server
   */
  mediaStats: publicProcedure.input(z.object({ serverId: z.string() })).query(async ({ input }) => {
    const server = await prisma.storageServer.findUnique({
      where: { id: input.serverId },
    });

    if (!server) {
      throw new Error("Server not found");
    }

    if (server.mediaServerType === MediaServerType.NONE) {
      return null;
    }

    if (!server.mediaServerUrl || !server.mediaServerApiKey) {
      return null;
    }

    // Decrypt the API key for use
    const apiKey = decryptIfPresent(server.mediaServerApiKey);
    if (!apiKey) {
      return null;
    }

    if (server.mediaServerType === MediaServerType.EMBY) {
      const stats = await fetchEmbyStats(server.mediaServerUrl, apiKey);
      return {
        ...stats,
        serverName: server.name,
        mediaServerType: "emby" as const,
      };
    } else if (server.mediaServerType === MediaServerType.PLEX) {
      const stats = await fetchPlexStats(server.mediaServerUrl, apiKey);
      return {
        ...stats,
        serverName: server.name,
        mediaServerType: "plex" as const,
      };
    }

    return null;
  }),

  // =============================================================================
  // Per-Server Library Sync Control
  // =============================================================================

  /**
   * Get library sync status for a specific server
   */
  syncStatus: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const server = await prisma.storageServer.findUnique({
      where: { id: input.id },
    });

    if (!server) {
      return null;
    }

    const jobQueue = getJobQueueService();
    const schedulerRunning = jobQueue.isServerSyncSchedulerRunning(input.id);

    // Check for actively running sync jobs with recent heartbeat (within 2 minutes)
    // This prevents stuck jobs from blocking the UI indefinitely
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const activeSyncJob = await prisma.job.findFirst({
      where: {
        type: "library:sync-server",
        status: "RUNNING",
        heartbeatAt: { gte: twoMinutesAgo },
        payload: {
          path: ["serverId"],
          equals: input.id,
        },
      },
    });
    const currentlySyncing = activeSyncJob !== null;

    // Get the last completed sync job for this server
    const lastSyncJob = await prisma.job.findFirst({
      where: {
        type: "library:sync-server",
        status: "COMPLETED",
        payload: {
          path: ["serverId"],
          equals: input.id,
        },
      },
      orderBy: { completedAt: "desc" },
    });

    return {
      enabled: server.librarySyncEnabled,
      intervalMinutes: server.librarySyncInterval,
      schedulerRunning,
      currentlySyncing,
      lastSyncAt: lastSyncJob?.completedAt?.toISOString() || null,
      hasMediaServer: server.mediaServerType !== MediaServerType.NONE,
    };
  }),

  /**
   * Update library sync settings for a specific server
   */
  updateSyncSettings: publicProcedure
    .input(
      z.object({
        id: z.string(),
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().min(1).max(1440).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, enabled, intervalMinutes } = input;

      const data: Record<string, unknown> = {};
      if (enabled !== undefined) data.librarySyncEnabled = enabled;
      if (intervalMinutes !== undefined) data.librarySyncInterval = intervalMinutes;

      await prisma.storageServer.update({
        where: { id },
        data,
      });

      // Update the scheduler with new settings
      const jobQueue = getJobQueueService();
      await jobQueue.updateServerSyncScheduler(id);

      return { success: true };
    }),

  /**
   * Trigger an immediate library sync for a specific server
   * @param incremental - If true, only sync items added since last sync
   */
  triggerSync: publicProcedure
    .input(
      z.object({
        id: z.string(),
        incremental: z.boolean().optional().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const server = await prisma.storageServer.findUnique({
        where: { id: input.id },
      });

      if (!server) {
        throw new Error("Server not found");
      }

      if (server.mediaServerType === MediaServerType.NONE) {
        throw new Error("No media server configured for this storage server");
      }

      const jobQueue = getJobQueueService();

      // For incremental sync, use the last sync time
      let sinceDate: Date | undefined;
      if (input.incremental) {
        const lastSync = await prisma.libraryItem.findFirst({
          where: { serverId: input.id },
          orderBy: { syncedAt: "desc" },
          select: { syncedAt: true },
        });
        sinceDate = lastSync?.syncedAt || undefined;

        if (!sinceDate) {
          // No previous sync found, do a full sync instead
          console.log(`[LibrarySync] No previous sync found for ${server.name}, running full sync`);
        }
      }

      const job = await jobQueue.triggerServerLibrarySync(input.id, sinceDate);

      return {
        success: true,
        jobId: job?.id || null,
        alreadyRunning: job === null,
        isIncremental: !!sinceDate,
      };
    }),

  /**
   * Check if any Plex servers are configured
   */
  hasPlexServers: publicProcedure.query(async () => {
    const count = await prisma.storageServer.count({
      where: { mediaServerType: "PLEX" },
    });
    return { exists: count > 0 };
  }),

  /**
   * Check if any Emby servers are configured
   */
  hasEmbyServers: publicProcedure.query(async () => {
    const count = await prisma.storageServer.count({
      where: { mediaServerType: "EMBY" },
    });
    return { exists: count > 0 };
  }),
});
