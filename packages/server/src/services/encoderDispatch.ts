/**
 * Encoder Dispatch Service (Refactored)
 *
 * Manages the pool of remote encoders and dispatches encoding jobs.
 * Key principles:
 * - Database is the single source of truth (no in-memory state that matters)
 * - Single unified tick loop for all encoder management
 * - Crash-resilient: server restart seamlessly resumes encoding
 */

import { existsSync } from "node:fs";
import type {
  EncoderMessage,
  EncodingConfig,
  HeartbeatMessage,
  JobAssignMessage,
  JobCompleteMessage,
  JobFailedMessage,
  JobProgressMessage,
  RegisterMessage,
  ServerMessage,
} from "@annex/shared";
import type { EncoderAssignment, RemoteEncoder } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { ServerWebSocket } from "bun";
import { prisma } from "../db/client.js";
import { getJobEventService } from "./jobEvents.js";
import { getSchedulerService } from "./scheduler.js";

// =============================================================================
// Types
// =============================================================================

export interface EncoderWebSocketData {
  type: "encoder";
  encoderId: string | null;
}

// Minimal in-memory encoder connection (WebSocket only)
interface ConnectedEncoder {
  ws: ServerWebSocket<EncoderWebSocketData>;
  encoderId: string;
  lastHeartbeat: Date;
}

// Path mapping: translate server paths to remote encoder paths
const PATH_MAPPINGS: Array<{ server: string; remote: string }> = [
  {
    server: process.env.ENCODER_SERVER_ENCODING_PATH || "/media/encoding",
    remote: process.env.ENCODER_REMOTE_ENCODING_PATH || "/mnt/downloads/encoding",
  },
  {
    server: process.env.ENCODER_SERVER_MEDIA_PATH || "/media",
    remote: process.env.ENCODER_REMOTE_MEDIA_PATH || "/mnt/downloads",
  },
];

function translateToRemotePath(serverPath: string): string {
  for (const mapping of PATH_MAPPINGS) {
    if (serverPath.startsWith(mapping.server)) {
      return serverPath.replace(mapping.server, mapping.remote);
    }
  }
  return serverPath;
}

// =============================================================================
// Encoder Dispatch Service
// =============================================================================

class EncoderDispatchService {
  // Only track WebSocket connections in memory (unavoidable)
  private encoders: Map<string, ConnectedEncoder> = new Map();

  // Progress debouncing - tracks last DB write time per job to avoid connection pool exhaustion
  // This is safe to lose on restart since progress is non-critical and will be updated on next progress message
  private progressLastWritten: Map<string, number> = new Map();

  // Configuration
  private readonly tickIntervalMs = 5000; // Single unified tick every 5 seconds
  private readonly heartbeatTimeoutMs = 90000; // 90 seconds without heartbeat = offline
  private readonly assignedTimeoutMs = 30000; // 30 seconds in ASSIGNED state = stuck
  private readonly stallTimeoutMs = 120000; // 2 minutes without progress = stalled
  private readonly capacityBlockDurationMs = 10000; // 10 seconds block after capacity error
  private readonly progressDebounceMs = 5000; // Only write progress to DB every 5 seconds

  // Callbacks for pipeline integration (optional)
  onJobComplete?: (jobId: string, result: JobCompleteMessage) => void;
  onJobFailed?: (jobId: string, error: string) => void;

  // ==========================================================================
  // Initialization & Shutdown
  // ==========================================================================

  async initialize(): Promise<void> {
    // Set up job completion callbacks to trigger pipeline recovery
    this.onJobComplete = async (_jobId: string) => {
      // Trigger encoding recovery to detect and process completed jobs
      // This runs asynchronously without blocking
      const { recoverStuckEncodings } = await import("./encodingRecovery.js");
      recoverStuckEncodings().catch((err) =>
        console.error("[EncoderDispatch] Recovery failed after job completion:", err)
      );
    };

    this.onJobFailed = async (jobId: string, error: string) => {
      console.log(`[EncoderDispatch] Job ${jobId} failed: ${error}`);

      // Update the request and pipeline to reflect the failure
      try {
        const job = await prisma.job.findUnique({
          where: { id: jobId },
          select: { requestId: true },
        });

        if (job?.requestId) {
          // Update MediaRequest to FAILED
          await prisma.mediaRequest.update({
            where: { id: job.requestId },
            data: {
              status: "FAILED",
              error: `Encoding failed: ${error}`,
              currentStep: null,
            },
          });

          // Mark pipeline as FAILED
          await prisma.pipelineExecution.updateMany({
            where: {
              requestId: job.requestId,
              status: "RUNNING",
            },
            data: {
              status: "FAILED",
              error: `Encoding failed: ${error}`,
              completedAt: new Date(),
            },
          });

          console.log(`[EncoderDispatch] Marked request ${job.requestId} as FAILED`);
        }
      } catch (err) {
        console.error("[EncoderDispatch] Failed to update request after job failure:", err);
      }
    };

    // Recovery: Reset any ASSIGNED jobs to PENDING (server crashed mid-assignment)
    const resetAssigned = await prisma.encoderAssignment.updateMany({
      where: { status: "ASSIGNED" },
      data: { status: "PENDING", sentAt: null },
    });
    if (resetAssigned.count > 0) {
      console.log(
        `[EncoderDispatch] Recovery: Reset ${resetAssigned.count} ASSIGNED jobs to PENDING`
      );
    }

    // Recovery: Mark all encoders offline (they'll re-register)
    await prisma.remoteEncoder.updateMany({
      where: { status: { not: "OFFLINE" } },
      data: { status: "OFFLINE", currentJobs: 0 },
    });

    // Register single unified tick task
    const scheduler = getSchedulerService();
    scheduler.register("encoder-tick", "Encoder Tick", this.tickIntervalMs, () => this.tick());

    console.log(`[EncoderDispatch] Initialized with ${this.tickIntervalMs}ms tick interval`);
  }

  shutdown(): void {
    console.log("[EncoderDispatch] Shutting down...");

    const scheduler = getSchedulerService();
    scheduler.unregister("encoder-tick");

    // Send shutdown message to all encoders
    for (const encoder of this.encoders.values()) {
      this.send(encoder.ws, { type: "server:shutdown", reconnectDelay: 5000 });
      encoder.ws.close();
    }

    this.encoders.clear();
  }

  // ==========================================================================
  // Single Unified Tick Loop
  // ==========================================================================

  private async tick(): Promise<void> {
    try {
      // 1. Mark offline: Encoders with no heartbeat > 90s
      await this.markOfflineEncoders();

      // 2. Reset stuck: ASSIGNED jobs > 30s without acceptance
      await this.resetStuckAssignments();

      // 3. Detect stalls: ENCODING jobs > 2min without progress
      await this.detectStalledJobs();

      // 4. Detect stuck completed: ENCODING jobs at 100% with no progress for > 5min
      await this.detectStuckCompletedJobs();

      // 5. Assign jobs: Match PENDING jobs to available encoders
      await this.assignPendingJobs();
    } catch (error) {
      console.error("[EncoderDispatch] Tick error:", error);
    }
  }

  // ==========================================================================
  // Tick Substeps (Testable Methods)
  // ==========================================================================

  async markOfflineEncoders(): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.heartbeatTimeoutMs);

    for (const [encoderId, encoder] of this.encoders) {
      if (encoder.lastHeartbeat < cutoff) {
        console.warn(`[EncoderDispatch] Encoder ${encoderId} timed out (no heartbeat)`);
        encoder.ws.terminate();
        await this.handleDisconnect(encoderId);
      }
    }
  }

  async resetStuckAssignments(): Promise<void> {
    const cutoff = new Date(Date.now() - this.assignedTimeoutMs);

    // Find ASSIGNED jobs that were sent more than 30s ago
    const stuckJobs = await prisma.encoderAssignment.findMany({
      where: {
        status: "ASSIGNED",
        sentAt: { lt: cutoff },
      },
    });

    for (const job of stuckJobs) {
      console.warn(
        `[EncoderDispatch] Job ${job.jobId} stuck in ASSIGNED state, resetting to PENDING`
      );

      await prisma.encoderAssignment.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          sentAt: null,
          error: "Assignment timeout - encoder did not accept",
        },
      });
    }
  }

  async detectStalledJobs(): Promise<void> {
    const cutoff = new Date(Date.now() - this.stallTimeoutMs);

    // Find ENCODING jobs with no progress update in 2 minutes
    const stalledJobs = await prisma.encoderAssignment.findMany({
      where: {
        status: "ENCODING",
        lastProgressAt: { lt: cutoff },
      },
    });

    for (const job of stalledJobs) {
      console.warn(`[EncoderDispatch] Job ${job.jobId} stalled at ${job.progress.toFixed(1)}%`);
      await this.handleStalledJob(job);
    }

    // Also check for ENCODING jobs that never sent any progress
    const neverStarted = await prisma.encoderAssignment.findMany({
      where: {
        status: "ENCODING",
        lastProgressAt: null,
        startedAt: { lt: cutoff },
      },
    });

    for (const job of neverStarted) {
      console.warn(`[EncoderDispatch] Job ${job.jobId} never sent progress`);
      await this.handleStalledJob(job);
    }
  }

  async detectStuckCompletedJobs(): Promise<void> {
    const cutoff = new Date(Date.now() - 300000); // 5 minutes

    // Find ENCODING jobs at or near 100% progress with no update for 5+ minutes
    const stuckCompleted = await prisma.encoderAssignment.findMany({
      where: {
        status: "ENCODING",
        progress: { gte: 99.5 }, // 99.5% or higher
        lastProgressAt: { lt: cutoff },
      },
    });

    for (const job of stuckCompleted) {
      console.warn(
        `[EncoderDispatch] Job ${job.jobId} appears complete (${job.progress.toFixed(1)}%) but stuck in ENCODING state - marking as COMPLETED`
      );

      // Mark as completed since it reached 100%
      await prisma.encoderAssignment.update({
        where: { id: job.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });

      // Decrement encoder job count
      await prisma.remoteEncoder
        .update({
          where: { encoderId: job.encoderId },
          data: { currentJobs: { decrement: 1 } },
        })
        .catch(() => {});

      // Trigger completion callback with reconstructed result
      if (this.onJobComplete && job.outputPath) {
        this.onJobComplete(job.jobId, {
          type: "job:complete",
          jobId: job.jobId,
          outputPath: job.outputPath,
          outputSize: job.outputSize ? Number(job.outputSize) : 0,
          compressionRatio: job.compressionRatio || 0,
          duration:
            job.completedAt && job.startedAt
              ? (job.completedAt.getTime() - job.startedAt.getTime()) / 1000
              : 0,
        });
      }
      this.emitEncoderStatusUpdate(job.encoderId);
    }
  }

  private async handleStalledJob(job: EncoderAssignment): Promise<void> {
    // Send cancel to encoder
    const encoder = this.encoders.get(job.encoderId);
    if (encoder) {
      this.send(encoder.ws, { type: "job:cancel", jobId: job.jobId, reason: "Stalled" });
    }

    // Decrement encoder job count
    await prisma.remoteEncoder
      .update({
        where: { encoderId: job.encoderId },
        data: { currentJobs: { decrement: 1 } },
      })
      .catch(() => {});

    // Check retry eligibility
    const shouldRetry = job.attempt < job.maxAttempts;
    const shouldIncrementAttempt = job.progress > 0; // Only increment if actually started

    if (shouldRetry) {
      await prisma.encoderAssignment.update({
        where: { id: job.id },
        data: {
          status: "PENDING",
          sentAt: null,
          startedAt: null,
          lastProgressAt: null,
          progress: 0,
          attempt: shouldIncrementAttempt ? { increment: 1 } : undefined,
          error:
            job.progress > 0
              ? `Stalled at ${job.progress.toFixed(1)}%`
              : "Never started - requeuing",
        },
      });
      console.log(`[EncoderDispatch] Requeued stalled job ${job.jobId}`);
    } else {
      await prisma.encoderAssignment.update({
        where: { id: job.id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: `Stalled at ${job.progress.toFixed(1)}% after ${job.maxAttempts} attempts`,
        },
      });

      await prisma.remoteEncoder
        .update({
          where: { encoderId: job.encoderId },
          data: { totalJobsFailed: { increment: 1 } },
        })
        .catch(() => {});

      this.onJobFailed?.(job.jobId, "Job stalled");
    }
  }

  async assignPendingJobs(): Promise<void> {
    const now = new Date();

    // Get pending assignments
    const pendingJobs = await prisma.encoderAssignment.findMany({
      where: { status: "PENDING" },
      orderBy: { assignedAt: "asc" },
    });

    if (pendingJobs.length === 0) return;

    // Get available encoders from database
    const availableEncoders = await prisma.remoteEncoder.findMany({
      where: {
        status: { in: ["IDLE", "ENCODING"] },
        OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }],
      },
      orderBy: [{ currentJobs: "asc" }, { totalJobsCompleted: "desc" }],
    });

    type AvailableEncoderData = Prisma.RemoteEncoderGetPayload<Record<string, never>>;

    for (const job of pendingJobs) {
      // Verify input file exists
      if (!existsSync(job.inputPath)) {
        continue; // File not ready yet
      }

      // Find encoder with capacity
      const encoder = availableEncoders.find(
        (e: AvailableEncoderData) =>
          e.currentJobs < e.maxConcurrent && this.encoders.has(e.encoderId)
      );

      if (!encoder) {
        continue; // No available encoder
      }

      // Get encoding config from job payload
      const jobRecord = await prisma.job.findUnique({
        where: { id: job.jobId },
        select: { payload: true },
      });
      if (!jobRecord) continue;

      const payload = jobRecord.payload as { encodingConfig?: Record<string, unknown> };
      const encodingConfig = payload.encodingConfig;
      if (!encodingConfig) continue;

      // Get WebSocket connection
      const connection = this.encoders.get(encoder.encoderId);
      if (!connection) continue;

      // Send job assignment
      const assignMsg: JobAssignMessage = {
        type: "job:assign",
        jobId: job.jobId,
        inputPath: translateToRemotePath(job.inputPath),
        outputPath: translateToRemotePath(job.outputPath),
        encodingConfig: encodingConfig as unknown as EncodingConfig,
      };

      this.send(connection.ws, assignMsg);

      // Update to ASSIGNED status
      await prisma.encoderAssignment.update({
        where: { id: job.id },
        data: {
          status: "ASSIGNED",
          sentAt: now,
          encoderId: encoder.encoderId,
        },
      });

      // Increment encoder job count
      await prisma.remoteEncoder.update({
        where: { encoderId: encoder.encoderId },
        data: { currentJobs: { increment: 1 }, status: "ENCODING" },
      });

      // Update local capacity tracking for this tick
      encoder.currentJobs++;

      console.log(`[EncoderDispatch] Assigned job ${job.jobId} to ${encoder.encoderId}`);
      this.emitEncoderStatusUpdate(encoder.encoderId);
    }
  }

  // ==========================================================================
  // WebSocket Handlers
  // ==========================================================================

  handleConnection(): void {
    console.log(`[EncoderDispatch] New encoder connection`);
  }

  async handleMessage(
    ws: ServerWebSocket<EncoderWebSocketData>,
    data: string | Buffer
  ): Promise<void> {
    try {
      const dataStr = typeof data === "string" ? data : data.toString();
      const msg = JSON.parse(dataStr) as EncoderMessage;

      switch (msg.type) {
        case "register":
          await this.handleRegister(ws, msg);
          break;
        case "heartbeat":
          await this.handleHeartbeat(msg);
          break;
        case "job:accepted":
          await this.handleJobAccepted(msg.jobId, msg.encoderId);
          break;
        case "job:progress":
          await this.handleJobProgress(msg);
          break;
        case "job:complete":
          await this.handleJobComplete(msg);
          break;
        case "job:failed":
          await this.handleJobFailed(msg);
          break;
      }
    } catch (error) {
      console.error(`[EncoderDispatch] Message handling error:`, error);
    }
  }

  handleClose(ws: ServerWebSocket<EncoderWebSocketData>): void {
    const encoderId = ws.data.encoderId;
    if (encoderId) {
      this.handleDisconnect(encoderId);
    }
  }

  // ==========================================================================
  // Message Handlers
  // ==========================================================================

  private async handleRegister(
    ws: ServerWebSocket<EncoderWebSocketData>,
    msg: RegisterMessage
  ): Promise<void> {
    const { encoderId, gpuDevice, maxConcurrent, currentJobs, hostname, version, capabilities } =
      msg;

    // Upsert encoder in database
    await prisma.remoteEncoder.upsert({
      where: { encoderId },
      update: {
        gpuDevice,
        maxConcurrent,
        currentJobs,
        hostname,
        version,
        capabilities: capabilities
          ? (capabilities as unknown as Prisma.JsonObject)
          : Prisma.JsonNull,
        status: currentJobs > 0 ? "ENCODING" : "IDLE",
        lastHeartbeat: new Date(),
        blockedUntil: null,
      },
      create: {
        encoderId,
        gpuDevice,
        maxConcurrent,
        currentJobs,
        hostname,
        version,
        capabilities: capabilities
          ? (capabilities as unknown as Prisma.JsonObject)
          : Prisma.JsonNull,
        status: currentJobs > 0 ? "ENCODING" : "IDLE",
        lastHeartbeat: new Date(),
      },
    });

    // Store encoderId in WebSocket data
    ws.data.encoderId = encoderId;

    // Track connection (minimal in-memory state)
    this.encoders.set(encoderId, {
      ws,
      encoderId,
      lastHeartbeat: new Date(),
    });

    this.send(ws, { type: "registered" });

    console.log(
      `[EncoderDispatch] Encoder registered: ${encoderId} (${maxConcurrent} slots, GPU: ${gpuDevice})`
    );
    this.emitEncoderStatusUpdate(encoderId);
  }

  private async handleHeartbeat(msg: HeartbeatMessage): Promise<void> {
    const encoder = this.encoders.get(msg.encoderId);
    if (encoder) {
      encoder.lastHeartbeat = new Date();
    }

    // Get encoder to check capacity
    const dbEncoder = await prisma.remoteEncoder.findUnique({
      where: { encoderId: msg.encoderId },
      select: { maxConcurrent: true },
    });

    // Update database
    await prisma.remoteEncoder.update({
      where: { encoderId: msg.encoderId },
      data: {
        currentJobs: msg.currentJobs,
        status: msg.state === "ENCODING" ? "ENCODING" : "IDLE",
        lastHeartbeat: new Date(),
        // Clear block if encoder has capacity
        blockedUntil: dbEncoder && msg.currentJobs < dbEncoder.maxConcurrent ? null : undefined,
      },
    });

    // Respond with pong
    if (encoder) {
      this.send(encoder.ws, { type: "pong", timestamp: Date.now() });
    }
  }

  private async handleJobAccepted(jobId: string, encoderId: string): Promise<void> {
    // Transition from ASSIGNED to ENCODING
    await prisma.encoderAssignment.update({
      where: { jobId },
      data: {
        status: "ENCODING",
        startedAt: new Date(),
        lastProgressAt: new Date(),
      },
    });

    console.log(`[EncoderDispatch] Job ${jobId} accepted by ${encoderId}`);
  }

  private async handleJobProgress(msg: JobProgressMessage): Promise<void> {
    const now = Date.now();
    const lastWrite = this.progressLastWritten.get(msg.jobId) || 0;
    const timeSinceLastWrite = now - lastWrite;

    // Debounce database writes to prevent connection pool exhaustion
    // Only write if: first write, 5+ seconds since last write, or job is nearly complete (>95%)
    const shouldWriteToDb =
      lastWrite === 0 || timeSinceLastWrite >= this.progressDebounceMs || msg.progress >= 95;

    if (shouldWriteToDb) {
      this.progressLastWritten.set(msg.jobId, now);
      await prisma.encoderAssignment.update({
        where: { jobId: msg.jobId },
        data: {
          progress: msg.progress,
          fps: msg.fps,
          speed: msg.speed,
          eta: Math.round(msg.eta),
          lastProgressAt: new Date(),
        },
      });
    }

    // Always emit UI events using message data directly (no extra DB query)
    // We need requestId from DB, but we can cache this lookup
    const assignment = await this.getAssignmentForUI(msg.jobId);
    if (assignment?.requestId) {
      const events = getJobEventService();
      events.emitJobUpdate("progress", {
        id: msg.jobId,
        type: "remote:encode",
        status: "RUNNING",
        progress: msg.progress,
        progressCurrent: null,
        progressTotal: null,
        requestId: assignment.requestId,
        parentJobId: null,
        dedupeKey: null,
        error: null,
        startedAt: assignment.startedAt,
        completedAt: null,
      });
    }
  }

  // Cache for requestId lookups to avoid repeated DB queries during progress updates
  private assignmentCache: Map<string, { requestId: string; startedAt: Date | null }> = new Map();

  private async getAssignmentForUI(
    jobId: string
  ): Promise<{ requestId: string; startedAt: Date | null } | null> {
    // Check cache first
    const cached = this.assignmentCache.get(jobId);
    if (cached) {
      return cached;
    }

    // Fetch from DB and cache
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId },
      include: { job: { select: { requestId: true } } },
    });

    if (assignment?.job.requestId) {
      const data = { requestId: assignment.job.requestId, startedAt: assignment.startedAt };
      this.assignmentCache.set(jobId, data);
      return data;
    }

    return null;
  }

  private async handleJobComplete(msg: JobCompleteMessage): Promise<void> {
    const assignment = await prisma.encoderAssignment.update({
      where: { jobId: msg.jobId },
      data: {
        status: "COMPLETED",
        progress: 100,
        outputSize: BigInt(msg.outputSize),
        compressionRatio: msg.compressionRatio,
        encodeDuration: msg.duration,
        completedAt: new Date(),
      },
      include: { encoder: true },
    });

    // Update encoder stats
    await prisma.remoteEncoder.update({
      where: { encoderId: assignment.encoderId },
      data: {
        totalJobsCompleted: { increment: 1 },
        currentJobs: { decrement: 1 },
        status: "IDLE",
        blockedUntil: null,
      },
    });

    console.log(
      `[EncoderDispatch] Job ${msg.jobId} completed (${msg.compressionRatio.toFixed(2)}x compression)`
    );

    // Clean up caches
    this.cleanupJobCaches(msg.jobId);

    this.onJobComplete?.(msg.jobId, msg);
    this.emitEncoderStatusUpdate(assignment.encoderId);
  }

  private cleanupJobCaches(jobId: string): void {
    this.progressLastWritten.delete(jobId);
    this.assignmentCache.delete(jobId);
  }

  private async handleJobFailed(msg: JobFailedMessage): Promise<void> {
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId: msg.jobId },
    });
    if (!assignment) return;

    // Check if capacity error (not a real encoding failure)
    const isCapacityError =
      msg.error.toLowerCase().includes("encoder at capacity") ||
      msg.error.toLowerCase().includes("encoder disconnected") ||
      msg.error.toLowerCase().includes("no available encoder");

    if (isCapacityError) {
      // Block encoder temporarily
      await prisma.remoteEncoder.update({
        where: { encoderId: assignment.encoderId },
        data: { blockedUntil: new Date(Date.now() + this.capacityBlockDurationMs) },
      });

      // Requeue without incrementing attempt
      await prisma.encoderAssignment.update({
        where: { jobId: msg.jobId },
        data: {
          status: "PENDING",
          sentAt: null,
          error: msg.error,
        },
      });

      console.log(`[EncoderDispatch] Job ${msg.jobId} requeued (encoder at capacity)`);
      return;
    }

    // Real encoding failure
    await prisma.remoteEncoder.update({
      where: { encoderId: assignment.encoderId },
      data: { currentJobs: { decrement: 1 }, status: "IDLE" },
    });

    // Check for input file errors
    let shouldRetry = msg.retriable;
    if (shouldRetry && msg.error.toLowerCase().includes("input file not found")) {
      shouldRetry = existsSync(assignment.inputPath);
    }

    if (shouldRetry && assignment.attempt < assignment.maxAttempts) {
      await prisma.encoderAssignment.update({
        where: { jobId: msg.jobId },
        data: {
          status: "PENDING",
          sentAt: null,
          startedAt: null,
          lastProgressAt: null,
          progress: 0,
          attempt: { increment: 1 },
          error: msg.error,
        },
      });

      console.log(
        `[EncoderDispatch] Job ${msg.jobId} failed, retrying (attempt ${assignment.attempt + 1}/${assignment.maxAttempts})`
      );
    } else {
      await prisma.encoderAssignment.update({
        where: { jobId: msg.jobId },
        data: {
          status: "FAILED",
          error: msg.error,
          completedAt: new Date(),
        },
      });

      await prisma.remoteEncoder.update({
        where: { encoderId: assignment.encoderId },
        data: { totalJobsFailed: { increment: 1 } },
      });

      console.error(`[EncoderDispatch] Job ${msg.jobId} failed permanently: ${msg.error}`);
      this.onJobFailed?.(msg.jobId, msg.error);

      // Clean up caches for permanently failed jobs
      this.cleanupJobCaches(msg.jobId);
    }

    this.emitEncoderStatusUpdate(assignment.encoderId);
  }

  private async handleDisconnect(encoderId: string): Promise<void> {
    console.log(`[EncoderDispatch] Encoder disconnected: ${encoderId}`);

    // Mark encoder offline
    await prisma.remoteEncoder
      .update({
        where: { encoderId },
        data: { status: "OFFLINE", currentJobs: 0 },
      })
      .catch(() => {});

    // Reset any ASSIGNED or ENCODING jobs for this encoder to PENDING
    const jobs = await prisma.encoderAssignment.findMany({
      where: {
        encoderId,
        status: { in: ["ASSIGNED", "ENCODING"] },
      },
    });

    for (const job of jobs) {
      if (job.attempt < job.maxAttempts) {
        await prisma.encoderAssignment.update({
          where: { id: job.id },
          data: {
            status: "PENDING",
            sentAt: null,
            startedAt: null,
            lastProgressAt: null,
            progress: 0,
            attempt: { increment: 1 },
            error: "Encoder disconnected",
          },
        });
        console.log(`[EncoderDispatch] Requeued job ${job.jobId} (encoder disconnected)`);
      } else {
        await prisma.encoderAssignment.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            error: "Max retries exceeded after encoder disconnection",
            completedAt: new Date(),
          },
        });
        this.onJobFailed?.(job.jobId, "Encoder disconnected");
      }
    }

    this.encoders.delete(encoderId);
    this.emitEncoderStatusUpdate(encoderId);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Queue a new encoding job for remote execution.
   * Returns the assignment immediately - use getAssignmentStatus() to poll for completion.
   */
  async queueEncodingJob(
    jobId: string,
    inputPath: string,
    outputPath: string,
    _encodingConfig: Record<string, unknown>
  ): Promise<EncoderAssignment> {
    // Check for existing active assignment for same input file (deduplication)
    const existingAssignment = await prisma.encoderAssignment.findFirst({
      where: {
        inputPath,
        status: { in: ["PENDING", "ASSIGNED", "ENCODING"] },
      },
    });

    if (existingAssignment) {
      console.log(`[EncoderDispatch] Reusing existing assignment for ${inputPath}`);
      return existingAssignment;
    }

    // Select initial encoder
    const encoder = await prisma.remoteEncoder.findFirst({
      where: {
        status: { in: ["IDLE", "ENCODING"] },
        OR: [{ blockedUntil: null }, { blockedUntil: { lt: new Date() } }],
      },
      orderBy: [{ currentJobs: "asc" }, { totalJobsCompleted: "desc" }],
    });

    if (!encoder) {
      throw new Error("No encoders available");
    }

    // Create assignment
    const assignment = await prisma.encoderAssignment.create({
      data: {
        jobId,
        encoderId: encoder.encoderId,
        inputPath,
        outputPath,
        status: "PENDING",
      },
    });

    console.log(`[EncoderDispatch] Queued job ${jobId} for remote encoding`);
    return assignment;
  }

  /**
   * Get current status of an assignment (for polling)
   */
  async getAssignmentStatus(assignmentId: string): Promise<EncoderAssignment | null> {
    return prisma.encoderAssignment.findUnique({
      where: { id: assignmentId },
    });
  }

  /**
   * Cancel an encoding job
   */
  async cancelJob(jobId: string, reason?: string): Promise<boolean> {
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId },
    });
    if (!assignment) return false;

    const encoder = this.encoders.get(assignment.encoderId);
    if (encoder) {
      this.send(encoder.ws, { type: "job:cancel", jobId, reason });
    }

    await prisma.encoderAssignment.update({
      where: { jobId },
      data: {
        status: "CANCELLED",
        error: reason || "Cancelled by user",
        completedAt: new Date(),
      },
    });

    if (assignment.status === "ENCODING" || assignment.status === "ASSIGNED") {
      await prisma.remoteEncoder
        .update({
          where: { encoderId: assignment.encoderId },
          data: { currentJobs: { decrement: 1 } },
        })
        .catch(() => {});
    }

    return true;
  }

  /**
   * Check if remote encoding is available
   */
  isAvailable(): boolean {
    return this.encoders.size > 0;
  }

  /**
   * Check if any encoders are connected
   */
  hasEncoders(): boolean {
    return this.encoders.size > 0;
  }

  /**
   * Get count of connected encoders
   */
  getEncoderCount(): number {
    return this.encoders.size;
  }

  /**
   * Get encoder status for UI
   */
  async getEncoderStatus(): Promise<RemoteEncoder[]> {
    return prisma.remoteEncoder.findMany({
      orderBy: { encoderId: "asc" },
    });
  }

  /**
   * Get active assignments
   */
  async getActiveAssignments(): Promise<EncoderAssignment[]> {
    return prisma.encoderAssignment.findMany({
      where: { status: { in: ["PENDING", "ASSIGNED", "ENCODING"] } },
      orderBy: { assignedAt: "desc" },
    });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  private send(ws: ServerWebSocket<EncoderWebSocketData>, msg: ServerMessage): void {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  private emitEncoderStatusUpdate(encoderId: string): void {
    const events = getJobEventService();
    const encoder = this.encoders.get(encoderId);
    events.emitWorkerStatus({
      workerId: encoderId,
      hostname: encoderId,
      status: encoder ? "ACTIVE" : "STOPPED",
      lastHeartbeat: encoder?.lastHeartbeat || new Date(),
      runningJobs: 0, // Will be updated from DB
    });
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

let encoderDispatchService: EncoderDispatchService | null = null;

export function getEncoderDispatchService(): EncoderDispatchService {
  if (!encoderDispatchService) {
    encoderDispatchService = new EncoderDispatchService();
  }
  return encoderDispatchService;
}

export { EncoderDispatchService };
