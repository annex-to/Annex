/**
 * Job Queue Service
 *
 * Simple in-memory job queue for a single-threaded server.
 * Database is only used for persistence/crash recovery.
 */

import { prisma } from "../db/client.js";
import { getConfig } from "../config/index.js";
import { getMDBListService } from "./mdblist.js";
import { getSyncService } from "./sync.js";
import { getTMDBService } from "./tmdb.js";
import { syncAllLibraries, syncServerLibrary } from "./librarySync.js";
import { getJobEventService, type JobEventData, type JobUpdateType } from "./jobEvents.js";
import { hostname } from "os";
import type { Job } from "@prisma/client";

// Job type definitions
export type JobType =
  | "mdblist:hydrate"
  | "mdblist:batch-hydrate"
  | "tmdb:hydrate"
  | "tmdb:batch-hydrate"
  | "sync:full"
  | "sync:incremental"
  | "sync:refresh-stale"
  | "sync:tmdb-full"
  | "sync:tmdb-missing"
  | "library:sync"
  | "library:sync-server"
  | "pipeline:search"
  | "pipeline:download"
  | "pipeline:encode"
  | "pipeline:deliver"
  | "pipeline:retry-awaiting"
  | "tv:search"
  | "tv:download-season"
  | "tv:download-episode"
  | "tv:check-new-episodes";

interface MDBListHydratePayload {
  tmdbId: number;
  type: "movie" | "tv";
}

interface MDBListBatchHydratePayload {
  items: Array<{ tmdbId: number; type: "movie" | "tv" }>;
}

interface TMDBHydratePayload {
  tmdbId: number;
  type: "movie" | "tv";
  includeSeasons?: boolean;
}

interface TMDBBatchHydratePayload {
  items: Array<{ tmdbId: number; type: "movie" | "tv" }>;
  includeSeasons?: boolean;
}

interface SyncFullPayload {
  movies?: boolean;
  tvShows?: boolean;
  popularityThreshold?: number;
  maxItems?: number;
}

interface SyncTMDBFullPayload {
  movies?: boolean;
  tvShows?: boolean;
  popularityThreshold?: number;
  maxItems?: number;
  includeSeasons?: boolean;
}

interface SyncTMDBMissingPayload {
  movies?: boolean;
  tvShows?: boolean;
  limit?: number;
}

interface SyncRefreshStalePayload {
  limit?: number;
}

interface LibrarySyncPayload {
  // Empty - syncs all servers
}

interface LibrarySyncServerPayload {
  serverId: string;
}

type JobPayload =
  | MDBListHydratePayload
  | MDBListBatchHydratePayload
  | LibrarySyncPayload
  | LibrarySyncServerPayload
  | TMDBHydratePayload
  | TMDBBatchHydratePayload
  | SyncFullPayload
  | SyncTMDBFullPayload
  | SyncTMDBMissingPayload
  | SyncRefreshStalePayload
  | Record<string, never>;

interface JobHandler {
  (payload: JobPayload, jobId: string): Promise<unknown>;
}

class JobQueueService {
  private handlers: Map<JobType, JobHandler> = new Map();
  private runningJobs: Map<string, Job> = new Map(); // jobId -> Job
  private cancelledJobs: Set<string> = new Set(); // Jobs requested for cancellation (in-memory cache)
  private serverSyncIntervals: Map<string, NodeJS.Timeout> = new Map(); // serverId -> interval
  private awaitingRetryInterval: NodeJS.Timeout | null = null; // Interval for retrying awaiting requests
  private heartbeatInterval: NodeJS.Timeout | null = null; // Interval for job heartbeats
  private concurrency: number;
  private isStarted = false;

  // Worker identification for crash recovery
  private workerId: string;

  constructor() {
    const config = getConfig();
    this.concurrency = config.jobs.concurrency;

    // Generate unique worker ID: hostname:pid:timestamp
    this.workerId = `${hostname()}:${process.pid}:${Date.now()}`;
    console.log(`[JobQueue] Worker ID: ${this.workerId}`);

    this.registerDefaultHandlers();
  }

  /**
   * Get the worker ID for this job queue instance
   */
  getWorkerId(): string {
    return this.workerId;
  }

  /**
   * Register default job handlers
   */
  private registerDefaultHandlers(): void {
    this.registerHandler("mdblist:hydrate", async (payload) => {
      const { tmdbId, type } = payload as MDBListHydratePayload;
      const mdblist = getMDBListService();
      const success = await mdblist.hydrateMediaItem(tmdbId, type);
      return { success, tmdbId, type };
    });

    this.registerHandler("mdblist:batch-hydrate", async (payload) => {
      const { items } = payload as MDBListBatchHydratePayload;
      const mdblist = getMDBListService();
      const result = await mdblist.batchHydrateMediaItems(items);
      return result;
    });

    this.registerHandler("sync:full", async (payload, jobId) => {
      const options = payload as SyncFullPayload;
      const sync = getSyncService();
      const result = await sync.fullSync({ ...options, jobId });
      return result;
    });

    this.registerHandler("sync:incremental", async () => {
      const sync = getSyncService();
      const result = await sync.incrementalSync();
      return result;
    });

    this.registerHandler("sync:refresh-stale", async (payload) => {
      const { limit } = payload as SyncRefreshStalePayload;
      const sync = getSyncService();
      const refreshed = await sync.refreshStaleItems(limit);
      return { refreshed };
    });

    this.registerHandler("tmdb:hydrate", async (payload) => {
      const { tmdbId, type, includeSeasons } = payload as TMDBHydratePayload;
      const tmdb = getTMDBService();
      const success = type === "movie"
        ? await tmdb.hydrateMovie(tmdbId)
        : await tmdb.hydrateTvShow(tmdbId, includeSeasons ?? true);
      return { success, tmdbId, type };
    });

    this.registerHandler("tmdb:batch-hydrate", async (payload) => {
      const { items, includeSeasons } = payload as TMDBBatchHydratePayload;
      const tmdb = getTMDBService();
      const result = await tmdb.batchHydrate(items, { includeSeasons: includeSeasons ?? false });
      return result;
    });

    this.registerHandler("sync:tmdb-full", async (payload, jobId) => {
      const options = payload as SyncTMDBFullPayload;
      const sync = getSyncService();
      const result = await sync.fullTMDBSync({ ...options, jobId });
      return result;
    });

    this.registerHandler("sync:tmdb-missing", async (payload, jobId) => {
      const options = payload as SyncTMDBMissingPayload;
      const sync = getSyncService();
      const result = await sync.syncMissingFromTMDB({ ...options, jobId });
      return result;
    });

    this.registerHandler("library:sync", async () => {
      const result = await syncAllLibraries();
      return result;
    });

    this.registerHandler("library:sync-server", async (payload) => {
      const { serverId } = payload as LibrarySyncServerPayload;
      const result = await syncServerLibrary(serverId);
      return result;
    });
  }

  /**
   * Register a job handler
   */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Start the job queue - recover any pending/running jobs from database
   */
  async start(): Promise<void> {
    if (this.isStarted) {
      console.log("[JobQueue] Already started");
      return;
    }

    console.log(`[JobQueue] Starting with concurrency ${this.concurrency}`);
    console.log(`[JobQueue] Starting crash recovery sequence`);

    // 1. Register this worker in the database
    await this.registerWorker();

    // 2. Find all pending and running jobs from database
    const jobs = await prisma.job.findMany({
      where: {
        status: { in: ["PENDING", "RUNNING"] },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });

    console.log(`[JobQueue] Recovered ${jobs.length} jobs from database`);

    // 4. Reset running jobs to pending (they were interrupted by crash)
    for (const job of jobs) {
      if (job.status === "RUNNING") {
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            startedAt: null,
            heartbeatAt: null,
            workerId: null,
            cancelRequested: false, // Clear any stale cancellation
          },
        });
      }
    }

    // 5. Queue all jobs for processing
    for (const job of jobs) {
      this.scheduleJob(job);
    }

    this.isStarted = true;

    // 6. Start heartbeat loop for running jobs
    this.startHeartbeat();

    // 7. Start scheduled jobs
    this.startScheduledJobs();

    console.log(`[JobQueue] Crash recovery complete, queue started`);
  }

  /**
   * Register this worker instance in the database
   */
  private async registerWorker(): Promise<void> {
    await prisma.worker.upsert({
      where: { workerId: this.workerId },
      update: {
        status: "ACTIVE",
        lastHeartbeat: new Date(),
      },
      create: {
        workerId: this.workerId,
        hostname: hostname(),
        nodePid: process.pid,
        status: "ACTIVE",
      },
    });
    console.log(`[JobQueue] Worker registered: ${this.workerId}`);
  }

  /**
   * Start heartbeat loop - updates heartbeatAt for all running jobs
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Update heartbeat every 30 seconds
    this.heartbeatInterval = setInterval(async () => {
      const runningJobIds = Array.from(this.runningJobs.keys());
      if (runningJobIds.length === 0) return;

      try {
        // Update heartbeat for all running jobs
        await prisma.job.updateMany({
          where: {
            id: { in: runningJobIds },
            status: "RUNNING",
          },
          data: { heartbeatAt: new Date() },
        });

        // Also update worker heartbeat
        await prisma.worker.update({
          where: { workerId: this.workerId },
          data: { lastHeartbeat: new Date() },
        });

        // Sync cancellation state from database to in-memory cache
        const cancelledInDb = await prisma.job.findMany({
          where: {
            id: { in: runningJobIds },
            cancelRequested: true,
          },
          select: { id: true },
        });

        for (const job of cancelledInDb) {
          if (!this.cancelledJobs.has(job.id)) {
            this.cancelledJobs.add(job.id);
            console.log(`[JobQueue] Synced cancellation from DB for job ${job.id}`);
          }
        }
      } catch (error) {
        console.error(`[JobQueue] Heartbeat update failed:`, error);
      }
    }, 30000);

    console.log(`[JobQueue] Heartbeat loop started (30s interval)`);
  }

  /**
   * Stop heartbeat loop
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log(`[JobQueue] Heartbeat loop stopped`);
    }
  }

  /**
   * Start all scheduled recurring jobs (per-server library sync, awaiting retries)
   */
  private async startScheduledJobs(): Promise<void> {
    await this.startAllServerSyncSchedulers();
    await this.startAwaitingRetryScheduler();
  }

  /**
   * Get the retry interval for awaiting requests (in hours)
   * Default is 6 hours if not configured
   */
  private async getAwaitingRetryIntervalHours(): Promise<number> {
    const setting = await prisma.setting.findUnique({
      where: { key: "search.retryIntervalHours" },
    });
    if (setting) {
      try {
        const value = JSON.parse(setting.value);
        if (typeof value === "number" && value >= 1) {
          return value;
        }
      } catch {
        // Invalid JSON, use default
      }
    }
    return 6; // Default: 6 hours
  }

  /**
   * Start the scheduler for retrying awaiting requests
   */
  async startAwaitingRetryScheduler(): Promise<void> {
    // Clear existing interval if any
    this.stopAwaitingRetryScheduler();

    const intervalHours = await this.getAwaitingRetryIntervalHours();
    const intervalMs = intervalHours * 60 * 60 * 1000;

    console.log(`[JobQueue] Scheduling awaiting request retries every ${intervalHours} hours`);

    // Run at the configured interval (don't run immediately on startup)
    this.awaitingRetryInterval = setInterval(() => {
      this.queueAwaitingRetries();
    }, intervalMs);
  }

  /**
   * Stop the awaiting retry scheduler
   */
  stopAwaitingRetryScheduler(): void {
    if (this.awaitingRetryInterval) {
      clearInterval(this.awaitingRetryInterval);
      this.awaitingRetryInterval = null;
      console.log("[JobQueue] Stopped awaiting retry scheduler");
    }
  }

  /**
   * Update the awaiting retry scheduler with new interval
   */
  async updateAwaitingRetryScheduler(): Promise<void> {
    await this.startAwaitingRetryScheduler();
  }

  /**
   * Queue retry jobs for all awaiting requests
   */
  private async queueAwaitingRetries(): Promise<void> {
    await this.addJobIfNotExists(
      "pipeline:retry-awaiting",
      {},
      "pipeline:retry-awaiting",
      { priority: 5, maxAttempts: 1 }
    );
  }

  /**
   * Start sync schedulers for all servers with media server configured
   */
  async startAllServerSyncSchedulers(): Promise<void> {
    // Get all servers with media server integration enabled
    const servers = await prisma.storageServer.findMany({
      where: {
        mediaServerType: { not: "NONE" },
        enabled: true,
        librarySyncEnabled: true,
      },
    });

    console.log(`[JobQueue] Starting library sync schedulers for ${servers.length} servers`);

    for (const server of servers) {
      this.startServerSyncScheduler(server.id, server.name, server.librarySyncInterval);
    }
  }

  /**
   * Start sync scheduler for a specific server
   */
  startServerSyncScheduler(serverId: string, serverName: string, intervalMinutes: number): void {
    // Clear existing interval if any
    this.stopServerSyncScheduler(serverId);

    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`[JobQueue] Scheduling library sync for "${serverName}" every ${intervalMinutes} minutes`);

    // Run immediately on startup
    this.queueServerLibrarySync(serverId);

    // Then run at the configured interval
    const interval = setInterval(() => {
      this.queueServerLibrarySync(serverId);
    }, intervalMs);

    this.serverSyncIntervals.set(serverId, interval);
  }

  /**
   * Stop sync scheduler for a specific server
   */
  stopServerSyncScheduler(serverId: string): void {
    const interval = this.serverSyncIntervals.get(serverId);
    if (interval) {
      clearInterval(interval);
      this.serverSyncIntervals.delete(serverId);
      console.log(`[JobQueue] Stopped library sync scheduler for server ${serverId}`);
    }
  }

  /**
   * Update sync scheduler for a server (restart with new interval or stop)
   */
  async updateServerSyncScheduler(serverId: string): Promise<void> {
    const server = await prisma.storageServer.findUnique({
      where: { id: serverId },
    });

    if (!server) {
      this.stopServerSyncScheduler(serverId);
      return;
    }

    // Stop if disabled, no media server, or server disabled
    if (!server.librarySyncEnabled || server.mediaServerType === "NONE" || !server.enabled) {
      this.stopServerSyncScheduler(serverId);
      return;
    }

    // Start/restart with current settings
    this.startServerSyncScheduler(serverId, server.name, server.librarySyncInterval);
  }

  /**
   * Queue a library sync job for a specific server
   */
  private async queueServerLibrarySync(serverId: string): Promise<void> {
    await this.addJobIfNotExists(
      "library:sync-server",
      { serverId },
      `library:sync-server:${serverId}`,
      { priority: 1, maxAttempts: 1 }
    );
  }

  /**
   * Stop the job queue
   */
  async stop(): Promise<void> {
    this.isStarted = false;

    // Clear all server sync intervals
    for (const [serverId, interval] of this.serverSyncIntervals) {
      clearInterval(interval);
      console.log(`[JobQueue] Stopped sync scheduler for server ${serverId}`);
    }
    this.serverSyncIntervals.clear();

    // Stop awaiting retry scheduler
    this.stopAwaitingRetryScheduler();

    // Stop heartbeat loop
    this.stopHeartbeat();

    // Mark worker as stopped
    try {
      await prisma.worker.update({
        where: { workerId: this.workerId },
        data: { status: "STOPPED" },
      });
      console.log(`[JobQueue] Worker marked as stopped: ${this.workerId}`);
    } catch (error) {
      console.error(`[JobQueue] Failed to mark worker as stopped:`, error);
    }

    console.log("[JobQueue] Stopped");
  }

  /**
   * Convert a Job to JobEventData for event emission
   */
  private toEventData(job: Job): JobEventData {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      progressCurrent: job.progressCurrent,
      progressTotal: job.progressTotal,
      requestId: job.requestId,
      parentJobId: job.parentJobId,
      dedupeKey: job.dedupeKey,
      error: job.error,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  /**
   * Emit a job event
   */
  private emitJobEvent(eventType: JobUpdateType, job: Job): void {
    const events = getJobEventService();
    events.emitJobUpdate(eventType, this.toEventData(job));
  }

  /**
   * Add a job to the queue
   */
  async addJob(
    type: JobType,
    payload: JobPayload,
    options: {
      priority?: number;
      maxAttempts?: number;
      dedupeKey?: string;
    } = {}
  ): Promise<Job> {
    const { priority = 0, maxAttempts = 3, dedupeKey } = options;

    // Create job in database
    const job = await prisma.job.create({
      data: {
        type,
        payload: payload as object,
        priority,
        maxAttempts,
        dedupeKey,
        scheduledFor: new Date(),
      },
    });

    console.log(`[JobQueue] Added job ${job.id} (${type}${dedupeKey ? ` key=${dedupeKey}` : ""})`);

    // Emit created event
    this.emitJobEvent("created", job);

    // Schedule for processing
    this.scheduleJob(job);

    return job;
  }

  /**
   * Add a job only if one with the same deduplication key isn't already running or pending.
   * The dedupeKey should be unique per logical unit of work (e.g., "tv:encode:{episodeId}").
   */
  async addJobIfNotExists(
    type: JobType,
    payload: JobPayload,
    dedupeKey: string,
    options: {
      priority?: number;
      maxAttempts?: number;
    } = {}
  ): Promise<Job | null> {
    // Check if already running in memory (by dedupeKey)
    for (const [, job] of this.runningJobs) {
      if (job.dedupeKey === dedupeKey) {
        console.log(`[JobQueue] Duplicate skipped (running): ${dedupeKey}`);
        return null;
      }
    }

    // Check database for pending/running jobs with same dedupeKey
    const existing = await prisma.job.findFirst({
      where: {
        dedupeKey,
        status: { in: ["PENDING", "RUNNING"] },
      },
    });

    if (existing) {
      console.log(`[JobQueue] Duplicate skipped (pending): ${dedupeKey}`);
      return null;
    }

    // Add job with the dedupeKey stored
    return this.addJob(type, payload, { ...options, dedupeKey });
  }

  /**
   * Schedule a job for processing (respects concurrency)
   */
  private scheduleJob(job: Job): void {
    // Use setImmediate to avoid blocking
    setImmediate(() => this.tryProcessNext(job));
  }

  /**
   * Try to process a job if we have capacity
   */
  private async tryProcessNext(job: Job): Promise<void> {
    // Check concurrency
    if (this.runningJobs.size >= this.concurrency) {
      // Re-schedule to try again later
      setTimeout(() => this.scheduleJob(job), 1000);
      return;
    }

    // Check if job is still pending in database (might have been cancelled)
    const currentJob = await prisma.job.findUnique({
      where: { id: job.id },
    });

    if (!currentJob || currentJob.status !== "PENDING") {
      return;
    }

    // Process the job
    await this.processJob(currentJob);
  }

  /**
   * Process a single job
   */
  private async processJob(job: Job): Promise<void> {
    // Mark as running in memory and database
    this.runningJobs.set(job.id, job);

    try {
      const updatedJob = await prisma.job.update({
        where: { id: job.id },
        data: {
          status: "RUNNING",
          startedAt: new Date(),
          heartbeatAt: new Date(),
          workerId: this.workerId,
          attempts: { increment: 1 },
        },
      });

      // Emit started event
      this.emitJobEvent("started", updatedJob);

      console.log(`[JobQueue] Processing job ${job.id} (${job.type})`);

      const handler = this.handlers.get(job.type as JobType);
      if (!handler) {
        throw new Error(`No handler for job type: ${job.type}`);
      }

      const result = await handler(job.payload as JobPayload, job.id);

      // Check if job was cancelled during execution
      if (this.cancelledJobs.has(job.id)) {
        const cancelledJob = await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "CANCELLED",
            completedAt: new Date(),
            error: "Cancelled by user",
          },
        });
        // Emit cancelled event
        this.emitJobEvent("cancelled", cancelledJob);
        console.log(`[JobQueue] Job ${job.id} cancelled`);
      } else {
        // Mark completed
        const completedJob = await prisma.job.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            result: result as object,
            completedAt: new Date(),
          },
        });
        // Emit completed event
        this.emitJobEvent("completed", completedJob);
        console.log(`[JobQueue] Job ${job.id} completed`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[JobQueue] Job ${job.id} failed:`, errorMessage);

      // Get current attempt count
      const currentJob = await prisma.job.findUnique({
        where: { id: job.id },
        select: { attempts: true, maxAttempts: true },
      });

      const shouldRetry = currentJob && currentJob.attempts < currentJob.maxAttempts;

      const failedJob = await prisma.job.update({
        where: { id: job.id },
        data: {
          status: shouldRetry ? "PENDING" : "FAILED",
          error: errorMessage,
        },
      });

      // Emit failed event (only if not retrying)
      if (!shouldRetry) {
        this.emitJobEvent("failed", failedJob);
      }

      // Re-queue for retry if needed
      if (shouldRetry) {
        const updatedJob = await prisma.job.findUnique({ where: { id: job.id } });
        if (updatedJob) {
          const delay = Math.pow(2, currentJob.attempts) * 1000; // Exponential backoff
          console.log(`[JobQueue] Job ${job.id} will retry in ${delay}ms`);
          setTimeout(() => this.scheduleJob(updatedJob), delay);
        }
      }
    } finally {
      this.runningJobs.delete(job.id);
      this.cancelledJobs.delete(job.id); // Clean up cancellation flag
    }
  }

  /**
   * Get queue statistics
   */
  async getStats(): Promise<{
    pending: number;
    running: number;
    completed: number;
    failed: number;
    activeInMemory: number;
    byType: Record<string, number>;
  }> {
    const [pending, running, completed, failed, byTypeRaw] = await Promise.all([
      prisma.job.count({ where: { status: "PENDING" } }),
      prisma.job.count({ where: { status: "RUNNING" } }),
      prisma.job.count({ where: { status: "COMPLETED" } }),
      prisma.job.count({ where: { status: "FAILED" } }),
      prisma.job.groupBy({
        by: ["type"],
        where: { status: "PENDING" },
        _count: true,
      }),
    ]);

    const byType: Record<string, number> = {};
    for (const item of byTypeRaw) {
      byType[item.type] = item._count;
    }

    return {
      pending,
      running,
      completed,
      failed,
      activeInMemory: this.runningJobs.size,
      byType,
    };
  }

  /**
   * Clean up old completed/failed jobs
   */
  async cleanup(olderThanDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const result = await prisma.job.deleteMany({
      where: {
        status: { in: ["COMPLETED", "FAILED"] },
        updatedAt: { lt: cutoff },
      },
    });

    console.log(`[JobQueue] Cleaned up ${result.count} old jobs`);
    return result.count;
  }

  /**
   * Cancel a pending job
   */
  async cancelJob(jobId: string): Promise<boolean> {
    const result = await prisma.job.updateMany({
      where: {
        id: jobId,
        status: "PENDING",
      },
      data: {
        status: "CANCELLED",
      },
    });

    return result.count > 0;
  }

  /**
   * Request cancellation of a running job
   * The job handler must check isCancelled() periodically and stop gracefully
   * Cancellation is persisted to database for crash resilience
   */
  async requestCancellation(jobId: string): Promise<boolean> {
    // Check if job is running
    if (!this.runningJobs.has(jobId)) {
      // Try to cancel pending job instead
      return this.cancelJob(jobId);
    }

    // Persist cancellation request to database (crash-resilient)
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { cancelRequested: true },
      });
    } catch (error) {
      console.error(`[JobQueue] Failed to persist cancellation for ${jobId}:`, error);
    }

    // Also add to in-memory cache for immediate effect
    this.cancelledJobs.add(jobId);
    console.log(`[JobQueue] Cancellation requested for job ${jobId} (persisted to DB)`);
    return true;
  }

  /**
   * Check if a job has been requested for cancellation
   * Job handlers should call this periodically and stop if true
   * Checks both in-memory cache (for speed) and database (for persistence)
   */
  isCancelled(jobId: string): boolean {
    // Check in-memory cache first (faster)
    if (this.cancelledJobs.has(jobId)) {
      return true;
    }
    return false;
  }

  /**
   * Check if a job has been requested for cancellation (async, checks database)
   * Use this for periodic checks in long-running jobs
   */
  async isCancelledAsync(jobId: string): Promise<boolean> {
    // Check in-memory cache first
    if (this.cancelledJobs.has(jobId)) {
      return true;
    }

    // Check database for persistence (in case cancellation was requested after crash)
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { cancelRequested: true },
    });

    if (job?.cancelRequested) {
      // Sync to in-memory cache
      this.cancelledJobs.add(jobId);
      return true;
    }

    return false;
  }

  /**
   * Get running job by type (for UI to show cancel button)
   */
  getRunningJobByType(type: JobType): Job | null {
    for (const [, job] of this.runningJobs) {
      if (job.type === type) {
        return job;
      }
    }
    return null;
  }

  /**
   * Update job progress (called by job handlers)
   */
  async updateJobProgress(
    jobId: string,
    current: number,
    total: number,
    payload?: object
  ): Promise<void> {
    const progress = total > 0 ? (current / total) * 100 : 0;

    const updateData: {
      progress: number;
      progressCurrent: number;
      progressTotal: number;
      payload?: object;
    } = {
      progress,
      progressCurrent: current,
      progressTotal: total,
    };

    if (payload !== undefined) {
      updateData.payload = payload;
    }

    const updatedJob = await prisma.job.update({
      where: { id: jobId },
      data: updateData,
    });

    // Emit progress event
    this.emitJobEvent("progress", updatedJob);
  }

  /**
   * Get a job by ID
   */
  async getJob(jobId: string) {
    return prisma.job.findUnique({
      where: { id: jobId },
    });
  }

  /**
   * Check if a job type is currently running
   */
  isJobTypeRunning(type: JobType): boolean {
    for (const [, job] of this.runningJobs) {
      if (job.type === type) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get running job IDs
   */
  getRunningJobIds(): string[] {
    return Array.from(this.runningJobs.keys());
  }

  // =============================================================================
  // Per-Server Library Sync Control Methods (Public API)
  // =============================================================================

  /**
   * Check if a server's sync scheduler is running
   */
  isServerSyncSchedulerRunning(serverId: string): boolean {
    return this.serverSyncIntervals.has(serverId);
  }

  /**
   * Trigger an immediate library sync for a specific server
   */
  async triggerServerLibrarySync(serverId: string): Promise<Job | null> {
    return this.addJobIfNotExists(
      "library:sync-server",
      { serverId },
      `library:sync-server:${serverId}`,
      { priority: 10, maxAttempts: 1 } // Higher priority for manual triggers
    );
  }

  /**
   * Get all server IDs with active sync schedulers
   */
  getActiveServerSyncSchedulers(): string[] {
    return Array.from(this.serverSyncIntervals.keys());
  }
}

// Singleton instance
let jobQueueService: JobQueueService | null = null;

export function getJobQueueService(): JobQueueService {
  if (!jobQueueService) {
    jobQueueService = new JobQueueService();
  }
  return jobQueueService;
}

export { JobQueueService };
