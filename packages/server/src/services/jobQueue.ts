/**
 * Job Queue Service
 *
 * Simple in-memory job queue for a single-threaded server.
 * Database is only used for persistence/crash recovery.
 */

import { hostname } from "node:os";
import type { Job } from "@prisma/client";
import { getConfig } from "../config/index.js";
import { prisma } from "../db/client.js";
import { getJobEventService, type JobEventData, type JobUpdateType } from "./jobEvents.js";
import { syncAllLibraries, syncServerLibrary } from "./librarySync.js";
import { getSchedulerService } from "./scheduler.js";

// Job type definitions
export type JobType =
  | "library:sync"
  | "library:sync-server"
  | "mdblist:hydrate-discover"
  | "pipeline:search"
  | "pipeline:download"
  | "pipeline:encode"
  | "pipeline:deliver"
  | "pipeline:retry-awaiting"
  | "pipeline:execute-step"
  | "tv:search"
  | "tv:download-season"
  | "tv:download-episode"
  | "tv:check-new-episodes"
  | "ratelimit:cleanup";

interface LibrarySyncServerPayload {
  serverId: string;
  sinceDate?: string; // ISO date string for incremental sync
}

interface MDBListHydratePayload {
  items: Array<{ tmdbId: number; type: "movie" | "tv" }>;
}

// Generic payload type - specific types are defined in their respective services
// biome-ignore lint/suspicious/noExplicitAny: Generic job queue accepts any payload type
type JobPayload = any;

type JobHandler = (payload: JobPayload, jobId: string) => Promise<unknown>;

class JobQueueService {
  private handlers: Map<JobType, JobHandler> = new Map();
  private runningJobs: Map<string, Job> = new Map(); // jobId -> Job
  private cancelledJobs: Set<string> = new Set(); // Jobs requested for cancellation (in-memory cache)
  private registeredServerSyncs: Set<string> = new Set(); // Tracks which server sync tasks are registered
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
    this.registerHandler("library:sync", async () => {
      const result = await syncAllLibraries();
      return result;
    });

    this.registerHandler("library:sync-server", async (payload) => {
      const { serverId, sinceDate } = payload as LibrarySyncServerPayload;
      const result = await syncServerLibrary(serverId, {
        sinceDate: sinceDate ? new Date(sinceDate) : undefined,
      });
      return result;
    });

    this.registerHandler("mdblist:hydrate-discover", async (payload) => {
      const { items } = payload as MDBListHydratePayload;
      if (!items || items.length === 0) {
        return { success: 0, failed: 0, skipped: 0 };
      }

      const { getMDBListService } = await import("./mdblist.js");
      const mdblist = getMDBListService();

      // Skip if MDBList is not configured
      const isConfigured = await mdblist.isConfigured();
      if (!isConfigured) {
        console.log("[MDBList] Skipping hydration - MDBList not configured");
        return { success: 0, failed: 0, skipped: items.length };
      }

      const result = await mdblist.batchHydrateMediaItems(items);
      console.log(
        `[MDBList] Hydrated discover items: ${result.success} success, ${result.failed} failed, ${result.skipped} skipped`
      );
      return result;
    });

    this.registerHandler("ratelimit:cleanup", async () => {
      const { getRateLimiter } = await import("./rateLimiter.js");
      const rateLimiter = getRateLimiter();
      const count = await rateLimiter.cleanupOldRecords();
      return { cleaned: count };
    });

    this.registerHandler("pipeline:execute-step", async (payload) => {
      const { executionId } = payload as { executionId: string };
      const { PipelineExecutor } = await import("./pipeline/PipelineExecutor.js");
      const executor = new PipelineExecutor();
      await executor.executeNextStep(executionId);
      return { success: true };
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

    // 2. Clean up stale workers (heartbeat older than 10 minutes)
    await this.cleanupStaleWorkers();

    // 3. Find all pending and running jobs from database
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

    this.isStarted = true;

    // 5. Register scheduler tasks
    this.registerHeartbeatTask();
    this.registerJobProcessTask();

    // 6. Start scheduled jobs (library sync, awaiting retries)
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
   * Clean up stale workers (heartbeat older than threshold)
   */
  private async cleanupStaleWorkers(): Promise<void> {
    const threshold = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes

    const result = await prisma.worker.deleteMany({
      where: {
        lastHeartbeat: { lt: threshold },
        workerId: { not: this.workerId }, // Don't delete self
      },
    });

    if (result.count > 0) {
      console.log(`[JobQueue] Cleaned up ${result.count} stale workers`);
    }
  }

  /**
   * Register heartbeat task with scheduler
   */
  private registerHeartbeatTask(): void {
    const scheduler = getSchedulerService();

    scheduler.register(
      "job-heartbeat",
      "Job Heartbeat",
      30_000, // 30 seconds
      async () => {
        const runningJobIds = Array.from(this.runningJobs.keys());
        if (runningJobIds.length === 0) return;

        // Update heartbeat for all running jobs
        await prisma.job.updateMany({
          where: {
            id: { in: runningJobIds },
            status: "RUNNING",
          },
          data: { heartbeatAt: new Date() },
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
      }
    );

    scheduler.register(
      "worker-heartbeat",
      "Worker Heartbeat",
      30_000, // 30 seconds
      async () => {
        await prisma.worker.update({
          where: { workerId: this.workerId },
          data: { lastHeartbeat: new Date() },
        });
      }
    );

    scheduler.register(
      "stale-worker-cleanup",
      "Stale Worker Cleanup",
      10 * 60 * 1000, // 10 minutes
      async () => {
        await this.cleanupStaleWorkers();
      }
    );
  }

  /**
   * Unregister heartbeat tasks from scheduler
   */
  private unregisterHeartbeatTask(): void {
    const scheduler = getSchedulerService();
    scheduler.unregister("job-heartbeat");
    scheduler.unregister("worker-heartbeat");
    scheduler.unregister("stale-worker-cleanup");
  }

  /**
   * Register job processing task with scheduler
   * This polls for pending jobs and processes them up to concurrency limit
   */
  private registerJobProcessTask(): void {
    const config = getConfig();
    const pollInterval = config.jobs.pollInterval;

    const scheduler = getSchedulerService();
    scheduler.register("job-process", "Job Processing", pollInterval, async () => {
      await this.pollAndProcessJobs();
    });

    console.log(`[JobQueue] Registered job process task (${pollInterval}ms interval)`);
  }

  /**
   * Poll for pending jobs and process up to concurrency limit
   */
  private async pollAndProcessJobs(): Promise<void> {
    // Calculate how many jobs we can start
    const available = this.concurrency - this.runningJobs.size;
    if (available <= 0) {
      return;
    }

    // Find pending jobs, ordered by priority and creation time
    const pendingJobs = await prisma.job.findMany({
      where: {
        status: "PENDING",
        scheduledFor: { lte: new Date() },
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: available,
    });

    if (pendingJobs.length === 0) {
      return;
    }

    // Start processing each job (fire and forget - non-blocking)
    for (const job of pendingJobs) {
      // Double-check we still have capacity
      if (this.runningJobs.size >= this.concurrency) {
        break;
      }

      // Skip if job is already being processed (race condition protection)
      if (this.runningJobs.has(job.id)) {
        continue;
      }

      // Process job (non-blocking)
      this.processJob(job).catch((error) => {
        console.error(`[JobQueue] Error processing job ${job.id}:`, error);
      });
    }
  }

  /**
   * Start all scheduled recurring jobs (per-server library sync, awaiting retries)
   */
  private async startScheduledJobs(): Promise<void> {
    await this.startAllServerSyncSchedulers();
    await this.startAwaitingRetryScheduler();
    await this.startApprovalTimeoutScheduler();
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
   * Register the awaiting retry task with scheduler
   */
  async startAwaitingRetryScheduler(): Promise<void> {
    const scheduler = getSchedulerService();
    const intervalHours = await this.getAwaitingRetryIntervalHours();
    const intervalMs = intervalHours * 60 * 60 * 1000;

    scheduler.register("awaiting-retry", "Awaiting Request Retry", intervalMs, async () => {
      await this.queueAwaitingRetries();
    });

    console.log(`[JobQueue] Registered awaiting retry task (${intervalHours}h interval)`);
  }

  /**
   * Unregister the awaiting retry task from scheduler
   */
  stopAwaitingRetryScheduler(): void {
    const scheduler = getSchedulerService();
    scheduler.unregister("awaiting-retry");
    console.log("[JobQueue] Unregistered awaiting retry task");
  }

  /**
   * Update the awaiting retry scheduler with new interval
   */
  async updateAwaitingRetryScheduler(): Promise<void> {
    const scheduler = getSchedulerService();
    const intervalHours = await this.getAwaitingRetryIntervalHours();
    const intervalMs = intervalHours * 60 * 60 * 1000;
    scheduler.updateInterval("awaiting-retry", intervalMs);
    console.log(`[JobQueue] Updated awaiting retry interval to ${intervalHours}h`);
  }

  /**
   * Register the approval timeout checker with scheduler
   * Runs every 5 minutes to check for timed-out approvals
   */
  async startApprovalTimeoutScheduler(): Promise<void> {
    const scheduler = getSchedulerService();
    const intervalMs = 5 * 60 * 1000; // 5 minutes

    scheduler.register("approval-timeout", "Approval Timeout Check", intervalMs, async () => {
      await this.checkApprovalTimeouts();
    });

    console.log("[JobQueue] Registered approval timeout task (5m interval)");
  }

  /**
   * Check for timed-out approvals and execute auto-actions
   */
  private async checkApprovalTimeouts(): Promise<void> {
    const { getApprovalService } = await import("./approvals/ApprovalService.js");
    const approvalService = getApprovalService();

    try {
      await approvalService.checkTimeouts();
    } catch (error) {
      console.error("[JobQueue] Approval timeout check failed:", error);
    }
  }

  /**
   * Queue retry jobs for all awaiting requests
   */
  private async queueAwaitingRetries(): Promise<void> {
    await this.addJobIfNotExists("pipeline:retry-awaiting", {}, "pipeline:retry-awaiting", {
      priority: 5,
      maxAttempts: 1,
    });
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
   * Register sync task for a specific server with scheduler
   * Auto syncs use incremental mode with sinceDate = interval + 5 min buffer
   */
  startServerSyncScheduler(serverId: string, serverName: string, intervalMinutes: number): void {
    // Unregister existing task if any
    this.stopServerSyncScheduler(serverId);

    const scheduler = getSchedulerService();
    const taskId = `library-sync-${serverId}`;
    const intervalMs = intervalMinutes * 60 * 1000;

    scheduler.register(taskId, `Library Sync: ${serverName}`, intervalMs, async () => {
      await this.queueServerLibrarySync(serverId, intervalMinutes);
    });

    this.registeredServerSyncs.add(serverId);
    console.log(
      `[JobQueue] Registered library sync task for "${serverName}" (${intervalMinutes}m interval, incremental)`
    );

    // Run immediately on startup (full sync for first run)
    this.queueServerLibrarySync(serverId);
  }

  /**
   * Unregister sync task for a specific server
   */
  stopServerSyncScheduler(serverId: string): void {
    if (this.registeredServerSyncs.has(serverId)) {
      const scheduler = getSchedulerService();
      const taskId = `library-sync-${serverId}`;
      scheduler.unregister(taskId);
      this.registeredServerSyncs.delete(serverId);
      console.log(`[JobQueue] Unregistered library sync task for server ${serverId}`);
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
   * @param serverId - Server to sync
   * @param intervalMinutes - If provided, uses incremental sync with sinceDate = interval + 5 min buffer
   */
  private async queueServerLibrarySync(serverId: string, intervalMinutes?: number): Promise<void> {
    // Calculate sinceDate for incremental sync
    // Use interval + 5 minute buffer to ensure overlap and no missed items
    let sinceDate: string | undefined;
    if (intervalMinutes) {
      const bufferMinutes = 5;
      const totalMinutes = intervalMinutes + bufferMinutes;
      const since = new Date(Date.now() - totalMinutes * 60 * 1000);
      sinceDate = since.toISOString();
      console.log(
        `[JobQueue] Queueing incremental sync for ${serverId} (since ${since.toISOString()})`
      );
    }

    const payload: LibrarySyncServerPayload = {
      serverId,
      sinceDate,
    };

    await this.addJobIfNotExists(
      "library:sync-server",
      payload,
      `library:sync-server:${serverId}`,
      { priority: 1, maxAttempts: 1 }
    );
  }

  /**
   * Stop the job queue
   */
  async stop(): Promise<void> {
    this.isStarted = false;

    // Unregister all server sync tasks
    for (const serverId of this.registeredServerSyncs) {
      const scheduler = getSchedulerService();
      scheduler.unregister(`library-sync-${serverId}`);
      console.log(`[JobQueue] Unregistered sync task for server ${serverId}`);
    }
    this.registeredServerSyncs.clear();

    // Stop awaiting retry scheduler
    this.stopAwaitingRetryScheduler();

    // Unregister heartbeat tasks
    this.unregisterHeartbeatTask();

    // Unregister job processing task
    const scheduler = getSchedulerService();
    scheduler.unregister("job-process");

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

    // Extract requestId from payload if present (for pipeline jobs)
    const requestId = (payload as { requestId?: string }).requestId;

    // Create job in database
    const job = await prisma.job.create({
      data: {
        type,
        payload: payload as object,
        priority,
        maxAttempts,
        dedupeKey,
        requestId,
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
   * Schedule a job for processing
   * Note: With the scheduler-based polling, this is mostly a no-op.
   * The scheduler's job-process task polls for pending jobs.
   * This method is kept for immediate processing when capacity is available.
   */
  private scheduleJob(job: Job): void {
    // If we have capacity, process immediately (don't wait for next poll)
    if (this.runningJobs.size < this.concurrency && !this.runningJobs.has(job.id)) {
      this.processJob(job).catch((error) => {
        console.error(`[JobQueue] Error processing job ${job.id}:`, error);
      });
    }
    // Otherwise, the scheduler's polling task will pick it up
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

      // Check if job was cancelled or paused during execution
      if (this.cancelledJobs.has(job.id)) {
        // Check actual database status - might be PAUSED instead of cancelled
        const currentStatus = await prisma.job.findUnique({
          where: { id: job.id },
          select: { status: true },
        });

        if (currentStatus?.status === "PAUSED") {
          // Job was paused, don't change status - just log and emit event
          const pausedJob = await prisma.job.findUnique({ where: { id: job.id } });
          if (pausedJob) {
            this.emitJobEvent("progress", pausedJob);
            console.log(`[JobQueue] Job ${job.id} paused`);
          }
        } else {
          // Job was cancelled
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
        }
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
          const delay = 2 ** currentJob.attempts * 1000; // Exponential backoff
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
    paused: number;
    completed: number;
    failed: number;
    activeInMemory: number;
    byType: Record<string, number>;
  }> {
    const [pending, running, paused, completed, failed, byTypeRaw] = await Promise.all([
      prisma.job.count({ where: { status: "PENDING" } }),
      prisma.job.count({ where: { status: "RUNNING" } }),
      prisma.job.count({ where: { status: "PAUSED" } }),
      prisma.job.count({ where: { status: "COMPLETED" } }),
      prisma.job.count({ where: { status: "FAILED" } }),
      prisma.job.groupBy({
        by: ["type"],
        where: { status: { in: ["PENDING", "PAUSED"] } },
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
      paused,
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
   * Pause a pending or running job
   * Running jobs will be marked as paused and the handler should check isPaused()
   */
  async pauseJob(jobId: string): Promise<boolean> {
    // Check if job exists and is in a pausable state
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true },
    });

    if (!job || !["PENDING", "RUNNING"].includes(job.status)) {
      return false;
    }

    // Mark as paused in database
    const result = await prisma.job.update({
      where: { id: jobId },
      data: {
        status: "PAUSED",
      },
    });

    // If was running, also track in memory for handler to detect
    if (job.status === "RUNNING" && this.runningJobs.has(jobId)) {
      this.cancelledJobs.add(jobId); // Reuse cancellation mechanism to signal pause
    }

    console.log(`[JobQueue] Job ${jobId} paused`);
    this.emitJobEvent("progress", result); // Emit to update UI

    return true;
  }

  /**
   * Resume a paused job
   * The job will be set back to PENDING and picked up by the queue
   */
  async resumeJob(jobId: string): Promise<boolean> {
    const result = await prisma.job.updateMany({
      where: {
        id: jobId,
        status: "PAUSED",
      },
      data: {
        status: "PENDING",
        startedAt: null,
        heartbeatAt: null,
        workerId: null,
      },
    });

    if (result.count > 0) {
      console.log(`[JobQueue] Job ${jobId} resumed`);

      // Get the job and schedule it for processing
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (job) {
        this.emitJobEvent("progress", job); // Emit to update UI
        this.scheduleJob(job);
      }
      return true;
    }

    return false;
  }

  /**
   * Check if a job is paused
   */
  async isPaused(jobId: string): Promise<boolean> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return job?.status === "PAUSED";
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
    return this.registeredServerSyncs.has(serverId);
  }

  /**
   * Trigger an immediate library sync for a server
   * @param serverId - The server to sync
   * @param sinceDate - Only sync items added after this date (incremental sync)
   */
  async triggerServerLibrarySync(serverId: string, sinceDate?: Date): Promise<Job | null> {
    const payload: LibrarySyncServerPayload = {
      serverId,
      sinceDate: sinceDate?.toISOString(),
    };

    // Use different dedupe key for incremental vs full sync
    const dedupeKey = sinceDate
      ? `library:sync-server:${serverId}:incremental`
      : `library:sync-server:${serverId}`;

    return this.addJobIfNotExists(
      "library:sync-server",
      payload,
      dedupeKey,
      { priority: 10, maxAttempts: 1 } // Higher priority for manual triggers
    );
  }

  /**
   * Get all server IDs with active sync schedulers
   */
  getActiveServerSyncSchedulers(): string[] {
    return Array.from(this.registeredServerSyncs);
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
