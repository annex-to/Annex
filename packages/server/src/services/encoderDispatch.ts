/**
 * Encoder Dispatch Service
 *
 * Manages the pool of remote encoders and dispatches encoding jobs.
 * Handles encoder registration, health monitoring, job assignment, and retries.
 */

import type { ServerWebSocket } from "bun";
import { existsSync } from "fs";
import { prisma } from "../db/client.js";
import { getJobEventService } from "./jobEvents.js";
import { getSchedulerService } from "./scheduler.js";
import type {
  EncoderMessage,
  ServerMessage,
  RegisterMessage,
  HeartbeatMessage,
  JobProgressMessage,
  JobCompleteMessage,
  JobFailedMessage,
  JobAssignMessage,
  EncodingProfileData,
} from "@annex/shared";
import type { EncodingProfile, RemoteEncoder, EncoderAssignment } from "@prisma/client";

// =============================================================================
// Types
// =============================================================================

// WebSocket data for encoder connections
export interface EncoderWebSocketData {
  type: "encoder";
  encoderId: string | null;
}

interface ConnectedEncoder {
  ws: ServerWebSocket<EncoderWebSocketData>;
  encoderId: string;
  lastHeartbeat: Date;
  currentJobs: Set<string>;
  maxConcurrent: number;
}

// Progress update throttling - cache progress in memory, write to DB periodically
interface CachedProgress {
  jobId: string;
  progress: number;
  fps: number | null;
  speed: number | null;
  eta: number;
  lastDbWrite: number;
  lastProgressAt: number; // Timestamp of last progress update (for stall detection)
  dirty: boolean;
}

// Path mapping: translate server paths to remote encoder paths
// Multiple mappings can be configured for different mount points
// Order matters: more specific paths should come first
const PATH_MAPPINGS: Array<{ server: string; remote: string }> = [
  // Encoding output: /media/encoding -> /mnt/downloads/encoding (most specific)
  {
    server: process.env.ENCODER_SERVER_ENCODING_PATH || "/media/encoding",
    remote: process.env.ENCODER_REMOTE_ENCODING_PATH || "/mnt/downloads/encoding",
  },
  // General media directory: /media -> /mnt/downloads (catches /media/completed, /media/downloads, etc.)
  {
    server: process.env.ENCODER_SERVER_MEDIA_PATH || "/media",
    remote: process.env.ENCODER_REMOTE_MEDIA_PATH || "/mnt/downloads",
  },
];

/**
 * Translate a server path to the remote encoder's mount path
 */
function translateToRemotePath(serverPath: string): string {
  for (const mapping of PATH_MAPPINGS) {
    if (serverPath.startsWith(mapping.server)) {
      return serverPath.replace(mapping.server, mapping.remote);
    }
  }
  return serverPath;
}

/**
 * Translate a remote encoder path back to the server path
 * Currently unused but kept for potential future use (e.g., verifying output paths)
 */
function _translateToServerPath(remotePath: string): string {
  for (const mapping of PATH_MAPPINGS) {
    if (remotePath.startsWith(mapping.remote)) {
      return remotePath.replace(mapping.remote, mapping.server);
    }
  }
  return remotePath;
}

export interface QueueEncodingJobResult {
  assignment: EncoderAssignment;
  waitForCompletion: () => Promise<EncoderAssignment>;
}

// =============================================================================
// Encoder Dispatch Service
// =============================================================================

class EncoderDispatchService {
  private encoders: Map<string, ConnectedEncoder> = new Map();
  private jobCompletionCallbacks: Map<string, {
    resolve: (assignment: EncoderAssignment) => void;
    reject: (error: Error) => void;
  }> = new Map();

  // Progress cache - buffer updates to reduce DB writes
  private progressCache: Map<string, CachedProgress> = new Map();
  // Cache requestId lookups to avoid repeated DB queries during progress updates
  private jobRequestIdCache: Map<string, { requestId: string; startedAt: Date | null }> = new Map();

  // Configuration
  private readonly heartbeatTimeout = 90000; // 90 seconds
  private readonly healthCheckIntervalMs = 30000; // 30 seconds
  private readonly progressWriteIntervalMs = 5000; // Write progress to DB every 5 seconds
  private readonly progressFlushIntervalMs = 2000; // Check for dirty progress every 2 seconds
  private readonly jobStallTimeoutMs = 120000; // 2 minutes without progress = job stalled

  // Callbacks for pipeline integration
  onJobComplete?: (jobId: string, result: JobCompleteMessage) => void;
  onJobFailed?: (jobId: string, error: string) => void;

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /**
   * Initialize the encoder dispatch service
   */
  initialize(): void {
    this.startHealthCheck();
    this.startProgressFlush();
    console.log(`[EncoderDispatch] Initialized`);
  }

  // ==========================================================================
  // WebSocket Handlers (called from Bun.serve())
  // ==========================================================================

  /**
   * Handle a new WebSocket connection
   */
  handleConnection(): void {
    console.log(`[EncoderDispatch] New encoder connection`);
  }

  /**
   * Handle a WebSocket message
   */
  async handleMessage(ws: ServerWebSocket<EncoderWebSocketData>, data: string | Buffer): Promise<void> {
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
          console.log(`[EncoderDispatch] Job ${msg.jobId} accepted by ${msg.encoderId}`);
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

  /**
   * Handle a WebSocket close
   */
  handleClose(ws: ServerWebSocket<EncoderWebSocketData>): void {
    const encoderId = ws.data.encoderId;
    if (encoderId) {
      this.handleDisconnect(encoderId);
    }
  }

  // ==========================================================================
  // Message Handlers
  // ==========================================================================

  private async handleRegister(ws: ServerWebSocket<EncoderWebSocketData>, msg: RegisterMessage): Promise<void> {
    const { encoderId, gpuDevice, maxConcurrent, currentJobs, hostname, version } = msg;

    // Upsert encoder in database
    await prisma.remoteEncoder.upsert({
      where: { encoderId },
      update: {
        gpuDevice,
        maxConcurrent,
        currentJobs,
        hostname,
        version,
        status: "IDLE",
        lastHeartbeat: new Date(),
      },
      create: {
        encoderId,
        gpuDevice,
        maxConcurrent,
        currentJobs,
        hostname,
        version,
        status: "IDLE",
        lastHeartbeat: new Date(),
      },
    });

    // Store encoderId in WebSocket data for close handling
    ws.data.encoderId = encoderId;

    // Track connection
    this.encoders.set(encoderId, {
      ws,
      encoderId,
      lastHeartbeat: new Date(),
      currentJobs: new Set(),
      maxConcurrent,
    });

    // Send acknowledgment
    this.send(ws, { type: "registered" });

    console.log(`[EncoderDispatch] Encoder registered: ${encoderId} (${maxConcurrent} slots, GPU: ${gpuDevice})`);

    // Emit status update
    this.emitEncoderStatusUpdate(encoderId);

    // Check for pending jobs to assign
    await this.tryAssignPendingJobs();
  }

  private async handleHeartbeat(msg: HeartbeatMessage): Promise<void> {
    const encoder = this.encoders.get(msg.encoderId);
    if (encoder) {
      encoder.lastHeartbeat = new Date();
    }

    await prisma.remoteEncoder.update({
      where: { encoderId: msg.encoderId },
      data: {
        currentJobs: msg.currentJobs,
        status: msg.state === "ENCODING" ? "ENCODING" : "IDLE",
        lastHeartbeat: new Date(),
      },
    });

    // Respond with pong
    if (encoder) {
      this.send(encoder.ws, { type: "pong", timestamp: Date.now() });
    }
  }

  private async handleJobProgress(msg: JobProgressMessage): Promise<void> {
    const now = Date.now();
    const cached = this.progressCache.get(msg.jobId);

    // Update in-memory cache (always)
    const updatedCache: CachedProgress = {
      jobId: msg.jobId,
      progress: msg.progress,
      fps: msg.fps,
      speed: msg.speed,
      eta: Math.round(msg.eta),
      lastDbWrite: cached?.lastDbWrite || 0,
      lastProgressAt: now, // Track when we last received progress for stall detection
      dirty: true,
    };
    this.progressCache.set(msg.jobId, updatedCache);

    // Only write to DB if enough time has passed since last write
    const shouldWriteToDb = now - updatedCache.lastDbWrite >= this.progressWriteIntervalMs;

    if (shouldWriteToDb) {
      updatedCache.lastDbWrite = now;
      updatedCache.dirty = false;

      // Non-blocking DB write - don't await
      prisma.encoderAssignment.updateMany({
        where: { jobId: msg.jobId },
        data: {
          progress: msg.progress,
          fps: msg.fps,
          speed: msg.speed,
          eta: Math.round(msg.eta),
        },
      }).catch((err) => {
        console.error(`[EncoderDispatch] Progress update failed for ${msg.jobId}:`, err.message);
      });
    }

    // Emit to UI immediately (no DB needed) - but only get requestId once
    // Use cached requestId if available to avoid DB lookup
    if (!this.jobRequestIdCache.has(msg.jobId)) {
      const assignment = await prisma.encoderAssignment.findUnique({
        where: { jobId: msg.jobId },
        include: { job: { select: { requestId: true } } },
      });
      if (assignment?.job.requestId) {
        this.jobRequestIdCache.set(msg.jobId, {
          requestId: assignment.job.requestId,
          startedAt: assignment.startedAt,
        });
      }
    }

    const cachedJobInfo = this.jobRequestIdCache.get(msg.jobId);
    if (cachedJobInfo?.requestId) {
      const events = getJobEventService();
      events.emitJobUpdate("progress", {
        id: msg.jobId,
        type: "remote:encode",
        status: "RUNNING",
        progress: msg.progress,
        progressCurrent: null,
        progressTotal: null,
        requestId: cachedJobInfo.requestId,
        parentJobId: null,
        dedupeKey: null,
        error: null,
        startedAt: cachedJobInfo.startedAt,
        completedAt: null,
      });
    }
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
      include: { encoder: true, job: true },
    });

    // Update encoder stats
    await prisma.remoteEncoder.update({
      where: { encoderId: assignment.encoderId },
      data: {
        totalJobsCompleted: { increment: 1 },
        currentJobs: { decrement: 1 },
        status: "IDLE",
      },
    });

    // Remove from in-memory tracking
    const encoder = this.encoders.get(assignment.encoderId);
    if (encoder) {
      encoder.currentJobs.delete(msg.jobId);
    }

    console.log(`[EncoderDispatch] Job ${msg.jobId} completed on ${assignment.encoderId} (${msg.compressionRatio.toFixed(2)}x compression)`);

    // Clean up progress cache
    this.cleanupJobCache(msg.jobId);

    // Notify completion callback
    const callback = this.jobCompletionCallbacks.get(msg.jobId);
    if (callback) {
      callback.resolve(assignment);
      this.jobCompletionCallbacks.delete(msg.jobId);
    }

    // Call pipeline callback
    this.onJobComplete?.(msg.jobId, msg);

    // Emit status updates
    this.emitEncoderStatusUpdate(assignment.encoderId);

    // Try to assign more jobs
    await this.tryAssignPendingJobs();
  }

  private async handleJobFailed(msg: JobFailedMessage): Promise<void> {
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId: msg.jobId },
      include: { encoder: true },
    });

    if (!assignment) return;

    // Update encoder stats
    await prisma.remoteEncoder.update({
      where: { encoderId: assignment.encoderId },
      data: {
        currentJobs: { decrement: 1 },
        status: "IDLE",
      },
    });

    // Remove from in-memory tracking
    const encoder = this.encoders.get(assignment.encoderId);
    if (encoder) {
      encoder.currentJobs.delete(msg.jobId);
    }

    // For "Input file not found" errors, verify the file actually exists on the server
    // If it doesn't exist here either, there's no point retrying
    let shouldRetry = msg.retriable;
    if (shouldRetry && msg.error.toLowerCase().includes("input file not found")) {
      const inputFileExists = existsSync(assignment.inputPath);
      if (!inputFileExists) {
        console.log(`[EncoderDispatch] Job ${msg.jobId} - input file does not exist on server: ${assignment.inputPath}`);
        shouldRetry = false;
      }
    }

    // Check if should retry (same encoder is fine)
    if (shouldRetry && assignment.attempt < assignment.maxAttempts) {
      console.log(`[EncoderDispatch] Job ${msg.jobId} failed, retrying (attempt ${assignment.attempt + 1}/${assignment.maxAttempts})`);

      // Find any available encoder (same encoder is fine)
      const newEncoderId = await this.selectEncoder();

      // Update assignment for retry
      await prisma.encoderAssignment.update({
        where: { jobId: msg.jobId },
        data: {
          status: "PENDING",
          attempt: { increment: 1 },
          error: msg.error,
          encoderId: newEncoderId || assignment.encoderId,
          startedAt: null,
          progress: 0,
        },
      });

      await this.tryAssignPendingJobs();
    } else {
      // No more retries - mark as failed
      await prisma.encoderAssignment.update({
        where: { jobId: msg.jobId },
        data: {
          status: "FAILED",
          error: msg.error,
          completedAt: new Date(),
        },
      });

      // Update encoder failed count
      await prisma.remoteEncoder.update({
        where: { encoderId: assignment.encoderId },
        data: {
          totalJobsFailed: { increment: 1 },
        },
      });

      console.error(`[EncoderDispatch] Job ${msg.jobId} failed permanently: ${msg.error}`);

      // Clean up progress cache on permanent failure
      this.cleanupJobCache(msg.jobId);

      // Notify completion callback with failure
      const callback = this.jobCompletionCallbacks.get(msg.jobId);
      if (callback) {
        callback.reject(new Error(msg.error));
        this.jobCompletionCallbacks.delete(msg.jobId);
      }

      // Call pipeline callback
      this.onJobFailed?.(msg.jobId, msg.error);
    }

    // Emit status updates
    this.emitEncoderStatusUpdate(assignment.encoderId);
  }

  private handleDisconnect(encoderId: string): void {
    const encoder = this.encoders.get(encoderId);
    if (!encoder) return;

    console.log(`[EncoderDispatch] Encoder disconnected: ${encoderId}`);

    // Mark encoder as offline
    prisma.remoteEncoder.update({
      where: { encoderId },
      data: { status: "OFFLINE", currentJobs: 0 },
    }).catch(console.error);

    // Re-queue any jobs that were assigned to this encoder
    for (const jobId of encoder.currentJobs) {
      this.requeueJob(jobId, encoderId);
    }

    this.encoders.delete(encoderId);
    this.emitEncoderStatusUpdate(encoderId);
  }

  // ==========================================================================
  // Job Management
  // ==========================================================================

  private async requeueJob(jobId: string, failedEncoderId: string): Promise<void> {
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId },
    });

    if (!assignment || assignment.status === "COMPLETED") return;

    if (assignment.attempt < assignment.maxAttempts) {
      // Find new encoder (excluding failed one)
      const newEncoderId = await this.selectEncoder(failedEncoderId);

      if (newEncoderId) {
        await prisma.encoderAssignment.update({
          where: { jobId },
          data: {
            status: "PENDING",
            attempt: { increment: 1 },
            encoderId: newEncoderId,
            error: "Encoder disconnected",
            startedAt: null,
            progress: 0,
          },
        });

        console.log(`[EncoderDispatch] Requeued job ${jobId} from ${failedEncoderId} to ${newEncoderId}`);
        await this.tryAssignPendingJobs();
      } else {
        // No available encoders - keep pending
        await prisma.encoderAssignment.update({
          where: { jobId },
          data: {
            status: "PENDING",
            error: "Encoder disconnected, waiting for available encoder",
            startedAt: null,
            progress: 0,
          },
        });
      }
    } else {
      // Max retries exceeded
      await prisma.encoderAssignment.update({
        where: { jobId },
        data: {
          status: "FAILED",
          error: "Max retries exceeded after encoder disconnection",
          completedAt: new Date(),
        },
      });

      // Notify callback
      const callback = this.jobCompletionCallbacks.get(jobId);
      if (callback) {
        callback.reject(new Error("Max retries exceeded"));
        this.jobCompletionCallbacks.delete(jobId);
      }

      this.onJobFailed?.(jobId, "Max retries exceeded");
    }
  }

  /**
   * Select the best encoder for a new job (least busy with capacity)
   */
  private async selectEncoder(excludeId?: string): Promise<string | null> {
    // First try connected encoders with capacity
    for (const [encoderId, encoder] of this.encoders) {
      if (excludeId && encoderId === excludeId) continue;
      if (encoder.currentJobs.size < encoder.maxConcurrent) {
        return encoderId;
      }
    }

    // Fall back to database query for any available encoder
    const encoder = await prisma.remoteEncoder.findFirst({
      where: {
        status: { in: ["IDLE", "ENCODING"] },
        encoderId: excludeId ? { not: excludeId } : undefined,
      },
      orderBy: [
        { currentJobs: "asc" },
        { totalJobsCompleted: "desc" },
      ],
    });

    if (encoder && encoder.currentJobs < encoder.maxConcurrent) {
      return encoder.encoderId;
    }

    return null;
  }

  /**
   * Queue a new encoding job for remote execution
   * Returns the assignment and a promise that resolves when encoding completes
   */
  async queueEncodingJob(
    jobId: string,
    inputPath: string,
    outputPath: string,
    profileId: string,
  ): Promise<QueueEncodingJobResult> {
    // Check for existing active assignment for the same input file
    // This prevents duplicate encodes when multiple jobs target the same file
    const existingAssignment = await prisma.encoderAssignment.findFirst({
      where: {
        inputPath,
        status: { in: ["PENDING", "ENCODING"] },
      },
    });

    if (existingAssignment) {
      console.log(`[EncoderDispatch] Reusing existing assignment ${existingAssignment.jobId} for ${inputPath}`);

      // Return the existing assignment with a completion promise
      const waitForCompletion = (): Promise<EncoderAssignment> => {
        return new Promise((resolve, reject) => {
          // Check if there's already a callback registered
          const existingCallback = this.jobCompletionCallbacks.get(existingAssignment.jobId);
          if (existingCallback) {
            // Chain onto existing callback
            const originalResolve = existingCallback.resolve;
            const originalReject = existingCallback.reject;
            this.jobCompletionCallbacks.set(existingAssignment.jobId, {
              resolve: (result) => { originalResolve(result); resolve(result); },
              reject: (err) => { originalReject(err); reject(err); },
            });
          } else {
            this.jobCompletionCallbacks.set(existingAssignment.jobId, { resolve, reject });
          }
        });
      };

      return { assignment: existingAssignment, waitForCompletion };
    }

    // Select initial encoder (prefer one with capacity, but accept any connected encoder)
    let encoderId = await this.selectEncoder();

    // If no encoder has capacity, use any connected encoder - job will queue
    if (!encoderId) {
      const connectedEncoders = Array.from(this.encoders.keys());
      if (connectedEncoders.length > 0) {
        encoderId = connectedEncoders[0];
        console.log(`[EncoderDispatch] No encoder with capacity, queuing job for ${encoderId}`);
      } else {
        throw new Error("No encoders connected");
      }
    }

    // Create assignment
    const assignment = await prisma.encoderAssignment.create({
      data: {
        jobId,
        encoderId,
        inputPath,
        outputPath,
        profileId,
        status: "PENDING",
      },
    });

    console.log(`[EncoderDispatch] Queued job ${jobId} for remote encoding (assigned to ${encoderId})`);

    // Create completion promise
    const waitForCompletion = (): Promise<EncoderAssignment> => {
      return new Promise((resolve, reject) => {
        this.jobCompletionCallbacks.set(jobId, { resolve, reject });
      });
    };

    // Try to assign immediately
    await this.tryAssignPendingJobs();

    return { assignment, waitForCompletion };
  }

  /**
   * Try to assign pending jobs to available encoders
   */
  private async tryAssignPendingJobs(): Promise<void> {
    // Get pending assignments
    const pendingAssignments = await prisma.encoderAssignment.findMany({
      where: { status: "PENDING" },
      include: { encoder: true },
      orderBy: { assignedAt: "asc" },
    });

    if (pendingAssignments.length > 0) {
      const connectedEncoders = Array.from(this.encoders.entries()).map(([id, e]) =>
        `${id}(${e.currentJobs.size}/${e.maxConcurrent})`
      );
      console.log(`[EncoderDispatch] ${pendingAssignments.length} pending jobs, connected encoders: [${connectedEncoders.join(", ")}]`);
    }

    for (const assignment of pendingAssignments) {
      const encoder = this.encoders.get(assignment.encoderId);

      // Check if encoder is connected and has capacity
      if (!encoder || encoder.currentJobs.size >= encoder.maxConcurrent) {
        // Try to find ANY available encoder (don't exclude current - it might have reconnected)
        const newEncoderId = await this.selectEncoder();
        if (newEncoderId && this.encoders.has(newEncoderId)) {
          console.log(`[EncoderDispatch] Reassigning job ${assignment.jobId} from ${assignment.encoderId} to ${newEncoderId}`);
          await prisma.encoderAssignment.update({
            where: { id: assignment.id },
            data: { encoderId: newEncoderId },
          });
          assignment.encoderId = newEncoderId;
        } else {
          console.log(`[EncoderDispatch] No available encoder for job ${assignment.jobId} (assigned to ${assignment.encoderId})`);
          continue; // Skip, no available encoder
        }
      }

      // Verify input file exists before dispatching (prevents premature dispatch)
      if (!existsSync(assignment.inputPath)) {
        console.log(`[EncoderDispatch] Skipping job ${assignment.jobId} - input file not ready: ${assignment.inputPath}`);
        continue; // File not ready yet, will be picked up on next try
      }

      // Get profile
      const profile = await prisma.encodingProfile.findUnique({
        where: { id: assignment.profileId },
      });

      if (!profile) {
        console.error(`[EncoderDispatch] Profile not found: ${assignment.profileId}`);
        continue;
      }

      // Get target encoder
      const targetEncoder = this.encoders.get(assignment.encoderId);
      if (!targetEncoder) continue;

      // Send job assignment with translated paths for remote filesystem
      const serializedProfile = this.serializeProfile(profile);
      const assignMsg: JobAssignMessage = {
        type: "job:assign",
        jobId: assignment.jobId,
        inputPath: translateToRemotePath(assignment.inputPath),
        outputPath: translateToRemotePath(assignment.outputPath),
        profileId: assignment.profileId,
        profile: serializedProfile,
      };

      console.log(`[EncoderDispatch] Sending profile with hwAccel="${serializedProfile.hwAccel}" videoEncoder="${serializedProfile.videoEncoder}"`);
      this.send(targetEncoder.ws, assignMsg);
      targetEncoder.currentJobs.add(assignment.jobId);

      console.log(`[EncoderDispatch] Paths translated: ${assignment.inputPath} -> ${assignMsg.inputPath}`);

      // Initialize progress cache for stall detection
      const now = Date.now();
      this.progressCache.set(assignment.jobId, {
        jobId: assignment.jobId,
        progress: 0,
        fps: null,
        speed: null,
        eta: 0,
        lastDbWrite: now,
        lastProgressAt: now, // Start tracking from assignment time
        dirty: false,
      });

      // Update assignment status
      await prisma.encoderAssignment.update({
        where: { id: assignment.id },
        data: {
          status: "ENCODING",
          startedAt: new Date(),
        },
      });

      // Update encoder state
      await prisma.remoteEncoder.update({
        where: { encoderId: assignment.encoderId },
        data: {
          currentJobs: { increment: 1 },
          status: "ENCODING",
        },
      });

      console.log(`[EncoderDispatch] Assigned job ${assignment.jobId} to ${assignment.encoderId}`);
      this.emitEncoderStatusUpdate(assignment.encoderId);
    }
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
      this.send(encoder.ws, {
        type: "job:cancel",
        jobId,
        reason,
      });
    }

    await prisma.encoderAssignment.update({
      where: { jobId },
      data: {
        status: "CANCELLED",
        error: reason || "Cancelled by user",
        completedAt: new Date(),
      },
    });

    // Remove completion callback
    const callback = this.jobCompletionCallbacks.get(jobId);
    if (callback) {
      callback.reject(new Error("Job cancelled"));
      this.jobCompletionCallbacks.delete(jobId);
    }

    return true;
  }

  // ==========================================================================
  // Profile Serialization
  // ==========================================================================

  private serializeProfile(profile: EncodingProfile): EncodingProfileData {
    return {
      id: profile.id,
      name: profile.name,
      videoEncoder: profile.videoEncoder,
      videoQuality: profile.videoQuality,
      videoMaxResolution: profile.videoMaxResolution,
      videoMaxBitrate: profile.videoMaxBitrate,
      hwAccel: profile.hwAccel,
      hwDevice: profile.hwDevice,
      videoFlags: profile.videoFlags as Record<string, unknown>,
      audioEncoder: profile.audioEncoder,
      audioFlags: profile.audioFlags as Record<string, unknown>,
      subtitlesMode: profile.subtitlesMode,
      container: profile.container,
    };
  }

  // ==========================================================================
  // Health Monitoring
  // ==========================================================================

  private startHealthCheck(): void {
    const scheduler = getSchedulerService();
    scheduler.register(
      "encoder-health",
      "Encoder Health Check",
      this.healthCheckIntervalMs,
      async () => {
        const now = new Date();

        // Check encoder heartbeats
        for (const [encoderId, encoder] of this.encoders) {
          const elapsed = now.getTime() - encoder.lastHeartbeat.getTime();

          if (elapsed > this.heartbeatTimeout) {
            console.warn(`[EncoderDispatch] Encoder ${encoderId} health check failed (${elapsed}ms since last heartbeat)`);
            encoder.ws.terminate();
            this.handleDisconnect(encoderId);
          }
        }

        // Check for stalled jobs (no progress updates for too long)
        await this.checkStalledJobs();

        // Try to assign any pending jobs that might be waiting
        await this.tryAssignPendingJobs();
      }
    );
  }

  /**
   * Check for jobs that haven't received progress updates and are likely stalled
   */
  private async checkStalledJobs(): Promise<void> {
    const now = Date.now();

    // Get all ENCODING assignments from the database
    const activeAssignments = await prisma.encoderAssignment.findMany({
      where: { status: "ENCODING" },
    });

    for (const assignment of activeAssignments) {
      const cached = this.progressCache.get(assignment.jobId);

      // If we have cached progress, check the last progress time
      if (cached) {
        const timeSinceProgress = now - cached.lastProgressAt;
        if (timeSinceProgress > this.jobStallTimeoutMs) {
          console.warn(`[EncoderDispatch] Job ${assignment.jobId} appears stalled (${Math.round(timeSinceProgress / 1000)}s since last progress at ${cached.progress.toFixed(1)}%)`);
          await this.handleStalledJob(assignment.jobId, assignment.encoderId, cached.progress);
        }
      } else {
        // No cached progress but job is marked as ENCODING - check startedAt
        if (assignment.startedAt) {
          const timeSinceStart = now - assignment.startedAt.getTime();
          // Give jobs 2x the stall timeout to send their first progress update
          if (timeSinceStart > this.jobStallTimeoutMs * 2) {
            console.warn(`[EncoderDispatch] Job ${assignment.jobId} never sent progress (${Math.round(timeSinceStart / 1000)}s since start)`);
            await this.handleStalledJob(assignment.jobId, assignment.encoderId, 0);
          }
        }
      }
    }
  }

  /**
   * Handle a job that appears to be stalled
   */
  private async handleStalledJob(jobId: string, encoderId: string, lastProgress: number): Promise<void> {
    // Get current assignment
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId },
    });

    if (!assignment || assignment.status !== "ENCODING") {
      return; // Already handled or not encoding
    }

    // Clean up encoder tracking
    const encoder = this.encoders.get(encoderId);
    if (encoder) {
      encoder.currentJobs.delete(jobId);
      // Send cancel message to encoder in case it's still alive
      this.send(encoder.ws, {
        type: "job:cancel",
        jobId,
        reason: "Job stalled - no progress updates received",
      });
    }

    // Update encoder state
    await prisma.remoteEncoder.update({
      where: { encoderId },
      data: {
        currentJobs: { decrement: 1 },
        status: encoder && encoder.currentJobs.size === 0 ? "IDLE" : "ENCODING",
      },
    }).catch(() => {}); // Ignore if encoder doesn't exist

    // Check if we should retry
    // Don't count against retry limit if job never started (0% progress)
    // This happens when encoders are busy and can't accept new jobs
    const shouldIncrementAttempt = lastProgress > 0;
    const effectiveAttempt = shouldIncrementAttempt ? assignment.attempt + 1 : assignment.attempt;

    if (effectiveAttempt <= assignment.maxAttempts) {
      if (shouldIncrementAttempt) {
        console.log(`[EncoderDispatch] Retrying stalled job ${jobId} (attempt ${effectiveAttempt}/${assignment.maxAttempts})`);
      } else {
        console.log(`[EncoderDispatch] Requeuing job ${jobId} - never started (encoders may be busy)`);
      }

      // Try to find any available encoder (same encoder is fine)
      const newEncoderId = await this.selectEncoder();

      await prisma.encoderAssignment.update({
        where: { jobId },
        data: {
          status: "PENDING",
          attempt: shouldIncrementAttempt ? { increment: 1 } : undefined,
          error: lastProgress > 0
            ? `Job stalled at ${lastProgress.toFixed(1)}% - retrying`
            : "Job never started - requeuing",
          encoderId: newEncoderId || encoderId,
          startedAt: null,
          progress: 0,
          fps: null,
          speed: null,
          eta: null,
        },
      });

      // Clean up cache
      this.cleanupJobCache(jobId);

      // Try to reassign
      await this.tryAssignPendingJobs();
    } else {
      // Max retries exceeded - mark as failed
      console.error(`[EncoderDispatch] Job ${jobId} failed - stalled after max retries`);

      await prisma.encoderAssignment.update({
        where: { jobId },
        data: {
          status: "FAILED",
          error: `Job stalled at ${lastProgress.toFixed(1)}% after ${assignment.maxAttempts} attempts`,
          completedAt: new Date(),
        },
      });

      // Update encoder failed count
      await prisma.remoteEncoder.update({
        where: { encoderId },
        data: {
          totalJobsFailed: { increment: 1 },
        },
      }).catch(() => {});

      // Clean up cache
      this.cleanupJobCache(jobId);

      // Notify callback
      const callback = this.jobCompletionCallbacks.get(jobId);
      if (callback) {
        callback.reject(new Error(`Job stalled at ${lastProgress.toFixed(1)}%`));
        this.jobCompletionCallbacks.delete(jobId);
      }

      this.onJobFailed?.(jobId, `Job stalled at ${lastProgress.toFixed(1)}%`);
    }

    this.emitEncoderStatusUpdate(encoderId);
  }

  /**
   * Start periodic progress flush to ensure dirty progress gets written to DB
   */
  private startProgressFlush(): void {
    const scheduler = getSchedulerService();
    scheduler.register(
      "encoder-progress-flush",
      "Encoder Progress Flush",
      this.progressFlushIntervalMs,
      async () => {
        await this.flushProgressUpdates();
      }
    );
  }

  /**
   * Flush any dirty progress updates to the database
   */
  private async flushProgressUpdates(): Promise<void> {
    const now = Date.now();
    const toFlush: CachedProgress[] = [];

    for (const cached of this.progressCache.values()) {
      // Flush if dirty and enough time has passed
      if (cached.dirty && now - cached.lastDbWrite >= this.progressWriteIntervalMs) {
        toFlush.push(cached);
      }
    }

    // Batch update - one query per dirty job (could be optimized further with raw SQL)
    for (const cached of toFlush) {
      cached.lastDbWrite = now;
      cached.dirty = false;

      prisma.encoderAssignment.updateMany({
        where: { jobId: cached.jobId },
        data: {
          progress: cached.progress,
          fps: cached.fps,
          speed: cached.speed,
          eta: cached.eta,
        },
      }).catch((err) => {
        console.error(`[EncoderDispatch] Flush progress update failed for ${cached.jobId}:`, err.message);
      });
    }
  }

  /**
   * Clean up progress cache for a completed/failed job
   */
  private cleanupJobCache(jobId: string): void {
    this.progressCache.delete(jobId);
    this.jobRequestIdCache.delete(jobId);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  private send(ws: ServerWebSocket<EncoderWebSocketData>, msg: ServerMessage): void {
    // Bun WebSocket readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    }
  }

  private emitEncoderStatusUpdate(encoderId: string): void {
    // Emit via job events for UI
    const events = getJobEventService();
    events.emitWorkerStatus({
      workerId: encoderId,
      hostname: this.encoders.get(encoderId)?.encoderId || encoderId,
      status: this.encoders.has(encoderId) ? "ACTIVE" : "STOPPED",
      lastHeartbeat: this.encoders.get(encoderId)?.lastHeartbeat || new Date(),
      runningJobs: this.encoders.get(encoderId)?.currentJobs.size || 0,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Check if remote encoding is available (at least one encoder online)
   */
  isAvailable(): boolean {
    for (const encoder of this.encoders.values()) {
      if (encoder.currentJobs.size < encoder.maxConcurrent) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if any encoders are connected (even if busy)
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
      where: {
        status: { in: ["PENDING", "ENCODING"] },
      },
      orderBy: { assignedAt: "desc" },
    });
  }

  /**
   * Shutdown the service
   */
  shutdown(): void {
    console.log("[EncoderDispatch] Shutting down...");

    // Unregister scheduler tasks
    const scheduler = getSchedulerService();
    scheduler.unregister("encoder-health");
    scheduler.unregister("encoder-progress-flush");

    // Final flush of progress updates
    this.flushProgressUpdates().catch(console.error);

    // Clear caches
    this.progressCache.clear();
    this.jobRequestIdCache.clear();

    // Send shutdown message to all encoders
    for (const encoder of this.encoders.values()) {
      this.send(encoder.ws, {
        type: "server:shutdown",
        reconnectDelay: 5000,
      });
      encoder.ws.close();
    }

    this.encoders.clear();
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
