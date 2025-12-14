/**
 * Unified Process Scheduler
 *
 * Central scheduler for all recurring tasks. Replaces scattered setInterval calls
 * with a single main loop that fires tasks concurrently.
 */

import { getConfig } from "../config/index.js";

interface RecurringTask {
  id: string;
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  lastRun: Date | null;
  lastDuration: number | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  enabled: boolean;
  isRunning: boolean;
}

interface OneOffTask {
  id: string;
  name: string;
  runAt: Date;
  handler: () => Promise<void>;
  createdAt: Date;
}

export interface RecurringTaskStats {
  id: string;
  name: string;
  intervalMs: number;
  lastRun: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
  enabled: boolean;
  isRunning: boolean;
  nextRunIn: number | null;
}

export interface SchedulerHealth {
  isRunning: boolean;
  loopIntervalMs: number;
  lastLoopTime: Date | null;
  lastLoopDurationMs: number;
  avgLoopDurationMs: number;
  maxLoopDurationMs: number;
  loopDelayMs: number;
  recurringTasks: RecurringTaskStats[];
  pendingOneOffs: number;
}

class SchedulerService {
  private recurringTasks: Map<string, RecurringTask> = new Map();
  private oneOffTasks: Map<string, OneOffTask> = new Map();
  private loopTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private loopIntervalMs: number;

  // Health metrics
  private lastLoopTime: Date | null = null;
  private lastLoopDuration = 0;
  private loopDurations: number[] = [];
  private expectedNextTick: number | null = null;

  // For generating unique IDs
  private oneOffCounter = 0;

  constructor() {
    const config = getConfig();
    this.loopIntervalMs = config.scheduler?.intervalMs ?? 1000;
    console.log(`[Scheduler] Initialized with ${this.loopIntervalMs}ms loop interval`);
  }

  /**
   * Register a recurring task
   */
  register(
    id: string,
    name: string,
    intervalMs: number,
    handler: () => Promise<void>
  ): void {
    if (this.recurringTasks.has(id)) {
      console.warn(`[Scheduler] Task ${id} already registered, updating handler`);
    }

    this.recurringTasks.set(id, {
      id,
      name,
      intervalMs,
      handler,
      lastRun: null,
      lastDuration: null,
      lastError: null,
      runCount: 0,
      errorCount: 0,
      enabled: true,
      isRunning: false,
    });

    console.log(`[Scheduler] Registered task: ${name} (${id}) @ ${intervalMs}ms`);
  }

  /**
   * Unregister a recurring task
   */
  unregister(id: string): boolean {
    const task = this.recurringTasks.get(id);
    if (task) {
      this.recurringTasks.delete(id);
      console.log(`[Scheduler] Unregistered task: ${task.name} (${id})`);
      return true;
    }
    return false;
  }

  /**
   * Update interval for an existing task
   */
  updateInterval(id: string, intervalMs: number): boolean {
    const task = this.recurringTasks.get(id);
    if (task) {
      task.intervalMs = intervalMs;
      console.log(`[Scheduler] Updated interval for ${task.name}: ${intervalMs}ms`);
      return true;
    }
    return false;
  }

  /**
   * Enable or disable a task
   */
  setTaskEnabled(id: string, enabled: boolean): boolean {
    const task = this.recurringTasks.get(id);
    if (task) {
      task.enabled = enabled;
      console.log(`[Scheduler] Task ${task.name} ${enabled ? "enabled" : "disabled"}`);
      return true;
    }
    return false;
  }

  /**
   * Schedule a one-off task to run after a delay
   */
  scheduleOnce(
    name: string,
    delayMs: number,
    handler: () => Promise<void>
  ): string {
    const id = `oneoff-${++this.oneOffCounter}-${Date.now()}`;
    const runAt = new Date(Date.now() + delayMs);

    this.oneOffTasks.set(id, {
      id,
      name,
      runAt,
      handler,
      createdAt: new Date(),
    });

    console.log(`[Scheduler] Scheduled one-off: ${name} (${id}) in ${delayMs}ms`);
    return id;
  }

  /**
   * Cancel a one-off task
   */
  cancelOnce(id: string): boolean {
    const task = this.oneOffTasks.get(id);
    if (task) {
      this.oneOffTasks.delete(id);
      console.log(`[Scheduler] Cancelled one-off: ${task.name} (${id})`);
      return true;
    }
    return false;
  }

  /**
   * Start the main loop
   */
  start(): void {
    if (this.isRunning) {
      console.warn("[Scheduler] Already running");
      return;
    }

    this.isRunning = true;
    this.expectedNextTick = Date.now() + this.loopIntervalMs;

    // Use setInterval for the main loop
    this.loopTimer = setInterval(() => {
      this.tick();
    }, this.loopIntervalMs);

    console.log(`[Scheduler] Started main loop (${this.loopIntervalMs}ms interval)`);

    // Run first tick immediately
    this.tick();
  }

  /**
   * Stop the main loop gracefully
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log("[Scheduler] Stopping...");
    this.isRunning = false;

    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }

    // Wait for any running tasks to complete (with timeout)
    const runningTasks = Array.from(this.recurringTasks.values()).filter(
      (t) => t.isRunning
    );

    if (runningTasks.length > 0) {
      console.log(
        `[Scheduler] Waiting for ${runningTasks.length} running tasks to complete...`
      );

      // Give tasks up to 30 seconds to finish
      const timeout = 30000;
      const startWait = Date.now();

      while (Date.now() - startWait < timeout) {
        const stillRunning = Array.from(this.recurringTasks.values()).filter(
          (t) => t.isRunning
        );
        if (stillRunning.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    // Clear one-off tasks
    this.oneOffTasks.clear();

    console.log("[Scheduler] Stopped");
  }

  /**
   * Get health metrics for dashboard
   */
  getHealth(): SchedulerHealth {
    const now = Date.now();

    const recurringTasks: RecurringTaskStats[] = Array.from(
      this.recurringTasks.values()
    ).map((task) => {
      let nextRunIn: number | null = null;
      if (task.enabled && !task.isRunning) {
        if (task.lastRun) {
          const timeSinceLastRun = now - task.lastRun.getTime();
          nextRunIn = Math.max(0, task.intervalMs - timeSinceLastRun);
        } else {
          nextRunIn = 0; // Will run on next tick
        }
      }

      return {
        id: task.id,
        name: task.name,
        intervalMs: task.intervalMs,
        lastRun: task.lastRun,
        lastDurationMs: task.lastDuration,
        lastError: task.lastError,
        runCount: task.runCount,
        errorCount: task.errorCount,
        enabled: task.enabled,
        isRunning: task.isRunning,
        nextRunIn,
      };
    });

    // Calculate loop delay (drift from expected schedule)
    let loopDelayMs = 0;
    if (this.expectedNextTick && this.lastLoopTime) {
      loopDelayMs = Math.max(
        0,
        this.lastLoopTime.getTime() - (this.expectedNextTick - this.loopIntervalMs)
      );
    }

    return {
      isRunning: this.isRunning,
      loopIntervalMs: this.loopIntervalMs,
      lastLoopTime: this.lastLoopTime,
      lastLoopDurationMs: this.lastLoopDuration,
      avgLoopDurationMs:
        this.loopDurations.length > 0
          ? this.loopDurations.reduce((a, b) => a + b, 0) / this.loopDurations.length
          : 0,
      maxLoopDurationMs:
        this.loopDurations.length > 0 ? Math.max(...this.loopDurations) : 0,
      loopDelayMs,
      recurringTasks,
      pendingOneOffs: this.oneOffTasks.size,
    };
  }

  /**
   * Main loop tick - runs every loopIntervalMs
   * This is synchronous and fast - it only checks times and fires tasks
   */
  private tick(): void {
    const loopStart = Date.now();

    // 1. Fire due recurring tasks (non-blocking)
    for (const task of this.recurringTasks.values()) {
      if (!task.enabled || task.isRunning) continue;

      const timeSinceLastRun = task.lastRun
        ? loopStart - task.lastRun.getTime()
        : Infinity;

      if (timeSinceLastRun >= task.intervalMs) {
        // Fire and forget - don't await
        task.isRunning = true;
        const taskStart = Date.now();

        task
          .handler()
          .then(() => {
            task.lastDuration = Date.now() - taskStart;
            task.lastError = null;
            task.runCount++;
          })
          .catch((error: Error) => {
            task.lastDuration = Date.now() - taskStart;
            task.lastError = error.message;
            task.errorCount++;
            console.error(`[Scheduler] Task ${task.name} failed:`, error.message);
          })
          .finally(() => {
            task.isRunning = false;
            task.lastRun = new Date();
          });
      }
    }

    // 2. Fire due one-off tasks (non-blocking)
    const now = new Date();
    for (const [id, task] of this.oneOffTasks) {
      if (task.runAt <= now) {
        this.oneOffTasks.delete(id); // Remove immediately to prevent re-firing

        task.handler().catch((error: Error) => {
          console.error(`[Scheduler] One-off ${task.name} failed:`, error.message);
        });
      }
    }

    // 3. Update health metrics (tick itself is fast, just scheduling)
    this.lastLoopDuration = Date.now() - loopStart;
    this.lastLoopTime = new Date();
    this.loopDurations.push(this.lastLoopDuration);
    if (this.loopDurations.length > 100) this.loopDurations.shift();

    // Update expected next tick time
    this.expectedNextTick = Date.now() + this.loopIntervalMs;
  }
}

// Singleton instance
let schedulerInstance: SchedulerService | null = null;

export function getSchedulerService(): SchedulerService {
  if (!schedulerInstance) {
    schedulerInstance = new SchedulerService();
  }
  return schedulerInstance;
}

export function resetSchedulerService(): void {
  if (schedulerInstance) {
    schedulerInstance.stop();
    schedulerInstance = null;
  }
}
