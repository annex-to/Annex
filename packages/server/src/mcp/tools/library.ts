import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MediaItem, MediaRatings } from "@prisma/client";
import { MediaType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";

type MediaWithRatings = MediaItem & { ratings: MediaRatings | null };
type LibraryRow = { tmdbId: number; type: MediaType; quality: string | null; addedAt: Date | null };

export function registerLibraryTools(server: McpServer) {
  server.tool(
    "get_server_library",
    "Get paginated media items available on a specific storage server's library. Use this to see what the user already has.",
    {
      serverId: z.string().describe("Storage server ID"),
      type: z.enum(["movie", "tv"]).optional().describe("Filter by media type"),
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(50).default(20).describe("Items per page"),
      search: z.string().optional().describe("Search by title"),
    },
    async ({ serverId, type, page = 1, limit = 20, search }) => {
      const server = await prisma.storageServer.findUnique({
        where: { id: serverId },
        select: { id: true, name: true },
      });

      if (!server) {
        return {
          content: [{ type: "text" as const, text: "Server not found" }],
          isError: true,
        };
      }

      const where: Record<string, unknown> = { serverId };
      if (type) {
        where.type = type === "movie" ? MediaType.MOVIE : MediaType.TV;
      }

      // Get tmdbIds from library items
      const libraryItems = await prisma.libraryItem.findMany({
        where,
        select: { tmdbId: true, type: true, quality: true, addedAt: true },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { addedAt: "desc" },
      });

      const totalCount = await prisma.libraryItem.count({ where });

      // Hydrate with MediaItem metadata
      const tmdbKeys = libraryItems.map(
        (li: LibraryRow) => `tmdb-${li.type === MediaType.MOVIE ? "movie" : "tv"}-${li.tmdbId}`
      );

      const mediaItems: MediaWithRatings[] = await prisma.mediaItem.findMany({
        where: { id: { in: tmdbKeys } },
        include: { ratings: true },
      });

      const mediaMap = new Map<string, MediaWithRatings>(
        mediaItems.map((m: MediaWithRatings) => [m.id, m])
      );

      type LibraryResult = {
        tmdbId: number;
        type: string;
        title: string;
        year: number | null | undefined;
        overview: string | null | undefined;
        genres: string[];
        runtime: number | null | undefined;
        quality: string | null;
        addedAt: string | undefined;
        ratings: {
          imdb: number | null;
          tmdb: number | null;
          rottenTomatoes: number | null;
          metacritic: number | null;
        } | null;
      };

      let results: LibraryResult[] = libraryItems.map((li: LibraryRow) => {
        const key = `tmdb-${li.type === MediaType.MOVIE ? "movie" : "tv"}-${li.tmdbId}`;
        const media = mediaMap.get(key);
        const ratings = media?.ratings;
        return {
          tmdbId: li.tmdbId,
          type: li.type.toLowerCase(),
          title: media?.title ?? "Unknown",
          year: media?.year,
          overview: media?.overview,
          genres: media?.genres ?? [],
          runtime: media?.runtime,
          quality: li.quality,
          addedAt: li.addedAt?.toISOString(),
          ratings: ratings
            ? {
                imdb: ratings.imdbScore,
                tmdb: ratings.tmdbScore,
                rottenTomatoes: ratings.rtCriticScore,
                metacritic: ratings.metacriticScore,
              }
            : null,
        };
      });

      // Apply search filter after hydration (since search is on title)
      if (search) {
        const searchLower = search.toLowerCase();
        results = results.filter((item) => item.title.toLowerCase().includes(searchLower));
      }

      const response = {
        server: server.name,
        page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        items: results,
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
