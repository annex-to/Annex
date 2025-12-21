/**
 * Pipeline Test Assertions - Custom assertions for pipeline testing
 */

import { expect } from "bun:test";
import type { StepOutput } from "../../PipelineContext";

/**
 * Assert that a step output represents success
 */
export function assertStepSuccess(result: StepOutput, message?: string): void {
  expect(result.success).toBe(true);
  expect(result.error).toBeUndefined();
  if (message) {
    expect(result).toBeDefined();
  }
}

/**
 * Assert that a step output represents failure
 */
export function assertStepFailure(result: StepOutput, expectedError?: string): void {
  expect(result.success).toBe(false);
  if (expectedError) {
    expect(result.error).toContain(expectedError);
  }
}

/**
 * Assert that a step should skip
 */
export function assertStepSkipped(result: StepOutput): void {
  expect(result.shouldSkip).toBe(true);
}

/**
 * Assert that a step should pause
 */
export function assertStepPaused(result: StepOutput): void {
  expect(result.shouldPause).toBe(true);
}

/**
 * Assert that a step should retry
 */
export function assertStepRetry(result: StepOutput): void {
  expect(result.shouldRetry).toBe(true);
}

/**
 * Assert that step output contains specific data
 */
export function assertStepData(result: StepOutput, key: string, value?: unknown): void {
  expect(result.data).toBeDefined();
  if (result.data) {
    expect(result.data[key]).toBeDefined();

    if (value !== undefined) {
      expect(result.data[key]).toEqual(value);
    }
  }
}

/**
 * Assert that step output has a specific next step
 */
export function assertNextStep(result: StepOutput, nextStep: string | null): void {
  expect(result.nextStep).toBe(nextStep);
}
