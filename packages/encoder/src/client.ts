/**
 * Encoder WebSocket Client
 *
 * Handles communication with the main Annex server:
 * - Registration and heartbeats
 * - Receiving job assignments
 * - Reporting job progress and completion
 * - Auto-reconnection with exponential backoff
 */

import * as os from "os";
import type {
  EncoderState,
  EncoderMessage,
  ServerMessage,
  RegisterMessage,
  HeartbeatMessage,
  JobAcceptedMessage,
  JobCompleteMessage,
  JobFailedMessage,
  JobAssignMessage,
} from "@annex/shared";
import { getConfig, type EncoderConfig } from "./config.js";
import { encode } from "./encoder.js";
import { validateEnvironment, detectCapabilities } from "./validation.js";

interface ActiveJob {
  jobId: string;
  inputPath: string;
  outputPath: string;
  abortController: AbortController;
  startTime: number;
}

// Throttle log warnings to avoid log spam
let lastDisconnectedWarning = 0;
let lastCapacityWarning = 0;
const WARNING_THROTTLE_INTERVAL = 1000;

export class EncoderClient {
  private config: EncoderConfig;
  private ws: WebSocket | null = null;
  private state: EncoderState = "OFFLINE";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private activeJobs: Map<string, ActiveJob> = new Map();
  private shuttingDown = false;

  constructor() {
    this.config = getConfig();
  }

  /**
   * Start the encoder client
   */
  async start(): Promise<void> {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║    ██████╗███╗   ██╗ ██████╗ ██████╗ ██████╗ ███████╗██████╗  ║
║   ██╔════╝████╗  ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝██╔══██╗ ║
║   █████╗  ██╔██╗ ██║██║     ██║   ██║██║  ██║█████╗  ██████╔╝ ║
║   ██╔══╝  ██║╚██╗██║██║     ██║   ██║██║  ██║██╔══╝  ██╔══██╗ ║
║   ███████╗██║ ╚████║╚██████╗╚██████╔╝██████╔╝███████╗██║  ██║ ║
║   ╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝ ║
║                                                               ║
║    Annex Remote Encoder                                       ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝

Encoder ID: ${this.config.encoderId}
GPU Device: ${this.config.gpuDevice}
Max Concurrent: ${this.config.maxConcurrent}
Server: ${this.config.serverUrl}
`);

    // Validate environment before connecting
    const validation = await validateEnvironment();
    if (!validation.valid) {
      console.error("\n❌ Encoder validation failed. Please fix the errors above before starting.\n");
      process.exit(1);
    }

    if (validation.warnings.length > 0) {
      console.warn("\n⚠️  Starting with warnings - some features may not work correctly.\n");
    }

    this.connect();
  }

  /**
   * Stop the encoder client gracefully
   */
  async stop(): Promise<void> {
    console.log("[Client] Shutting down...");
    this.shuttingDown = true;

    // Stop reconnection attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Cancel all active jobs
    for (const [jobId, job] of this.activeJobs) {
      console.log(`[Client] Cancelling job ${jobId}`);
      job.abortController.abort();
    }

    // Wait for jobs to finish (with timeout)
    if (this.activeJobs.size > 0) {
      console.log(`[Client] Waiting for ${this.activeJobs.size} active jobs to finish...`);
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.activeJobs.size === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 500);

        // Force resolve after 30 seconds
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, 30000);
      });
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    console.log("[Client] Shutdown complete");
  }

  /**
   * Connect to the server
   */
  private connect(): void {
    if (this.shuttingDown) return;

    this.state = "CONNECTING";
    console.log(`[Client] Connecting to ${this.config.serverUrl}...`);

    this.ws = new WebSocket(this.config.serverUrl);

    this.ws.onopen = async () => {
      console.log("[Client] Connected");
      this.state = "REGISTERING";
      this.reconnectAttempts = 0;
      await this.register();
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(typeof event.data === "string" ? event.data : event.data.toString());
    };

    this.ws.onclose = (event) => {
      console.log(`[Client] Disconnected: ${event.code} ${event.reason}`);
      this.handleDisconnect();
    };

    this.ws.onerror = (event) => {
      console.error("[Client] WebSocket error:", event);
    };
  }

  /**
   * Handle WebSocket disconnection
   */
  private handleDisconnect(): void {
    this.state = "OFFLINE";

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Attempt reconnection
    if (!this.shuttingDown) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    const delay = Math.min(
      this.config.reconnectInterval * Math.pow(2, this.reconnectAttempts),
      this.config.maxReconnectInterval
    );

    console.log(`[Client] Reconnecting in ${delay / 1000}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, delay);
  }

  /**
   * Register with the server
   */
  private async register(): Promise<void> {
    console.log("[Client] Detecting encoder capabilities...");
    const capabilities = await detectCapabilities();

    const msg: RegisterMessage = {
      type: "register",
      encoderId: this.config.encoderId,
      gpuDevice: this.config.gpuDevice,
      maxConcurrent: this.config.maxConcurrent,
      currentJobs: this.activeJobs.size,
      hostname: os.hostname(),
      version: "1.0.0",
      capabilities,
    };

    this.send(msg);
  }

  /**
   * Start sending heartbeats
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }

  /**
   * Send a heartbeat message
   */
  private sendHeartbeat(): void {
    const msg: HeartbeatMessage = {
      type: "heartbeat",
      encoderId: this.config.encoderId,
      currentJobs: this.activeJobs.size,
      state: this.state,
      cpuUsage: os.loadavg()[0],
      memoryUsage: 1 - os.freemem() / os.totalmem(),
    };

    this.send(msg);
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      console.error("[Client] Invalid message:", data);
      return;
    }

    switch (msg.type) {
      case "registered":
        console.log("[Client] Registered with server");
        this.state = "IDLE";
        this.startHeartbeat();
        break;

      case "pong":
        // Heartbeat acknowledged
        break;

      case "job:assign":
        this.handleJobAssign(msg);
        break;

      case "job:cancel":
        this.handleJobCancel(msg.jobId, msg.reason);
        break;

      case "server:shutdown":
        console.log("[Client] Server shutting down");
        if (msg.reconnectDelay) {
          // Wait before reconnecting
          this.reconnectAttempts = 0;
          setTimeout(() => {
            this.config = { ...this.config, reconnectInterval: msg.reconnectDelay! };
          }, msg.reconnectDelay);
        }
        break;

      default:
        console.warn("[Client] Unknown message type:", (msg as { type: string }).type);
    }
  }

  /**
   * Handle job assignment
   */
  private async handleJobAssign(msg: JobAssignMessage): Promise<void> {
    const { jobId, inputPath, outputPath, encodingConfig } = msg;

    // Check capacity
    if (this.activeJobs.size >= this.config.maxConcurrent) {
      // Throttle capacity warnings to avoid log spam
      const now = Date.now();
      if (now - lastCapacityWarning >= WARNING_THROTTLE_INTERVAL) {
        console.warn(`[Client] At capacity (${this.activeJobs.size}/${this.config.maxConcurrent}), rejecting jobs`);
        lastCapacityWarning = now;
      }
      this.send({
        type: "job:failed",
        jobId,
        error: "Encoder at capacity",
        retriable: true,
      } as JobFailedMessage);
      return;
    }

    console.log(`[Client] Received job ${jobId}`);
    console.log(`  Input: ${inputPath}`);
    console.log(`  Output: ${outputPath}`);
    console.log(`  Config: videoEncoder="${encodingConfig.videoEncoder}" hwAccel="${encodingConfig.hwAccel}"`);

    // Accept the job
    const abortController = new AbortController();
    const activeJob: ActiveJob = {
      jobId,
      inputPath,
      outputPath,
      abortController,
      startTime: Date.now(),
    };

    this.activeJobs.set(jobId, activeJob);
    this.updateState();

    // Send acceptance
    this.send({
      type: "job:accepted",
      jobId,
      encoderId: this.config.encoderId,
    } as JobAcceptedMessage);

    // Execute the job
    try {
      const result = await encode({
        jobId,
        inputPath,
        outputPath,
        encodingConfig,
        onProgress: (progress) => this.send(progress),
        abortSignal: abortController.signal,
      });

      // Job completed
      this.activeJobs.delete(jobId);
      this.updateState();

      this.send({
        type: "job:complete",
        jobId,
        outputPath: result.outputPath,
        outputSize: result.outputSize,
        compressionRatio: result.compressionRatio,
        duration: result.duration,
      } as JobCompleteMessage);

      console.log(`[Client] Job ${jobId} completed`);

    } catch (error) {
      this.activeJobs.delete(jobId);
      this.updateState();

      const errorMsg = error instanceof Error ? error.message : String(error);
      const retriable = !abortController.signal.aborted;

      this.send({
        type: "job:failed",
        jobId,
        error: errorMsg,
        retriable,
      } as JobFailedMessage);

      console.error(`[Client] Job ${jobId} failed: ${errorMsg}`);
    }
  }

  /**
   * Handle job cancellation
   */
  private handleJobCancel(jobId: string, reason?: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      console.warn(`[Client] Received cancel for unknown job ${jobId}`);
      return;
    }

    console.log(`[Client] Cancelling job ${jobId}: ${reason || "No reason given"}`);
    job.abortController.abort();
  }

  /**
   * Update encoder state based on active jobs
   */
  private updateState(): void {
    if (this.state === "OFFLINE" || this.state === "CONNECTING" || this.state === "REGISTERING") {
      return;
    }

    this.state = this.activeJobs.size > 0 ? "ENCODING" : "IDLE";
  }

  /**
   * Send a message to the server
   */
  private send(msg: EncoderMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Throttle disconnected warnings to avoid log spam
      const now = Date.now();
      if (now - lastDisconnectedWarning >= WARNING_THROTTLE_INTERVAL) {
        console.warn("[Client] Cannot send, not connected (suppressing further warnings for 1s)");
        lastDisconnectedWarning = now;
      }
      return;
    }

    this.ws.send(JSON.stringify(msg));
  }
}
