import { workerManager } from "./workers/WorkerManager";

/**
 * PipelineService - Main service for managing the new pipeline system
 * Starts workers and handles lifecycle
 */
export class PipelineService {
  private isInitialized = false;

  /**
   * Initialize and start the pipeline service
   */
  async start(): Promise<void> {
    if (this.isInitialized) {
      console.log("[PipelineService] Already initialized");
      return;
    }

    console.log("[PipelineService] Initializing pipeline system...");

    try {
      // Register all workers with the scheduler
      await workerManager.registerWithScheduler();

      this.isInitialized = true;
      console.log("[PipelineService] Pipeline system initialized successfully");
    } catch (error) {
      console.error("[PipelineService] Failed to initialize:", error);
      throw error;
    }
  }

  /**
   * Stop the pipeline service
   */
  async stop(): Promise<void> {
    if (!this.isInitialized) {
      console.log("[PipelineService] Not initialized");
      return;
    }

    console.log("[PipelineService] Stopping pipeline system...");

    try {
      // Workers are managed by scheduler - no cleanup needed
      this.isInitialized = false;
      console.log("[PipelineService] Pipeline system stopped");
    } catch (error) {
      console.error("[PipelineService] Error stopping service:", error);
      throw error;
    }
  }

  /**
   * Get service status
   */
  getStatus(): {
    initialized: boolean;
    workers: ReturnType<typeof workerManager.getStatus>;
  } {
    return {
      initialized: this.isInitialized,
      workers: workerManager.getStatus(),
    };
  }
}

export const pipelineService = new PipelineService();
