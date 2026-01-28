import { describe, expect, test } from "bun:test";
import type { ProcessingStatus } from "@prisma/client";
import { StateMachine, StateTransitionError } from "../StateMachine.js";

const sm = new StateMachine();

const PIPELINE_ORDER: ProcessingStatus[] = [
  "PENDING",
  "SEARCHING",
  "FOUND",
  "DISCOVERED",
  "DOWNLOADING",
  "DOWNLOADED",
  "ENCODING",
  "ENCODED",
  "DELIVERING",
  "COMPLETED",
];

const TERMINAL_STATES: ProcessingStatus[] = ["COMPLETED", "FAILED", "CANCELLED"];

const NON_TERMINAL_STATES: ProcessingStatus[] = [
  "PENDING",
  "SEARCHING",
  "FOUND",
  "DISCOVERED",
  "DOWNLOADING",
  "DOWNLOADED",
  "ENCODING",
  "ENCODED",
  "DELIVERING",
];

describe("StateMachine", () => {
  describe("canTransition", () => {
    describe("forward transitions", () => {
      test("allows all sequential forward transitions", () => {
        for (let i = 0; i < PIPELINE_ORDER.length - 1; i++) {
          const from = PIPELINE_ORDER[i];
          const to = PIPELINE_ORDER[i + 1];
          expect(sm.canTransition(from, to)).toBe(true);
        }
      });

      test("allows skip-ahead transitions", () => {
        expect(sm.canTransition("PENDING", "DOWNLOADING")).toBe(true);
        expect(sm.canTransition("SEARCHING", "DOWNLOADED")).toBe(true);
        expect(sm.canTransition("PENDING", "COMPLETED")).toBe(true);
        expect(sm.canTransition("FOUND", "ENCODING")).toBe(true);
      });

      test("allows same-state transitions for non-terminal statuses", () => {
        for (const status of NON_TERMINAL_STATES) {
          expect(sm.canTransition(status, status)).toBe(true);
        }
      });

      test("blocks same-state transition for COMPLETED (terminal)", () => {
        expect(sm.canTransition("COMPLETED", "COMPLETED")).toBe(false);
      });
    });

    describe("terminal state transitions", () => {
      test("allows transition to FAILED from any non-terminal state", () => {
        for (const status of NON_TERMINAL_STATES) {
          expect(sm.canTransition(status, "FAILED")).toBe(true);
        }
      });

      test("allows transition to CANCELLED from any non-terminal state", () => {
        for (const status of NON_TERMINAL_STATES) {
          expect(sm.canTransition(status, "CANCELLED")).toBe(true);
        }
      });

      test("blocks transitions out of COMPLETED", () => {
        for (const to of [...PIPELINE_ORDER, ...TERMINAL_STATES]) {
          expect(sm.canTransition("COMPLETED", to)).toBe(false);
        }
      });

      test("blocks transitions out of CANCELLED", () => {
        for (const to of [...PIPELINE_ORDER, ...TERMINAL_STATES]) {
          expect(sm.canTransition("CANCELLED", to)).toBe(false);
        }
      });
    });

    describe("retry transitions", () => {
      test("allows FAILED -> PENDING (retry)", () => {
        expect(sm.canTransition("FAILED", "PENDING")).toBe(true);
      });

      test("blocks FAILED to any other status", () => {
        const otherStatuses = PIPELINE_ORDER.filter((s) => s !== "PENDING");
        for (const to of otherStatuses) {
          expect(sm.canTransition("FAILED", to)).toBe(false);
        }
      });
    });

    describe("backward transitions", () => {
      test("blocks backward transitions", () => {
        expect(sm.canTransition("DOWNLOADING", "SEARCHING")).toBe(false);
        expect(sm.canTransition("ENCODING", "DOWNLOADING")).toBe(false);
        expect(sm.canTransition("DELIVERING", "PENDING")).toBe(false);
        expect(sm.canTransition("ENCODED", "FOUND")).toBe(false);
      });
    });
  });

  describe("transition", () => {
    test("returns target status on valid transition", () => {
      expect(sm.transition("PENDING", "SEARCHING")).toBe("SEARCHING");
      expect(sm.transition("SEARCHING", "FOUND")).toBe("FOUND");
      expect(sm.transition("FAILED", "PENDING")).toBe("PENDING");
    });

    test("throws StateTransitionError on invalid transition", () => {
      expect(() => sm.transition("COMPLETED", "PENDING")).toThrow(StateTransitionError);
      expect(() => sm.transition("DOWNLOADING", "SEARCHING")).toThrow(StateTransitionError);
      expect(() => sm.transition("CANCELLED", "PENDING")).toThrow(StateTransitionError);
    });

    test("error message includes reason for terminal state", () => {
      try {
        sm.transition("COMPLETED", "PENDING");
      } catch (e) {
        expect(e).toBeInstanceOf(StateTransitionError);
        expect((e as StateTransitionError).message).toContain("Cannot leave terminal state");
        expect((e as StateTransitionError).fromStatus).toBe("COMPLETED");
        expect((e as StateTransitionError).toStatus).toBe("PENDING");
      }
    });

    test("error message includes reason for backward transition", () => {
      try {
        sm.transition("DOWNLOADING", "SEARCHING");
      } catch (e) {
        expect(e).toBeInstanceOf(StateTransitionError);
        expect((e as StateTransitionError).message).toContain("Cannot move backwards");
      }
    });

    test("error message for FAILED going to non-PENDING", () => {
      try {
        sm.transition("FAILED", "SEARCHING");
      } catch (e) {
        expect(e).toBeInstanceOf(StateTransitionError);
        expect((e as StateTransitionError).message).toContain(
          "FAILED can only transition to PENDING"
        );
      }
    });
  });

  describe("getNextStates", () => {
    test("returns empty array for COMPLETED", () => {
      expect(sm.getNextStates("COMPLETED")).toEqual([]);
    });

    test("returns empty array for CANCELLED", () => {
      expect(sm.getNextStates("CANCELLED")).toEqual([]);
    });

    test("returns only PENDING for FAILED", () => {
      expect(sm.getNextStates("FAILED")).toEqual(["PENDING"]);
    });

    test("returns all forward states plus FAILED and CANCELLED for PENDING", () => {
      const next = sm.getNextStates("PENDING");
      expect(next).toContain("SEARCHING");
      expect(next).toContain("COMPLETED");
      expect(next).toContain("FAILED");
      expect(next).toContain("CANCELLED");
      expect(next).not.toContain("PENDING");
    });

    test("returns correct forward states for mid-pipeline status", () => {
      const next = sm.getNextStates("DOWNLOADING");
      expect(next).toContain("DOWNLOADED");
      expect(next).toContain("ENCODING");
      expect(next).toContain("COMPLETED");
      expect(next).toContain("FAILED");
      expect(next).toContain("CANCELLED");
      expect(next).not.toContain("PENDING");
      expect(next).not.toContain("SEARCHING");
      expect(next).not.toContain("FOUND");
    });

    test("returns only terminal states for DELIVERING", () => {
      const next = sm.getNextStates("DELIVERING");
      expect(next).toContain("COMPLETED");
      expect(next).toContain("FAILED");
      expect(next).toContain("CANCELLED");
      expect(next).toHaveLength(3);
    });
  });

  describe("isTerminal", () => {
    test("returns true for terminal states", () => {
      expect(sm.isTerminal("COMPLETED")).toBe(true);
      expect(sm.isTerminal("FAILED")).toBe(true);
      expect(sm.isTerminal("CANCELLED")).toBe(true);
    });

    test("returns false for non-terminal states", () => {
      for (const status of NON_TERMINAL_STATES) {
        expect(sm.isTerminal(status)).toBe(false);
      }
    });
  });

  describe("requiresValidation", () => {
    test("returns true for states requiring validation", () => {
      expect(sm.requiresValidation("FOUND")).toBe(true);
      expect(sm.requiresValidation("DISCOVERED")).toBe(true);
      expect(sm.requiresValidation("DOWNLOADED")).toBe(true);
      expect(sm.requiresValidation("ENCODED")).toBe(true);
    });

    test("returns false for states not requiring validation", () => {
      expect(sm.requiresValidation("PENDING")).toBe(false);
      expect(sm.requiresValidation("SEARCHING")).toBe(false);
      expect(sm.requiresValidation("DOWNLOADING")).toBe(false);
      expect(sm.requiresValidation("ENCODING")).toBe(false);
      expect(sm.requiresValidation("DELIVERING")).toBe(false);
      expect(sm.requiresValidation("COMPLETED")).toBe(false);
      expect(sm.requiresValidation("FAILED")).toBe(false);
      expect(sm.requiresValidation("CANCELLED")).toBe(false);
    });
  });

  describe("canRetry (allowsRetry)", () => {
    test("returns true for retryable states", () => {
      expect(sm.canRetry("SEARCHING")).toBe(true);
      expect(sm.canRetry("DOWNLOADING")).toBe(true);
      expect(sm.canRetry("ENCODING")).toBe(true);
      expect(sm.canRetry("DELIVERING")).toBe(true);
      expect(sm.canRetry("FAILED")).toBe(true);
    });

    test("returns false for non-retryable states", () => {
      expect(sm.canRetry("PENDING")).toBe(false);
      expect(sm.canRetry("FOUND")).toBe(false);
      expect(sm.canRetry("DISCOVERED")).toBe(false);
      expect(sm.canRetry("DOWNLOADED")).toBe(false);
      expect(sm.canRetry("ENCODED")).toBe(false);
      expect(sm.canRetry("COMPLETED")).toBe(false);
      expect(sm.canRetry("CANCELLED")).toBe(false);
    });
  });

  describe("getMetadata", () => {
    test("returns metadata for all statuses", () => {
      const allStatuses: ProcessingStatus[] = [...PIPELINE_ORDER, "FAILED", "CANCELLED"];
      for (const status of allStatuses) {
        const meta = sm.getMetadata(status);
        expect(meta.description).toBeDefined();
        expect(typeof meta.isTerminal).toBe("boolean");
        expect(typeof meta.requiresValidation).toBe("boolean");
        expect(typeof meta.allowsRetry).toBe("boolean");
      }
    });
  });

  describe("getNextPipelineStatus", () => {
    test("returns correct natural progression", () => {
      expect(sm.getNextPipelineStatus("PENDING")).toBe("SEARCHING");
      expect(sm.getNextPipelineStatus("SEARCHING")).toBe("FOUND");
      expect(sm.getNextPipelineStatus("FOUND")).toBe("DOWNLOADING");
      expect(sm.getNextPipelineStatus("DOWNLOADING")).toBe("DOWNLOADED");
      expect(sm.getNextPipelineStatus("DOWNLOADED")).toBe("ENCODING");
      expect(sm.getNextPipelineStatus("ENCODING")).toBe("ENCODED");
      expect(sm.getNextPipelineStatus("ENCODED")).toBe("DELIVERING");
      expect(sm.getNextPipelineStatus("DELIVERING")).toBe("COMPLETED");
    });

    test("returns null for terminal states", () => {
      expect(sm.getNextPipelineStatus("COMPLETED")).toBeNull();
      expect(sm.getNextPipelineStatus("FAILED")).toBeNull();
      expect(sm.getNextPipelineStatus("CANCELLED")).toBeNull();
    });

    test("skips DISCOVERED in natural progression (FOUND -> DOWNLOADING)", () => {
      expect(sm.getNextPipelineStatus("FOUND")).toBe("DOWNLOADING");
    });
  });

  describe("getErrorStatus", () => {
    test("always returns FAILED", () => {
      expect(sm.getErrorStatus()).toBe("FAILED");
    });
  });

  describe("getCancelledStatus", () => {
    test("always returns CANCELLED", () => {
      expect(sm.getCancelledStatus()).toBe("CANCELLED");
    });
  });
});
