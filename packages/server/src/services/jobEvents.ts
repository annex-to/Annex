/**
 * Job Events Service
 *
 * Event emitter for real-time job status updates.
 * Used by tRPC subscriptions to push job updates to connected clients.
 */

import { EventEmitter } from "events";

// Job update event types
export type JobUpdateType =
  | "created"
  | "started"
  | "progress"
  | "completed"
  | "failed"
  | "cancelled";

// Minimal job info for events (avoids large payloads)
export interface JobEventData {
  id: string;
  type: string;
  status: string;
  progress: number;
  progressCurrent: number | null;
  progressTotal: number | null;
  requestId: string | null;
  parentJobId: string | null;
  dedupeKey: string | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface JobUpdateEvent {
  eventType: JobUpdateType;
  job: JobEventData;
  timestamp: Date;
}

// Worker status event
export interface WorkerStatusEvent {
  workerId: string;
  hostname: string;
  status: "ACTIVE" | "STOPPED" | "DEAD";
  lastHeartbeat: Date;
  runningJobs: number;
}

// GPU status event
export interface GpuStatusEvent {
  devicePath: string;
  activeCount: number;
  maxConcurrent: number;
  jobId: string | null;
}

class JobEventService extends EventEmitter {
  constructor() {
    super();
    // Allow many listeners (for many connected clients)
    this.setMaxListeners(1000);
  }

  /**
   * Emit a job update event
   */
  emitJobUpdate(eventType: JobUpdateType, job: JobEventData): void {
    const event: JobUpdateEvent = {
      eventType,
      job,
      timestamp: new Date(),
    };

    this.emit("job-update", event);

    // Also emit to request-specific channel if job has a request
    if (job.requestId) {
      this.emit(`request-jobs:${job.requestId}`, event);
    }

    // Emit to parent job channel if this is a child job
    if (job.parentJobId) {
      this.emit(`child-jobs:${job.parentJobId}`, event);
    }
  }

  /**
   * Emit worker status update
   */
  emitWorkerStatus(status: WorkerStatusEvent): void {
    this.emit("worker-status", status);
  }

  /**
   * Emit GPU status update
   */
  emitGpuStatus(status: GpuStatusEvent): void {
    this.emit("gpu-status", status);
  }

  /**
   * Subscribe to all job updates
   */
  onJobUpdate(handler: (event: JobUpdateEvent) => void): () => void {
    this.on("job-update", handler);
    return () => this.off("job-update", handler);
  }

  /**
   * Subscribe to job updates for a specific request
   */
  onRequestJobs(requestId: string, handler: (event: JobUpdateEvent) => void): () => void {
    const channel = `request-jobs:${requestId}`;
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }

  /**
   * Subscribe to child job updates for a specific parent job
   */
  onChildJobs(parentJobId: string, handler: (event: JobUpdateEvent) => void): () => void {
    const channel = `child-jobs:${parentJobId}`;
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }

  /**
   * Subscribe to worker status updates
   */
  onWorkerStatus(handler: (status: WorkerStatusEvent) => void): () => void {
    this.on("worker-status", handler);
    return () => this.off("worker-status", handler);
  }

  /**
   * Subscribe to GPU status updates
   */
  onGpuStatus(handler: (status: GpuStatusEvent) => void): () => void {
    this.on("gpu-status", handler);
    return () => this.off("gpu-status", handler);
  }
}

// Singleton instance
let jobEventService: JobEventService | null = null;

export function getJobEventService(): JobEventService {
  if (!jobEventService) {
    jobEventService = new JobEventService();
  }
  return jobEventService;
}

export { JobEventService };
