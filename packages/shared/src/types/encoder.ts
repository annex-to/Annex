/**
 * Remote Encoder Protocol Types
 *
 * Defines the WebSocket message protocol between the main Annex server
 * and remote encoder VMs for distributed encoding.
 */

// =============================================================================
// Encoder State
// =============================================================================

export type EncoderState =
  | "CONNECTING"
  | "REGISTERING"
  | "IDLE"
  | "ENCODING"
  | "OFFLINE";

export type EncoderStatus = "OFFLINE" | "IDLE" | "ENCODING" | "ERROR";

export type AssignmentStatus =
  | "PENDING"
  | "ENCODING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

// =============================================================================
// Encoder -> Server Messages
// =============================================================================

export interface RegisterMessage {
  type: "register";
  encoderId: string;
  gpuDevice: string;
  maxConcurrent: number;
  currentJobs: number;
  hostname?: string;
  version?: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  encoderId: string;
  currentJobs: number;
  state: EncoderState;
  cpuUsage?: number;
  memoryUsage?: number;
}

export interface JobAcceptedMessage {
  type: "job:accepted";
  jobId: string;
  encoderId: string;
}

export interface JobProgressMessage {
  type: "job:progress";
  jobId: string;
  progress: number; // 0-100
  frame: number;
  fps: number;
  bitrate: number; // kbps
  totalSize: number; // bytes
  elapsedTime: number; // seconds
  speed: number; // x realtime
  eta: number; // seconds remaining
}

export interface JobCompleteMessage {
  type: "job:complete";
  jobId: string;
  outputPath: string;
  outputSize: number; // bytes
  compressionRatio: number;
  duration: number; // seconds to encode
}

export interface JobFailedMessage {
  type: "job:failed";
  jobId: string;
  error: string;
  retriable: boolean; // false if user cancelled or unrecoverable
}

export type EncoderMessage =
  | RegisterMessage
  | HeartbeatMessage
  | JobAcceptedMessage
  | JobProgressMessage
  | JobCompleteMessage
  | JobFailedMessage;

// =============================================================================
// Server -> Encoder Messages
// =============================================================================

export interface RegisteredMessage {
  type: "registered";
  serverVersion?: string;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

export interface JobAssignMessage {
  type: "job:assign";
  jobId: string;
  inputPath: string;
  outputPath: string;
  profileId: string;
  profile: EncodingProfileData;
}

export interface JobCancelMessage {
  type: "job:cancel";
  jobId: string;
  reason?: string;
}

export interface ServerShutdownMessage {
  type: "server:shutdown";
  reconnectDelay?: number; // ms to wait before reconnecting
}

export type ServerMessage =
  | RegisteredMessage
  | PongMessage
  | JobAssignMessage
  | JobCancelMessage
  | ServerShutdownMessage;

// =============================================================================
// Shared Data Structures
// =============================================================================

/**
 * Encoding profile data sent to remote encoders
 * Matches the structure in Prisma but serializable over WebSocket
 */
export interface EncodingProfileData {
  id: string;
  name: string;
  videoEncoder: string;
  videoQuality: number;
  videoMaxResolution: string;
  videoMaxBitrate: number | null;
  hwAccel: string;
  hwDevice: string | null;
  videoFlags: Record<string, unknown>;
  audioEncoder: string;
  audioFlags: Record<string, unknown>;
  subtitlesMode: string;
  container: string;
}

/**
 * Remote encoder information for API responses
 */
export interface RemoteEncoderInfo {
  id: string;
  encoderId: string;
  name: string | null;
  gpuDevice: string;
  maxConcurrent: number;
  status: EncoderStatus;
  currentJobs: number;
  lastHeartbeat: Date | null;
  totalJobsCompleted: number;
  totalJobsFailed: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Encoder assignment information for API responses
 */
export interface EncoderAssignmentInfo {
  id: string;
  jobId: string;
  encoderId: string;
  inputPath: string;
  outputPath: string;
  profileId: string;
  status: AssignmentStatus;
  attempt: number;
  maxAttempts: number;
  progress: number;
  fps: number | null;
  speed: number | null;
  eta: number | null;
  error: string | null;
  assignedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
