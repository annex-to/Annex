/**
 * Media Sync Service
 *
 * Handles synchronization of media data from TMDB exports and MDBList:
 * 1. Downloads TMDB daily export files (contains all movie/show IDs)
 * 2. Queues items for hydration via MDBList batch API
 * 3. Processes hydration queue in background
 * 4. Handles incremental updates via TMDB changes API
 *
 * Progress is stored on the job itself for resume and UI display.
 */

import { createGunzip } from "zlib";
import { Readable } from "stream";
import { prisma } from "../db/client.js";
import { getMDBListService } from "./mdblist.js";
import { getTMDBService } from "./tmdb.js";
import { getConfig } from "../config/index.js";
import { getJobQueueService } from "./jobQueue.js";

const TMDB_EXPORT_BASE = "http://files.tmdb.org/p/exports";

interface TMDBExportItem {
  id: number;
  adult?: boolean;
  original_title?: string;
  original_name?: string;
  popularity: number;
  video?: boolean;
}

export interface SyncProgress {
  type: "movie" | "tv";
  total: number;
  processed: number;
  success: number;
  failed: number;
  startedAt: Date;
  estimatedCompletion?: Date;
}

// Payload structure stored in job (minimal - actual progress is in SyncState table)
interface SyncJobPayload {
  movies?: boolean;
  tvShows?: boolean;
  popularityThreshold?: number;
  maxItems?: number;
}

// Helper to get or create sync state
async function getOrCreateSyncState() {
  let state = await prisma.syncState.findUnique({ where: { id: "default" } });
  if (!state) {
    state = await prisma.syncState.create({ data: { id: "default" } });
  }
  return state;
}

class SyncService {
  private currentProgress: SyncProgress | null = null;

  /**
   * Download and parse TMDB daily export file
   * Returns both the URL used (for resuming) and the parsed items
   */
  async downloadTMDBExport(type: "movie" | "tv", specificUrl?: string): Promise<{ url: string; items: TMDBExportItem[] }> {
    // If a specific URL is provided (for resume), use that
    if (specificUrl) {
      console.log(`Downloading TMDB export from saved URL: ${specificUrl}`);
      const response = await fetch(specificUrl);
      if (!response.ok) {
        throw new Error(`Failed to download TMDB export from saved URL: ${response.status}`);
      }
      return { url: specificUrl, items: await this.parseGzipJsonLines(response) };
    }

    // Otherwise, try today's file, then yesterday's
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    const year = today.getFullYear();

    const filename = type === "movie"
      ? `movie_ids_${month}_${day}_${year}.json.gz`
      : `tv_series_ids_${month}_${day}_${year}.json.gz`;

    const url = `${TMDB_EXPORT_BASE}/${filename}`;

    console.log(`Downloading TMDB export: ${url}`);

    try {
      const response = await fetch(url);
      if (!response.ok) {
        // Try yesterday's file if today's isn't available yet
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yMonth = String(yesterday.getMonth() + 1).padStart(2, "0");
        const yDay = String(yesterday.getDate()).padStart(2, "0");
        const yYear = yesterday.getFullYear();

        const yFilename = type === "movie"
          ? `movie_ids_${yMonth}_${yDay}_${yYear}.json.gz`
          : `tv_series_ids_${yMonth}_${yDay}_${yYear}.json.gz`;

        const yUrl = `${TMDB_EXPORT_BASE}/${yFilename}`;
        console.log(`Today's export not available, trying yesterday: ${yUrl}`);

        const yResponse = await fetch(yUrl);
        if (!yResponse.ok) {
          throw new Error(`Failed to download TMDB export: ${yResponse.status}`);
        }

        return { url: yUrl, items: await this.parseGzipJsonLines(yResponse) };
      }

      return { url, items: await this.parseGzipJsonLines(response) };
    } catch (error) {
      console.error("Failed to download TMDB export:", error);
      throw error;
    }
  }

  /**
   * Parse gzipped JSON lines file
   */
  private async parseGzipJsonLines(response: Response): Promise<TMDBExportItem[]> {
    const items: TMDBExportItem[] = [];
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Decompress gzip
    const gunzip = createGunzip();
    const readable = Readable.from(buffer);

    let data = "";

    return new Promise((resolve, reject) => {
      readable.pipe(gunzip);

      gunzip.on("data", (chunk) => {
        data += chunk.toString();
      });

      gunzip.on("end", () => {
        // Parse JSON lines (each line is a JSON object)
        const lines = data.trim().split("\n");
        for (const line of lines) {
          if (line.trim()) {
            try {
              const item = JSON.parse(line) as TMDBExportItem;
              // Filter out adult content and videos
              if (!item.adult && !item.video) {
                items.push(item);
              }
            } catch {
              // Skip invalid JSON lines
            }
          }
        }
        resolve(items);
      });

      gunzip.on("error", reject);
    });
  }

  /**
   * Get IDs that need to be hydrated (not in DB or stale)
   * Batches queries to avoid PostgreSQL bind variable limits
   */
  async getIdsNeedingHydration(
    tmdbIds: number[],
    type: "movie" | "tv",
    maxAge = 24 * 60 * 60 * 1000 // 24 hours in ms
  ): Promise<number[]> {
    const prismaType = type === "movie" ? "MOVIE" : "TV";
    const cutoffDate = new Date(Date.now() - maxAge);

    // PostgreSQL has a limit of 32767 bind variables
    // Batch queries to stay well under this limit
    const QUERY_BATCH_SIZE = 10000;
    const freshIds = new Set<number>();

    // Query in batches to avoid bind variable limit
    for (let i = 0; i < tmdbIds.length; i += QUERY_BATCH_SIZE) {
      const batch = tmdbIds.slice(i, i + QUERY_BATCH_SIZE);

      const existingFresh = await prisma.mediaItem.findMany({
        where: {
          tmdbId: { in: batch },
          type: prismaType,
          mdblistUpdatedAt: { gte: cutoffDate },
        },
        select: { tmdbId: true },
      });

      for (const item of existingFresh) {
        freshIds.add(item.tmdbId);
      }
    }

    return tmdbIds.filter((id) => !freshIds.has(id));
  }

  /**
   * Full sync: Download all IDs and hydrate everything
   * Progress is saved to SyncState table for crash recovery
   * On resume, skips IDs that were already processed (by tracking last processed ID)
   */
  async fullSync(options: {
    movies?: boolean;
    tvShows?: boolean;
    popularityThreshold?: number;
    maxItems?: number;
    jobId?: string;
    onProgress?: (progress: SyncProgress) => void;
  } = {}): Promise<{ movies: number; tvShows: number; failed: number }> {
    const {
      movies = true,
      tvShows = true,
      popularityThreshold = 0,
      maxItems,
      jobId,
      onProgress,
    } = options;

    const mdblist = getMDBListService();
    const jobQueue = getJobQueueService();
    const config = getConfig();
    const batchSize = config.mdblist.batchSize || 200;

    let totalMovies = 0;
    let totalTvShows = 0;
    let totalFailed = 0;

    // Load sync state for resume capability
    const syncState = await getOrCreateSyncState();

    // Check if this is a resume of the same job
    const isResume = jobId && syncState.mdblistJobId === jobId;

    // Initialize sync state if fresh start
    if (!isResume && jobId) {
      await prisma.syncState.update({
        where: { id: "default" },
        data: {
          mdblistJobId: jobId,
          mdblistMovieExportUrl: null,
          mdblistTvExportUrl: null,
          mdblistLastMovieId: null,
          mdblistLastTvId: null,
          mdblistMovieTotal: null,
          mdblistTvTotal: null,
          mdblistStartedAt: new Date(),
        },
      });
    }

    // Reload state after potential update
    const state = await getOrCreateSyncState();

    // Calculate total items for progress
    let totalItems = 0;
    let processedItems = 0;

    // Process movies
    if (movies) {
      // Download export (using saved URL if resuming)
      const exportUrl = isResume ? state.mdblistMovieExportUrl : null;
      console.log(exportUrl
        ? `Resuming movie sync, re-downloading export...`
        : "Downloading movie export from TMDB...");

      const { url, items: movieExport } = await this.downloadTMDBExport("movie", exportUrl ?? undefined);

      // Sort by ID descending (higher IDs = newer content) and filter by popularity
      let movieIds = movieExport
        .filter((m) => m.popularity >= popularityThreshold)
        .sort((a, b) => b.id - a.id)
        .map((m) => m.id);

      if (maxItems) {
        movieIds = movieIds.slice(0, maxItems);
      }

      // If resuming, skip IDs that were already processed
      // Since we process in descending order, skip all IDs >= lastProcessedId
      const lastMovieId = isResume ? state.mdblistLastMovieId : null;
      let startIdx = 0;
      if (lastMovieId) {
        // Find where to resume - skip all IDs >= lastMovieId
        startIdx = movieIds.findIndex((id) => id < lastMovieId);
        if (startIdx === -1) {
          startIdx = movieIds.length; // All done
        }
        console.log(`Resuming from TMDB ID < ${lastMovieId}, skipping ${startIdx} already processed`);
      }

      console.log(`Found ${movieIds.length} movies to process (starting at index ${startIdx})`);

      // Save URL and total count
      await prisma.syncState.update({
        where: { id: "default" },
        data: {
          mdblistMovieExportUrl: url,
          mdblistMovieTotal: movieIds.length,
        },
      });

      totalItems += movieIds.length;
      processedItems += startIdx;

      // Process in batches
      this.currentProgress = {
        type: "movie",
        total: movieIds.length,
        processed: startIdx,
        success: 0,
        failed: 0,
        startedAt: new Date(),
      };

      // Process multiple batches in parallel for speed
      const parallelBatches = config.mdblist.parallelBatches || 5;
      const superBatchSize = batchSize * parallelBatches;

      for (let i = startIdx; i < movieIds.length; i += superBatchSize) {
        // Check for cancellation
        if (jobId && jobQueue.isCancelled(jobId)) {
          console.log("[Sync] Cancellation requested, stopping movie sync");
          break;
        }

        // Create parallel batches
        const batchPromises: Promise<{ success: number; failed: number; skipped: number }>[] = [];
        const batchEndIdx = Math.min(i + superBatchSize, movieIds.length);

        for (let j = 0; j < parallelBatches && i + j * batchSize < movieIds.length; j++) {
          const batchStart = i + j * batchSize;
          const batch = movieIds.slice(batchStart, Math.min(batchStart + batchSize, movieIds.length));
          const items = batch.map((tmdbId) => ({ tmdbId, type: "movie" as const }));
          batchPromises.push(mdblist.batchHydrateMediaItems(items));
        }

        // Wait for all parallel batches to complete
        const results = await Promise.all(batchPromises);

        // Aggregate results
        let batchSuccess = 0;
        let batchFailed = 0;
        let batchSkipped = 0;
        for (const result of results) {
          batchSuccess += result.success;
          batchFailed += result.failed;
          batchSkipped += result.skipped;
        }

        totalMovies += batchSuccess;
        totalFailed += batchFailed;

        this.currentProgress.processed = batchEndIdx;
        this.currentProgress.success += batchSuccess;
        this.currentProgress.failed += batchFailed;
        processedItems = this.currentProgress.processed;

        // Save progress to database - track last processed ID for resume
        const lastProcessedId = movieIds[batchEndIdx - 1];
        await prisma.syncState.update({
          where: { id: "default" },
          data: { mdblistLastMovieId: lastProcessedId },
        });

        // Update job progress
        if (jobId) {
          const tvTotal = state.mdblistTvTotal ?? 0;
          await jobQueue.updateJobProgress(jobId, processedItems, totalItems + (tvShows ? tvTotal : 0));
        }

        if (onProgress) {
          onProgress({ ...this.currentProgress });
        }

        console.log(
          `Movies: ${this.currentProgress.processed}/${movieIds.length} ` +
          `(${batchSuccess} MDBList, ${batchSkipped} skipped, ${batchFailed} failed)`
        );
      }

      console.log("Movie sync complete");
    }

    // Process TV shows
    if (tvShows) {
      // Download export (using saved URL if resuming)
      const exportUrl = isResume ? state.mdblistTvExportUrl : null;
      console.log(exportUrl
        ? `Resuming TV sync, re-downloading export...`
        : "Downloading TV export from TMDB...");

      const { url, items: tvExport } = await this.downloadTMDBExport("tv", exportUrl ?? undefined);

      // Sort by ID descending (higher IDs = newer content) and filter by popularity
      let tvIds = tvExport
        .filter((t) => t.popularity >= popularityThreshold)
        .sort((a, b) => b.id - a.id)
        .map((t) => t.id);

      if (maxItems) {
        tvIds = tvIds.slice(0, maxItems);
      }

      // If resuming, skip IDs that were already processed
      const lastTvId = isResume ? state.mdblistLastTvId : null;
      let startIdx = 0;
      if (lastTvId) {
        startIdx = tvIds.findIndex((id) => id < lastTvId);
        if (startIdx === -1) {
          startIdx = tvIds.length;
        }
        console.log(`Resuming from TMDB ID < ${lastTvId}, skipping ${startIdx} already processed`);
      }

      console.log(`Found ${tvIds.length} TV shows to process (starting at index ${startIdx})`);

      // Save URL and total count
      await prisma.syncState.update({
        where: { id: "default" },
        data: {
          mdblistTvExportUrl: url,
          mdblistTvTotal: tvIds.length,
        },
      });

      // Update total
      totalItems += tvIds.length;

      // Get movie total for overall progress
      const moviesDone = state.mdblistMovieTotal ?? 0;

      // Process in batches
      this.currentProgress = {
        type: "tv",
        total: tvIds.length,
        processed: startIdx,
        success: 0,
        failed: 0,
        startedAt: new Date(),
      };

      // Process multiple batches in parallel for speed
      const parallelBatches = config.mdblist.parallelBatches || 5;
      const superBatchSize = batchSize * parallelBatches;

      for (let i = startIdx; i < tvIds.length; i += superBatchSize) {
        // Check for cancellation
        if (jobId && jobQueue.isCancelled(jobId)) {
          console.log("[Sync] Cancellation requested, stopping TV sync");
          break;
        }

        // Create parallel batches
        const batchPromises: Promise<{ success: number; failed: number; skipped: number }>[] = [];
        const batchEndIdx = Math.min(i + superBatchSize, tvIds.length);

        for (let j = 0; j < parallelBatches && i + j * batchSize < tvIds.length; j++) {
          const batchStart = i + j * batchSize;
          const batch = tvIds.slice(batchStart, Math.min(batchStart + batchSize, tvIds.length));
          const items = batch.map((tmdbId) => ({ tmdbId, type: "tv" as const }));
          batchPromises.push(mdblist.batchHydrateMediaItems(items));
        }

        // Wait for all parallel batches to complete
        const results = await Promise.all(batchPromises);

        // Aggregate results
        let batchSuccess = 0;
        let batchFailed = 0;
        let batchSkipped = 0;
        for (const result of results) {
          batchSuccess += result.success;
          batchFailed += result.failed;
          batchSkipped += result.skipped;
        }

        totalTvShows += batchSuccess;
        totalFailed += batchFailed;

        this.currentProgress.processed = batchEndIdx;
        this.currentProgress.success += batchSuccess;
        this.currentProgress.failed += batchFailed;
        processedItems = moviesDone + this.currentProgress.processed;

        // Save progress to database - track last processed ID for resume
        const lastProcessedId = tvIds[batchEndIdx - 1];
        await prisma.syncState.update({
          where: { id: "default" },
          data: { mdblistLastTvId: lastProcessedId },
        });

        // Update job progress
        if (jobId) {
          await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
        }

        if (onProgress) {
          onProgress({ ...this.currentProgress });
        }

        console.log(
          `TV Shows: ${this.currentProgress.processed}/${tvIds.length} ` +
          `(${batchSuccess} MDBList, ${batchSkipped} skipped, ${batchFailed} failed)`
        );
      }

      console.log("TV sync complete");
    }

    // Clear sync state on completion
    await prisma.syncState.update({
      where: { id: "default" },
      data: {
        mdblistJobId: null,
        mdblistMovieExportUrl: null,
        mdblistTvExportUrl: null,
        mdblistLastMovieId: null,
        mdblistLastTvId: null,
        mdblistMovieTotal: null,
        mdblistTvTotal: null,
        mdblistStartedAt: null,
      },
    });

    this.currentProgress = null;
    return { movies: totalMovies, tvShows: totalTvShows, failed: totalFailed };
  }

  /**
   * Incremental sync: Only process new/changed items
   */
  async incrementalSync(): Promise<{ updated: number; added: number }> {
    const tmdb = getTMDBService();
    const mdblist = getMDBListService();

    let updated = 0;
    let added = 0;

    // Get changes from TMDB for the last 24 hours
    // Note: TMDB changes API returns items changed in the last 24 hours
    // We'll fetch details for each and hydrate via MDBList

    try {
      // Get movie changes
      const movieChanges = await tmdb.getChanges("movie");
      if (movieChanges.length > 0) {
        const items = movieChanges.map((id) => ({ tmdbId: id, type: "movie" as const }));
        const result = await mdblist.batchHydrateMediaItems(items);
        updated += result.success;
      }

      // Get TV changes
      const tvChanges = await tmdb.getChanges("tv");
      if (tvChanges.length > 0) {
        const items = tvChanges.map((id) => ({ tmdbId: id, type: "tv" as const }));
        const result = await mdblist.batchHydrateMediaItems(items);
        updated += result.success;
      }
    } catch (error) {
      console.error("Incremental sync failed:", error);
    }

    return { updated, added };
  }

  /**
   * Refresh stale items in the database
   * Processes by tmdbId descending (higher IDs = newer content)
   */
  async refreshStaleItems(limit = 1000): Promise<number> {
    const mdblist = getMDBListService();
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

    // Find stale items, ordered by tmdbId desc (higher IDs = newer content)
    const staleItems = await prisma.mediaItem.findMany({
      where: {
        OR: [
          { mdblistUpdatedAt: null },
          { mdblistUpdatedAt: { lt: cutoffDate } },
        ],
      },
      select: { tmdbId: true, type: true },
      take: limit,
      orderBy: { tmdbId: "desc" },
    });

    if (staleItems.length === 0) {
      return 0;
    }

    const items = staleItems.map((item) => ({
      tmdbId: item.tmdbId,
      type: item.type === "MOVIE" ? "movie" as const : "tv" as const,
    }));

    const result = await mdblist.batchHydrateMediaItems(items);
    return result.success;
  }

  /**
   * Full TMDB sync: Hydrates all media items in the database with full TMDB details
   * Processes from newest to oldest (highest tmdbId first)
   * This is for filling in cast, crew, videos, etc. for items that only have basic info
   * Progress is saved to SyncState table for crash recovery
   */
  async fullTMDBSync(options: {
    movies?: boolean;
    tvShows?: boolean;
    popularityThreshold?: number;
    maxItems?: number;
    includeSeasons?: boolean;
    jobId?: string;
    onProgress?: (progress: SyncProgress) => void;
  } = {}): Promise<{ movies: number; tvShows: number; failed: number }> {
    const {
      movies = true,
      tvShows = true,
      maxItems,
      includeSeasons = false,
      jobId,
      onProgress,
    } = options;

    const tmdb = getTMDBService();
    const jobQueue = getJobQueueService();
    const BATCH_SIZE = 50;

    let totalMovies = 0;
    let totalTvShows = 0;
    let totalFailed = 0;
    let totalItems = 0;
    let processedItems = 0;

    // Load sync state for resume capability
    const syncState = await getOrCreateSyncState();

    // Check if this is a resume of the same job
    const isResume = jobId && syncState.tmdbJobId === jobId;

    // Initialize sync state if fresh start
    if (!isResume && jobId) {
      await prisma.syncState.update({
        where: { id: "default" },
        data: {
          tmdbJobId: jobId,
          tmdbLastMovieId: null,
          tmdbLastTvId: null,
          tmdbMovieTotal: null,
          tmdbTvTotal: null,
          tmdbStartedAt: new Date(),
        },
      });
    }

    // Reload state after potential update
    const state = await getOrCreateSyncState();

    // Count items that need TMDB hydration (no tmdbUpdatedAt)
    const [movieCount, tvCount] = await Promise.all([
      movies ? prisma.mediaItem.count({
        where: {
          type: "MOVIE",
          tmdbUpdatedAt: null,
        },
      }) : 0,
      tvShows ? prisma.mediaItem.count({
        where: {
          type: "TV",
          tmdbUpdatedAt: null,
        },
      }) : 0,
    ]);

    // Save totals to state
    await prisma.syncState.update({
      where: { id: "default" },
      data: {
        tmdbMovieTotal: movieCount,
        tmdbTvTotal: tvCount,
      },
    });

    totalItems = (maxItems ? Math.min(movieCount + tvCount, maxItems) : movieCount + tvCount);
    console.log(`[TMDB Sync] Found ${movieCount} movies and ${tvCount} TV shows needing hydration`);

    if (jobId) {
      await jobQueue.updateJobProgress(jobId, 0, totalItems);
    }

    // Process movies first
    if (movies && movieCount > 0) {
      // Get all movie IDs that need hydration, sorted by tmdbId desc
      const allMovieIds = await prisma.mediaItem.findMany({
        where: {
          type: "MOVIE",
          tmdbUpdatedAt: null,
        },
        select: { tmdbId: true },
        orderBy: { tmdbId: "desc" },
        take: maxItems,
      });

      const movieIds = allMovieIds.map(m => m.tmdbId);

      // If resuming, skip IDs that were already processed (we process in descending order)
      const lastMovieId = isResume ? state.tmdbLastMovieId : null;
      let startIdx = 0;
      if (lastMovieId) {
        // Find where to resume - skip all IDs >= lastMovieId (already processed)
        startIdx = movieIds.findIndex((id) => id < lastMovieId);
        if (startIdx === -1) {
          startIdx = movieIds.length; // All done
        }
        console.log(`[TMDB Sync] Resuming from TMDB ID < ${lastMovieId}, skipping ${startIdx} already processed`);
      }

      const moviesToProcess = movieIds.length;

      this.currentProgress = {
        type: "movie",
        total: moviesToProcess,
        processed: startIdx,
        success: 0,
        failed: 0,
        startedAt: new Date(),
      };

      processedItems = startIdx;

      // Process in batches
      for (let i = startIdx; i < moviesToProcess; i += BATCH_SIZE) {
        // Check for cancellation
        if (jobId && jobQueue.isCancelled(jobId)) {
          console.log("[TMDB Sync] Cancellation requested, stopping movie sync");
          break;
        }

        const batchEndIdx = Math.min(i + BATCH_SIZE, moviesToProcess);
        const batch = movieIds.slice(i, batchEndIdx);

        // Hydrate each movie in the batch
        for (const tmdbId of batch) {
          // Check for cancellation inside inner loop too
          if (jobId && jobQueue.isCancelled(jobId)) {
            break;
          }

          const success = await tmdb.hydrateMovie(tmdbId);
          if (success) {
            totalMovies++;
            this.currentProgress.success++;
          } else {
            totalFailed++;
            this.currentProgress.failed++;
          }
          this.currentProgress.processed++;
          processedItems++;

          // Update job progress every 10 items
          if (jobId && processedItems % 10 === 0) {
            await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
          }
        }

        // Save progress to database - track last processed ID for resume
        const lastProcessedId = movieIds[batchEndIdx - 1];
        await prisma.syncState.update({
          where: { id: "default" },
          data: { tmdbLastMovieId: lastProcessedId },
        });

        if (onProgress) {
          onProgress({ ...this.currentProgress });
        }

        console.log(
          `[TMDB Sync] Movies: ${this.currentProgress.processed}/${moviesToProcess} ` +
          `(${this.currentProgress.success} success, ${this.currentProgress.failed} failed)`
        );
      }

      console.log("[TMDB Sync] Movie hydration complete");
    }

    // Process TV shows
    if (tvShows && tvCount > 0) {
      const moviesProcessed = processedItems;
      const tvLimit = maxItems ? Math.max(0, maxItems - moviesProcessed) : undefined;

      if (tvLimit === 0) {
        console.log("[TMDB Sync] No TV shows to process (maxItems reached)");
      } else {
        // Get all TV IDs that need hydration, sorted by tmdbId desc
        const allTvIds = await prisma.mediaItem.findMany({
          where: {
            type: "TV",
            tmdbUpdatedAt: null,
          },
          select: { tmdbId: true },
          orderBy: { tmdbId: "desc" },
          ...(tvLimit ? { take: tvLimit } : {}),
        });

        const tvIds = allTvIds.map(t => t.tmdbId);

        // If resuming, skip IDs that were already processed
        const lastTvId = isResume ? state.tmdbLastTvId : null;
        let startIdx = 0;
        if (lastTvId) {
          startIdx = tvIds.findIndex((id) => id < lastTvId);
          if (startIdx === -1) {
            startIdx = tvIds.length; // All done
          }
          console.log(`[TMDB Sync] Resuming from TMDB ID < ${lastTvId}, skipping ${startIdx} already processed`);
        }

        const tvToProcess = tvIds.length;

        this.currentProgress = {
          type: "tv",
          total: tvToProcess,
          processed: startIdx,
          success: 0,
          failed: 0,
          startedAt: new Date(),
        };

        // Process in batches
        for (let i = startIdx; i < tvToProcess; i += BATCH_SIZE) {
          // Check for cancellation
          if (jobId && jobQueue.isCancelled(jobId)) {
            console.log("[TMDB Sync] Cancellation requested, stopping TV sync");
            break;
          }

          const batchEndIdx = Math.min(i + BATCH_SIZE, tvToProcess);
          const batch = tvIds.slice(i, batchEndIdx);

          // Hydrate each TV show in the batch
          for (const tmdbId of batch) {
            // Check for cancellation inside inner loop too
            if (jobId && jobQueue.isCancelled(jobId)) {
              break;
            }

            const success = await tmdb.hydrateTvShow(tmdbId, includeSeasons);
            if (success) {
              totalTvShows++;
              this.currentProgress.success++;
            } else {
              totalFailed++;
              this.currentProgress.failed++;
            }
            this.currentProgress.processed++;
            processedItems++;

            // Update job progress every 10 items
            if (jobId && processedItems % 10 === 0) {
              await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
            }
          }

          // Save progress to database - track last processed ID for resume
          const lastProcessedId = tvIds[batchEndIdx - 1];
          await prisma.syncState.update({
            where: { id: "default" },
            data: { tmdbLastTvId: lastProcessedId },
          });

          if (onProgress) {
            onProgress({ ...this.currentProgress });
          }

          console.log(
            `[TMDB Sync] TV Shows: ${this.currentProgress.processed}/${tvToProcess} ` +
            `(${this.currentProgress.success} success, ${this.currentProgress.failed} failed)`
          );
        }

        console.log("[TMDB Sync] TV show hydration complete");
      }
    }

    // Clear sync state on completion
    await prisma.syncState.update({
      where: { id: "default" },
      data: {
        tmdbJobId: null,
        tmdbLastMovieId: null,
        tmdbLastTvId: null,
        tmdbMovieTotal: null,
        tmdbTvTotal: null,
        tmdbStartedAt: null,
      },
    });

    // Final progress update
    if (jobId) {
      await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
    }

    this.currentProgress = null;
    return { movies: totalMovies, tvShows: totalTvShows, failed: totalFailed };
  }

  /**
   * Refresh items that are missing TMDB details
   * Processes by tmdbId descending (higher IDs = newer content)
   */
  async refreshMissingTMDBDetails(limit = 1000): Promise<number> {
    const tmdb = getTMDBService();

    // Find items without full TMDB details, ordered by tmdbId desc
    const items = await prisma.mediaItem.findMany({
      where: {
        tmdbUpdatedAt: null,
      },
      select: { tmdbId: true, type: true },
      take: limit,
      orderBy: { tmdbId: "desc" },
    });

    if (items.length === 0) {
      return 0;
    }

    let success = 0;
    for (const item of items) {
      const result = item.type === "MOVIE"
        ? await tmdb.hydrateMovie(item.tmdbId)
        : await tmdb.hydrateTvShow(item.tmdbId, false);
      if (result) success++;
    }

    return success;
  }

  /**
   * Sync items missing MDBList data using TMDB as the data source
   * This runs separately from MDBList sync at TMDB's rate limit (20 req/sec)
   * Targets items that were skipped/not found during MDBList sync
   */
  async syncMissingFromTMDB(options: {
    movies?: boolean;
    tvShows?: boolean;
    limit?: number;
    jobId?: string;
    onProgress?: (progress: SyncProgress) => void;
  } = {}): Promise<{ movies: number; tvShows: number; failed: number }> {
    const {
      movies = true,
      tvShows = true,
      limit = 10000,
      jobId,
      onProgress,
    } = options;

    const tmdb = getTMDBService();
    const jobQueue = getJobQueueService();
    const BATCH_SIZE = 50; // Process 50 at a time for progress updates

    let totalMovies = 0;
    let totalTvShows = 0;
    let totalFailed = 0;
    let totalItems = 0;
    let processedItems = 0;

    // Count items that need TMDB data (have mdblistUpdatedAt = null, meaning MDBList didn't find them)
    const [movieCount, tvCount] = await Promise.all([
      movies ? prisma.mediaItem.count({
        where: {
          type: "MOVIE",
          mdblistUpdatedAt: null,
        },
      }) : 0,
      tvShows ? prisma.mediaItem.count({
        where: {
          type: "TV",
          mdblistUpdatedAt: null,
        },
      }) : 0,
    ]);

    totalItems = Math.min(movieCount + tvCount, limit);
    console.log(`[TMDB Fallback Sync] Found ${movieCount} movies and ${tvCount} TV shows missing MDBList data`);

    if (totalItems === 0) {
      console.log("[TMDB Fallback Sync] No items need syncing");
      return { movies: 0, tvShows: 0, failed: 0 };
    }

    if (jobId) {
      await jobQueue.updateJobProgress(jobId, 0, totalItems);
    }

    // Process movies first
    if (movies && movieCount > 0) {
      let movieOffset = 0;
      const moviesToProcess = Math.min(movieCount, limit);

      this.currentProgress = {
        type: "movie",
        total: moviesToProcess,
        processed: 0,
        success: 0,
        failed: 0,
        startedAt: new Date(),
      };

      while (movieOffset < moviesToProcess) {
        // Check for cancellation
        if (jobId && jobQueue.isCancelled(jobId)) {
          console.log("[TMDB Fallback Sync] Cancellation requested, stopping movie sync");
          break;
        }

        const batchLimit = Math.min(BATCH_SIZE, moviesToProcess - movieOffset);

        // Get batch of movies without MDBList data, ordered by tmdbId desc
        const movieBatch = await prisma.mediaItem.findMany({
          where: {
            type: "MOVIE",
            mdblistUpdatedAt: null,
          },
          select: { tmdbId: true },
          orderBy: { tmdbId: "desc" },
          skip: movieOffset,
          take: batchLimit,
        });

        if (movieBatch.length === 0) break;

        // Use batch hydration to populate from TMDB
        const items = movieBatch.map(m => ({ tmdbId: m.tmdbId, type: "movie" as const }));
        const result = await tmdb.batchHydrate(items, { includeSeasons: false });

        totalMovies += result.success;
        totalFailed += result.failed;
        this.currentProgress.success += result.success;
        this.currentProgress.failed += result.failed;
        this.currentProgress.processed += movieBatch.length;
        processedItems += movieBatch.length;

        // Update job progress
        if (jobId) {
          await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
        }

        if (onProgress) {
          onProgress({ ...this.currentProgress });
        }

        console.log(
          `[TMDB Fallback Sync] Movies: ${this.currentProgress.processed}/${moviesToProcess} ` +
          `(${this.currentProgress.success} success, ${this.currentProgress.failed} failed)`
        );

        movieOffset += movieBatch.length;
      }

      console.log("[TMDB Fallback Sync] Movie sync complete");
    }

    // Process TV shows
    if (tvShows && tvCount > 0) {
      const moviesProcessed = processedItems;
      let tvOffset = 0;
      const tvToProcess = Math.min(tvCount, limit - moviesProcessed);

      if (tvToProcess <= 0) {
        console.log("[TMDB Fallback Sync] No TV shows to process (limit reached)");
      } else {
        this.currentProgress = {
          type: "tv",
          total: tvToProcess,
          processed: 0,
          success: 0,
          failed: 0,
          startedAt: new Date(),
        };

        while (tvOffset < tvToProcess) {
          // Check for cancellation
          if (jobId && jobQueue.isCancelled(jobId)) {
            console.log("[TMDB Fallback Sync] Cancellation requested, stopping TV sync");
            break;
          }

          const batchLimit = Math.min(BATCH_SIZE, tvToProcess - tvOffset);

          // Get batch of TV shows without MDBList data
          const tvBatch = await prisma.mediaItem.findMany({
            where: {
              type: "TV",
              mdblistUpdatedAt: null,
            },
            select: { tmdbId: true },
            orderBy: { tmdbId: "desc" },
            skip: tvOffset,
            take: batchLimit,
          });

          if (tvBatch.length === 0) break;

          // Use batch hydration to populate from TMDB
          const items = tvBatch.map(s => ({ tmdbId: s.tmdbId, type: "tv" as const }));
          const result = await tmdb.batchHydrate(items, { includeSeasons: false });

          totalTvShows += result.success;
          totalFailed += result.failed;
          this.currentProgress.success += result.success;
          this.currentProgress.failed += result.failed;
          this.currentProgress.processed += tvBatch.length;
          processedItems += tvBatch.length;

          // Update job progress
          if (jobId) {
            await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
          }

          if (onProgress) {
            onProgress({ ...this.currentProgress });
          }

          console.log(
            `[TMDB Fallback Sync] TV Shows: ${this.currentProgress.processed}/${tvToProcess} ` +
            `(${this.currentProgress.success} success, ${this.currentProgress.failed} failed)`
          );

          tvOffset += tvBatch.length;
        }

        console.log("[TMDB Fallback Sync] TV show sync complete");
      }
    }

    // Final progress update
    if (jobId) {
      await jobQueue.updateJobProgress(jobId, processedItems, totalItems);
    }

    this.currentProgress = null;
    return { movies: totalMovies, tvShows: totalTvShows, failed: totalFailed };
  }

  /**
   * Get current sync progress
   */
  getProgress(): SyncProgress | null {
    return this.currentProgress;
  }

  /**
   * Get sync statistics
   */
  async getStats(): Promise<{
    totalMovies: number;
    totalTvShows: number;
    freshItems: number;
    staleItems: number;
    neverSynced: number;
    // TMDB hydration stats
    tmdbHydrated: number;
    tmdbNotHydrated: number;
  }> {
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      totalMovies,
      totalTvShows,
      freshItems,
      staleItems,
      neverSynced,
      tmdbHydrated,
      tmdbNotHydrated,
    ] = await Promise.all([
      prisma.mediaItem.count({ where: { type: "MOVIE" } }),
      prisma.mediaItem.count({ where: { type: "TV" } }),
      prisma.mediaItem.count({ where: { mdblistUpdatedAt: { gte: cutoffDate } } }),
      prisma.mediaItem.count({
        where: {
          mdblistUpdatedAt: { lt: cutoffDate },
          NOT: { mdblistUpdatedAt: null },
        },
      }),
      prisma.mediaItem.count({ where: { mdblistUpdatedAt: null } }),
      prisma.mediaItem.count({ where: { tmdbUpdatedAt: { not: null } } }),
      prisma.mediaItem.count({ where: { tmdbUpdatedAt: null } }),
    ]);

    return {
      totalMovies,
      totalTvShows,
      freshItems,
      staleItems,
      neverSynced,
      tmdbHydrated,
      tmdbNotHydrated,
    };
  }
}

// Singleton instance
let syncService: SyncService | null = null;

export function getSyncService(): SyncService {
  if (!syncService) {
    syncService = new SyncService();
  }
  return syncService;
}

export { SyncService };
