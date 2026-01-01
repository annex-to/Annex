/**
 * Library Metadata Hydration Service
 *
 * Automatically fetches and caches metadata (cover images, ratings, etc.)
 * for all library items from media servers using Trakt.
 *
 * Features:
 * - Rate-limited to respect API limits
 * - Batch processing for efficiency
 * - Prioritizes recently added items
 * - Runs as background job on a schedule
 */

import { MediaType } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getTraktService } from "./trakt.js";

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

    const trakt = getTraktService();

    // Process movies in batches
    if (movieIds.length > 0) {
      console.log(`[LibraryHydration] Processing ${movieIds.length} movies...`);
      const movieResults = await hydrateBatch(trakt, movieIds, "movie");
      processed += movieResults.processed;
      hydrated += movieResults.hydrated;
      failed += movieResults.failed;
      skipped += movieResults.skipped;
    }

    // Process TV shows in batches
    if (tvIds.length > 0) {
      console.log(`[LibraryHydration] Processing ${tvIds.length} TV shows...`);
      const tvResults = await hydrateBatch(trakt, tvIds, "tv");
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
  trakt: ReturnType<typeof getTraktService>,
  tmdbIds: number[],
  type: "movie" | "tv"
): Promise<HydrationResult> {
  let processed = 0;
  let hydrated = 0;
  let failed = 0;
  let skipped = 0;

  // Process items one at a time to respect rate limits
  // Trakt service has built-in rate limiting (4 req/sec)
  for (const tmdbId of tmdbIds) {
    processed++;

    try {
      const success = await hydrateMediaItemFromTrakt(trakt, tmdbId, type);

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
 * Hydrate a single media item from Trakt
 */
async function hydrateMediaItemFromTrakt(
  trakt: ReturnType<typeof getTraktService>,
  tmdbId: number,
  type: "movie" | "tv"
): Promise<boolean> {
  try {
    const data =
      type === "movie" ? await trakt.getMovieDetails(tmdbId) : await trakt.getTvShowDetails(tmdbId);

    if (!data) {
      return false;
    }

    const id = `tmdb-${type}-${tmdbId}`;
    const prismaType = type === "movie" ? MediaType.MOVIE : MediaType.TV;

    // Convert Trakt rating from 0-10 to 0-100 for storage
    const traktScore = data.rating ? Math.round(data.rating * 10) : null;

    await prisma.mediaItem.upsert({
      where: { id },
      create: {
        id,
        tmdbId,
        imdbId: data.ids.imdb || null,
        traktId: data.ids.trakt || null,
        tvdbId: "ids" in data && "tvdb" in data.ids ? data.ids.tvdb || null : null,
        type: prismaType,
        title: data.title,
        year: data.year || null,
        releaseDate:
          type === "movie" && "released" in data
            ? data.released
            : type === "tv" && "first_aired" in data
              ? data.first_aired?.split("T")[0]
              : null,
        overview: data.overview || null,
        tagline: type === "movie" && "tagline" in data ? data.tagline : null,
        genres: data.genres || [],
        certification: data.certification || null,
        runtime: data.runtime || null,
        status: data.status || null,
        language: data.language || null,
        country: data.country || null,
        numberOfSeasons: type === "tv" && "aired_episodes" in data ? null : null, // TV shows need separate season fetch
        numberOfEpisodes: type === "tv" && "aired_episodes" in data ? data.aired_episodes : null,
        networks:
          type === "tv" && "network" in data && data.network ? [{ name: data.network }] : null,
        traktUpdatedAt: new Date(),
        ratings: {
          upsert: {
            create: {
              traktScore,
              traktVotes: data.votes || null,
            },
            update: {
              traktScore,
              traktVotes: data.votes || null,
            },
          },
        },
      },
      update: {
        imdbId: data.ids.imdb || undefined,
        traktId: data.ids.trakt || undefined,
        tvdbId: "ids" in data && "tvdb" in data.ids ? data.ids.tvdb || undefined : undefined,
        title: data.title,
        year: data.year || undefined,
        releaseDate:
          type === "movie" && "released" in data
            ? data.released
            : type === "tv" && "first_aired" in data
              ? data.first_aired?.split("T")[0]
              : undefined,
        overview: data.overview || undefined,
        tagline: type === "movie" && "tagline" in data ? data.tagline : undefined,
        genres: data.genres || [],
        certification: data.certification || undefined,
        runtime: data.runtime || undefined,
        status: data.status || undefined,
        language: data.language || undefined,
        country: data.country || undefined,
        numberOfEpisodes:
          type === "tv" && "aired_episodes" in data ? data.aired_episodes : undefined,
        networks:
          type === "tv" && "network" in data && data.network ? [{ name: data.network }] : undefined,
        traktUpdatedAt: new Date(),
        ratings: {
          upsert: {
            create: {
              traktScore,
              traktVotes: data.votes || null,
            },
            update: {
              traktScore,
              traktVotes: data.votes || undefined,
            },
          },
        },
      },
    });

    return true;
  } catch (error) {
    console.error(`[LibraryHydration] Failed to save Trakt data for ${type} ${tmdbId}:`, error);
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
      WHERE mi."traktUpdatedAt" < ${staleDate}
         OR mi."traktUpdatedAt" IS NULL
      ORDER BY mi."tmdbId", mi.type, mi."traktUpdatedAt" ASC NULLS FIRST
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

    const trakt = getTraktService();

    // Refresh movies
    if (movieIds.length > 0) {
      const movieResults = await hydrateBatch(trakt, movieIds, "movie");
      processed += movieResults.processed;
      hydrated += movieResults.hydrated;
      failed += movieResults.failed;
      skipped += movieResults.skipped;
    }

    // Refresh TV shows
    if (tvIds.length > 0) {
      const tvResults = await hydrateBatch(trakt, tvIds, "tv");
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
