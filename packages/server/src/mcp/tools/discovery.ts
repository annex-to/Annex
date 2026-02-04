import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Episode, Season } from "@prisma/client";
import { MediaType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../db/client.js";
import type { TraktDiscoverItem, TraktFilterParams } from "../../services/trakt.js";
import { getTraktService } from "../../services/trakt.js";

type SeasonWithEpisodes = Season & { episodes: Episode[] };

function formatItem(item: TraktDiscoverItem) {
  return {
    tmdbId: item.tmdbId,
    type: item.type,
    title: item.title,
    year: item.year,
    posterUrl: item.posterUrl,
    fanartUrl: item.fanartUrl,
    ...(item.statValue != null && { [item.statLabel ?? "stat"]: item.statValue }),
  };
}

export function registerDiscoveryTools(server: McpServer) {
  server.tool(
    "search_media",
    "Search for movies or TV shows by title via Trakt. Returns results from the full Trakt catalog with tmdbId for use with create_request.",
    {
      query: z.string().describe("Search query (title)"),
      type: z.enum(["movie", "tv"]).describe("Media type"),
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(50).default(20).describe("Items per page"),
    },
    async ({ query, type, page = 1, limit = 20 }) => {
      const trakt = getTraktService();
      const items = await trakt.search(query, type, page, limit);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ query, type, page, items: items.map(formatItem) }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "discover_media",
    "Browse movies or TV shows from the full Trakt catalog. Supports list types (trending, popular, favorited, played, watched, collected), genre/year/rating filters, and server exclusion to find media not already in your library.",
    {
      type: z.enum(["movie", "tv"]).describe("Media type"),
      listType: z
        .enum(["trending", "popular", "favorited", "played", "watched", "collected"])
        .default("popular")
        .describe("Trakt list type"),
      period: z
        .enum(["daily", "weekly", "monthly", "yearly", "all"])
        .optional()
        .describe("Time period (for played/watched/collected lists)"),
      genres: z
        .array(z.string())
        .optional()
        .describe("Filter by Trakt genre slugs (e.g. ['action', 'comedy'])"),
      yearMin: z.number().optional().describe("Minimum release year"),
      yearMax: z.number().optional().describe("Maximum release year"),
      ratingMin: z.number().optional().describe("Minimum IMDB rating on 0-10 scale (e.g. 6.5)"),
      language: z.string().optional().describe("Original language (ISO 639-1, e.g. 'en')"),
      certification: z.string().optional().describe("Content rating (e.g. 'pg-13', 'r')"),
      page: z.number().min(1).default(1).describe("Page number"),
      limit: z.number().min(1).max(50).default(20).describe("Items per page"),
      excludeServerIds: z
        .array(z.string())
        .optional()
        .describe("Exclude media already in these servers' libraries"),
    },
    async ({
      type,
      listType = "popular",
      period,
      genres,
      yearMin,
      yearMax,
      ratingMin,
      language,
      certification,
      page = 1,
      limit = 20,
      excludeServerIds,
    }) => {
      const filters: TraktFilterParams = {};
      if (genres && genres.length > 0) {
        filters.genres = genres.join(",");
      }
      if (yearMin || yearMax) {
        filters.years = `${yearMin ?? 1900}-${yearMax ?? new Date().getFullYear()}`;
      }
      if (ratingMin) {
        const min = Math.round(ratingMin * 10);
        filters.imdb_ratings = `${min}-100`;
      }
      if (language) {
        filters.languages = language;
      }
      if (certification) {
        filters.certifications = certification;
      }

      // Build exclusion set from server libraries
      let excludeTmdbIds = new Set<number>();
      if (excludeServerIds && excludeServerIds.length > 0) {
        const mediaType = type === "movie" ? MediaType.MOVIE : MediaType.TV;
        const libraryItems = await prisma.libraryItem.findMany({
          where: { serverId: { in: excludeServerIds }, type: mediaType },
          select: { tmdbId: true },
          distinct: ["tmdbId"],
        });
        excludeTmdbIds = new Set(libraryItems.map((li: { tmdbId: number }) => li.tmdbId));
      }

      // Fetch from Trakt with over-fetch to compensate for exclusions
      const fetchLimit =
        excludeTmdbIds.size > 0 ? limit + Math.min(excludeTmdbIds.size, 50) : limit;
      const trakt = getTraktService();
      const raw = await trakt.getList(
        listType,
        type,
        page,
        fetchLimit,
        period ?? "weekly",
        filters
      );

      // Filter out excluded items
      let items =
        excludeTmdbIds.size > 0
          ? raw.filter((item: TraktDiscoverItem) => !excludeTmdbIds.has(item.tmdbId))
          : raw;
      items = items.slice(0, limit);

      const response = {
        type,
        listType,
        page,
        itemCount: items.length,
        excludedFromServers: excludeServerIds ?? [],
        excludedCount: excludeTmdbIds.size,
        items: items.map(formatItem),
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
              text: "Media item not found in database. Use search_media or discover_media to find items first.",
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
