import { prisma } from "../../../db/client.js";
import type { BaseWorker } from "./BaseWorker";
import { deliverWorker } from "./DeliverWorker";
import { discoveredWorker } from "./DiscoveredWorker";
import { downloadWorker } from "./DownloadWorker";
import { encodeWorker } from "./EncodeWorker";
import { fileMapWorker } from "./FileMapWorker";
import { searchWorker } from "./SearchWorker";

/**
 * WorkerManager - Manages all pipeline workers
 * Registers workers with the scheduler system
 */
export class WorkerManager {
  private workers: BaseWorker[] = [];
  private isRegistered = false;

  constructor() {
    this.workers = [searchWorker, discoveredWorker, downloadWorker, encodeWorker, deliverWorker];
  }

  /**
   * Recover stuck in-progress deliveries on startup
   * Moves DELIVERING items back to ENCODED so they can be rescheduled
   */
  async recoverStuckDeliveries(): Promise<void> {
    console.log("[WorkerManager] Checking for stuck deliveries...");

    const deliveringItems = await prisma.processingItem.findMany({
      where: { status: "DELIVERING" },
      select: { id: true, title: true },
    });

    if (deliveringItems.length === 0) {
      console.log("[WorkerManager] No stuck deliveries found");
      return;
    }

    console.log(
      `[WorkerManager] Found ${deliveringItems.length} stuck deliveries, resetting to ENCODED...`
    );

    // Reset all DELIVERING items back to ENCODED
    await prisma.processingItem.updateMany({
      where: { status: "DELIVERING" },
      data: {
        status: "ENCODED",
        currentStep: "encode_complete",
        progress: 100,
      },
    });

    console.log(
      `[WorkerManager] Reset ${deliveringItems.length} items back to ENCODED: ${deliveringItems.map((i: { id: string; title: string }) => i.title).join(", ")}`
    );
  }

  /**
   * Register all workers with the scheduler
   */
  async registerWithScheduler(): Promise<void> {
    if (this.isRegistered) {
      console.log("[WorkerManager] Workers already registered");
      return;
    }

    // Recover stuck deliveries before starting workers
    await this.recoverStuckDeliveries();

    console.log("[WorkerManager] Registering workers with scheduler...");

    const { getSchedulerService } = await import("../../scheduler.js");
    const scheduler = getSchedulerService();

    for (const worker of this.workers) {
      const taskId = `worker-${worker.name.toLowerCase().replace(/\s+/g, "-")}`;

      scheduler.register(taskId, `Worker: ${worker.name}`, worker.pollInterval, () =>
        worker.processBatch()
      );
    }

    scheduler.register("worker-filemapworker", `Worker: ${fileMapWorker.name}`, 10_000, () =>
      fileMapWorker.processBatch()
    );

    this.isRegistered = true;
    console.log(`[WorkerManager] Registered ${this.workers.length + 1} workers with scheduler`);
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
