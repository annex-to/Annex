/**
 * Library Metadata Hydration Service
 *
 * Automatically fetches and caches metadata (cover images, ratings, etc.)
 * for all library items from media servers using TMDB.
 *
 * Features:
 * - Rate-limited to respect API limits
 * - Batch processing for efficiency
 * - Prioritizes recently added items
 * - Runs as background job on a schedule
 */

import { MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTMDBService } from "./tmdb.js";

interface HydrationResult {
  processed: number;
  hydrated: number;
  failed: number;
  skipped: number;
}

/**
 * Hydrate library items that don't have MediaItem records
 *
 * @param limit Maximum number of items to process in this run
 * @param priorityServerId Optional server ID to prioritize
 */
export async function hydrateLibraryMetadata(
  limit = 100,
  priorityServerId?: string
): Promise<HydrationResult> {
  console.log(
    `[LibraryHydration] Starting metadata hydration (limit: ${limit}${priorityServerId ? `, priority server: ${priorityServerId}` : ""})`
  );

  const startTime = Date.now();
  let processed = 0;
  let hydrated = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // Find library items without corresponding MediaItem records
    // Prioritize recently added items
    const missingItems = priorityServerId
      ? await prisma.$queryRaw<Array<{ tmdbId: number; type: MediaType }>>`
          SELECT DISTINCT ON (li."tmdbId", li.type) li."tmdbId", li.type
          FROM "LibraryItem" li
          LEFT JOIN "MediaItem" mi ON mi."tmdbId" = li."tmdbId" AND mi.type = li.type
          WHERE mi.id IS NULL
            AND li."serverId" = ${priorityServerId}
          ORDER BY li."tmdbId", li.type, li."addedAt" DESC NULLS LAST, li."syncedAt" DESC
          LIMIT ${limit}
        `
      : await prisma.$queryRaw<Array<{ tmdbId: number; type: MediaType }>>`
          SELECT DISTINCT ON (li."tmdbId", li.type) li."tmdbId", li.type
          FROM "LibraryItem" li
          LEFT JOIN "MediaItem" mi ON mi."tmdbId" = li."tmdbId" AND mi.type = li.type
          WHERE mi.id IS NULL
          ORDER BY li."tmdbId", li.type, li."addedAt" DESC NULLS LAST, li."syncedAt" DESC
          LIMIT ${limit}
        `;

    if (missingItems.length === 0) {
      console.log("[LibraryHydration] No items need hydration");
      return { processed: 0, hydrated: 0, failed: 0, skipped: 0 };
    }

    console.log(`[LibraryHydration] Found ${missingItems.length} items to hydrate`);

    // Group by type for batch processing
    const movieIds = missingItems
      .filter((item: { tmdbId: number; type: MediaType }) => item.type === MediaType.MOVIE)
      .map((item: { tmdbId: number; type: MediaType }) => item.tmdbId);
    const tvIds = missingItems
      .filter((item: { tmdbId: number; type: MediaType }) => item.type === MediaType.TV)
      .map((item: { tmdbId: number; type: MediaType }) => item.tmdbId);

    const tmdb = getTMDBService();

    // Process movies in batches
    if (movieIds.length > 0) {
      console.log(`[LibraryHydration] Processing ${movieIds.length} movies...`);
      const movieResults = await hydrateBatch(tmdb, movieIds, "movie");
      processed += movieResults.processed;
      hydrated += movieResults.hydrated;
      failed += movieResults.failed;
      skipped += movieResults.skipped;
    }

    // Process TV shows in batches
    if (tvIds.length > 0) {
      console.log(`[LibraryHydration] Processing ${tvIds.length} TV shows...`);
      const tvResults = await hydrateBatch(tmdb, tvIds, "tv");
      processed += tvResults.processed;
      hydrated += tvResults.hydrated;
      failed += tvResults.failed;
      skipped += tvResults.skipped;
    }

    const duration = Date.now() - startTime;
    console.log(
      `[LibraryHydration] Completed in ${duration}ms: ${hydrated} hydrated, ${failed} failed, ${skipped} skipped`
    );

    return { processed, hydrated, failed, skipped };
  } catch (error) {
    console.error("[LibraryHydration] Error during hydration:", error);
    return { processed, hydrated, failed, skipped };
  }
}

/**
 * Hydrate a batch of items with rate limiting
 */
async function hydrateBatch(
  tmdb: ReturnType<typeof getTMDBService>,
  tmdbIds: number[],
  type: "movie" | "tv"
): Promise<HydrationResult> {
  let processed = 0;
  let hydrated = 0;
  let failed = 0;
  let skipped = 0;

  // Process items one at a time to respect rate limits
  // TMDB service has built-in rate limiting (10 req/sec)
  for (const tmdbId of tmdbIds) {
    processed++;

    try {
      const success = await hydrateMediaItemFromTMDB(tmdb, tmdbId, type);

      if (success) {
        hydrated++;
        if (hydrated % 10 === 0) {
          console.log(
            `[LibraryHydration] Progress: ${hydrated}/${tmdbIds.length} ${type}s hydrated`
          );
        }
      } else {
        skipped++;
        console.warn(`[LibraryHydration] No data found for ${type} ${tmdbId}`);
      }
    } catch (error) {
      failed++;
      console.error(`[LibraryHydration] Failed to hydrate ${type} ${tmdbId}:`, error);
    }
  }

  return { processed, hydrated, failed, skipped };
}

/**
 * Hydrate a single media item from TMDB
 */
async function hydrateMediaItemFromTMDB(
  tmdb: ReturnType<typeof getTMDBService>,
  tmdbId: number,
  type: "movie" | "tv"
): Promise<boolean> {
  try {
    // Fetch details, videos, and credits in parallel
    const [details, videos, credits] = await Promise.all([
      type === "movie" ? tmdb.getMovieDetails(tmdbId) : tmdb.getTVDetails(tmdbId),
      type === "movie" ? tmdb.getMovieVideos(tmdbId) : tmdb.getTVVideos(tmdbId),
      type === "movie" ? tmdb.getMovieCredits(tmdbId) : tmdb.getTVCredits(tmdbId),
    ]);

    if (!details) {
      return false;
    }

    const id = `tmdb-${type}-${tmdbId}`;
    const prismaType = type === "movie" ? MediaType.MOVIE : MediaType.TV;

    // Extract trailer key
    const trailerKey = tmdb.extractTrailerKey(videos);

    // Extract director (for movies)
    const director =
      type === "movie" ? credits.crew.find((c) => c.job === "Director")?.name || null : null;

    // Convert vote average from 0-10 to 0-100 for storage
    const tmdbScore = details.vote_average ? Math.round(details.vote_average * 10) : null;

    // Extract genre names
    const genres = details.genres.map((g) => g.name);

    // Get primary language
    const language =
      type === "movie"
        ? "original_language" in details
          ? details.original_language
          : null
        : "original_language" in details
          ? details.original_language
          : null;

    // Get primary country
    const country =
      type === "movie"
        ? "production_countries" in details && details.production_countries.length > 0
          ? details.production_countries[0].iso_3166_1
          : null
        : "origin_country" in details && details.origin_country.length > 0
          ? details.origin_country[0]
          : null;

    // Get runtime (movies have single value, TV shows have array)
    const runtime =
      type === "movie"
        ? "runtime" in details
          ? details.runtime
          : null
        : "episode_run_time" in details && details.episode_run_time.length > 0
          ? details.episode_run_time[0]
          : null;

    const mediaItemData = {
      id,
      tmdbId,
      imdbId: type === "movie" && "imdb_id" in details ? details.imdb_id : null,
      type: prismaType,
      title:
        type === "movie"
          ? "title" in details
            ? details.title
            : ""
          : "name" in details
            ? details.name
            : "",
      originalTitle:
        type === "movie"
          ? "original_title" in details
            ? details.original_title
            : null
          : "original_name" in details
            ? details.original_name
            : null,
      year:
        type === "movie"
          ? "release_date" in details && details.release_date
            ? Number.parseInt(details.release_date.split("-")[0], 10)
            : null
          : "first_air_date" in details && details.first_air_date
            ? Number.parseInt(details.first_air_date.split("-")[0], 10)
            : null,
      releaseDate:
        type === "movie"
          ? "release_date" in details
            ? details.release_date
            : null
          : "first_air_date" in details
            ? details.first_air_date
            : null,
      overview: details.overview || null,
      tagline: "tagline" in details ? details.tagline : null,
      runtime,
      status: details.status || null,
      genres,
      language,
      country,
      posterPath: tmdb.getImageUrl(details.poster_path, "w500"),
      backdropPath: tmdb.getImageUrl(details.backdrop_path, "original"),
      numberOfSeasons:
        type === "tv" && "number_of_seasons" in details ? details.number_of_seasons : null,
      numberOfEpisodes:
        type === "tv" && "number_of_episodes" in details ? details.number_of_episodes : null,
      networks:
        type === "tv" && "networks" in details && details.networks.length > 0
          ? details.networks.map((n) => ({ name: n.name }))
          : null,
      videos: trailerKey ? [{ key: trailerKey, type: "Trailer", site: "YouTube" }] : [],
      cast: credits.cast.slice(0, 20).map((c) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        order: c.order,
        profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
      })),
      crew: credits.crew.slice(0, 20).map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
        profilePath: tmdb.getImageUrl(c.profile_path, "w500"),
      })),
      director,
      tmdbUpdatedAt: new Date(),
    };

    await prisma.mediaItem.upsert({
      where: { id },
      create: mediaItemData,
      update: mediaItemData,
    });

    // Save ratings separately (Prisma doesn't support nested upsert)
    if (tmdbScore !== null || details.vote_count) {
      await prisma.mediaRatings.upsert({
        where: { mediaId: id },
        create: {
          mediaId: id,
          tmdbScore,
          tmdbVotes: details.vote_count || null,
        },
        update: {
          tmdbScore,
          tmdbVotes: details.vote_count || undefined,
        },
      });
    }

    return true;
  } catch (error) {
    console.error(`[LibraryHydration] Failed to save TMDB data for ${type} ${tmdbId}:`, error);
    return false;
  }
}

/**
 * Get hydration statistics
 */
export async function getHydrationStats(): Promise<{
  totalLibraryItems: number;
  hydratedItems: number;
  missingItems: number;
  percentComplete: number;
}> {
  // Count total distinct library items
  const totalResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT ("tmdbId", type)) as count
    FROM "LibraryItem"
  `;
  const totalLibraryItems = Number(totalResult[0]?.count || 0);

  // Count items with MediaItem records
  const hydratedResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT (li."tmdbId", li.type)) as count
    FROM "LibraryItem" li
    INNER JOIN "MediaItem" mi ON mi."tmdbId" = li."tmdbId" AND mi.type = li.type
  `;
  const hydratedItems = Number(hydratedResult[0]?.count || 0);

  const missingItems = totalLibraryItems - hydratedItems;
  const percentComplete = totalLibraryItems > 0 ? (hydratedItems / totalLibraryItems) * 100 : 0;

  return {
    totalLibraryItems,
    hydratedItems,
    missingItems,
    percentComplete: Math.round(percentComplete * 10) / 10, // Round to 1 decimal
  };
}

/**
 * Refresh stale metadata for items that haven't been updated recently
 *
 * @param daysStale Number of days since last update to consider stale
 * @param limit Maximum number of items to refresh
 */
export async function refreshStaleMetadata(daysStale = 30, limit = 50): Promise<HydrationResult> {
  console.log(
    `[LibraryHydration] Refreshing metadata older than ${daysStale} days (limit: ${limit})`
  );

  const startTime = Date.now();
  let processed = 0;
  let hydrated = 0;
  let failed = 0;
  let skipped = 0;

  try {
    // Find MediaItems that haven't been updated recently and are in the library
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - daysStale);

    const staleItems = await prisma.$queryRaw<Array<{ tmdbId: number; type: MediaType }>>`
      SELECT DISTINCT ON (mi."tmdbId", mi.type) mi."tmdbId", mi.type
      FROM "MediaItem" mi
      INNER JOIN "LibraryItem" li ON li."tmdbId" = mi."tmdbId" AND li.type = mi.type
      WHERE mi."tmdbUpdatedAt" < ${staleDate}
         OR mi."tmdbUpdatedAt" IS NULL
      ORDER BY mi."tmdbId", mi.type, mi."tmdbUpdatedAt" ASC NULLS FIRST
      LIMIT ${limit}
    `;

    if (staleItems.length === 0) {
      console.log("[LibraryHydration] No stale metadata found");
      return { processed: 0, hydrated: 0, failed: 0, skipped: 0 };
    }

    console.log(`[LibraryHydration] Found ${staleItems.length} stale items to refresh`);

    // Group by type
    const movieIds = staleItems
      .filter((item: { tmdbId: number; type: MediaType }) => item.type === MediaType.MOVIE)
      .map((item: { tmdbId: number; type: MediaType }) => item.tmdbId);
    const tvIds = staleItems
      .filter((item: { tmdbId: number; type: MediaType }) => item.type === MediaType.TV)
      .map((item: { tmdbId: number; type: MediaType }) => item.tmdbId);

    const tmdb = getTMDBService();

    // Refresh movies
    if (movieIds.length > 0) {
      const movieResults = await hydrateBatch(tmdb, movieIds, "movie");
      processed += movieResults.processed;
      hydrated += movieResults.hydrated;
      failed += movieResults.failed;
      skipped += movieResults.skipped;
    }

    // Refresh TV shows
    if (tvIds.length > 0) {
      const tvResults = await hydrateBatch(tmdb, tvIds, "tv");
      processed += tvResults.processed;
      hydrated += tvResults.hydrated;
      failed += tvResults.failed;
      skipped += tvResults.skipped;
    }

    const duration = Date.now() - startTime;
    console.log(
      `[LibraryHydration] Refresh completed in ${duration}ms: ${hydrated} refreshed, ${failed} failed`
    );

    return { processed, hydrated, failed, skipped };
  } catch (error) {
    console.error("[LibraryHydration] Error during refresh:", error);
    return { processed, hydrated, failed, skipped };
  }
}
