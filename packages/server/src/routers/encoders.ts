/**
 * Remote Encoders Router
 *
 * API for managing remote encoders and viewing status.
 */

import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import { observable } from "@trpc/server/observable";
import { prisma } from "../db/client.js";
import { getEncoderDispatchService } from "../services/encoderDispatch.js";
import { getJobEventService, type JobUpdateEvent } from "../services/jobEvents.js";
import type { RemoteEncoderInfo, EncoderAssignmentInfo } from "@annex/shared";

export const encodersRouter = router({
  /**
   * List all registered encoders
   */
  list: publicProcedure.query(async (): Promise<RemoteEncoderInfo[]> => {
    const encoders = await prisma.remoteEncoder.findMany({
      orderBy: { encoderId: "asc" },
    });

    return encoders.map((e) => ({
      id: e.id,
      encoderId: e.encoderId,
      name: e.name,
      gpuDevice: e.gpuDevice,
      maxConcurrent: e.maxConcurrent,
      status: e.status as RemoteEncoderInfo["status"],
      currentJobs: e.currentJobs,
      lastHeartbeat: e.lastHeartbeat,
      totalJobsCompleted: e.totalJobsCompleted,
      totalJobsFailed: e.totalJobsFailed,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
  }),

  /**
   * Get encoder by ID
   */
  get: publicProcedure
    .input(z.object({ encoderId: z.string() }))
    .query(async ({ input }): Promise<RemoteEncoderInfo | null> => {
      const encoder = await prisma.remoteEncoder.findUnique({
        where: { encoderId: input.encoderId },
      });

      if (!encoder) return null;

      return {
        id: encoder.id,
        encoderId: encoder.encoderId,
        name: encoder.name,
        gpuDevice: encoder.gpuDevice,
        maxConcurrent: encoder.maxConcurrent,
        status: encoder.status as RemoteEncoderInfo["status"],
        currentJobs: encoder.currentJobs,
        lastHeartbeat: encoder.lastHeartbeat,
        totalJobsCompleted: encoder.totalJobsCompleted,
        totalJobsFailed: encoder.totalJobsFailed,
        createdAt: encoder.createdAt,
        updatedAt: encoder.updatedAt,
      };
    }),

  /**
   * Update encoder name
   */
  updateName: publicProcedure
    .input(z.object({
      encoderId: z.string(),
      name: z.string().min(1).max(100),
    }))
    .mutation(async ({ input }) => {
      return prisma.remoteEncoder.update({
        where: { encoderId: input.encoderId },
        data: { name: input.name },
      });
    }),

  /**
   * Remove encoder (only if offline)
   */
  remove: publicProcedure
    .input(z.object({ encoderId: z.string() }))
    .mutation(async ({ input }) => {
      const encoder = await prisma.remoteEncoder.findUnique({
        where: { encoderId: input.encoderId },
      });

      if (!encoder) {
        throw new Error("Encoder not found");
      }

      if (encoder.status !== "OFFLINE") {
        throw new Error("Cannot remove an online encoder. Shut it down first.");
      }

      await prisma.remoteEncoder.delete({
        where: { encoderId: input.encoderId },
      });

      return { success: true };
    }),

  /**
   * Get all active encoding assignments
   */
  assignments: publicProcedure.query(async (): Promise<EncoderAssignmentInfo[]> => {
    const assignments = await prisma.encoderAssignment.findMany({
      where: {
        status: { in: ["PENDING", "ENCODING"] },
      },
      orderBy: { assignedAt: "desc" },
    });

    return assignments.map((a) => ({
      id: a.id,
      jobId: a.jobId,
      encoderId: a.encoderId,
      inputPath: a.inputPath,
      outputPath: a.outputPath,
      profileId: a.profileId,
      status: a.status as EncoderAssignmentInfo["status"],
      attempt: a.attempt,
      maxAttempts: a.maxAttempts,
      progress: a.progress,
      fps: a.fps,
      speed: a.speed,
      eta: a.eta,
      error: a.error,
      assignedAt: a.assignedAt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
    }));
  }),

  /**
   * Get assignment history (recent completed/failed)
   */
  assignmentHistory: publicProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input }): Promise<EncoderAssignmentInfo[]> => {
      const assignments = await prisma.encoderAssignment.findMany({
        where: {
          status: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
        },
        orderBy: { completedAt: "desc" },
        take: input.limit,
      });

      return assignments.map((a) => ({
        id: a.id,
        jobId: a.jobId,
        encoderId: a.encoderId,
        inputPath: a.inputPath,
        outputPath: a.outputPath,
        profileId: a.profileId,
        status: a.status as EncoderAssignmentInfo["status"],
        attempt: a.attempt,
        maxAttempts: a.maxAttempts,
        progress: a.progress,
        fps: a.fps,
        speed: a.speed,
        eta: a.eta,
        error: a.error,
        assignedAt: a.assignedAt,
        startedAt: a.startedAt,
        completedAt: a.completedAt,
      }));
    }),

  /**
   * Check if remote encoding is available
   */
  isAvailable: publicProcedure.query(() => {
    const dispatch = getEncoderDispatchService();
    return {
      available: dispatch.isAvailable(),
      hasEncoders: dispatch.hasEncoders(),
      encoderCount: dispatch.getEncoderCount(),
    };
  }),

  /**
   * Get encoding statistics
   */
  stats: publicProcedure.query(async () => {
    const [
      totalEncoders,
      onlineEncoders,
      totalAssignments,
      completedAssignments,
      failedAssignments,
      totalJobsCompleted,
      totalJobsFailed,
    ] = await Promise.all([
      prisma.remoteEncoder.count(),
      prisma.remoteEncoder.count({ where: { status: { not: "OFFLINE" } } }),
      prisma.encoderAssignment.count(),
      prisma.encoderAssignment.count({ where: { status: "COMPLETED" } }),
      prisma.encoderAssignment.count({ where: { status: "FAILED" } }),
      prisma.remoteEncoder.aggregate({ _sum: { totalJobsCompleted: true } }),
      prisma.remoteEncoder.aggregate({ _sum: { totalJobsFailed: true } }),
    ]);

    return {
      totalEncoders,
      onlineEncoders,
      totalAssignments,
      completedAssignments,
      failedAssignments,
      totalJobsCompleted: totalJobsCompleted._sum.totalJobsCompleted || 0,
      totalJobsFailed: totalJobsFailed._sum.totalJobsFailed || 0,
      successRate: completedAssignments > 0
        ? Math.round((completedAssignments / (completedAssignments + failedAssignments)) * 100)
        : 0,
    };
  }),

  /**
   * Cancel an encoding job
   */
  cancelJob: publicProcedure
    .input(z.object({
      jobId: z.string(),
      reason: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const dispatch = getEncoderDispatchService();
      const cancelled = await dispatch.cancelJob(input.jobId, input.reason);

      if (!cancelled) {
        throw new Error("Job not found or already completed");
      }

      return { success: true };
    }),

  /**
   * Subscribe to encoder status updates
   */
  onStatusUpdate: publicProcedure.subscription(() => {
    return observable<{
      encoderId: string;
      status: string;
      currentJobs: number;
      lastHeartbeat: Date | null;
    }>((emit) => {
      const events = getJobEventService();

      // Emit current state immediately
      prisma.remoteEncoder.findMany().then((encoders) => {
        for (const encoder of encoders) {
          emit.next({
            encoderId: encoder.encoderId,
            status: encoder.status,
            currentJobs: encoder.currentJobs,
            lastHeartbeat: encoder.lastHeartbeat,
          });
        }
      });

      // Subscribe to worker status events
      const handler = (event: {
        workerId: string;
        status: string;
        runningJobs: number;
        lastHeartbeat: Date;
      }) => {
        emit.next({
          encoderId: event.workerId,
          status: event.status === "ACTIVE" ? "IDLE" : "OFFLINE",
          currentJobs: event.runningJobs,
          lastHeartbeat: event.lastHeartbeat,
        });
      };

      const unsubscribe = events.onWorkerStatus(handler);
      return unsubscribe;
    });
  }),

  /**
   * Subscribe to assignment progress updates
   */
  onAssignmentProgress: publicProcedure.subscription(() => {
    return observable<{
      jobId: string;
      progress: number;
      fps: number | null;
      speed: number | null;
      eta: number | null;
    }>((emit) => {
      const events = getJobEventService();

      const handler = (event: JobUpdateEvent) => {
        if (event.job.type === "remote:encode" && event.eventType === "progress") {
          // Fetch full assignment info
          prisma.encoderAssignment.findUnique({
            where: { jobId: event.job.id },
          }).then((assignment) => {
            if (assignment) {
              emit.next({
                jobId: assignment.jobId,
                progress: assignment.progress,
                fps: assignment.fps,
                speed: assignment.speed,
                eta: assignment.eta,
              });
            }
          });
        }
      };

      const unsubscribe = events.onJobUpdate(handler);
      return unsubscribe;
    });
  }),
});
