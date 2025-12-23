import { type ExecutionStatus, type MediaType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getPipelineExecutor } from "../services/pipeline/PipelineExecutor.js";
import { publicProcedure, router } from "../trpc.js";

export interface ConditionRuleType {
  field: string;
  operator: "==" | "!=" | ">" | "<" | ">=" | "<=" | "in" | "not_in" | "contains" | "matches";
  value?: unknown;
  logicalOp?: "AND" | "OR";
  conditions?: ConditionRuleType[];
}

const conditionRuleSchema: z.ZodType<ConditionRuleType> = z.lazy(() =>
  z.object({
    field: z.string(),
    operator: z.enum(["==", "!=", ">", "<", ">=", "<=", "in", "not_in", "contains", "matches"]),
    value: z.unknown(),
    logicalOp: z.enum(["AND", "OR"]).optional(),
    conditions: z.array(conditionRuleSchema).optional(),
  })
);

// Recursive step schema to support tree structure for parallel execution
export type StepSchemaType = {
  type: "SEARCH" | "DOWNLOAD" | "ENCODE" | "DELIVER" | "APPROVAL" | "NOTIFICATION";
  name: string;
  config: Record<string, unknown>;
  condition?: ConditionRuleType;
  required?: boolean;
  retryable?: boolean;
  timeout?: number;
  continueOnError?: boolean;
  children?: StepSchemaType[];
};

const stepSchema: z.ZodType<StepSchemaType> = z.lazy(() =>
  z.object({
    type: z.enum(["SEARCH", "DOWNLOAD", "ENCODE", "DELIVER", "APPROVAL", "NOTIFICATION"]),
    name: z.string().min(1),
    config: z.record(z.unknown()),
    condition: conditionRuleSchema.optional(),
    required: z.boolean().default(true),
    retryable: z.boolean().default(true),
    timeout: z.number().optional(),
    continueOnError: z.boolean().default(false),
    children: z.array(stepSchema).optional(),
  })
);

const pipelineInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  mediaType: z.enum(["MOVIE", "TV"]),
  isDefault: z.boolean().default(false),
  isPublic: z.boolean().default(true),
  steps: z.array(stepSchema),
  layout: z.record(z.unknown()).optional(), // Visual layout data (node positions)
});

const pipelineUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  steps: z.array(stepSchema).optional(),
  layout: z.record(z.unknown()).optional(),
});

function toMediaType(value: string): MediaType {
  return value === "TV" ? MediaType.TV : MediaType.MOVIE;
}

function countSteps(steps: StepSchemaType[]): number {
  let count = 0;
  for (const step of steps) {
    count++;
    if (step.children && step.children.length > 0) {
      count += countSteps(step.children);
    }
  }
  return count;
}

export const pipelinesRouter = router({
  /**
   * List all pipeline templates
   */
  list: publicProcedure
    .input(
      z
        .object({
          mediaType: z.enum(["MOVIE", "TV"]).optional(),
          userId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const where: {
        mediaType?: MediaType;
        userId?: string | null;
        isPublic?: boolean;
      } = {};

      if (input?.mediaType) {
        where.mediaType = toMediaType(input.mediaType);
      }

      if (input?.userId !== undefined) {
        where.userId = input.userId || null;
      } else {
        where.isPublic = true;
      }

      const templates = await prisma.pipelineTemplate.findMany({
        where,
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      });

      type PipelineTemplateData = Prisma.PipelineTemplateGetPayload<Record<string, never>>;

      return templates.map((t: PipelineTemplateData) => {
        const steps = (t.steps || []) as unknown as StepSchemaType[];
        return {
          id: t.id,
          name: t.name,
          description: t.description,
          mediaType: t.mediaType,
          isDefault: t.isDefault,
          isPublic: t.isPublic,
          stepCount: countSteps(steps),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        };
      });
    }),

  /**
   * Get a single pipeline template by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const template = await prisma.pipelineTemplate.findUnique({
      where: { id: input.id },
    });

    if (!template) {
      return null;
    }

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      mediaType: template.mediaType,
      isDefault: template.isDefault,
      isPublic: template.isPublic,
      steps: (template.steps || []) as unknown as StepSchemaType[],
      layout: (template.layout || null) as Record<string, unknown> | null,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }),

  /**
   * Create a new pipeline template
   */
  create: publicProcedure.input(pipelineInputSchema).mutation(async ({ input, ctx }) => {
    const template = await prisma.pipelineTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        mediaType: toMediaType(input.mediaType),
        isDefault: input.isDefault,
        isPublic: input.isPublic,
        userId: (ctx as { userId?: string }).userId,
        steps: input.steps as unknown as import("@prisma/client").Prisma.InputJsonValue,
        layout: input.layout
          ? (input.layout as unknown as import("@prisma/client").Prisma.InputJsonValue)
          : undefined,
      },
    });

    return { id: template.id };
  }),

  /**
   * Update a pipeline template
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: pipelineUpdateSchema,
      })
    )
    .mutation(async ({ input }) => {
      const updateData: {
        name?: string;
        description?: string | null;
        isDefault?: boolean;
        isPublic?: boolean;
        steps?: import("@prisma/client").Prisma.InputJsonValue;
        layout?: import("@prisma/client").Prisma.InputJsonValue;
      } = {};

      if (input.data.name) updateData.name = input.data.name;
      if (input.data.description !== undefined)
        updateData.description = input.data.description || null;
      if (input.data.isDefault !== undefined) updateData.isDefault = input.data.isDefault;
      if (input.data.isPublic !== undefined) updateData.isPublic = input.data.isPublic;
      if (input.data.steps)
        updateData.steps = input.data
          .steps as unknown as import("@prisma/client").Prisma.InputJsonValue;
      if (input.data.layout !== undefined) {
        updateData.layout = input.data.layout
          ? (input.data.layout as unknown as import("@prisma/client").Prisma.InputJsonValue)
          : undefined;
      }

      await prisma.pipelineTemplate.update({
        where: { id: input.id },
        data: updateData,
      });

      return { success: true };
    }),

  /**
   * Delete a pipeline template
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    await prisma.pipelineTemplate.delete({
      where: { id: input.id },
    });

    return { success: true };
  }),

  /**
   * Test a pipeline template with a mock request
   */
  test: publicProcedure
    .input(
      z.object({
        id: z.string(),
        mockData: z.object({
          tmdbId: z.number(),
          title: z.string(),
          year: z.number(),
        }),
      })
    )
    .mutation(async ({ input }) => {
      const template = await prisma.pipelineTemplate.findUnique({
        where: { id: input.id },
      });

      if (!template) {
        throw new Error("Template not found");
      }

      const steps = (template.steps || []) as unknown as StepSchemaType[];

      return {
        success: true,
        message: "Test functionality not yet implemented",
        steps: steps.map((s) => s.name),
      };
    }),

  /**
   * Execute a pipeline for a request
   */
  execute: publicProcedure
    .input(
      z.object({
        requestId: z.string(),
        templateId: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const executor = getPipelineExecutor();

      // Start execution (runs asynchronously)
      executor.startExecution(input.requestId, input.templateId).catch((error) => {
        console.error(`Pipeline execution failed for request ${input.requestId}:`, error);
      });

      return { success: true, message: "Pipeline execution started" };
    }),

  /**
   * Get a pipeline execution by ID
   */
  getExecution: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const execution = await prisma.pipelineExecution.findUnique({
      where: { id: input.id },
      include: {
        stepExecutions: {
          orderBy: { stepOrder: "asc" },
        },
      },
    });

    if (!execution) {
      return null;
    }

    return {
      id: execution.id,
      requestId: execution.requestId,
      templateId: execution.templateId,
      status: execution.status,
      currentStep: execution.currentStep,
      context: execution.context,
      error: execution.error,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      stepExecutions: execution.stepExecutions,
    };
  }),

  /**
   * Get execution for a specific request
   */
  getExecutionByRequest: publicProcedure
    .input(z.object({ requestId: z.string() }))
    .query(async ({ input }) => {
      const execution = await prisma.pipelineExecution.findUnique({
        where: { requestId: input.requestId },
        include: {
          stepExecutions: {
            orderBy: { stepOrder: "asc" },
          },
        },
      });

      if (!execution) {
        return null;
      }

      return {
        id: execution.id,
        requestId: execution.requestId,
        templateId: execution.templateId,
        status: execution.status,
        currentStep: execution.currentStep,
        context: execution.context,
        error: execution.error,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        stepExecutions: execution.stepExecutions,
      };
    }),

  /**
   * List all executions for a template
   */
  listExecutions: publicProcedure
    .input(
      z.object({
        templateId: z.string().optional(),
        status: z.nativeEnum(ExecutionStatus).optional(),
        limit: z.number().default(50),
      })
    )
    .query(async ({ input }) => {
      const where: {
        templateId?: string;
        status?: ExecutionStatus;
      } = {};

      if (input.templateId) {
        where.templateId = input.templateId;
      }

      if (input.status) {
        where.status = input.status;
      }

      const executions = await prisma.pipelineExecution.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: input.limit,
        include: {
          request: {
            select: {
              title: true,
              type: true,
            },
          },
        },
      });

      type ExecutionWithRequest = Prisma.PipelineExecutionGetPayload<{
        include: { request: { select: { title: true; type: true } } };
      }>;

      return executions.map((e: ExecutionWithRequest) => ({
        id: e.id,
        requestId: e.requestId,
        templateId: e.templateId,
        status: e.status,
        currentStep: e.currentStep,
        error: e.error,
        startedAt: e.startedAt,
        completedAt: e.completedAt,
        requestTitle: e.request.title,
        requestType: e.request.type,
      }));
    }),

  /**
   * Cancel a running pipeline execution
   */
  cancelExecution: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const executor = getPipelineExecutor();
      await executor.cancelExecution(input.id);

      return { success: true };
    }),

  /**
   * Resume a paused pipeline execution
   */
  resumeExecution: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const executor = getPipelineExecutor();
      await executor.resumeExecution(input.id);

      return { success: true };
    }),
});
