import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { IndexerType } from "@prisma/client";
import { getIndexerService } from "../services/indexer.js";
import {
  getTorrentLeechProvider,
  TORRENTLEECH_CATEGORIES,
  TORRENTLEECH_CATEGORY_GROUPS,
} from "../services/torrentleech.js";
import {
  getUnit3dProvider,
  UNIT3D_CATEGORIES,
  UNIT3D_CATEGORY_GROUPS,
} from "../services/unit3d.js";
import { getCryptoService } from "../services/crypto.js";

const indexerInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["torznab", "newznab", "rss", "torrentleech", "unit3d"]),
  url: z.string().url(),
  apiKey: z.string(),
  categories: z.object({
    movies: z.array(z.number()),
    tv: z.array(z.number()),
  }),
  priority: z.number().min(1).max(100).default(50),
  enabled: z.boolean().default(true),
});

// Map string values to Prisma enums
function toIndexerType(value: string): IndexerType {
  const map: Record<string, IndexerType> = {
    torznab: IndexerType.TORZNAB,
    newznab: IndexerType.NEWZNAB,
    rss: IndexerType.RSS,
    torrentleech: IndexerType.TORRENTLEECH,
    unit3d: IndexerType.UNIT3D,
  };
  return map[value] ?? IndexerType.TORZNAB;
}

function fromIndexerType(value: IndexerType): string {
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

export const indexersRouter = router({
  /**
   * List all indexers
   */
  list: publicProcedure.query(async () => {
    const results = await prisma.indexer.findMany({
      orderBy: { priority: "asc" },
    });

    return results.map((i) => ({
      id: i.id,
      name: i.name,
      type: fromIndexerType(i.type),
      url: i.url,
      hasApiKey: !!i.apiKey,
      categories: {
        movies: i.categoriesMovies,
        tv: i.categoriesTv,
      },
      priority: i.priority,
      enabled: i.enabled,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));
  }),

  /**
   * Get a single indexer by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const i = await prisma.indexer.findUnique({
      where: { id: input.id },
    });

    if (!i) {
      return null;
    }

    return {
      id: i.id,
      name: i.name,
      type: fromIndexerType(i.type),
      url: i.url,
      hasApiKey: !!i.apiKey,
      categories: {
        movies: i.categoriesMovies,
        tv: i.categoriesTv,
      },
      priority: i.priority,
      enabled: i.enabled,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    };
  }),

  /**
   * Create a new indexer
   */
  create: publicProcedure.input(indexerInputSchema).mutation(async ({ input }) => {
    const indexer = await prisma.indexer.create({
      data: {
        name: input.name,
        type: toIndexerType(input.type),
        url: input.url,
        apiKey: encryptIfPresent(input.apiKey) || "",
        categoriesMovies: input.categories.movies,
        categoriesTv: input.categories.tv,
        priority: input.priority,
        enabled: input.enabled,
      },
    });

    return { id: indexer.id };
  }),

  /**
   * Update an indexer
   */
  update: publicProcedure
    .input(z.object({ id: z.string() }).merge(indexerInputSchema.partial()))
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      const data: Record<string, unknown> = {};

      if (updates.name !== undefined) data.name = updates.name;
      if (updates.type !== undefined) data.type = toIndexerType(updates.type);
      if (updates.url !== undefined) data.url = updates.url;
      // Only update apiKey if a new one was provided (don't overwrite with null/empty)
      if (updates.apiKey) data.apiKey = encryptIfPresent(updates.apiKey);
      if (updates.categories?.movies !== undefined) data.categoriesMovies = updates.categories.movies;
      if (updates.categories?.tv !== undefined) data.categoriesTv = updates.categories.tv;
      if (updates.priority !== undefined) data.priority = updates.priority;
      if (updates.enabled !== undefined) data.enabled = updates.enabled;

      await prisma.indexer.update({
        where: { id },
        data,
      });

      return { success: true };
    }),

  /**
   * Delete an indexer
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    await prisma.indexer.delete({
      where: { id: input.id },
    });
    return { success: true };
  }),

  /**
   * Test an indexer connection
   */
  test: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const indexer = await prisma.indexer.findUnique({
      where: { id: input.id },
    });

    if (!indexer) {
      return {
        success: false,
        message: "Indexer not found",
        capabilities: null,
      };
    }

    // Decrypt the API key for testing
    const apiKey = decryptIfPresent(indexer.apiKey) || "";

    try {
      // Test based on indexer type
      if (indexer.type === IndexerType.TORRENTLEECH) {
        // Test TorrentLeech connection
        // Format: username:password or username:password:alt2FAToken or username:password:alt2FAToken:rssKey
        const parts = apiKey.split(":");
        const [username, password] = parts;

        // Third part could be 2FA token (32 char MD5) or RSS key (longer)
        let alt2FAToken: string | undefined;
        let rssKey: string | undefined;

        if (parts[2]) {
          if (parts[2].length === 32 && /^[a-f0-9]+$/i.test(parts[2])) {
            alt2FAToken = parts[2];
            rssKey = parts[3];
          } else {
            rssKey = parts[2];
          }
        }

        if (!username || !password) {
          return {
            success: false,
            message: "Invalid credentials format. Use 'username:password' or 'username:password:alt2FAToken'",
            capabilities: null,
          };
        }

        const provider = getTorrentLeechProvider({
          baseUrl: indexer.url,
          username,
          password,
          alt2FAToken,
          rssKey,
        });

        const result = await provider.testConnection();
        return {
          success: result.success,
          message: result.message,
          capabilities: result.success
            ? {
                search: true,
                tvSearch: true,
                movieSearch: true,
                username: result.username,
              }
            : null,
        };
      } else if (indexer.type === IndexerType.UNIT3D) {
        // Test UNIT3D connection
        const provider = getUnit3dProvider({
          baseUrl: indexer.url,
          apiToken: apiKey,
        });

        const result = await provider.testConnection();
        return {
          success: result.success,
          message: result.message,
          capabilities: result.success
            ? {
                search: true,
                tvSearch: true,
                movieSearch: true,
                username: result.username,
              }
            : null,
        };
      } else {
        // Test Torznab/Newznab connection via capabilities endpoint
        const baseUrl = indexer.url.replace(/\/+$/, "");
        const capsUrl = `${baseUrl}/api?apikey=${encodeURIComponent(apiKey)}&t=caps`;

        const response = await fetch(capsUrl, {
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) {
          return {
            success: false,
            message: `HTTP ${response.status}: ${response.statusText}`,
            capabilities: null,
          };
        }

        const xml = await response.text();

        // Check for error response
        if (xml.includes("<error")) {
          const errorMatch = xml.match(/description="([^"]+)"/);
          return {
            success: false,
            message: errorMatch ? errorMatch[1] : "Unknown error from indexer",
            capabilities: null,
          };
        }

        // Parse capabilities
        const capabilities = {
          search: xml.includes('available="yes"') || xml.includes("<searching>"),
          tvSearch: xml.includes('t="tvsearch"') || xml.includes("tv-search"),
          movieSearch: xml.includes('t="movie"') || xml.includes("movie-search"),
        };

        return {
          success: true,
          message: "Connection successful",
          capabilities,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : "Connection failed",
        capabilities: null,
      };
    }
  }),

  /**
   * Search across all enabled indexers
   */
  search: publicProcedure
    .input(
      z.object({
        query: z.string().optional(),
        type: z.enum(["movie", "tv"]),
        tmdbId: z.number().optional(),
        imdbId: z.string().optional(),
        tvdbId: z.number().optional(),
        season: z.number().optional(),
        episode: z.number().optional(),
      })
    )
    .query(async ({ input }) => {
      const indexerService = getIndexerService();

      const result = await indexerService.search({
        type: input.type,
        query: input.query,
        tmdbId: input.tmdbId,
        imdbId: input.imdbId,
        tvdbId: input.tvdbId,
        season: input.season,
        episode: input.episode,
      });

      return {
        releases: result.releases,
        indexersQueried: result.indexersQueried,
        indexersFailed: result.indexersFailed,
        errors: result.errors,
      };
    }),

  /**
   * Get TorrentLeech categories
   */
  torrentleechCategories: publicProcedure.query(() => {
    return {
      categories: TORRENTLEECH_CATEGORIES,
      groups: {
        movies: TORRENTLEECH_CATEGORY_GROUPS.movies,
        tv: TORRENTLEECH_CATEGORY_GROUPS.tv,
        all: TORRENTLEECH_CATEGORY_GROUPS.all,
      },
    };
  }),

  /**
   * Get UNIT3D categories (default values - actual categories vary per tracker)
   */
  unit3dCategories: publicProcedure.query(() => {
    return {
      categories: UNIT3D_CATEGORIES,
      groups: {
        movies: UNIT3D_CATEGORY_GROUPS.movies,
        tv: UNIT3D_CATEGORY_GROUPS.tv,
        all: UNIT3D_CATEGORY_GROUPS.all,
      },
    };
  }),
});
