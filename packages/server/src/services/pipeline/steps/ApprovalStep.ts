import { BaseStep, type StepOutput } from "./BaseStep.js";
import type { PipelineContext } from "../PipelineContext.js";
import { StepType, ApprovalStatus } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getApprovalService } from "../../approvals/ApprovalService.js";

interface ApprovalStepConfig {
  reason?: string;
  requiredRole?: "admin" | "moderator" | "any";
  timeoutHours?: number;
  autoAction?: "approve" | "reject" | "cancel";
  includeContext?: boolean; // Whether to include full pipeline context in approval details
}

/**
 * Approval Step - Pause pipeline execution and wait for manual approval
 *
 * Inputs:
 * - requestId, executionId (from context)
 * - Config: reason, requiredRole, timeoutHours, autoAction
 *
 * Outputs:
 * - approval.approvalId: ID of the created approval request
 * - approval.status: Current approval status
 *
 * Behavior:
 * - Creates an ApprovalQueue entry
 * - Returns shouldPause: true to halt pipeline execution
 * - Pipeline resumes when approval is processed or times out
 */
export class ApprovalStep extends BaseStep {
  readonly type = StepType.APPROVAL;

  validateConfig(config: unknown): void {
    if (config !== undefined && typeof config !== "object") {
      throw new Error("ApprovalStep config must be an object");
    }

    const cfg = config as ApprovalStepConfig | undefined;
    if (!cfg) return;

    if (cfg.requiredRole && !["admin", "moderator", "any"].includes(cfg.requiredRole)) {
      throw new Error("requiredRole must be 'admin', 'moderator', or 'any'");
    }

    if (cfg.timeoutHours !== undefined && (typeof cfg.timeoutHours !== "number" || cfg.timeoutHours <= 0)) {
      throw new Error("timeoutHours must be a positive number");
    }

    if (cfg.autoAction && !["approve", "reject", "cancel"].includes(cfg.autoAction)) {
      throw new Error("autoAction must be 'approve', 'reject', or 'cancel'");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as ApprovalStepConfig | undefined) || {};

    // Check if we're resuming from an existing approval
    const existingApproval = await this.checkExistingApproval(context);
    if (existingApproval) {
      return existingApproval;
    }

    // Get execution ID from context or database
    const execution = await prisma.pipelineExecution.findUnique({
      where: { requestId: context.requestId },
      select: { id: true, currentStep: true },
    });

    if (!execution) {
      throw new Error("Pipeline execution not found");
    }

    const approvalService = getApprovalService();

    // Prepare context for approval
    const approvalContext = cfg.includeContext
      ? {
          mediaType: context.mediaType,
          title: context.title,
          year: context.year,
          search: context.search,
          download: context.download,
          encode: context.encode,
        }
      : {
          mediaType: context.mediaType,
          title: context.title,
          year: context.year,
        };

    // Create approval request
    const approvalId = await approvalService.createApproval({
      requestId: context.requestId,
      executionId: execution.id,
      stepOrder: execution.currentStep || 0,
      reason: cfg.reason || "Manual approval required",
      context: approvalContext,
      requiredRole: cfg.requiredRole || "any",
      timeoutHours: cfg.timeoutHours,
      autoAction: cfg.autoAction,
    });

    this.reportProgress(0, `Waiting for approval (${cfg.requiredRole || "any"})`);

    return {
      success: true,
      shouldPause: true, // Pause execution until approved
      data: {
        approvalId,
        status: ApprovalStatus.PENDING,
      },
    };
  }

  /**
   * Check if there's an existing approval for this request and return result if processed
   */
  private async checkExistingApproval(context: PipelineContext): Promise<StepOutput | null> {
    const approval = await prisma.approvalQueue.findFirst({
      where: {
        requestId: context.requestId,
        status: { in: [ApprovalStatus.PENDING, ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.TIMEOUT] },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!approval) {
      return null;
    }

    // If still pending, keep waiting
    if (approval.status === ApprovalStatus.PENDING) {
      this.reportProgress(0, "Waiting for approval");
      return {
        success: true,
        shouldPause: true,
        data: {
          approvalId: approval.id,
          status: ApprovalStatus.PENDING,
        },
      };
    }

    // If approved, continue pipeline
    if (approval.status === ApprovalStatus.APPROVED) {
      this.reportProgress(100, "Approved");
      return {
        success: true,
        data: {
          approvalId: approval.id,
          status: ApprovalStatus.APPROVED,
          processedBy: approval.processedBy || undefined,
          comment: approval.comment || undefined,
        },
      };
    }

    // If rejected or timed out, fail pipeline
    if (approval.status === ApprovalStatus.REJECTED || approval.status === ApprovalStatus.TIMEOUT) {
      this.reportProgress(0, approval.status === ApprovalStatus.REJECTED ? "Rejected" : "Timed out");
      return {
        success: false,
        error: approval.status === ApprovalStatus.REJECTED
          ? `Approval rejected${approval.comment ? `: ${approval.comment}` : ""}`
          : `Approval timed out${approval.comment ? `: ${approval.comment}` : ""}`,
        data: {
          approvalId: approval.id,
          status: approval.status,
          processedBy: approval.processedBy || undefined,
          comment: approval.comment || undefined,
        },
      };
    }

    return null;
  }
}
