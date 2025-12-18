import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { ApprovalStatus } from "@prisma/client";
import { getApprovalService } from "../services/approvals/ApprovalService.js";
import { observable } from "@trpc/server/observable";
import { EventEmitter } from "events";

const approvalEmitter = new EventEmitter();

export const approvalsRouter = router({
  /**
   * List all approval requests
   */
  list: publicProcedure
    .input(
      z
        .object({
          status: z.enum(["PENDING", "APPROVED", "REJECTED", "SKIPPED", "TIMEOUT"]).optional(),
          requestId: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const where: {
        status?: ApprovalStatus;
        requestId?: string;
      } = {};

      if (input?.status) {
        where.status = input.status as ApprovalStatus;
      }

      if (input?.requestId) {
        where.requestId = input.requestId;
      }

      const approvals = await prisma.approvalQueue.findMany({
        where,
        include: {
          request: {
            select: {
              id: true,
              title: true,
              type: true,
              year: true,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      return approvals.map((a) => ({
        id: a.id,
        requestId: a.requestId,
        request: {
          title: a.request.title,
          year: a.request.year,
          type: a.request.type,
        },
        executionId: a.executionId,
        stepOrder: a.stepOrder,
        reason: a.reason,
        context: a.context,
        status: a.status,
        requiredRole: a.requiredRole,
        timeoutHours: a.timeoutHours,
        autoAction: a.autoAction,
        processedBy: a.processedBy,
        processedAt: a.processedAt,
        comment: a.comment,
        createdAt: a.createdAt,
      }));
    }),

  /**
   * Get a single approval by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const approval = await prisma.approvalQueue.findUnique({
      where: { id: input.id },
      include: {
        request: {
          select: {
            id: true,
            title: true,
            type: true,
            year: true,
            status: true,
          },
        },
      },
    });

    if (!approval) {
      return null;
    }

    return {
      id: approval.id,
      requestId: approval.requestId,
      request: {
        title: approval.request.title,
        year: approval.request.year,
        type: approval.request.type,
        status: approval.request.status,
      },
      executionId: approval.executionId,
      stepOrder: approval.stepOrder,
      reason: approval.reason,
      context: approval.context,
      status: approval.status,
      requiredRole: approval.requiredRole,
      timeoutHours: approval.timeoutHours,
      autoAction: approval.autoAction,
      processedBy: approval.processedBy,
      processedAt: approval.processedAt,
      comment: approval.comment,
      createdAt: approval.createdAt,
    };
  }),

  /**
   * Process an approval (approve or reject)
   */
  process: publicProcedure
    .input(
      z.object({
        id: z.string(),
        action: z.enum(["approve", "reject"]),
        processedBy: z.string(),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const approvalService = getApprovalService();

      await approvalService.processApproval({
        approvalId: input.id,
        action: input.action,
        processedBy: input.processedBy,
        comment: input.comment,
      });

      const approval = await prisma.approvalQueue.findUnique({
        where: { id: input.id },
      });

      if (approval) {
        approvalEmitter.emit("approval-processed", {
          id: approval.id,
          requestId: approval.requestId,
          action: input.action,
        });
      }

      return { success: true };
    }),

  /**
   * Get pending approval count
   */
  pendingCount: publicProcedure.query(async () => {
    const count = await prisma.approvalQueue.count({
      where: {
        status: ApprovalStatus.PENDING,
      },
    });

    return { count };
  }),

  /**
   * Subscribe to new approval requests
   */
  onNewApproval: publicProcedure.subscription(() => {
    return observable<{
      id: string;
      requestId: string;
      title: string;
      year: number;
      reason: string | null;
    }>((emit) => {
      const onNewApproval = (data: {
        id: string;
        requestId: string;
        title: string;
        year: number;
        reason: string | null;
      }) => {
        emit.next(data);
      };

      approvalEmitter.on("new-approval", onNewApproval);

      return () => {
        approvalEmitter.off("new-approval", onNewApproval);
      };
    });
  }),

  /**
   * Subscribe to approval updates
   */
  onApprovalProcessed: publicProcedure.subscription(() => {
    return observable<{
      id: string;
      requestId: string;
      action: string;
    }>((emit) => {
      const onProcessed = (data: { id: string; requestId: string; action: string }) => {
        emit.next(data);
      };

      approvalEmitter.on("approval-processed", onProcessed);

      return () => {
        approvalEmitter.off("approval-processed", onProcessed);
      };
    });
  }),
});

// Export emitter for use in ApprovalService
export { approvalEmitter };
