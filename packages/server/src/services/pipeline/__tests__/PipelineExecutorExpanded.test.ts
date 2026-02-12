/**
 * PipelineExecutor Expanded Tests
 *
 * Tests for condition evaluation, pause/resume, retry hints,
 * context loading, and edge cases not covered in the base executor tests.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { StepType } from "@prisma/client";
import { createMockPrisma } from "../../../__tests__/setup.js";
import type { ConditionRule, PipelineContext, StepOutput } from "../PipelineContext.js";

const mockPrisma = createMockPrisma();
mock.module("../../../db/client.js", () => ({
  prisma: mockPrisma,
}));

import { PipelineExecutor } from "../PipelineExecutor.js";
import { StepRegistry } from "../StepRegistry.js";
import { BaseStep } from "../steps/BaseStep.js";

class ConfigurableStep extends BaseStep {
  static executionLog: Array<{ name: string; timestamp: number }> = [];
  static resetLog() {
    ConfigurableStep.executionLog = [];
  }

  constructor(public readonly type: StepType) {
    super();
  }

  async execute(_context: PipelineContext, config: unknown): Promise<StepOutput> {
    const cfg = config as {
      name: string;
      delay?: number;
      shouldFail?: boolean;
      shouldPause?: boolean;
      shouldRetry?: boolean;
      shouldSkip?: boolean;
      nextStep?: string | null;
      data?: Record<string, unknown>;
    };

    ConfigurableStep.executionLog.push({ name: cfg.name, timestamp: Date.now() });

    if (cfg.delay) {
      await new Promise((resolve) => setTimeout(resolve, cfg.delay));
    }

    if (cfg.shouldPause) {
      return { success: true, shouldPause: true };
    }

    if (cfg.shouldRetry) {
      return { success: false, shouldRetry: true, error: "Retry needed" };
    }

    if (cfg.shouldSkip) {
      return { success: true, shouldSkip: true };
    }

    if (cfg.shouldFail) {
      return { success: false, error: `Step ${cfg.name} failed` };
    }

    return {
      success: true,
      data: cfg.data || { [`${cfg.name}_completed`]: true },
      nextStep: cfg.nextStep,
    };
  }

  validateConfig(config: unknown): void {
    const cfg = config as { name?: string };
    if (!cfg || typeof cfg.name !== "string") {
      throw new Error("Step requires config with name");
    }
  }
}

describe("PipelineExecutor - Expanded", () => {
  let executor: PipelineExecutor;
  let mockRequestId: string;

  beforeEach(async () => {
    executor = new PipelineExecutor();
    ConfigurableStep.resetLog();
    mockPrisma._clear();

    StepRegistry.reset();

    const types = ["SEARCH", "DOWNLOAD", "ENCODE", "DELIVER", "NOTIFICATION", "APPROVAL"];
    for (const t of types) {
      const stepType = t as StepType;
      class DynStep extends ConfigurableStep {
        constructor() {
          super(stepType);
        }
      }
      StepRegistry.register(stepType, DynStep);
    }

    const request = await mockPrisma.mediaRequest.create({
      data: {
        type: "MOVIE",
        tmdbId: 12345,
        title: "Test Movie",
        year: 2024,
        status: "PENDING",
        targets: [],
      },
    });
    mockRequestId = request.id;
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  async function createTemplate(steps: unknown[]) {
    const template = await mockPrisma.pipelineTemplate.create({
      data: {
        name: "Test Template",
        mediaType: "MOVIE",
        isPublic: true,
        isDefault: false,
        steps,
      },
    });
    return template.id;
  }

  describe("Condition Evaluation", () => {
    it("skips step when condition evaluates to false", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Conditional Step",
          config: { name: "conditional" },
          condition: { field: "mediaType", operator: "==", value: "TV" },
          required: true,
          continueOnError: false,
        },
        {
          type: "NOTIFICATION",
          name: "Always Runs",
          config: { name: "always" },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const names = ConfigurableStep.executionLog.map((l) => l.name);
      expect(names).toContain("always");
      expect(names).not.toContain("conditional");
    });

    it("executes step when condition evaluates to true", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Movie Step",
          config: { name: "movie_step" },
          condition: { field: "mediaType", operator: "==", value: "MOVIE" },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      expect(ConfigurableStep.executionLog.map((l) => l.name)).toContain("movie_step");
    });

    it("handles != operator", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Not TV",
          config: { name: "not_tv" },
          condition: { field: "mediaType", operator: "!=", value: "TV" },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);
      expect(ConfigurableStep.executionLog.map((l) => l.name)).toContain("not_tv");
    });

    it("handles 'in' operator", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "In Check",
          config: { name: "in_check" },
          condition: { field: "mediaType", operator: "in", value: ["MOVIE", "TV"] },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);
      expect(ConfigurableStep.executionLog.map((l) => l.name)).toContain("in_check");
    });
  });

  describe("shouldPause behavior", () => {
    it("throws pause error when step returns shouldPause", async () => {
      const templateId = await createTemplate([
        {
          type: "APPROVAL",
          name: "Pause Step",
          config: { name: "pause_step", shouldPause: true },
          required: true,
          continueOnError: false,
        },
      ]);

      await expect(executor.startExecution(mockRequestId, templateId)).rejects.toThrow("paused");

      // Note: pauseExecution sets PAUSED, but the error propagates to
      // startExecution's catch block which calls failExecution, overriding
      // the status to FAILED. This is an existing behavior where failExecution
      // only skips if status is already FAILED, not PAUSED.
      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: mockRequestId },
      });
      expect(execution?.status).toBe("FAILED");
    });
  });

  describe("shouldRetry behavior", () => {
    it("completes execution when step returns shouldRetry", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Retry Step",
          config: { name: "retry_step", shouldRetry: true },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: mockRequestId },
      });
      expect(execution?.status).toBe("COMPLETED");
    });
  });

  describe("shouldSkip behavior", () => {
    it("skips step and continues to siblings", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Skip Step",
          config: { name: "skip_step", shouldSkip: true },
          required: true,
          continueOnError: false,
        },
        {
          type: "NOTIFICATION",
          name: "After Skip",
          config: { name: "after_skip" },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const names = ConfigurableStep.executionLog.map((l) => l.name);
      expect(names).toContain("skip_step");
      expect(names).toContain("after_skip");
    });
  });

  describe("nextStep override", () => {
    it("stops pipeline when nextStep is null", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Stop Step",
          config: { name: "stop_step", nextStep: null, data: { stopped: true } },
          required: true,
          continueOnError: false,
          children: [
            {
              type: "DOWNLOAD",
              name: "Should Not Run",
              config: { name: "should_not_run" },
              required: true,
              continueOnError: false,
            },
          ],
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const names = ConfigurableStep.executionLog.map((l) => l.name);
      expect(names).toContain("stop_step");
      expect(names).not.toContain("should_not_run");
    });
  });

  describe("Deep nesting", () => {
    it("executes 3+ levels of parent -> child -> grandchild", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Level 1",
          config: { name: "level_1" },
          required: true,
          continueOnError: false,
          children: [
            {
              type: "DOWNLOAD",
              name: "Level 2",
              config: { name: "level_2" },
              required: true,
              continueOnError: false,
              children: [
                {
                  type: "ENCODE",
                  name: "Level 3",
                  config: { name: "level_3" },
                  required: true,
                  continueOnError: false,
                  children: [
                    {
                      type: "DELIVER",
                      name: "Level 4",
                      config: { name: "level_4" },
                      required: true,
                      continueOnError: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const names = ConfigurableStep.executionLog.map((l) => l.name);
      expect(names).toEqual(["level_1", "level_2", "level_3", "level_4"]);
    });
  });

  describe("Mixed tree execution", () => {
    it("handles parallel branches where one has sequential children", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Branch A",
          config: { name: "branch_a", delay: 10 },
          required: true,
          continueOnError: false,
          children: [
            {
              type: "DOWNLOAD",
              name: "A Child",
              config: { name: "a_child" },
              required: true,
              continueOnError: false,
            },
          ],
        },
        {
          type: "NOTIFICATION",
          name: "Branch B (leaf)",
          config: { name: "branch_b" },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const names = ConfigurableStep.executionLog.map((l) => l.name);
      expect(names).toContain("branch_a");
      expect(names).toContain("a_child");
      expect(names).toContain("branch_b");
      expect(names).toHaveLength(3);
    });
  });

  describe("Empty step tree", () => {
    it("completes immediately with no steps", async () => {
      const templateId = await createTemplate([]);

      await executor.startExecution(mockRequestId, templateId);

      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: mockRequestId },
      });
      expect(execution?.status).toBe("COMPLETED");
      expect(ConfigurableStep.executionLog).toHaveLength(0);
    });
  });

  describe("Step registry miss", () => {
    it("throws when step type not registered", async () => {
      StepRegistry.reset();
      // Don't register any steps

      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Unregistered",
          config: { name: "test" },
          required: true,
          continueOnError: false,
        },
      ]);

      await expect(executor.startExecution(mockRequestId, templateId)).rejects.toThrow();
    });
  });

  describe("Context preservation", () => {
    it("preserves core context fields through step execution", async () => {
      const templateId = await createTemplate([
        {
          type: "SEARCH",
          name: "Context Step",
          config: {
            name: "context_step",
            data: {
              requestId: "should-not-overwrite",
              title: "should-not-overwrite",
              customField: "should-persist",
            },
          },
          required: true,
          continueOnError: false,
        },
      ]);

      await executor.startExecution(mockRequestId, templateId);

      const execution = await mockPrisma.pipelineExecution.findFirst({
        where: { requestId: mockRequestId },
      });

      const context = execution?.context as Record<string, unknown>;
      expect(context.requestId).toBe(mockRequestId);
      expect(context.title).toBe("Test Movie");
      expect(context.customField).toBe("should-persist");
    });
  });
});

describe("BaseStep - Condition Evaluation", () => {
  class TestStep extends BaseStep {
    readonly type = "SEARCH" as StepType;

    validateConfig(): void {}
    async execute(): Promise<StepOutput> {
      return { success: true };
    }
  }

  const step = new TestStep();

  function makeContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
    return {
      requestId: "test-req",
      mediaType: "MOVIE" as any,
      tmdbId: 27205,
      title: "Inception",
      year: 2010,
      targets: [],
      ...overrides,
    };
  }

  it("returns true when no condition", () => {
    expect(step.evaluateCondition(makeContext())).toBe(true);
  });

  it("handles == operator", () => {
    const condition: ConditionRule = { field: "mediaType", operator: "==", value: "MOVIE" };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);

    condition.value = "TV";
    expect(step.evaluateCondition(makeContext(), condition)).toBe(false);
  });

  it("handles != operator", () => {
    const condition: ConditionRule = { field: "mediaType", operator: "!=", value: "TV" };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });

  it("handles > and < operators", () => {
    const context = makeContext({ year: 2010 });
    expect(step.evaluateCondition(context, { field: "year", operator: ">", value: 2005 })).toBe(
      true
    );
    expect(step.evaluateCondition(context, { field: "year", operator: ">", value: 2020 })).toBe(
      false
    );
    expect(step.evaluateCondition(context, { field: "year", operator: "<", value: 2020 })).toBe(
      true
    );
  });

  it("handles >= and <= operators", () => {
    const context = makeContext({ year: 2010 });
    expect(step.evaluateCondition(context, { field: "year", operator: ">=", value: 2010 })).toBe(
      true
    );
    expect(step.evaluateCondition(context, { field: "year", operator: "<=", value: 2010 })).toBe(
      true
    );
  });

  it("handles 'in' operator", () => {
    const condition: ConditionRule = {
      field: "mediaType",
      operator: "in",
      value: ["MOVIE", "TV"],
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);

    condition.value = ["TV", "ANIME"];
    expect(step.evaluateCondition(makeContext(), condition)).toBe(false);
  });

  it("handles 'not_in' operator", () => {
    const condition: ConditionRule = {
      field: "mediaType",
      operator: "not_in",
      value: ["TV", "ANIME"],
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });

  it("handles 'contains' operator", () => {
    const condition: ConditionRule = {
      field: "title",
      operator: "contains",
      value: "cepti",
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });

  it("handles 'matches' operator", () => {
    const condition: ConditionRule = {
      field: "title",
      operator: "matches",
      value: "^In.*on$",
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });

  it("handles nested AND conditions", () => {
    const condition: ConditionRule = {
      field: "",
      operator: "==",
      value: "",
      logicalOp: "AND",
      conditions: [
        { field: "mediaType", operator: "==", value: "MOVIE" },
        { field: "year", operator: ">", value: 2005 },
      ],
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });

  it("handles nested OR conditions", () => {
    const condition: ConditionRule = {
      field: "",
      operator: "==",
      value: "",
      logicalOp: "OR",
      conditions: [
        { field: "mediaType", operator: "==", value: "TV" },
        { field: "year", operator: "==", value: 2010 },
      ],
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });

  it("returns false for AND when one condition fails", () => {
    const condition: ConditionRule = {
      field: "",
      operator: "==",
      value: "",
      logicalOp: "AND",
      conditions: [
        { field: "mediaType", operator: "==", value: "MOVIE" },
        { field: "year", operator: ">", value: 2020 },
      ],
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(false);
  });

  it("handles dot notation for nested context fields", () => {
    const context = makeContext({
      search: { selectedRelease: { resolution: "1080p" } as any },
    } as any);
    const condition: ConditionRule = {
      field: "search.selectedRelease.resolution",
      operator: "==",
      value: "1080p",
    };
    expect(step.evaluateCondition(context, condition)).toBe(true);
  });

  it("returns undefined for non-existent nested path", () => {
    const condition: ConditionRule = {
      field: "nonexistent.deep.path",
      operator: "==",
      value: undefined,
    };
    expect(step.evaluateCondition(makeContext(), condition)).toBe(true);
  });
});
