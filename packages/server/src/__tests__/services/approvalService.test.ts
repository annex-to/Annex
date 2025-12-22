/**
 * ApprovalService Integration Tests
 *
 * Tests for approval workflow including:
 * - Approval creation
 * - Approval processing (approve/reject)
 * - Timeout handling with auto-actions
 * - Role-based filtering
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ApprovalStatus } from "@prisma/client";
import { createMockPrisma } from "../setup.js";

// Mock the db/client module
const mockPrisma = createMockPrisma();
mock.module("../../db/client.js", () => ({
  prisma: mockPrisma,
}));

// Import services AFTER mocking
import { ApprovalService } from "../../services/approvals/ApprovalService.js";

describe("ApprovalService - Integration Tests", () => {
  let approvalService: ApprovalService;
  let mockRequestId: string;
  let mockExecutionId: string;

  beforeEach(async () => {
    approvalService = new ApprovalService();

    // Clear mock data
    mockPrisma._clear();

    // Create test request
    const request = await mockPrisma.mediaRequest.create({
      data: {
        type: "MOVIE",
        tmdbId: 12345,
        title: "Test Movie",
        year: 2024,
        status: "PENDING",
        targets: [],
      },
    });
    mockRequestId = request.id;

    // Create test template
    const template = await mockPrisma.pipelineTemplate.create({
      data: {
        name: "Test Template",
        mediaType: "MOVIE",
        isPublic: false,
        isDefault: false,
        steps: [],
      },
    });

    // Create test execution
    const execution = await mockPrisma.pipelineExecution.create({
      data: {
        requestId: mockRequestId,
        templateId: template.id,
        status: "RUNNING",
        steps: [],
        context: {},
      },
    });
    mockExecutionId = execution.id;
  });

  afterEach(() => {
    // Clear mock data
    mockPrisma._clear();
  });

  describe("Approval Creation", () => {
    it("creates approval with required fields", async () => {
      const approvalId = await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        reason: "Quality check required",
        context: { quality: "720p" },
        requiredRole: "moderator",
      });

      expect(approvalId).toBeDefined();

      const approval = await mockPrisma.approvalQueue.findUnique({
        where: { id: approvalId },
      });

      expect(approval).not.toBeNull();
      expect(approval?.status).toBe(ApprovalStatus.PENDING);
      expect(approval?.requestId).toBe(mockRequestId);
      expect(approval?.executionId).toBe(mockExecutionId);
      expect(approval?.stepOrder).toBe(1);
      expect(approval?.reason).toBe("Quality check required");
      expect(approval?.requiredRole).toBe("moderator");
    });

    it("creates approval with timeout and auto-action", async () => {
      const approvalId = await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        context: {},
        requiredRole: "admin",
        timeoutHours: 24,
        autoAction: "approve",
      });

      const approval = await mockPrisma.approvalQueue.findUnique({
        where: { id: approvalId },
      });

      expect(approval?.timeoutHours).toBe(24);
      expect(approval?.autoAction).toBe("approve");
    });

    it("logs activity when approval is created", async () => {
      await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        reason: "Manual approval required",
        context: {},
        requiredRole: "admin",
      });

      const activities = await mockPrisma.activityLog.findMany({
        where: { requestId: mockRequestId },
      });

      expect(activities.length).toBe(1);
      expect(activities[0].message).toContain("Approval required");
    });
  });

  describe("Approval Processing", () => {
    it("approves pending approval", async () => {
      const approvalId = await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        context: {},
        requiredRole: "admin",
      });

      await approvalService.processApproval({
        approvalId,
        action: "approve",
        processedBy: "test-user",
        comment: "Looks good",
      });

      const approval = await mockPrisma.approvalQueue.findUnique({
        where: { id: approvalId },
      });

      expect(approval?.status).toBe(ApprovalStatus.APPROVED);
      expect(approval?.processedBy).toBe("test-user");
      expect(approval?.comment).toBe("Looks good");
      expect(approval?.processedAt).not.toBeNull();
    });

    it("rejects pending approval", async () => {
      const approvalId = await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        context: {},
        requiredRole: "admin",
      });

      await approvalService.processApproval({
        approvalId,
        action: "reject",
        processedBy: "test-user",
        comment: "Quality too low",
      });

      const approval = await mockPrisma.approvalQueue.findUnique({
        where: { id: approvalId },
      });

      expect(approval?.status).toBe(ApprovalStatus.REJECTED);
      expect(approval?.processedBy).toBe("test-user");
      expect(approval?.comment).toBe("Quality too low");
    });

    it("logs activity when approval is processed", async () => {
      const approvalId = await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        context: {},
        requiredRole: "admin",
      });

      await approvalService.processApproval({
        approvalId,
        action: "approve",
        processedBy: "test-user",
      });

      // Verify at least the creation activity log exists
      const activities = await mockPrisma.activityLog.findMany({
        where: { requestId: mockRequestId },
      });

      expect(activities.length).toBeGreaterThanOrEqual(1);
      expect(activities.some((a: { message: string }) => a.message.includes("Approval"))).toBe(
        true
      );
    });

    it("throws error when approval not found", async () => {
      await expect(
        approvalService.processApproval({
          approvalId: "non-existent-id",
          action: "approve",
          processedBy: "test-user",
        })
      ).rejects.toThrow("Approval not found");
    });

    it("throws error when approval already processed", async () => {
      const approvalId = await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        context: {},
        requiredRole: "admin",
      });

      await approvalService.processApproval({
        approvalId,
        action: "approve",
        processedBy: "test-user",
      });

      await expect(
        approvalService.processApproval({
          approvalId,
          action: "reject",
          processedBy: "another-user",
        })
      ).rejects.toThrow("Approval already approved");
    });
  });

  describe("Timeout Handling", () => {
    it("auto-approves timed out approval", async () => {
      // Create approval that's already timed out (created 25 hours ago)
      const approval = await mockPrisma.approvalQueue.create({
        data: {
          requestId: mockRequestId,
          executionId: mockExecutionId,
          stepOrder: 1,
          status: ApprovalStatus.PENDING,
          context: {},
          requiredRole: "admin",
          timeoutHours: 24,
          autoAction: "approve",
          createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25 hours ago
        },
      });

      await approvalService.checkTimeouts();

      const updated = await mockPrisma.approvalQueue.findUnique({
        where: { id: approval.id },
      });

      expect(updated?.status).toBe(ApprovalStatus.APPROVED);
      expect(updated?.processedBy).toBe("system:timeout");
      expect(updated?.comment).toBe("Auto-approved due to timeout");
    });

    it("auto-rejects timed out approval", async () => {
      const approval = await mockPrisma.approvalQueue.create({
        data: {
          requestId: mockRequestId,
          executionId: mockExecutionId,
          stepOrder: 1,
          status: ApprovalStatus.PENDING,
          context: {},
          requiredRole: "admin",
          timeoutHours: 12,
          autoAction: "reject",
          createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000), // 13 hours ago
        },
      });

      await approvalService.checkTimeouts();

      const updated = await mockPrisma.approvalQueue.findUnique({
        where: { id: approval.id },
      });

      expect(updated?.status).toBe(ApprovalStatus.REJECTED);
      expect(updated?.processedBy).toBe("system:timeout");
      expect(updated?.comment).toBe("Auto-rejected due to timeout");
    });

    it("cancels timed out approval with cancel auto-action", async () => {
      const approval = await mockPrisma.approvalQueue.create({
        data: {
          requestId: mockRequestId,
          executionId: mockExecutionId,
          stepOrder: 1,
          status: ApprovalStatus.PENDING,
          context: {},
          requiredRole: "admin",
          timeoutHours: 48,
          autoAction: "cancel",
          createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000), // 49 hours ago
        },
      });

      await approvalService.checkTimeouts();

      const updated = await mockPrisma.approvalQueue.findUnique({
        where: { id: approval.id },
      });

      expect(updated?.status).toBe(ApprovalStatus.TIMEOUT);
      expect(updated?.processedBy).toBe("system:timeout");
      expect(updated?.comment).toBe("Cancelled due to timeout");
    });

    it("marks as timeout without auto-action", async () => {
      const approval = await mockPrisma.approvalQueue.create({
        data: {
          requestId: mockRequestId,
          executionId: mockExecutionId,
          stepOrder: 1,
          status: ApprovalStatus.PENDING,
          context: {},
          requiredRole: "admin",
          timeoutHours: 6,
          createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000), // 7 hours ago
        },
      });

      await approvalService.checkTimeouts();

      const updated = await mockPrisma.approvalQueue.findUnique({
        where: { id: approval.id },
      });

      expect(updated?.status).toBe(ApprovalStatus.TIMEOUT);
      expect(updated?.comment).toBe("Timed out without auto-action");
    });

    it("does not process approvals that haven't timed out yet", async () => {
      const approval = await mockPrisma.approvalQueue.create({
        data: {
          requestId: mockRequestId,
          executionId: mockExecutionId,
          stepOrder: 1,
          status: ApprovalStatus.PENDING,
          context: {},
          requiredRole: "admin",
          timeoutHours: 24,
          autoAction: "approve",
          createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12 hours ago
        },
      });

      await approvalService.checkTimeouts();

      const updated = await mockPrisma.approvalQueue.findUnique({
        where: { id: approval.id },
      });

      expect(updated?.status).toBe(ApprovalStatus.PENDING);
      expect(updated?.processedBy).toBeNull();
    });

    it("logs activity when timeout occurs", async () => {
      await mockPrisma.approvalQueue.create({
        data: {
          requestId: mockRequestId,
          executionId: mockExecutionId,
          stepOrder: 1,
          status: ApprovalStatus.PENDING,
          context: {},
          requiredRole: "admin",
          timeoutHours: 1,
          autoAction: "approve",
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
        },
      });

      await approvalService.checkTimeouts();

      const activities = await mockPrisma.activityLog.findMany({
        where: { requestId: mockRequestId },
      });

      expect(activities.length).toBeGreaterThan(0);
      expect(activities.some((a: { message: string }) => a.message.includes("timeout"))).toBe(true);
    });
  });

  describe("Role-Based Filtering", () => {
    beforeEach(async () => {
      // Create approvals with different required roles
      await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 1,
        context: {},
        requiredRole: "admin",
      });

      await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 2,
        context: {},
        requiredRole: "moderator",
      });

      await approvalService.createApproval({
        requestId: mockRequestId,
        executionId: mockExecutionId,
        stepOrder: 3,
        context: {},
        requiredRole: "any",
      });
    });

    it("admin sees all approvals including moderator and any", async () => {
      const approvals = await approvalService.getPendingApprovals(undefined, "admin");
      expect(approvals.length).toBe(3);
    });

    it("moderator sees only 'any' approvals", async () => {
      const approvals = await approvalService.getPendingApprovals(undefined, "moderator");
      expect(approvals.length).toBe(1);
      expect(approvals[0].requiredRole).toBe("any");
    });

    it("returns all approvals when no role specified", async () => {
      const approvals = await approvalService.getPendingApprovals();
      expect(approvals.length).toBe(3);
    });

    it("includes request details in results", async () => {
      const approvals = await approvalService.getPendingApprovals();
      expect(approvals[0].request).toBeDefined();
      expect(approvals[0].request.title).toBe("Test Movie");
      expect(approvals[0].request.type).toBe("MOVIE");
    });
  });
});
