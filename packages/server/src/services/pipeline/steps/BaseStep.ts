// BaseStep - Abstract base class for all pipeline steps
// Each step type (SEARCH, DOWNLOAD, ENCODE, etc.) extends this class

import type { StepType } from '@prisma/client';
import type { PipelineContext, ConditionRule, StepOutput } from '../PipelineContext';

// Re-export StepOutput for convenience
export type { StepOutput };

export abstract class BaseStep {
  abstract readonly type: StepType;

  // Validate step-specific configuration
  abstract validateConfig(config: unknown): void;

  // Execute the step with the given context and config
  abstract execute(context: PipelineContext, config: unknown): Promise<StepOutput>;

  // Progress callback (can be overridden by executor)
  protected progressCallback?: (progress: number, message?: string) => void;

  // Set progress callback
  setProgressCallback(callback: (progress: number, message?: string) => void): void {
    this.progressCallback = callback;
  }

  // Report progress during execution
  protected reportProgress(progress: number, message?: string): void {
    if (this.progressCallback) {
      this.progressCallback(progress, message);
    }
  }

  // Evaluate conditional execution rules
  evaluateCondition(context: PipelineContext, condition?: ConditionRule): boolean {
    if (!condition) {
      return true; // No condition means always execute
    }

    // Handle nested conditions with logical operators
    if (condition.conditions && condition.conditions.length > 0) {
      const results = condition.conditions.map((c) => this.evaluateCondition(context, c));

      if (condition.logicalOp === 'OR') {
        return results.some((r) => r);
      } else {
        // Default to AND
        return results.every((r) => r);
      }
    }

    // Get value from context using dot notation
    const contextValue = this.getContextValue(context, condition.field);
    const expectedValue = condition.value;

    // Evaluate based on operator
    switch (condition.operator) {
      case '==':
        return contextValue === expectedValue;
      case '!=':
        return contextValue !== expectedValue;
      case '>':
        return typeof contextValue === 'number' &&
               typeof expectedValue === 'number' &&
               contextValue > expectedValue;
      case '<':
        return typeof contextValue === 'number' &&
               typeof expectedValue === 'number' &&
               contextValue < expectedValue;
      case '>=':
        return typeof contextValue === 'number' &&
               typeof expectedValue === 'number' &&
               contextValue >= expectedValue;
      case '<=':
        return typeof contextValue === 'number' &&
               typeof expectedValue === 'number' &&
               contextValue <= expectedValue;
      case 'in':
        return Array.isArray(expectedValue) && expectedValue.includes(contextValue);
      case 'not_in':
        return Array.isArray(expectedValue) && !expectedValue.includes(contextValue);
      case 'contains':
        return typeof contextValue === 'string' &&
               typeof expectedValue === 'string' &&
               contextValue.includes(expectedValue);
      case 'matches':
        return typeof contextValue === 'string' &&
               typeof expectedValue === 'string' &&
               new RegExp(expectedValue).test(contextValue);
      default:
        return false;
    }
  }

  // Get value from context using dot notation (e.g., "search.selectedRelease.quality")
  private getContextValue(context: PipelineContext, path: string): unknown {
    const parts = path.split('.');
    let value: unknown = context;

    for (const part of parts) {
      if (value === null || value === undefined) {
        return undefined;
      }
      value = (value as Record<string, unknown>)[part];
    }

    return value;
  }
}
