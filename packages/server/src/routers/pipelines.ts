import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { StepType, MediaType } from "@prisma/client";

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

const stepSchema = z.object({
  type: z.enum(["SEARCH", "DOWNLOAD", "ENCODE", "DELIVER", "APPROVAL", "NOTIFICATION"]),
  name: z.string().min(1),
  config: z.record(z.unknown()),
  condition: conditionRuleSchema.optional(),
  required: z.boolean().default(true),
  retryable: z.boolean().default(true),
  timeout: z.number().optional(),
  continueOnError: z.boolean().default(false),
});

const pipelineInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  mediaType: z.enum(["MOVIE", "TV"]),
  isDefault: z.boolean().default(false),
  isPublic: z.boolean().default(true),
  steps: z.array(stepSchema),
});

const pipelineUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  steps: z.array(stepSchema).optional(),
});

function toStepType(value: string): StepType {
  const map: Record<string, StepType> = {
    SEARCH: StepType.SEARCH,
    DOWNLOAD: StepType.DOWNLOAD,
    ENCODE: StepType.ENCODE,
    DELIVER: StepType.DELIVER,
    APPROVAL: StepType.APPROVAL,
    NOTIFICATION: StepType.NOTIFICATION,
  };
  return map[value] ?? StepType.SEARCH;
}

function toMediaType(value: string): MediaType {
  return value === "TV" ? MediaType.TV : MediaType.MOVIE;
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
        include: {
          steps: {
            orderBy: { order: "asc" },
          },
        },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      });

      return templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        mediaType: t.mediaType,
        isDefault: t.isDefault,
        isPublic: t.isPublic,
        stepCount: t.steps.length,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }));
    }),

  /**
   * Get a single pipeline template by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const template = await prisma.pipelineTemplate.findUnique({
      where: { id: input.id },
      include: {
        steps: {
          orderBy: { order: "asc" },
        },
      },
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
      steps: template.steps.map((s) => ({
        id: s.id,
        order: s.order,
        type: s.type,
        name: s.name,
        config: s.config,
        condition: s.condition,
        required: s.required,
        retryable: s.retryable,
        timeout: s.timeout,
        continueOnError: s.continueOnError,
      })),
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
        steps: {
          create: input.steps.map((step, index) => ({
            order: index,
            type: toStepType(step.type),
            name: step.name,
            config: step.config as import("@prisma/client").Prisma.InputJsonValue,
            condition: step.condition as import("@prisma/client").Prisma.InputJsonValue | undefined,
            required: step.required,
            retryable: step.retryable,
            timeout: step.timeout,
            continueOnError: step.continueOnError,
          })),
        },
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
      } = {};

      if (input.data.name) updateData.name = input.data.name;
      if (input.data.description !== undefined) updateData.description = input.data.description || null;
      if (input.data.isDefault !== undefined) updateData.isDefault = input.data.isDefault;
      if (input.data.isPublic !== undefined) updateData.isPublic = input.data.isPublic;

      await prisma.$transaction(async (tx) => {
        await tx.pipelineTemplate.update({
          where: { id: input.id },
          data: updateData,
        });

        if (input.data.steps) {
          await tx.pipelineStep.deleteMany({
            where: { templateId: input.id },
          });

          await tx.pipelineStep.createMany({
            data: input.data.steps.map((step, index) => ({
              templateId: input.id,
              order: index,
              type: toStepType(step.type),
              name: step.name,
              config: step.config as import("@prisma/client").Prisma.InputJsonValue,
              condition: step.condition as import("@prisma/client").Prisma.InputJsonValue | undefined,
              required: step.required,
              retryable: step.retryable,
              timeout: step.timeout,
              continueOnError: step.continueOnError,
            })),
          });
        }
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
        include: {
          steps: {
            orderBy: { order: "asc" },
          },
        },
      });

      if (!template) {
        throw new Error("Template not found");
      }

      return {
        success: true,
        message: "Test functionality not yet implemented",
        steps: template.steps.map((s) => s.name),
      };
    }),
});
