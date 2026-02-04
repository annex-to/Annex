import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Episode, MediaItem, MediaRatings, Season } from "@prisma/client";
import { MediaType, type Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";

type MediaWithRatings = MediaItem & { ratings: MediaRatings | null };
type SeasonWithEpisodes = Season & { episodes: Episode[] };

function formatRatings(ratings: MediaRatings | null) {
  if (!ratings) return null;
  return {
    imdb: ratings.imdbScore,
    tmdb: ratings.tmdbScore,
    rottenTomatoes: ratings.rtCriticScore,
    metacritic: ratings.metacriticScore,
  };
}

export function registerDiscoveryTools(server: McpServer) {
  server.tool(
    "search_media",
    "Search for media by title. Returns matching movies/TV shows with their tmdbId, which is needed for creating requests.",
    {
      query: z.string().describe("Search query (title)"),
      type: z.enum(["movie", "tv"]).optional().describe("Filter by media type"),
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(50).default(20).describe("Items per page"),
    },
    async ({ query, type, page = 1, limit = 20 }) => {
      const where: Record<string, unknown> = {
        title: { contains: query, mode: "insensitive" },
      };
      if (type) {
        where.type = type === "movie" ? MediaType.MOVIE : MediaType.TV;
      }

      const [items, totalCount]: [MediaWithRatings[], number] = await Promise.all([
        prisma.mediaItem.findMany({
          where,
          include: { ratings: true },
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        prisma.mediaItem.count({ where }),
      ]);

      const results = items.map((m: MediaWithRatings) => ({
        tmdbId: m.tmdbId,
        type: m.type.toLowerCase(),
        title: m.title,
        year: m.year,
        overview: m.overview,
        genres: m.genres,
        runtime: m.runtime,
        posterPath: m.posterPath,
        ratings: formatRatings(m.ratings),
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query,
                page,
                totalPages: Math.ceil(totalCount / limit),
                totalItems: totalCount,
                items: results,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "discover_media",
    "Browse and filter media from the database. Use excludeServerIds to filter out media already in a server's library. Good for finding recommendations.",
    {
      type: z.enum(["movie", "tv"]).describe("Media type to discover"),
      genres: z
        .array(z.string())
        .optional()
        .describe("Filter by genres (e.g. ['Action', 'Comedy'])"),
      yearMin: z.number().optional().describe("Minimum release year"),
      yearMax: z.number().optional().describe("Maximum release year"),
      ratingMin: z.number().optional().describe("Minimum IMDB rating on 0-10 scale (e.g. 6.5)"),
      language: z.string().optional().describe("Original language (ISO 639-1, e.g. 'en')"),
      certification: z.string().optional().describe("Content rating (e.g. 'PG-13', 'R')"),
      sortBy: z
        .enum(["rating", "year", "title", "popularity"])
        .default("rating")
        .describe("Sort field"),
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(50).default(20).describe("Items per page"),
      excludeServerIds: z
        .array(z.string())
        .optional()
        .describe("Exclude media already in these servers' libraries"),
    },
    async ({
      type,
      genres,
      yearMin,
      yearMax,
      ratingMin,
      language,
      certification,
      sortBy = "rating",
      page = 1,
      limit = 20,
      excludeServerIds,
    }) => {
      const mediaType = type === "movie" ? MediaType.MOVIE : MediaType.TV;

      const conditions: Prisma.MediaItemWhereInput[] = [{ type: mediaType }];

      if (genres && genres.length > 0) {
        conditions.push({ genres: { hasSome: genres } });
      }
      if (yearMin) {
        conditions.push({ year: { gte: yearMin } });
      }
      if (yearMax) {
        conditions.push({ year: { lte: yearMax } });
      }
      if (language) {
        conditions.push({ language });
      }
      if (certification) {
        conditions.push({ certification });
      }

      let excludeTmdbIds: number[] = [];
      if (excludeServerIds && excludeServerIds.length > 0) {
        const libraryItems = await prisma.libraryItem.findMany({
          where: {
            serverId: { in: excludeServerIds },
            type: mediaType,
          },
          select: { tmdbId: true },
          distinct: ["tmdbId"],
        });
        excludeTmdbIds = libraryItems.map((li: { tmdbId: number }) => li.tmdbId);
        if (excludeTmdbIds.length > 0) {
          conditions.push({ tmdbId: { notIn: excludeTmdbIds } });
        }
      }

      if (ratingMin) {
        const scaledMin = ratingMin <= 10 ? ratingMin * 10 : ratingMin;
        conditions.push({
          ratings: { imdbScore: { gte: scaledMin } },
        });
      }

      const where: Prisma.MediaItemWhereInput = { AND: conditions };

      let orderBy: Prisma.MediaItemOrderByWithRelationInput;
      switch (sortBy) {
        case "rating":
          orderBy = { ratings: { imdbScore: { sort: "desc", nulls: "last" } } };
          break;
        case "year":
          orderBy = { year: { sort: "desc", nulls: "last" } };
          break;
        case "title":
          orderBy = { title: "asc" };
          break;
        case "popularity":
          orderBy = { ratings: { tmdbPopularity: { sort: "desc", nulls: "last" } } };
          break;
        default:
          orderBy = { ratings: { imdbScore: { sort: "desc", nulls: "last" } } };
      }

      const [items, totalCount]: [MediaWithRatings[], number] = await Promise.all([
        prisma.mediaItem.findMany({
          where,
          include: { ratings: true },
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.mediaItem.count({ where }),
      ]);

      const results = items.map((m: MediaWithRatings) => ({
        tmdbId: m.tmdbId,
        type: m.type.toLowerCase(),
        title: m.title,
        year: m.year,
        overview: m.overview,
        genres: m.genres,
        runtime: m.runtime,
        language: m.language,
        certification: m.certification,
        posterPath: m.posterPath,
        ratings: m.ratings
          ? {
              ...formatRatings(m.ratings),
              letterboxd: m.ratings.letterboxdScore,
            }
          : null,
      }));

      const response = {
        type,
        page,
        totalPages: Math.ceil(totalCount / limit),
        totalItems: totalCount,
        excludedFromServers: excludeServerIds ?? [],
        excludedCount: excludeTmdbIds.length,
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

  server.tool(
    "get_media_details",
    "Get full details for a specific media item including all ratings, cast, crew, and videos/trailers. For TV shows, includes season/episode information.",
    {
      tmdbId: z.number().describe("TMDB ID of the media item"),
      type: z.enum(["movie", "tv"]).describe("Media type"),
    },
    async ({ tmdbId, type }) => {
      const id = `tmdb-${type}-${tmdbId}`;

      const item = await prisma.mediaItem.findUnique({
        where: { id },
        include: {
          ratings: true,
          seasons: {
            include: {
              episodes: {
                orderBy: { episodeNumber: "asc" },
              },
            },
            orderBy: { seasonNumber: "asc" },
          },
        },
      });

      if (!item) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Media item not found in database",
            },
          ],
          isError: true,
        };
      }

      const result: Record<string, unknown> = {
        tmdbId: item.tmdbId,
        imdbId: item.imdbId,
        type: item.type.toLowerCase(),
        title: item.title,
        originalTitle: item.originalTitle,
        year: item.year,
        releaseDate: item.releaseDate,
        overview: item.overview,
        tagline: item.tagline,
        genres: item.genres,
        certification: item.certification,
        runtime: item.runtime,
        status: item.status,
        language: item.language,
        director: item.director,
        posterPath: item.posterPath,
        backdropPath: item.backdropPath,
        ratings: item.ratings
          ? {
              imdb: { score: item.ratings.imdbScore, votes: item.ratings.imdbVotes },
              tmdb: { score: item.ratings.tmdbScore, votes: item.ratings.tmdbVotes },
              rottenTomatoes: {
                critics: item.ratings.rtCriticScore,
                audience: item.ratings.rtAudienceScore,
              },
              metacritic: {
                score: item.ratings.metacriticScore,
                userScore: item.ratings.metacriticUserScore,
              },
              letterboxd: item.ratings.letterboxdScore,
              trakt: { score: item.ratings.traktScore, votes: item.ratings.traktVotes },
              mdblist: { score: item.ratings.mdblistScore, rank: item.ratings.mdblistRank },
            }
          : null,
        cast: item.cast
          ? (item.cast as Array<Record<string, unknown>>).slice(0, 10).map((c) => ({
              name: c.name,
              character: c.character,
            }))
          : [],
        videos: item.videos
          ? (item.videos as Array<Record<string, unknown>>)
              .filter((v) => v.site === "YouTube" && v.type === "Trailer")
              .slice(0, 3)
              .map((v) => ({
                name: v.name,
                key: v.key,
                url: `https://youtube.com/watch?v=${v.key}`,
              }))
          : [],
      };

      if (item.type === MediaType.TV) {
        result.numberOfSeasons = item.numberOfSeasons;
        result.numberOfEpisodes = item.numberOfEpisodes;
        result.createdBy = item.createdBy;
        result.seasons = (item.seasons as SeasonWithEpisodes[]).map((s: SeasonWithEpisodes) => ({
          seasonNumber: s.seasonNumber,
          name: s.name,
          episodeCount: s.episodes.length,
          airDate: s.airDate,
          episodes: s.episodes.map((e: Episode) => ({
            episodeNumber: e.episodeNumber,
            name: e.name,
            airDate: e.airDate,
            runtime: e.runtime,
          })),
        }));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
