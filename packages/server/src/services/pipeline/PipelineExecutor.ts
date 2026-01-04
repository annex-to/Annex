// PipelineExecutor - Core service for executing customizable request pipelines
// Manages pipeline execution state, step orchestration, and error handling

import { type ExecutionStatus, Prisma, type StepStatus, type StepType } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { logger } from "../../utils/logger";
import type { PipelineContext, StepOutput } from "./PipelineContext";
import { registerPipelineSteps } from "./registerSteps";
import { StepRegistry } from "./StepRegistry";

// Tree-based step structure
export interface StepTree {
  type: StepType;
  name: string;
  config: unknown;
  condition?: unknown;
  required?: boolean;
  retryable?: boolean;
  timeout?: number;
  continueOnError?: boolean;
  children?: StepTree[];
}

interface StepExecution {
  status: StepStatus;
  [key: string]: unknown;
}

export class PipelineExecutor {
  // Start a new pipeline execution for a request
  async startExecution(requestId: string, templateId: string): Promise<void> {
    try {
      // Fetch the template
      const template = await prisma.pipelineTemplate.findUnique({
        where: { id: templateId },
      });

      if (!template) {
        throw new Error(`Pipeline template ${templateId} not found`);
      }

      // Fetch the request
      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
      });

      if (!request) {
        throw new Error(`Request ${requestId} not found`);
      }

      // Parse steps tree from template
      const stepsTree = template.steps as unknown as StepTree[];

      // Initialize context from request
      const initialContext: PipelineContext = {
        requestId: request.id,
        mediaType: request.type,
        tmdbId: request.tmdbId,
        title: request.title,
        year: request.year,
        requestedSeasons: request.requestedSeasons,
        requestedEpisodes: request.requestedEpisodes as
          | Array<{ season: number; episode: number }>
          | undefined,
        targets: request.targets as Array<{ serverId: string; encodingProfileId?: string }>,
        processingItemId: request.id, // Use requestId for deterministic file naming across retries
      };

      // Clean up stale state from previous pipeline runs
      logger.info(`Cleaning up stale state for request ${requestId}`);

      // 1. Delete any existing pipeline executions
      await prisma.pipelineExecution.deleteMany({
        where: { requestId },
      });

      // 2. Clear old errors from ProcessingItems (MediaRequest state computed from items)
      await prisma.processingItem.updateMany({
        where: { requestId },
        data: {
          lastError: null,
        },
      });

      // 3. Cancel/cleanup orphaned encoding jobs from previous attempts
      const orphanedJobs = await prisma.job.findMany({
        where: {
          requestId,
          type: "remote:encode",
        },
        include: { encoderAssignment: true },
      });

      for (const job of orphanedJobs) {
        if (job.encoderAssignment) {
          const assignment = job.encoderAssignment;
          // Cancel if still in active state
          if (["PENDING", "ASSIGNED", "ENCODING"].includes(assignment.status)) {
            await prisma.encoderAssignment.update({
              where: { id: assignment.id },
              data: {
                status: "CANCELLED",
                error: "Cancelled due to pipeline restart/retry",
              },
            });
            logger.info(`Cancelled orphaned encoding assignment ${assignment.id} for retry`);
          }
        }
      }

      logger.info(`Stale state cleaned up for request ${requestId}`);

      // Create pipeline execution
      const execution = await prisma.pipelineExecution.create({
        data: {
          requestId,
          templateId,
          status: "RUNNING" as ExecutionStatus,
          currentStep: 0,
          steps: stepsTree as unknown as Prisma.JsonArray,
          context: initialContext as unknown as Prisma.JsonObject,
        },
      });

      logger.info(`Started pipeline execution ${execution.id} for request ${requestId}`);

      // Start executing the tree
      await this.executeStepTree(execution.id, stepsTree, initialContext);

      // Mark execution as complete
      await this.completeExecution(execution.id);
    } catch (error) {
      logger.error(`Failed to execute pipeline for request ${requestId}:`, error);
      await this.failExecution(
        await this.getExecutionId(requestId),
        error instanceof Error ? error.message : "Unknown error"
      );
      throw error;
    }
  }

  // Get execution ID for a request
  private async getExecutionId(requestId: string): Promise<string> {
    const execution = await prisma.pipelineExecution.findFirst({
      where: { requestId },
      orderBy: { id: "desc" },
    });
    return execution?.id || "";
  }

  // Execute a tree of steps (supports parallel execution of branches)
  private async executeStepTree(
    executionId: string,
    steps: StepTree[],
    currentContext: PipelineContext
  ): Promise<PipelineContext> {
    // Execute all steps at this level in parallel
    const results = await Promise.all(
      steps.map(async (stepDef) => {
        try {
          // Get current execution state
          const execution = await prisma.pipelineExecution.findUnique({
            where: { id: executionId },
          });

          if (!execution || execution.status !== "RUNNING") {
            logger.info(
              `Pipeline execution ${executionId} is not running, stopping step ${stepDef.name}`
            );
            return currentContext;
          }

          // Create step instance
          const step = StepRegistry.create(stepDef.type);

          // Validate config
          step.validateConfig(stepDef.config);

          // Evaluate condition
          const shouldExecute = step.evaluateCondition(
            currentContext,
            stepDef.condition as unknown as Parameters<typeof step.evaluateCondition>[1]
          );

          if (!shouldExecute) {
            logger.info(`Skipped step ${stepDef.name} (condition not met)`);
            return currentContext;
          }

          // Log step start
          logger.info(`Executing step: ${stepDef.name}`);

          // DEBUG: Log config being passed to step
          if (stepDef.type === "ENCODE") {
            console.log(`[PipelineExecutor] About to execute ENCODE step`);
            console.log(
              `[PipelineExecutor] stepDef.config:`,
              JSON.stringify(stepDef.config, null, 2)
            );
          }

          // Execute the step
          const result: StepOutput = await step.execute(currentContext, stepDef.config);

          // Handle result
          if (result.shouldPause) {
            // Pause execution (used by ApprovalStep)
            await this.pauseExecution(executionId, `Awaiting approval: ${stepDef.name}`);
            throw new Error("Execution paused for approval");
          }

          if (result.shouldSkip) {
            logger.info(`Step ${stepDef.name} chose to skip`);
            return currentContext;
          }

          if (result.shouldRetry) {
            // Step needs retry (e.g., no releases found yet)
            // Complete execution gracefully - request is in AWAITING/QUALITY_UNAVAILABLE status
            // Background job will retry later
            logger.info(`Step ${stepDef.name} will retry later: ${result.error}`);
            await this.completeExecution(executionId);
            return currentContext;
          }

          if (!result.success) {
            // Step failed
            if (stepDef.continueOnError) {
              logger.warn(`Step ${stepDef.name} failed but continuing: ${result.error}`);
              return currentContext;
            } else if (stepDef.required !== false) {
              throw new Error(`Required step ${stepDef.name} failed: ${result.error}`);
            } else {
              logger.warn(`Optional step ${stepDef.name} failed: ${result.error}`);
              return currentContext;
            }
          }

          // Step succeeded - merge output into context
          // Preserve core context fields that should never be overwritten by step outputs
          const { requestId, mediaType, tmdbId, title, year, targets, ...otherFields } =
            currentContext;

          // Remove core fields from step output to prevent overwriting
          const {
            requestId: _rid,
            mediaType: _mt,
            tmdbId: _tid,
            title: _t,
            year: _y,
            targets: _tgt,
            ...stepData
          } = result.data || {};

          const updatedContext: PipelineContext = {
            ...otherFields,
            ...stepData,
            // Core fields always come last to ensure they're never overwritten
            requestId,
            mediaType,
            tmdbId,
            title,
            year,
            targets,
          };

          logger.info(`Completed step: ${stepDef.name}`);

          // Check if step explicitly set nextStep to null (stop pipeline)
          if (result.nextStep === null) {
            logger.info(`Step ${stepDef.name} requested pipeline stop (nextStep: null)`);
            await this.completeExecution(executionId);
            return updatedContext;
          }

          // Execute children if any
          if (stepDef.children && stepDef.children.length > 0) {
            return await this.executeStepTree(executionId, stepDef.children, updatedContext);
          }

          return updatedContext;
        } catch (error) {
          logger.error(`Step ${stepDef.name} failed:`, error);
          if (stepDef.required !== false) {
            throw error;
          }
          return currentContext;
        }
      })
    );

    // Merge all branch contexts (last one wins for conflicts)
    // But preserve core context fields from being overwritten
    const mergedContext = results.reduce((acc, ctx) => Object.assign(acc, ctx), {
      ...currentContext,
    });

    // Ensure core fields are never lost
    mergedContext.requestId = currentContext.requestId;
    mergedContext.mediaType = currentContext.mediaType;
    mergedContext.tmdbId = currentContext.tmdbId;
    mergedContext.title = currentContext.title;
    mergedContext.year = currentContext.year;
    mergedContext.targets = currentContext.targets;

    // Update execution context in database once after all parallel branches complete
    // Use updateMany to avoid errors if execution was already completed/cancelled
    await prisma.pipelineExecution.updateMany({
      where: {
        id: executionId,
        status: "RUNNING", // Only update if still running
      },
      data: { context: mergedContext as unknown as Prisma.JsonObject },
    });

    return mergedContext;
  }

  // Execute the next pending step in the pipeline (LEGACY - kept for compatibility)
  async executeNextStep(executionId: string): Promise<void> {
    try {
      // Fetch execution with current state
      const execution = await prisma.pipelineExecution.findUnique({
        where: { id: executionId },
        include: {
          stepExecutions: {
            orderBy: { stepOrder: "asc" },
          },
        },
      });

      if (!execution) {
        throw new Error(`Pipeline execution ${executionId} not found`);
      }

      // Check if execution is paused, cancelled, or completed
      if (execution.status !== "RUNNING") {
        logger.info(`Pipeline execution ${executionId} is ${execution.status}, stopping`);
        return;
      }

      // Find next pending step
      const nextStep = execution.stepExecutions.find((s: StepExecution) => s.status === "PENDING");

      if (!nextStep) {
        // All steps completed
        await this.completeExecution(executionId);
        return;
      }

      // Get step definition from snapshot
      const steps = execution.steps as Array<{
        order: number;
        type: StepType;
        name: string;
        config: unknown;
        condition: unknown;
        required: boolean;
        retryable: boolean;
        timeout?: number;
        continueOnError: boolean;
      }>;

      const stepDef = steps.find((s) => s.order === nextStep.stepOrder);
      if (!stepDef) {
        throw new Error(`Step definition not found for order ${nextStep.stepOrder}`);
      }

      // Update execution current step
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: { currentStep: nextStep.stepOrder },
      });

      // Execute the step
      await this.executeStep(executionId, nextStep.id, stepDef);

      // After step completes, execute next step
      await this.executeNextStep(executionId);
    } catch (error) {
      logger.error(`Failed to execute next step for execution ${executionId}:`, error);
      await this.failExecution(
        executionId,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  // Execute a single step
  private async executeStep(
    executionId: string,
    stepExecutionId: string,
    stepDef: {
      order: number;
      type: StepType;
      name: string;
      config: unknown;
      condition: unknown;
      required: boolean;
      retryable: boolean;
      timeout?: number;
      continueOnError: boolean;
    }
  ): Promise<void> {
    try {
      // Get current context
      const execution = await prisma.pipelineExecution.findUnique({
        where: { id: executionId },
      });

      if (!execution) {
        throw new Error(`Pipeline execution ${executionId} not found`);
      }

      const context = execution.context as PipelineContext;

      // Create step instance
      const step = StepRegistry.create(stepDef.type);

      // Validate config
      step.validateConfig(stepDef.config);

      // Evaluate condition
      const shouldExecute = step.evaluateCondition(
        context,
        stepDef.condition as unknown as Parameters<typeof step.evaluateCondition>[1]
      );

      if (!shouldExecute) {
        // Skip step
        await prisma.stepExecution.update({
          where: { id: stepExecutionId },
          data: {
            status: "SKIPPED" as StepStatus,
            completedAt: new Date(),
          },
        });
        logger.info(`Skipped step ${stepDef.name} (condition not met)`);
        return;
      }

      // Update step status to RUNNING
      await prisma.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "RUNNING" as StepStatus,
          startedAt: new Date(),
        },
      });

      // Set progress callback
      step.setProgressCallback(async (progress, message) => {
        await prisma.stepExecution.update({
          where: { id: stepExecutionId },
          data: { progress },
        });
        logger.debug(`Step ${stepDef.name} progress: ${progress}% ${message || ""}`);
      });

      // Execute the step
      const result: StepOutput = await step.execute(context, stepDef.config);

      // Handle result
      if (result.shouldPause) {
        // Pause execution (used by ApprovalStep)
        await this.pauseExecution(executionId, "Awaiting approval");
        await prisma.stepExecution.update({
          where: { id: stepExecutionId },
          data: {
            status: "RUNNING" as StepStatus,
            output: result.data ? (result.data as unknown as Prisma.JsonObject) : Prisma.JsonNull,
          },
        });
        return;
      }

      if (result.shouldSkip) {
        // Skip step
        await prisma.stepExecution.update({
          where: { id: stepExecutionId },
          data: {
            status: "SKIPPED" as StepStatus,
            output: result.data ? (result.data as unknown as Prisma.JsonObject) : Prisma.JsonNull,
            completedAt: new Date(),
          },
        });
        return;
      }

      if (!result.success) {
        // Step failed
        if (stepDef.continueOnError) {
          // Continue despite error
          await prisma.stepExecution.update({
            where: { id: stepExecutionId },
            data: {
              status: "FAILED" as StepStatus,
              error: result.error,
              completedAt: new Date(),
            },
          });
          logger.warn(`Step ${stepDef.name} failed but continuing: ${result.error}`);
          return;
        } else {
          throw new Error(result.error || "Step execution failed");
        }
      }

      // Step succeeded
      // Update context with step output
      const updatedContext = {
        ...context,
        ...result.data,
      };

      // Save context to ProcessingItem.stepContext (NEW - source of truth)
      if (updatedContext.processingItemId) {
        await prisma.processingItem.update({
          where: { id: updatedContext.processingItemId },
          data: {
            stepContext: updatedContext as unknown as Prisma.JsonObject,
          },
        });
      }

      // DEPRECATED: Also save to PipelineExecution.context for backwards compatibility
      // TODO: Remove this in Phase 4 after confirming the new system works
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: { context: updatedContext as unknown as Prisma.JsonObject },
      });

      await prisma.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "COMPLETED" as StepStatus,
          progress: 100,
          output: result.data ? (result.data as unknown as Prisma.JsonObject) : Prisma.JsonNull,
          completedAt: new Date(),
        },
      });

      logger.info(`Completed step ${stepDef.name}`);
    } catch (error) {
      logger.error(`Step ${stepDef.name} failed:`, error);

      // Update step status to FAILED
      await prisma.stepExecution.update({
        where: { id: stepExecutionId },
        data: {
          status: "FAILED" as StepStatus,
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        },
      });

      // Fail the entire execution if step is required
      if (stepDef.required) {
        throw error;
      }
    }
  }

  // Pause execution
  async pauseExecution(executionId: string, reason: string): Promise<void> {
    try {
      // Use updateMany to avoid errors if execution was already completed
      const result = await prisma.pipelineExecution.updateMany({
        where: {
          id: executionId,
          status: "RUNNING", // Only pause if still running
        },
        data: {
          status: "PAUSED" as ExecutionStatus,
          error: reason,
        },
      });

      if (result.count > 0) {
        logger.info(`Paused pipeline execution ${executionId}: ${reason}`);
      } else {
        logger.debug(`Skipped pausing execution ${executionId} (not running or doesn't exist)`);
      }
    } catch (err) {
      logger.error(`Error while pausing execution ${executionId}:`, err);
    }
  }

  // Resume execution (LEGACY - for sequential pipeline system)
  async resumeExecution(executionId: string): Promise<void> {
    await prisma.pipelineExecution.update({
      where: { id: executionId },
      data: {
        status: "RUNNING" as ExecutionStatus,
        error: null,
      },
    });
    logger.info(`Resumed pipeline execution ${executionId}`);

    // Continue executing steps
    await this.executeNextStep(executionId);
  }

  /**
   * Load context from ProcessingItem.stepContext (source of truth).
   * Falls back to PipelineExecution.context for backwards compatibility.
   */
  private async loadContext(executionId: string, requestId: string): Promise<PipelineContext> {
    // Get the MediaRequest for base context
    const request = await prisma.mediaRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new Error(`Request ${requestId} not found`);
    }

    // Try to find a ProcessingItem with step context
    const processingItem = await prisma.processingItem.findFirst({
      where: { requestId },
      orderBy: { updatedAt: "desc" },
      select: { id: true, stepContext: true },
    });

    // If ProcessingItem has stepContext, use it (NEW WAY - source of truth)
    if (processingItem?.stepContext && typeof processingItem.stepContext === "object") {
      const stepContext = processingItem.stepContext as Record<string, unknown>;

      // Build context from ProcessingItem.stepContext + MediaRequest fields
      const context: PipelineContext = {
        requestId: request.id,
        mediaType: request.type,
        tmdbId: request.tmdbId,
        title: request.title,
        year: request.year,
        requestedSeasons: request.requestedSeasons,
        requestedEpisodes: request.requestedEpisodes as
          | Array<{ season: number; episode: number }>
          | undefined,
        targets: request.targets as Array<{ serverId: string; encodingProfileId?: string }>,
        processingItemId: processingItem.id,
        // Merge step-specific data from ProcessingItem.stepContext
        ...stepContext,
      };

      logger.info(
        `Loaded context from ProcessingItem ${processingItem.id} for request ${requestId}`
      );
      return context;
    }

    // BACKWARDS COMPATIBILITY: Fall back to PipelineExecution.context (OLD WAY)
    const execution = await prisma.pipelineExecution.findUnique({
      where: { id: executionId },
      select: { context: true },
    });

    if (execution?.context) {
      logger.warn(
        `[MIGRATION] Falling back to PipelineExecution.context for execution ${executionId} - ProcessingItem has no stepContext`
      );
      return execution.context as PipelineContext;
    }

    // Last resort: Initialize fresh context from MediaRequest
    logger.warn(
      `[MIGRATION] No context found for request ${requestId}, initializing fresh context`
    );
    return {
      requestId: request.id,
      mediaType: request.type,
      tmdbId: request.tmdbId,
      title: request.title,
      year: request.year,
      requestedSeasons: request.requestedSeasons,
      requestedEpisodes: request.requestedEpisodes as
        | Array<{ season: number; episode: number }>
        | undefined,
      targets: request.targets as Array<{ serverId: string; encodingProfileId?: string }>,
      processingItemId: requestId,
    };
  }

  // Resume tree-based execution after hot reload or restart
  async resumeTreeExecution(executionId: string): Promise<void> {
    // Ensure pipeline steps are registered before attempting to resume
    if (StepRegistry.getRegisteredTypes().length === 0) {
      logger.info("[Pipeline] Steps not registered, registering now...");
      registerPipelineSteps();
    }

    try {
      // Load the execution with its current state
      const execution = await prisma.pipelineExecution.findUnique({
        where: { id: executionId },
      });

      if (!execution) {
        throw new Error(`Pipeline execution ${executionId} not found`);
      }

      if (execution.status !== "RUNNING") {
        logger.info(`Pipeline execution ${executionId} is ${execution.status}, not resuming`);
        return;
      }

      // Get the step tree
      const stepsTree = execution.steps as unknown as StepTree[];

      // Load context from ProcessingItem.stepContext (fixes dual-context bug)
      const currentContext = await this.loadContext(executionId, execution.requestId);

      logger.info(
        `Resuming tree-based pipeline execution ${executionId} for request ${execution.requestId}`
      );

      // Re-execute the tree with the current context
      // Steps will check context to determine if they need to run
      await this.executeStepTree(executionId, stepsTree, currentContext);

      // Mark execution as complete
      await this.completeExecution(executionId);
    } catch (error) {
      logger.error(`Failed to resume tree execution ${executionId}:`, error);
      await this.failExecution(
        executionId,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  // Fail execution
  async failExecution(executionId: string, error: string): Promise<void> {
    try {
      // Get execution to find requestId
      const execution = await prisma.pipelineExecution.findUnique({
        where: { id: executionId },
        select: { requestId: true, status: true },
      });

      if (!execution) {
        logger.debug(`Skipped failing execution ${executionId} (doesn't exist)`);
        return;
      }

      if (execution.status === "FAILED") {
        logger.debug(`Skipped failing execution ${executionId} (already failed)`);
        return;
      }

      // Update PipelineExecution
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: {
          status: "FAILED" as ExecutionStatus,
          error,
          completedAt: new Date(),
        },
      });

      // Update all ProcessingItems for this request to FAILED (MediaRequest status computed from items)
      await prisma.processingItem.updateMany({
        where: {
          requestId: execution.requestId,
          status: {
            notIn: ["COMPLETED", "CANCELLED", "FAILED"], // Don't override terminal states
          },
        },
        data: {
          status: "FAILED" as import("@prisma/client").ProcessingStatus,
          lastError: error,
        },
      });

      logger.error(`Failed pipeline execution ${executionId}: ${error}`);
    } catch (err) {
      logger.error(`Error while failing execution ${executionId}:`, err);
    }
  }

  // Complete execution
  async completeExecution(executionId: string): Promise<void> {
    try {
      // Get execution to find requestId
      const execution = await prisma.pipelineExecution.findUnique({
        where: { id: executionId },
        select: { requestId: true, status: true },
      });

      if (!execution) {
        logger.debug(`Skipped completing execution ${executionId} (doesn't exist)`);
        return;
      }

      if (execution.status !== "RUNNING") {
        logger.debug(`Skipped completing execution ${executionId} (status: ${execution.status})`);
        return;
      }

      // Update PipelineExecution
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: {
          status: "COMPLETED" as ExecutionStatus,
          completedAt: new Date(),
        },
      });

      // Check if all ProcessingItems are completed
      const items = await prisma.processingItem.findMany({
        where: { requestId: execution.requestId },
        select: { status: true },
      });

      const allCompleted = items.every(
        (item: { status: import("@prisma/client").ProcessingStatus }) =>
          item.status === "COMPLETED" || item.status === "CANCELLED"
      );

      // Only update MediaRequest to COMPLETED if all items are done (and if it exists)
      if (allCompleted) {
        // MediaRequest status computed from ProcessingItems - no update needed
        logger.info(`Completed request ${execution.requestId} - all items finished`);
      }

      logger.info(`Completed pipeline execution ${executionId}`);
    } catch (err) {
      logger.error(`Error while completing execution ${executionId}:`, err);
    }
  }

  // Cancel execution
  async cancelExecution(executionId: string): Promise<void> {
    try {
      // Get execution to find requestId
      const execution = await prisma.pipelineExecution.findUnique({
        where: { id: executionId },
        select: { requestId: true, status: true },
      });

      if (!execution) {
        logger.debug(`Skipped cancelling execution ${executionId} (doesn't exist)`);
        return;
      }

      if (["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)) {
        logger.debug(`Skipped cancelling execution ${executionId} (status: ${execution.status})`);
        return;
      }

      // Update PipelineExecution
      await prisma.pipelineExecution.update({
        where: { id: executionId },
        data: {
          status: "CANCELLED" as ExecutionStatus,
          completedAt: new Date(),
        },
      });

      // Update MediaRequest to match (if all items are cancelled)
      const items = await prisma.processingItem.findMany({
        where: { requestId: execution.requestId },
        select: { status: true },
      });

      const allCancelled = items.every(
        (item: { status: import("@prisma/client").ProcessingStatus }) => item.status === "CANCELLED"
      );

      if (allCancelled) {
        // MediaRequest status computed from ProcessingItems (will be CANCELLED)
        logger.info(`All items cancelled for request ${execution.requestId}`);
      }

      logger.info(`Cancelled pipeline execution ${executionId}`);
    } catch (err) {
      logger.error(`Error while cancelling execution ${executionId}:`, err);
    }
  }

  // Spawn a branch pipeline execution (for TV episode processing)
  async spawnBranchExecution(
    parentExecutionId: string,
    requestId: string,
    episodeId: string,
    branchTemplateId: string,
    context: Partial<PipelineContext>
  ): Promise<string> {
    try {
      // Fetch the branch template
      const template = await prisma.pipelineTemplate.findUnique({
        where: { id: branchTemplateId },
      });

      if (!template) {
        throw new Error(`Branch template ${branchTemplateId} not found`);
      }

      // Parse steps tree from template
      const stepsTree = template.steps as unknown as StepTree[];

      // Get parent execution and request for context
      const parentExecution = await prisma.pipelineExecution.findUnique({
        where: { id: parentExecutionId },
        select: { context: true },
      });

      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
      });

      if (!request) {
        throw new Error(`Request ${requestId} not found`);
      }

      // Merge parent context with branch-specific context
      // Core fields from request should never be overwritten
      const parentContext = (parentExecution?.context as Record<string, unknown>) || {};

      // Remove core fields from context parameter to prevent overwriting
      const {
        requestId: _,
        mediaType: __,
        tmdbId: ___,
        title: ____,
        year: _____,
        targets: ______,
        ...contextData
      } = context as Partial<PipelineContext>;

      const branchContext: PipelineContext = {
        requestId: request.id,
        mediaType: request.type,
        tmdbId: request.tmdbId,
        title: request.title,
        year: request.year,
        targets: request.targets as Array<{ serverId: string; encodingProfileId?: string }>,
        episodeId, // Add episode ID to context
        ...parentContext, // Inherit from parent (e.g., selected release)
        ...contextData, // Override with branch-specific context (core fields removed)
      };

      // Create branch execution
      const branchExecution = await prisma.pipelineExecution.create({
        data: {
          requestId,
          templateId: branchTemplateId,
          parentExecutionId,
          episodeId,
          status: "RUNNING" as ExecutionStatus,
          currentStep: 0,
          steps: stepsTree as unknown as Prisma.JsonArray,
          context: branchContext as unknown as Prisma.JsonObject,
        },
      });

      logger.info(
        `Spawned branch execution ${branchExecution.id} for episode ${episodeId} (parent: ${parentExecutionId})`
      );

      // Start executing the branch asynchronously (don't wait)
      this.executeStepTree(branchExecution.id, stepsTree, branchContext)
        .then(async () => {
          await this.completeExecution(branchExecution.id);
        })
        .catch(async (error) => {
          logger.error(
            `Branch execution ${branchExecution.id} failed for episode ${episodeId}:`,
            error
          );
          await this.failExecution(
            branchExecution.id,
            error instanceof Error ? error.message : "Unknown error"
          );
        });

      return branchExecution.id;
    } catch (error) {
      logger.error(`Failed to spawn branch execution for episode ${episodeId}:`, error);
      throw error;
    }
  }
}

// Singleton instance
let pipelineExecutorInstance: PipelineExecutor | null = null;

export function getPipelineExecutor(): PipelineExecutor {
  if (!pipelineExecutorInstance) {
    pipelineExecutorInstance = new PipelineExecutor();
  }
  return pipelineExecutorInstance;
}
