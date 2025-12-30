/**
 * Scheduler Log Capture System
 *
 * Captures console logs for scheduler tasks in memory (last 100 entries per task)
 * Provides API to retrieve logs for monitoring/debugging
 */

export interface LogEntry {
  timestamp: Date;
  level: "log" | "error" | "warn" | "info";
  message: string;
  args: unknown[];
}

class SchedulerLogService {
  private logs: Map<string, LogEntry[]> = new Map();
  private maxLogsPerTask = 100;
  private originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
  };
  private activeWrappers = 0;

  /**
   * Capture logs for a specific task execution
   * Returns a restore function to call after task completes
   */
  captureLogsForTask(taskId: string, taskName: string): () => void {
    const taskLogs = this.logs.get(taskId) || [];
    this.logs.set(taskId, taskLogs);

    // Extract worker name from task name (e.g., "Worker: DeliverWorker" -> "DeliverWorker")
    const workerNameMatch = taskName.match(/Worker:\s*(.+)/);
    const workerName = workerNameMatch ? workerNameMatch[1] : null;

    // Store reference to current console (might already be wrapped by another task)
    const previousConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
    };

    this.activeWrappers++;

    // Override console methods to capture logs
    const addLog = (level: LogEntry["level"], args: unknown[]) => {
      const message = args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return arg.message;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" ");

      // Only capture logs that belong to this task
      if (workerName) {
        // Check if message starts with this worker's prefix
        const hasWorkerPrefix = message.startsWith(`[${workerName}]`);

        // Check if message has any other worker's prefix
        const hasOtherWorkerPrefix = message.match(/^\[(\w+Worker)\]/) && !hasWorkerPrefix;

        // Only capture if it's this worker's log or a general log (no worker prefix)
        if (hasOtherWorkerPrefix) {
          return; // Skip logs from other workers
        }
      }

      taskLogs.push({
        timestamp: new Date(),
        level,
        message,
        args,
      });

      // Keep only last N logs
      if (taskLogs.length > this.maxLogsPerTask) {
        taskLogs.shift();
      }
    };

    // Wrapper functions that call both logging and previous console
    console.log = (...args: unknown[]) => {
      addLog("log", args);
      this.originalConsole.log(...args);
    };

    console.error = (...args: unknown[]) => {
      addLog("error", args);
      this.originalConsole.error(...args);
    };

    console.warn = (...args: unknown[]) => {
      addLog("warn", args);
      this.originalConsole.warn(...args);
    };

    console.info = (...args: unknown[]) => {
      addLog("info", args);
      this.originalConsole.info(...args);
    };

    // Return restore function that restores previous console state
    return () => {
      this.activeWrappers--;

      // Only restore if no other wrappers are active
      if (this.activeWrappers === 0) {
        console.log = this.originalConsole.log;
        console.error = this.originalConsole.error;
        console.warn = this.originalConsole.warn;
        console.info = this.originalConsole.info;
      } else {
        // Restore to previous console (which might be another wrapper)
        console.log = previousConsole.log;
        console.error = previousConsole.error;
        console.warn = previousConsole.warn;
        console.info = previousConsole.info;
      }
    };
  }

  /**
   * Get logs for a specific task
   */
  getLogsForTask(taskId: string): LogEntry[] {
    return this.logs.get(taskId) || [];
  }

  /**
   * Get all task IDs that have logs
   */
  getTaskIds(): string[] {
    return Array.from(this.logs.keys());
  }

  /**
   * Clear logs for a specific task
   */
  clearLogsForTask(taskId: string): void {
    this.logs.delete(taskId);
  }

  /**
   * Clear all logs
   */
  clearAllLogs(): void {
    this.logs.clear();
  }

  /**
   * Get logs for all tasks
   */
  getAllLogs(): Record<string, LogEntry[]> {
    const result: Record<string, LogEntry[]> = {};
    for (const [taskId, logs] of this.logs.entries()) {
      result[taskId] = logs;
    }
    return result;
  }
}

export const schedulerLogService = new SchedulerLogService();
