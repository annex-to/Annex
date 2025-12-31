import type { Prisma, ProcessingItem, ProcessingStatus, ProcessingType } from "@prisma/client";
import { prisma } from "../../db/client.js";

export class ProcessingItemRepository {
  /**
   * Create a new ProcessingItem
   */
  async create(data: {
    requestId: string;
    type: ProcessingType;
    tmdbId: number;
    title: string;
    year?: number;
    season?: number;
    episode?: number;
    status?: ProcessingStatus;
    maxAttempts?: number;
  }): Promise<ProcessingItem> {
    return await prisma.processingItem.create({
      data: {
        id: crypto.randomUUID(),
        requestId: data.requestId,
        type: data.type,
        tmdbId: data.tmdbId,
        title: data.title,
        year: data.year,
        season: data.season,
        episode: data.episode,
        status: data.status || "PENDING",
        maxAttempts: data.maxAttempts || 5,
      },
    });
  }

  /**
   * Create multiple ProcessingItems in a transaction
   */
  async createMany(
    items: Array<{
      requestId: string;
      type: ProcessingType;
      tmdbId: number;
      title: string;
      year?: number;
      season?: number;
      episode?: number;
    }>
  ): Promise<ProcessingItem[]> {
    const created: ProcessingItem[] = [];

    for (const item of items) {
      const processingItem = await this.create(item);
      created.push(processingItem);
    }

    return created;
  }

  /**
   * Find ProcessingItem by ID
   */
  async findById(id: string): Promise<ProcessingItem | null> {
    return await prisma.processingItem.findUnique({
      where: { id },
    });
  }

  /**
   * Find all ProcessingItems for a request
   */
  async findByRequestId(requestId: string): Promise<ProcessingItem[]> {
    return await prisma.processingItem.findMany({
      where: { requestId },
      orderBy: [{ season: "asc" }, { episode: "asc" }, { createdAt: "asc" }],
    });
  }

  /**
   * Find ProcessingItems by status
   */
  async findByStatus(status: ProcessingStatus): Promise<ProcessingItem[]> {
    return await prisma.processingItem.findMany({
      where: { status },
      orderBy: { createdAt: "asc" },
    });
  }

  /**
   * Find ProcessingItems ready for retry
   */
  async findReadyForRetry(status: ProcessingStatus): Promise<ProcessingItem[]> {
    return await prisma.processingItem.findMany({
      where: {
        status,
        nextRetryAt: {
          lte: new Date(),
        },
        attempts: {
          lt: prisma.processingItem.fields.maxAttempts,
        },
      },
      orderBy: { nextRetryAt: "asc" },
    });
  }

  /**
   * Update ProcessingItem status with atomic increment of attempts
   */
  async updateStatus(
    id: string,
    status: ProcessingStatus,
    data?: {
      currentStep?: string | null;
      stepContext?: Prisma.InputJsonValue;
      progress?: number;
      lastError?: string | null;
      nextRetryAt?: Date | null;
      downloadId?: string | null;
      encodingJobId?: string | null;
    }
  ): Promise<ProcessingItem> {
    const updateData: Prisma.ProcessingItemUpdateInput = {
      status,
      updatedAt: new Date(),
    };

    if (data) {
      if (data.currentStep !== undefined) updateData.currentStep = data.currentStep;
      if (data.stepContext !== undefined) updateData.stepContext = data.stepContext;
      if (data.progress !== undefined) updateData.progress = data.progress;
      if (data.lastError !== undefined) updateData.lastError = data.lastError;
      if (data.nextRetryAt !== undefined) updateData.nextRetryAt = data.nextRetryAt;
      if (data.downloadId !== undefined) {
        updateData.download = data.downloadId
          ? { connect: { id: data.downloadId } }
          : { disconnect: true };
      }
      if (data.encodingJobId !== undefined) updateData.encodingJobId = data.encodingJobId;
    }

    // Mark completion time if status is terminal
    if (status === "COMPLETED" || status === "FAILED" || status === "CANCELLED") {
      updateData.completedAt = new Date();
    }

    return await prisma.processingItem.update({
      where: { id },
      data: updateData,
    });
  }

  /**
   * Increment attempts counter and set next retry time
   */
  async incrementAttempts(id: string, nextRetryAt?: Date): Promise<ProcessingItem> {
    return await prisma.processingItem.update({
      where: { id },
      data: {
        attempts: {
          increment: 1,
        },
        nextRetryAt,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Update progress percentage
   */
  async updateProgress(id: string, progress: number): Promise<ProcessingItem> {
    return await prisma.processingItem.update({
      where: { id },
      data: {
        progress: Math.min(100, Math.max(0, progress)),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Update step context (merge with existing)
   */
  async updateStepContext(id: string, context: Record<string, unknown>): Promise<ProcessingItem> {
    const item = await this.findById(id);
    if (!item) {
      throw new Error(`ProcessingItem ${id} not found`);
    }

    const existingContext = (item.stepContext as Record<string, unknown>) || {};
    const mergedContext = { ...existingContext, ...context };

    return await prisma.processingItem.update({
      where: { id },
      data: {
        stepContext: mergedContext as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Delete ProcessingItem
   */
  async delete(id: string): Promise<void> {
    await prisma.processingItem.delete({
      where: { id },
    });
  }

  /**
   * Get statistics for a request
   */
  async getRequestStats(requestId: string): Promise<{
    total: number;
    completed: number;
    failed: number;
    pending: number;
    inProgress: number;
  }> {
    const items = await this.findByRequestId(requestId);

    return {
      total: items.length,
      completed: items.filter((i) => i.status === "COMPLETED").length,
      failed: items.filter((i) => i.status === "FAILED").length,
      pending: items.filter((i) => i.status === "PENDING").length,
      inProgress: items.filter(
        (i) =>
          i.status !== "PENDING" &&
          i.status !== "COMPLETED" &&
          i.status !== "FAILED" &&
          i.status !== "CANCELLED"
      ).length,
    };
  }

  /**
   * Update request aggregate fields based on ProcessingItems
   */
  async updateRequestAggregates(requestId: string): Promise<void> {
    const items = await this.findByRequestId(requestId);
    const stats = await this.getRequestStats(requestId);

    // Determine request status based on ProcessingItem statuses
    let requestStatus: import("@prisma/client").RequestStatus;

    if (stats.total === 0) {
      requestStatus = "PENDING";
    } else if (stats.completed === stats.total) {
      requestStatus = "COMPLETED";
    } else if (stats.failed === stats.total) {
      requestStatus = "FAILED";
    } else {
      // Determine status from the earliest active step
      const hasSearching = items.some((i) => i.status === "SEARCHING" || i.status === "PENDING");
      const hasDownloading = items.some((i) => i.status === "DOWNLOADING" || i.status === "FOUND");
      const hasEncoding = items.some((i) => i.status === "ENCODING" || i.status === "DOWNLOADED");
      const hasDelivering = items.some((i) => i.status === "DELIVERING" || i.status === "ENCODED");

      if (hasSearching) {
        requestStatus = "SEARCHING";
      } else if (hasDownloading) {
        requestStatus = "DOWNLOADING";
      } else if (hasEncoding) {
        requestStatus = "ENCODING";
      } else if (hasDelivering) {
        requestStatus = "DELIVERING";
      } else {
        requestStatus = "PENDING";
      }
    }

    // Calculate average progress across all items
    const totalProgress = items.reduce((sum, item) => sum + item.progress, 0);
    const avgProgress = items.length > 0 ? Math.round(totalProgress / items.length) : 0;

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        totalItems: stats.total,
        completedItems: stats.completed,
        failedItems: stats.failed,
        status: requestStatus,
        progress: avgProgress,
      },
    });
  }
}

export const processingItemRepository = new ProcessingItemRepository();
