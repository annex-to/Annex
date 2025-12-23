import { type MediaType, type NotificationProvider, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getNotificationDispatcher } from "../services/notifications/NotificationDispatcher.js";
import { publicProcedure, router } from "../trpc.js";

const notificationConfigSchema = z.object({
  name: z.string().min(1),
  provider: z.enum(["DISCORD", "WEBHOOK", "EMAIL", "PUSH"]),
  config: z.record(z.unknown()),
  events: z.array(z.string()).min(1),
  mediaType: z.enum(["MOVIE", "TV"]).optional(),
  enabled: z.boolean().default(true),
});

const notificationUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  events: z.array(z.string()).min(1).optional(),
  mediaType: z.enum(["MOVIE", "TV"]).optional().nullable(),
  enabled: z.boolean().optional(),
});

function toNotificationProvider(value: string): NotificationProvider {
  const map: Record<string, NotificationProvider> = {
    DISCORD: NotificationProvider.DISCORD,
    WEBHOOK: NotificationProvider.WEBHOOK,
    EMAIL: NotificationProvider.EMAIL,
    PUSH: NotificationProvider.PUSH,
  };
  return map[value] ?? NotificationProvider.WEBHOOK;
}

function toMediaType(value: string | null | undefined): MediaType | null {
  if (!value) return null;
  return value === "TV" ? MediaType.TV : MediaType.MOVIE;
}

export const notificationsRouter = router({
  /**
   * List all notification configs
   */
  list: publicProcedure
    .input(
      z
        .object({
          provider: z.enum(["DISCORD", "WEBHOOK", "EMAIL", "PUSH"]).optional(),
          enabled: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const where: {
        provider?: NotificationProvider;
        enabled?: boolean;
      } = {};

      if (input?.provider) {
        where.provider = toNotificationProvider(input.provider);
      }

      if (input?.enabled !== undefined) {
        where.enabled = input.enabled;
      }

      const configs = await prisma.notificationConfig.findMany({
        where,
        orderBy: {
          createdAt: "desc",
        },
      });

      type NotificationConfigData = Prisma.NotificationConfigGetPayload<Record<string, never>>;

      return configs.map((c: NotificationConfigData) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        events: c.events,
        mediaType: c.mediaType,
        enabled: c.enabled,
        createdAt: c.createdAt,
      }));
    }),

  /**
   * Get a single notification config by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const config = await prisma.notificationConfig.findUnique({
      where: { id: input.id },
    });

    if (!config) {
      return null;
    }

    return {
      id: config.id,
      name: config.name,
      provider: config.provider,
      config: config.config,
      events: config.events,
      mediaType: config.mediaType,
      enabled: config.enabled,
      createdAt: config.createdAt,
    };
  }),

  /**
   * Create a new notification config
   */
  create: publicProcedure.input(notificationConfigSchema).mutation(async ({ input, ctx }) => {
    const config = await prisma.notificationConfig.create({
      data: {
        name: input.name,
        provider: toNotificationProvider(input.provider),
        config: input.config as import("@prisma/client").Prisma.InputJsonValue,
        events: input.events,
        mediaType: toMediaType(input.mediaType),
        enabled: input.enabled,
        userId: (ctx as { userId?: string }).userId,
      },
    });

    return { id: config.id };
  }),

  /**
   * Update a notification config
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: notificationUpdateSchema,
      })
    )
    .mutation(async ({ input }) => {
      const updateData: {
        name?: string;
        config?: import("@prisma/client").Prisma.InputJsonValue;
        events?: string[];
        mediaType?: MediaType | null;
        enabled?: boolean;
      } = {};

      if (input.data.name) updateData.name = input.data.name;
      if (input.data.config) {
        updateData.config = input.data.config as import("@prisma/client").Prisma.InputJsonValue;
      }
      if (input.data.events) updateData.events = input.data.events;
      if (input.data.mediaType !== undefined) {
        updateData.mediaType = toMediaType(input.data.mediaType);
      }
      if (input.data.enabled !== undefined) updateData.enabled = input.data.enabled;

      await prisma.notificationConfig.update({
        where: { id: input.id },
        data: updateData,
      });

      return { success: true };
    }),

  /**
   * Delete a notification config
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    await prisma.notificationConfig.delete({
      where: { id: input.id },
    });

    return { success: true };
  }),

  /**
   * Test a notification config
   */
  test: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const dispatcher = getNotificationDispatcher();
    const result = await dispatcher.testNotification(input.id);

    return {
      success: result.success,
      error: result.error,
    };
  }),

  /**
   * Get available event types
   */
  availableEvents: publicProcedure.query(async () => {
    return [
      {
        value: "request.started",
        label: "Request Started",
        description: "When a new request is created",
      },
      {
        value: "request.completed",
        label: "Request Completed",
        description: "When a request is fully completed",
      },
      { value: "request.failed", label: "Request Failed", description: "When a request fails" },
      {
        value: "step.completed",
        label: "Step Completed",
        description: "When a pipeline step completes",
      },
      {
        value: "approval.required",
        label: "Approval Required",
        description: "When manual approval is needed",
      },
      {
        value: "approval.processed",
        label: "Approval Processed",
        description: "When an approval is approved or rejected",
      },
      {
        value: "search.quality_unavailable",
        label: "Quality Unavailable",
        description: "When requested quality is not available",
      },
    ];
  }),
});
