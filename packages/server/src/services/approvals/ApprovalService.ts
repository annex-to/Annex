// ApprovalService - Manages approval requests for pipeline steps
// Handles approval creation, processing, and timeout checks

import { prisma } from "../../db/client.js";
import { ApprovalStatus, ActivityType } from "@prisma/client";

export interface CreateApprovalOptions {
  requestId: string;
  executionId: string;
  stepOrder: number;
  reason?: string;
  context: Record<string, unknown>;
  requiredRole: string;
  timeoutHours?: number;
  autoAction?: "approve" | "reject" | "cancel";
}

export interface ProcessApprovalOptions {
  approvalId: string;
  action: "approve" | "reject";
  processedBy: string;
  comment?: string;
}

export class ApprovalService {
  async createApproval(options: CreateApprovalOptions): Promise<string> {
    const approval = await prisma.approvalQueue.create({
      data: {
        requestId: options.requestId,
        executionId: options.executionId,
        stepOrder: options.stepOrder,
        reason: options.reason,
        context: options.context as import("@prisma/client").Prisma.InputJsonValue,
        status: ApprovalStatus.PENDING,
        requiredRole: options.requiredRole,
        timeoutHours: options.timeoutHours,
        autoAction: options.autoAction,
      },
    });

    await this.logActivity(
      options.requestId,
      ActivityType.INFO,
      `Approval required: ${options.reason || "Manual approval needed"}`,
      {
        approvalId: approval.id,
        requiredRole: options.requiredRole,
        timeoutHours: options.timeoutHours,
        autoAction: options.autoAction,
      }
    );

    return approval.id;
  }

  async processApproval(options: ProcessApprovalOptions): Promise<void> {
    const approval = await prisma.approvalQueue.findUnique({
      where: { id: options.approvalId },
      include: { request: true },
    });

    if (!approval) {
      throw new Error("Approval not found");
    }

    if (approval.status !== ApprovalStatus.PENDING) {
      throw new Error(`Approval already ${approval.status.toLowerCase()}`);
    }

    const newStatus = options.action === "approve" ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;

    await prisma.approvalQueue.update({
      where: { id: options.approvalId },
      data: {
        status: newStatus,
        processedBy: options.processedBy,
        processedAt: new Date(),
        comment: options.comment,
      },
    });

    await this.logActivity(
      approval.requestId,
      options.action === "approve" ? ActivityType.SUCCESS : ActivityType.WARNING,
      `Approval ${options.action}ed by ${options.processedBy}${options.comment ? `: ${options.comment}` : ""}`,
      {
        approvalId: approval.id,
        action: options.action,
        processedBy: options.processedBy,
      }
    );

    // TODO: Resume pipeline execution if approved
    // This will be handled by the PipelineExecutor when it's integrated
  }

  async checkTimeouts(): Promise<void> {
    const now = new Date();

    // Find pending approvals that have exceeded their timeout
    const timedOutApprovals = await prisma.$queryRaw<Array<{
      id: string;
      requestId: string;
      autoAction: string | null;
      timeoutHours: number;
      createdAt: Date;
    }>>`
      SELECT id, "requestId", "autoAction", "timeoutHours", "createdAt"
      FROM "ApprovalQueue"
      WHERE status = 'PENDING'
      AND "timeoutHours" IS NOT NULL
      AND "createdAt" + ("timeoutHours" * INTERVAL '1 hour') <= ${now}
    `;

    for (const approval of timedOutApprovals) {
      const autoAction = approval.autoAction as "approve" | "reject" | "cancel" | null;

      if (autoAction === "approve") {
        await prisma.approvalQueue.update({
          where: { id: approval.id },
          data: {
            status: ApprovalStatus.APPROVED,
            processedBy: "system:timeout",
            processedAt: now,
            comment: "Auto-approved due to timeout",
          },
        });

        await this.logActivity(
          approval.requestId,
          ActivityType.WARNING,
          `Approval auto-approved after ${approval.timeoutHours}h timeout`,
          { approvalId: approval.id }
        );

        // TODO: Resume pipeline execution
      } else if (autoAction === "reject") {
        await prisma.approvalQueue.update({
          where: { id: approval.id },
          data: {
            status: ApprovalStatus.REJECTED,
            processedBy: "system:timeout",
            processedAt: now,
            comment: "Auto-rejected due to timeout",
          },
        });

        await this.logActivity(
          approval.requestId,
          ActivityType.ERROR,
          `Approval auto-rejected after ${approval.timeoutHours}h timeout`,
          { approvalId: approval.id }
        );

        // TODO: Fail pipeline execution
      } else if (autoAction === "cancel") {
        await prisma.approvalQueue.update({
          where: { id: approval.id },
          data: {
            status: ApprovalStatus.TIMEOUT,
            processedBy: "system:timeout",
            processedAt: now,
            comment: "Cancelled due to timeout",
          },
        });

        await this.logActivity(
          approval.requestId,
          ActivityType.ERROR,
          `Request cancelled after ${approval.timeoutHours}h timeout`,
          { approvalId: approval.id }
        );

        // TODO: Cancel pipeline execution
      } else {
        // No auto-action, just mark as timed out
        await prisma.approvalQueue.update({
          where: { id: approval.id },
          data: {
            status: ApprovalStatus.TIMEOUT,
            processedAt: now,
            comment: "Timed out without auto-action",
          },
        });

        await this.logActivity(
          approval.requestId,
          ActivityType.WARNING,
          `Approval timed out after ${approval.timeoutHours}h (no auto-action configured)`,
          { approvalId: approval.id }
        );
      }
    }
  }

  async getPendingApprovals(userId?: string, role?: string) {
    const where: {
      status: ApprovalStatus;
      requiredRole?: string | { in: string[] };
    } = {
      status: ApprovalStatus.PENDING,
    };

    // Filter by role if provided
    if (role) {
      where.requiredRole = role === "admin" ? { in: ["admin", "moderator", "any"] } : "any";
    }

    return prisma.approvalQueue.findMany({
      where,
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
      orderBy: {
        createdAt: "asc",
      },
    });
  }

  private async logActivity(requestId: string, type: ActivityType, message: string, details?: object): Promise<void> {
    await prisma.activityLog.create({
      data: {
        requestId,
        type,
        message,
        details: details || undefined,
      },
    });
  }
}

// Singleton instance
let approvalServiceInstance: ApprovalService | null = null;

export function getApprovalService(): ApprovalService {
  if (!approvalServiceInstance) {
    approvalServiceInstance = new ApprovalService();
  }
  return approvalServiceInstance;
}
