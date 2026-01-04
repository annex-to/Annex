import type { ProcessingStatus } from "@prisma/client";

/**
 * Pipeline order - defines the natural progression of statuses
 */
const PIPELINE_ORDER: ProcessingStatus[] = [
  "PENDING",
  "SEARCHING",
  "FOUND",
  "DOWNLOADING",
  "DOWNLOADED",
  "ENCODING",
  "ENCODED",
  "DELIVERING",
  "COMPLETED",
];

/**
 * State metadata for each status
 */
interface StateMetadata {
  description: string;
  isTerminal: boolean;
  requiresValidation: boolean;
  allowsRetry: boolean;
}

const STATE_METADATA: Record<ProcessingStatus, StateMetadata> = {
  PENDING: {
    description: "Waiting to begin processing",
    isTerminal: false,
    requiresValidation: false,
    allowsRetry: false,
  },
  SEARCHING: {
    description: "Searching for releases",
    isTerminal: false,
    requiresValidation: false,
    allowsRetry: true,
  },
  FOUND: {
    description: "Release found and selected",
    isTerminal: false,
    requiresValidation: true,
    allowsRetry: false,
  },
  DOWNLOADING: {
    description: "Downloading content",
    isTerminal: false,
    requiresValidation: false,
    allowsRetry: true,
  },
  DOWNLOADED: {
    description: "Download complete, file validated",
    isTerminal: false,
    requiresValidation: true,
    allowsRetry: false,
  },
  ENCODING: {
    description: "Encoding in progress",
    isTerminal: false,
    requiresValidation: false,
    allowsRetry: true,
  },
  ENCODED: {
    description: "Encoding complete, file validated",
    isTerminal: false,
    requiresValidation: true,
    allowsRetry: false,
  },
  DELIVERING: {
    description: "Delivering to storage servers",
    isTerminal: false,
    requiresValidation: false,
    allowsRetry: true,
  },
  COMPLETED: {
    description: "Successfully completed all steps",
    isTerminal: true,
    requiresValidation: false,
    allowsRetry: false,
  },
  FAILED: {
    description: "Permanent failure",
    isTerminal: true,
    requiresValidation: false,
    allowsRetry: true,
  },
  CANCELLED: {
    description: "Cancelled by user",
    isTerminal: true,
    requiresValidation: false,
    allowsRetry: false,
  },
};

export class StateTransitionError extends Error {
  constructor(
    public readonly fromStatus: ProcessingStatus,
    public readonly toStatus: ProcessingStatus,
    message?: string
  ) {
    super(message || `Invalid transition from ${fromStatus} to ${toStatus}`);
    this.name = "StateTransitionError";
  }
}

export class StateMachine {
  /**
   * Check if a status transition is valid
   * Simple validation: allow forward movement, FAILED, CANCELLED, or FAILED->PENDING retry
   */
  canTransition(from: ProcessingStatus, to: ProcessingStatus): boolean {
    // Terminal states can't be left (except FAILED -> PENDING for retry)
    if (from === "COMPLETED" || from === "CANCELLED") {
      return false;
    }

    // Allow FAILED -> PENDING for retry
    if (from === "FAILED" && to === "PENDING") {
      return true;
    }

    // Allow transition to FAILED or CANCELLED from any non-terminal state
    if (to === "FAILED" || to === "CANCELLED") {
      return true;
    }

    // Allow any forward movement in pipeline
    const fromIndex = PIPELINE_ORDER.indexOf(from);
    const toIndex = PIPELINE_ORDER.indexOf(to);

    // Both must be in pipeline order
    if (fromIndex === -1 || toIndex === -1) {
      return false;
    }

    // Can move forward (including skipping states)
    return toIndex >= fromIndex;
  }

  /**
   * Validate and get next status, throwing error if invalid
   */
  transition(from: ProcessingStatus, to: ProcessingStatus): ProcessingStatus {
    if (!this.canTransition(from, to)) {
      let reason = "";
      if (from === "COMPLETED" || from === "CANCELLED") {
        reason = `Cannot leave terminal state ${from}`;
      } else if (from === "FAILED" && to !== "PENDING") {
        reason = `FAILED can only transition to PENDING (retry)`;
      } else {
        const fromIndex = PIPELINE_ORDER.indexOf(from);
        const toIndex = PIPELINE_ORDER.indexOf(to);
        if (toIndex < fromIndex) {
          reason = `Cannot move backwards from ${from} to ${to}`;
        } else {
          reason = `Invalid transition from ${from} to ${to}`;
        }
      }
      throw new StateTransitionError(from, to, reason);
    }
    return to;
  }

  /**
   * Get all valid next states from current state
   * Returns all forward states plus FAILED and CANCELLED
   */
  getNextStates(current: ProcessingStatus): ProcessingStatus[] {
    if (current === "COMPLETED" || current === "CANCELLED") {
      return [];
    }

    if (current === "FAILED") {
      return ["PENDING"];
    }

    const currentIndex = PIPELINE_ORDER.indexOf(current);
    if (currentIndex === -1) {
      return ["FAILED", "CANCELLED"];
    }

    // All forward states plus FAILED and CANCELLED
    const forwardStates = PIPELINE_ORDER.slice(currentIndex + 1);
    return [...forwardStates, "FAILED", "CANCELLED"];
  }

  /**
   * Check if a status is terminal (no further transitions)
   */
  isTerminal(status: ProcessingStatus): boolean {
    return STATE_METADATA[status].isTerminal;
  }

  /**
   * Check if a status requires validation before transitioning
   */
  requiresValidation(status: ProcessingStatus): boolean {
    return STATE_METADATA[status].requiresValidation;
  }

  /**
   * Check if a status can be retried
   */
  canRetry(status: ProcessingStatus): boolean {
    return STATE_METADATA[status].allowsRetry;
  }

  /**
   * Get metadata for a status
   */
  getMetadata(status: ProcessingStatus): StateMetadata {
    return STATE_METADATA[status];
  }

  /**
   * Get the natural next status in the pipeline flow
   */
  getNextPipelineStatus(current: ProcessingStatus): ProcessingStatus | null {
    switch (current) {
      case "PENDING":
        return "SEARCHING";
      case "SEARCHING":
        return "FOUND";
      case "FOUND":
        return "DOWNLOADING";
      case "DOWNLOADING":
        return "DOWNLOADED";
      case "DOWNLOADED":
        return "ENCODING";
      case "ENCODING":
        return "ENCODED";
      case "ENCODED":
        return "DELIVERING";
      case "DELIVERING":
        return "COMPLETED";
      default:
        return null; // Terminal or error state
    }
  }

  /**
   * Get the error status (always FAILED)
   */
  getErrorStatus(): ProcessingStatus {
    return "FAILED";
  }

  /**
   * Get the cancellation status (always CANCELLED)
   */
  getCancelledStatus(): ProcessingStatus {
    return "CANCELLED";
  }
}

export const stateMachine = new StateMachine();
