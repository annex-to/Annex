import type { BaseWorker } from "./BaseWorker";
import { deliverWorker } from "./DeliverWorker";
import { downloadWorker } from "./DownloadWorker";
import { encodeWorker } from "./EncodeWorker";
import { searchWorker } from "./SearchWorker";

/**
 * WorkerManager - Manages all pipeline workers
 * Registers workers with the scheduler system
 */
export class WorkerManager {
  private workers: BaseWorker[] = [];
  private isRegistered = false;

  constructor() {
    this.workers = [searchWorker, downloadWorker, encodeWorker, deliverWorker];
  }

  /**
   * Register all workers with the scheduler
   */
  async registerWithScheduler(): Promise<void> {
    if (this.isRegistered) {
      console.log("[WorkerManager] Workers already registered");
      return;
    }

    console.log("[WorkerManager] Registering workers with scheduler...");

    const { getSchedulerService } = await import("../../scheduler.js");
    const scheduler = getSchedulerService();

    for (const worker of this.workers) {
      const taskId = `worker-${worker.name.toLowerCase().replace(/\s+/g, "-")}`;

      scheduler.register(taskId, `Worker: ${worker.name}`, worker.pollInterval, () =>
        worker.processBatch()
      );
    }

    this.isRegistered = true;
    console.log(`[WorkerManager] Registered ${this.workers.length} workers with scheduler`);
  }

  /**
   * Get worker status
   */
  getStatus(): {
    registered: boolean;
    workers: Array<{ name: string; processingStatus: string; pollInterval: number }>;
  } {
    return {
      registered: this.isRegistered,
      workers: this.workers.map((w) => ({
        name: w.name,
        processingStatus: w.processingStatus,
        pollInterval: w.pollInterval,
      })),
    };
  }
}

export const workerManager = new WorkerManager();
