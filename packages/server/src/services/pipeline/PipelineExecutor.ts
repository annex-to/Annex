// PipelineExecutor - Core service for executing customizable request pipelines
// Manages pipeline execution state, step orchestration, and error handling

import { type ExecutionStatus, Prisma, type StepStatus, type StepType } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { logger } from "../../utils/logger";
import type { PipelineContext, StepOutput } from "./PipelineContext";
import { StepRegistry } from "./StepRegistry";

// Tree-based step structure
interface StepTree {
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
      };

      // Delete any existing execution for this request (in case of retry)
      await prisma.pipelineExecution.deleteMany({
        where: { requestId },
      });

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
          const updatedContext = {
            ...currentContext,
            ...result.data,
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
    const mergedContext = results.reduce((acc, ctx) => Object.assign(acc, ctx), {
      ...currentContext,
    });

    // Update execution context in database once after all parallel branches complete
    await prisma.pipelineExecution.update({
      where: { id: executionId },
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
    await prisma.pipelineExecution.update({
      where: { id: executionId },
      data: {
        status: "PAUSED" as ExecutionStatus,
        error: reason,
      },
    });
    logger.info(`Paused pipeline execution ${executionId}: ${reason}`);
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

  // Resume tree-based execution after hot reload or restart
  async resumeTreeExecution(executionId: string): Promise<void> {
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

      // Get the step tree and current context
      const stepsTree = execution.steps as unknown as StepTree[];
      const currentContext = execution.context as PipelineContext;

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
    await prisma.pipelineExecution.update({
      where: { id: executionId },
      data: {
        status: "FAILED" as ExecutionStatus,
        error,
        completedAt: new Date(),
      },
    });
    logger.error(`Failed pipeline execution ${executionId}: ${error}`);
  }

  // Complete execution
  async completeExecution(executionId: string): Promise<void> {
    await prisma.pipelineExecution.update({
      where: { id: executionId },
      data: {
        status: "COMPLETED" as ExecutionStatus,
        completedAt: new Date(),
      },
    });
    logger.info(`Completed pipeline execution ${executionId}`);
  }

  // Cancel execution
  async cancelExecution(executionId: string): Promise<void> {
    await prisma.pipelineExecution.update({
      where: { id: executionId },
      data: {
        status: "CANCELLED" as ExecutionStatus,
        completedAt: new Date(),
      },
    });
    logger.info(`Cancelled pipeline execution ${executionId}`);
  }

  // Detect and clean up stuck pipeline executions
  async detectStuckExecutions(): Promise<void> {
    const stuckTimeout = 3600000; // 1 hour in ms
    const cutoff = new Date(Date.now() - stuckTimeout);

    // Find RUNNING executions
    const runningExecutions = await prisma.pipelineExecution.findMany({
      where: {
        status: "RUNNING" as ExecutionStatus,
      },
      include: {
        request: {
          select: {
            id: true,
            title: true,
            jobs: {
              where: {
                type: "remote:encode",
              },
              select: {
                id: true,
                encoderAssignment: {
                  select: {
                    id: true,
                    status: true,
                    lastProgressAt: true,
                    startedAt: true,
                    progress: true,
                  },
                },
              },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
          },
        },
      },
    });

    const stuckExecutions: typeof runningExecutions = [];

    for (const execution of runningExecutions) {
      // Check if there's an active encoding job
      const latestEncodingJob = execution.request?.jobs?.[0];
      const assignment = latestEncodingJob?.encoderAssignment;

      if (assignment && assignment.status === "ENCODING") {
        // Actively encoding - check if progress is stalled
        if (assignment.lastProgressAt && assignment.lastProgressAt < cutoff) {
          logger.warn(
            `[Pipeline] Execution ${execution.id} for "${execution.request?.title}" stuck - ` +
              `encoding progress stalled for > 1 hour (last update: ${assignment.lastProgressAt.toISOString()}, ` +
              `progress: ${assignment.progress}%)`
          );
          stuckExecutions.push(execution);
        }
      }
      // If status is PENDING or ASSIGNED, it's waiting in queue - allow indefinitely
      // If no encoding job yet, it's in an earlier step - check request updatedAt
      else if (
        !assignment ||
        (assignment.status !== "PENDING" && assignment.status !== "ASSIGNED")
      ) {
        // No active encoding, check if the request itself is stalled
        // Only timeout if request hasn't been updated in over 1 hour
        const request = await prisma.mediaRequest.findUnique({
          where: { id: execution.requestId },
          select: { updatedAt: true, status: true },
        });

        if (request && request.updatedAt < cutoff) {
          // Check if in an active status (should be making progress)
          const activeStatuses = ["SEARCHING", "DOWNLOADING", "DELIVERING"];
          if (activeStatuses.includes(request.status)) {
            logger.warn(
              `[Pipeline] Execution ${execution.id} for "${execution.request?.title}" stuck - ` +
                `no progress in ${request.status} status for > 1 hour`
            );
            stuckExecutions.push(execution);
          }
        }
      }
    }

    // Mark stuck executions as failed
    for (const execution of stuckExecutions) {
      await prisma.pipelineExecution.update({
        where: { id: execution.id },
        data: {
          status: "FAILED" as ExecutionStatus,
          error: "Pipeline execution stuck - no progress for over 1 hour",
          completedAt: new Date(),
        },
      });

      // Mark request as failed if it exists
      if (execution.requestId) {
        await prisma.mediaRequest
          .update({
            where: { id: execution.requestId },
            data: {
              status: "FAILED",
              error: "Pipeline execution stuck - no progress for over 1 hour",
            },
          })
          .catch((err) => logger.error(`Failed to update request ${execution.requestId}:`, err));
      }

      logger.info(`[Pipeline] Marked stuck execution ${execution.id} as FAILED`);
    }

    if (stuckExecutions.length > 0) {
      logger.info(`[Pipeline] Cleaned up ${stuckExecutions.length} stuck execution(s)`);
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
