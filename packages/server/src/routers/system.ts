import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { RequestStatus, ActivityType, JobStatus } from "@prisma/client";
import { getJobQueueService } from "../services/jobQueue.js";

function fromActivityType(value: ActivityType): string {
  return value.toLowerCase();
}

function fromJobStatus(status: JobStatus): string {
  return status.toLowerCase();
}

/**
 * Sanitize job payload for client display.
 * Strips out large arrays (like ID lists) that are only needed for internal processing.
 */
function sanitizePayloadForClient(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const sanitized: Record<string, unknown> = {};
  const raw = payload as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    // Skip large ID arrays - they're only for internal resume logic
    if (key === "movieIds" || key === "tvIds") {
      // Just show the count instead
      if (Array.isArray(value)) {
        sanitized[`${key}Count`] = value.length;
      }
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

export const systemRouter = router({
  /**
   * Get system health status
   */
  health: publicProcedure.query(async () => {
    // TODO: Add actual health checks (qBittorrent, encoder, disk space, etc.)
    return {
      status: "healthy",
      version: "0.1.0",
      uptime: process.uptime(),
      checks: {
        database: true,
        qbittorrent: false, // TODO: Implement
        encoder: false, // TODO: Implement
      },
    };
  }),

  /**
   * Get current processing queue
   */
  queue: publicProcedure.query(async () => {
    const activeStatuses = [
      RequestStatus.PENDING,
      RequestStatus.SEARCHING,
      RequestStatus.DOWNLOADING,
      RequestStatus.ENCODING,
      RequestStatus.DELIVERING,
    ];

    const results = await prisma.mediaRequest.findMany({
      where: {
        status: { in: activeStatuses },
      },
      orderBy: { createdAt: "asc" },
    });

    // Get poster paths from MediaItem
    const mediaItemIds = results.map((r) => `tmdb-${r.type.toLowerCase()}-${r.tmdbId}`);
    const mediaItems = await prisma.mediaItem.findMany({
      where: { id: { in: mediaItemIds } },
      select: { id: true, posterPath: true },
    });
    const posterMap = new Map(mediaItems.map((m) => [m.id, m.posterPath]));

    return results.map((r, index) => {
      const mediaItemId = `tmdb-${r.type.toLowerCase()}-${r.tmdbId}`;
      return {
        requestId: r.id,
        title: r.title,
        year: r.year,
        type: r.type.toLowerCase(),
        status: r.status.toLowerCase(),
        progress: r.progress,
        currentStep: r.currentStep,
        posterPath: posterMap.get(mediaItemId) || null,
        position: index + 1,
      };
    });
  }),

  /**
   * Get recent activity log
   */
  activity: publicProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        requestId: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const results = await prisma.activityLog.findMany({
        where: input.requestId ? { requestId: input.requestId } : undefined,
        orderBy: { timestamp: "desc" },
        take: input.limit,
      });

      return results.map((a) => ({
        id: a.id,
        requestId: a.requestId,
        type: fromActivityType(a.type),
        message: a.message,
        details: a.details,
        timestamp: a.timestamp,
      }));
    }),

  /**
   * Get/set system settings
   */
  settings: router({
    get: publicProcedure.input(z.object({ key: z.string() })).query(async ({ input }) => {
      const result = await prisma.setting.findUnique({
        where: { key: input.key },
      });

      if (!result) {
        return null;
      }

      return {
        key: result.key,
        value: JSON.parse(result.value),
        updatedAt: result.updatedAt,
      };
    }),

    set: publicProcedure
      .input(
        z.object({
          key: z.string(),
          value: z.unknown(),
        })
      )
      .mutation(async ({ input }) => {
        await prisma.setting.upsert({
          where: { key: input.key },
          create: {
            key: input.key,
            value: JSON.stringify(input.value),
          },
          update: {
            value: JSON.stringify(input.value),
          },
        });

        return { success: true };
      }),

    list: publicProcedure.query(async () => {
      const results = await prisma.setting.findMany();

      return results.map((s) => ({
        key: s.key,
        value: JSON.parse(s.value),
        updatedAt: s.updatedAt,
      }));
    }),
  }),

  /**
   * Job queue management
   */
  jobs: router({
    /**
     * List jobs with filtering and pagination
     */
    list: publicProcedure
      .input(
        z.object({
          status: z.enum(["pending", "running", "completed", "failed", "cancelled", "all"]).default("all"),
          type: z.string().optional(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
        })
      )
      .query(async ({ input }) => {
        const statusFilter = input.status === "all"
          ? undefined
          : { status: input.status.toUpperCase() as JobStatus };

        const typeFilter = input.type ? { type: input.type } : {};

        const [jobs, totalCount] = await Promise.all([
          prisma.job.findMany({
            where: {
              ...statusFilter,
              ...typeFilter,
            },
            orderBy: [
              { status: "asc" }, // Running first, then pending
              { priority: "desc" },
              { createdAt: "desc" },
            ],
            take: input.limit,
            skip: input.offset,
          }),
          prisma.job.count({
            where: {
              ...statusFilter,
              ...typeFilter,
            },
          }),
        ]);

        return {
          jobs: jobs.map((job) => ({
            id: job.id,
            type: job.type,
            status: fromJobStatus(job.status),
            priority: job.priority,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            progress: job.progress,
            progressTotal: job.progressTotal,
            progressCurrent: job.progressCurrent,
            error: job.error,
            result: job.result,
            payload: sanitizePayloadForClient(job.payload),
            lockedBy: job.lockedBy,
            scheduledFor: job.scheduledFor,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
          })),
          totalCount,
          hasMore: input.offset + jobs.length < totalCount,
        };
      }),

    /**
     * Get job queue statistics
     */
    stats: publicProcedure.query(async () => {
      const jobQueue = getJobQueueService();
      return jobQueue.getStats();
    }),

    /**
     * Get a single job by ID
     */
    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input }) => {
        const job = await prisma.job.findUnique({
          where: { id: input.id },
        });

        if (!job) {
          return null;
        }

        return {
          id: job.id,
          type: job.type,
          status: fromJobStatus(job.status),
          priority: job.priority,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          progress: job.progress,
          progressTotal: job.progressTotal,
          progressCurrent: job.progressCurrent,
          error: job.error,
          result: job.result,
          payload: sanitizePayloadForClient(job.payload),
          lockedBy: job.lockedBy,
          scheduledFor: job.scheduledFor,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        };
      }),

    /**
     * Cancel a pending job
     */
    cancel: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const jobQueue = getJobQueueService();
        const success = await jobQueue.cancelJob(input.id);
        return { success };
      }),

    /**
     * Request cancellation of a running job
     * The job will stop gracefully at the next checkpoint
     */
    requestCancellation: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const jobQueue = getJobQueueService();
        const success = await jobQueue.requestCancellation(input.id);
        return { success };
      }),

    /**
     * Retry a failed job
     */
    retry: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ input }) => {
        const job = await prisma.job.findUnique({
          where: { id: input.id },
        });

        if (!job || job.status !== "FAILED") {
          return { success: false, error: "Job not found or not in failed state" };
        }

        await prisma.job.update({
          where: { id: input.id },
          data: {
            status: "PENDING",
            error: null,
            attempts: 0,
            lockedAt: null,
            lockedBy: null,
            scheduledFor: new Date(),
          },
        });

        return { success: true };
      }),

    /**
     * Clean up old completed/failed jobs
     */
    cleanup: publicProcedure
      .input(z.object({ olderThanDays: z.number().min(1).default(7) }))
      .mutation(async ({ input }) => {
        const jobQueue = getJobQueueService();
        const count = await jobQueue.cleanup(input.olderThanDays);
        return { deletedCount: count };
      }),

    /**
     * Get job tree (hierarchical jobs for a request or root jobs)
     */
    tree: publicProcedure
      .input(
        z.object({
          requestId: z.string().optional(),
          rootOnly: z.boolean().default(false),
          includeCompleted: z.boolean().default(true),
          limit: z.number().min(1).max(100).default(50),
        })
      )
      .query(async ({ input }) => {
        const where: {
          requestId?: string;
          parentJobId?: null;
          status?: { not: JobStatus };
        } = {};

        if (input.requestId) {
          where.requestId = input.requestId;
        }

        if (input.rootOnly) {
          where.parentJobId = null;
        }

        if (!input.includeCompleted) {
          where.status = { not: "COMPLETED" as JobStatus };
        }

        const jobs = await prisma.job.findMany({
          where,
          include: {
            childJobs: {
              include: {
                childJobs: true, // Get 2 levels deep
              },
              orderBy: { createdAt: "asc" },
            },
            request: {
              select: { title: true, type: true },
            },
          },
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
          take: input.limit,
        });

        return jobs.map((job) => ({
          id: job.id,
          type: job.type,
          status: fromJobStatus(job.status),
          progress: job.progress,
          progressCurrent: job.progressCurrent,
          progressTotal: job.progressTotal,
          error: job.error,
          parentJobId: job.parentJobId,
          requestId: job.requestId,
          requestTitle: job.request?.title,
          requestType: job.request?.type?.toLowerCase(),
          workerId: job.workerId,
          heartbeatAt: job.heartbeatAt,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          createdAt: job.createdAt,
          childJobs: job.childJobs.map((child) => ({
            id: child.id,
            type: child.type,
            status: fromJobStatus(child.status),
            progress: child.progress,
            error: child.error,
            startedAt: child.startedAt,
            completedAt: child.completedAt,
            childJobs: child.childJobs.map((grandchild) => ({
              id: grandchild.id,
              type: grandchild.type,
              status: fromJobStatus(grandchild.status),
              progress: grandchild.progress,
              error: grandchild.error,
            })),
          })),
        }));
      }),
  }),

  /**
   * Worker and GPU status (for crash resilience monitoring)
   */
  workers: router({
    /**
     * List all workers
     */
    list: publicProcedure.query(async () => {
      const workers = await prisma.worker.findMany({
        orderBy: { startedAt: "desc" },
      });

      return workers.map((w) => ({
        id: w.id,
        workerId: w.workerId,
        hostname: w.hostname,
        nodePid: w.nodePid,
        status: w.status.toLowerCase(),
        startedAt: w.startedAt,
        lastHeartbeat: w.lastHeartbeat,
      }));
    }),

    /**
     * Get current worker info
     */
    current: publicProcedure.query(async () => {
      const jobQueue = getJobQueueService();
      const workerId = jobQueue.getWorkerId();
      const runningJobIds = jobQueue.getRunningJobIds();

      return {
        workerId,
        runningJobs: runningJobIds.length,
        runningJobIds,
      };
    }),
  }),
});
