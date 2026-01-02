import type { RequestStatus } from "@prisma/client";
import { prisma } from "../db/client.js";

/**
 * Computed status and progress aggregated from ProcessingItems
 */
export interface ComputedRequestStatus {
  status: RequestStatus;
  progress: number;
  currentStep: string | null;
  currentStepStartedAt: Date | null;
  error: string | null;
  totalItems: number;
  completedItems: number;
  failedItems: number;
}

/**
 * Release metadata computed from Download
 */
export interface ReleaseMetadata {
  fileSize: number;
  indexerName: string | null;
  seeders: number | null;
  leechers: number | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  score: number | null;
  publishDate: Date | null;
  name: string | null;
  episodeCount: number | null;
}

/**
 * RequestStatusComputer - Computes MediaRequest status/progress from ProcessingItems
 *
 * This service replaces direct field access on MediaRequest for execution state.
 * All status/progress is now derived from ProcessingItems to ensure single source of truth.
 */
export class RequestStatusComputer {
  /**
   * Compute aggregate status from ProcessingItems
   */
  async computeStatus(requestId: string): Promise<ComputedRequestStatus> {
    const items = await prisma.processingItem.findMany({
      where: { requestId },
      select: {
        status: true,
        progress: true,
        currentStep: true,
        lastError: true,
        updatedAt: true,
      },
    });

    // BACKWARDS COMPATIBILITY: If no ProcessingItems, fall back to MediaRequest fields
    if (items.length === 0) {
      const request = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        select: {
          status: true,
          progress: true,
          currentStep: true,
          error: true,
          totalItems: true,
          completedItems: true,
          failedItems: true,
          currentStepStartedAt: true,
        },
      });

      if (!request) {
        throw new Error(`Request ${requestId} not found`);
      }

      // Return data from old fields (legacy requests)
      return {
        status: request.status,
        progress: request.progress,
        currentStep: request.currentStep,
        currentStepStartedAt: request.currentStepStartedAt,
        error: request.error,
        totalItems: request.totalItems,
        completedItems: request.completedItems,
        failedItems: request.failedItems,
      };
    }

    // Compute status from ProcessingItems
    const totalItems = items.length;
    const completedItems = items.filter((i: (typeof items)[0]) => i.status === "COMPLETED").length;
    const failedItems = items.filter((i: (typeof items)[0]) => i.status === "FAILED").length;
    const cancelledItems = items.filter((i: (typeof items)[0]) => i.status === "CANCELLED").length;

    // Derive overall status
    let status: RequestStatus;
    if (completedItems === totalItems) {
      status = "COMPLETED";
    } else if (failedItems === totalItems) {
      status = "FAILED";
    } else if (cancelledItems === totalItems) {
      status = "CANCELLED";
    } else if (failedItems > 0 && completedItems > 0) {
      status = "PARTIAL";
    } else if (items.some((i: (typeof items)[0]) => i.status === "DOWNLOADING")) {
      status = "DOWNLOADING";
    } else if (items.some((i: (typeof items)[0]) => i.status === "ENCODING")) {
      status = "ENCODING";
    } else if (items.some((i: (typeof items)[0]) => i.status === "DELIVERING")) {
      status = "DELIVERING";
    } else if (items.some((i: (typeof items)[0]) => i.status === "SEARCHING")) {
      status = "SEARCHING";
    } else if (items.some((i: (typeof items)[0]) => i.status === "PENDING")) {
      status = "PENDING";
    } else {
      status = "PROCESSING";
    }

    // Compute average progress
    const avgProgress =
      items.reduce((sum: number, item: (typeof items)[0]) => sum + item.progress, 0) / totalItems;

    // Find most common current step among active items
    const activeItems = items.filter(
      (i: (typeof items)[0]) => !["COMPLETED", "FAILED", "CANCELLED"].includes(i.status)
    );
    const currentStep = activeItems.length > 0 ? activeItems[0].currentStep : null;

    // Find most recent step start time
    const currentStepStartedAt =
      activeItems.length > 0
        ? activeItems.reduce(
            (latest: Date, item: (typeof items)[0]) =>
              item.updatedAt > latest ? item.updatedAt : latest,
            activeItems[0].updatedAt
          )
        : null;

    // Get first error from failed items
    const error =
      items.find((i: (typeof items)[0]) => i.status === "FAILED" && i.lastError)?.lastError || null;

    return {
      status,
      progress: avgProgress,
      currentStep,
      currentStepStartedAt,
      error,
      totalItems,
      completedItems,
      failedItems,
    };
  }

  /**
   * Batch compute status for multiple requests (optimized)
   */
  async batchComputeStatus(requestIds: string[]): Promise<Map<string, ComputedRequestStatus>> {
    const results = new Map<string, ComputedRequestStatus>();

    // Fetch all ProcessingItems for all requests in one query
    const allItems = await prisma.processingItem.findMany({
      where: { requestId: { in: requestIds } },
      select: {
        requestId: true,
        status: true,
        progress: true,
        currentStep: true,
        lastError: true,
        updatedAt: true,
      },
    });

    // Group items by requestId
    const itemsByRequest = new Map<string, typeof allItems>();
    for (const item of allItems) {
      const existing = itemsByRequest.get(item.requestId) || [];
      existing.push(item);
      itemsByRequest.set(item.requestId, existing);
    }

    // Compute status for each request
    for (const requestId of requestIds) {
      const items = itemsByRequest.get(requestId) || [];

      // Use same logic as single computeStatus
      if (items.length === 0) {
        // Fallback to MediaRequest fields for legacy requests
        const request = await prisma.mediaRequest.findUnique({
          where: { id: requestId },
          select: {
            status: true,
            progress: true,
            currentStep: true,
            error: true,
            totalItems: true,
            completedItems: true,
            failedItems: true,
            currentStepStartedAt: true,
          },
        });

        if (request) {
          results.set(requestId, {
            status: request.status,
            progress: request.progress,
            currentStep: request.currentStep,
            currentStepStartedAt: request.currentStepStartedAt,
            error: request.error,
            totalItems: request.totalItems,
            completedItems: request.completedItems,
            failedItems: request.failedItems,
          });
        }
        continue;
      }

      // Same computation logic as single request
      const totalItems = items.length;
      const completedItems = items.filter(
        (i: (typeof items)[0]) => i.status === "COMPLETED"
      ).length;
      const failedItems = items.filter((i: (typeof items)[0]) => i.status === "FAILED").length;
      const cancelledItems = items.filter(
        (i: (typeof items)[0]) => i.status === "CANCELLED"
      ).length;

      let status: RequestStatus;
      if (completedItems === totalItems) {
        status = "COMPLETED";
      } else if (failedItems === totalItems) {
        status = "FAILED";
      } else if (cancelledItems === totalItems) {
        status = "CANCELLED";
      } else if (failedItems > 0 && completedItems > 0) {
        status = "PARTIAL";
      } else if (items.some((i: (typeof items)[0]) => i.status === "DOWNLOADING")) {
        status = "DOWNLOADING";
      } else if (items.some((i: (typeof items)[0]) => i.status === "ENCODING")) {
        status = "ENCODING";
      } else if (items.some((i: (typeof items)[0]) => i.status === "DELIVERING")) {
        status = "DELIVERING";
      } else if (items.some((i: (typeof items)[0]) => i.status === "SEARCHING")) {
        status = "SEARCHING";
      } else if (items.some((i: (typeof items)[0]) => i.status === "PENDING")) {
        status = "PENDING";
      } else {
        status = "PROCESSING";
      }

      const avgProgress =
        items.reduce((sum: number, item: (typeof items)[0]) => sum + item.progress, 0) / totalItems;

      const activeItems = items.filter(
        (i: (typeof items)[0]) => !["COMPLETED", "FAILED", "CANCELLED"].includes(i.status)
      );
      const currentStep = activeItems.length > 0 ? activeItems[0].currentStep : null;
      const currentStepStartedAt =
        activeItems.length > 0
          ? activeItems.reduce(
              (latest: Date, item: (typeof items)[0]) =>
                item.updatedAt > latest ? item.updatedAt : latest,
              activeItems[0].updatedAt
            )
          : null;

      const error =
        items.find((i: (typeof items)[0]) => i.status === "FAILED" && i.lastError)?.lastError ||
        null;

      results.set(requestId, {
        status,
        progress: avgProgress,
        currentStep,
        currentStepStartedAt,
        error,
        totalItems,
        completedItems,
        failedItems,
      });
    }

    return results;
  }

  /**
   * Get release metadata from Download model
   */
  async getReleaseMetadata(requestId: string): Promise<ReleaseMetadata | null> {
    // Try Download first (new location)
    const download = await prisma.download.findFirst({
      where: { requestId },
      orderBy: { createdAt: "desc" },
      select: {
        size: true,
        indexerName: true,
        seedCount: true,
        peerCount: true,
        resolution: true,
        source: true,
        codec: true,
        qualityScore: true,
        publishDate: true,
        torrentName: true,
        isSeasonPack: true,
      },
    });

    if (download?.indexerName) {
      return {
        fileSize: Number(download.size || 0),
        indexerName: download.indexerName,
        seeders: download.seedCount,
        leechers: download.peerCount,
        resolution: download.resolution,
        source: download.source,
        codec: download.codec,
        score: download.qualityScore,
        publishDate: download.publishDate,
        name: download.torrentName,
        episodeCount: download.isSeasonPack ? null : null, // TODO: Calculate from ProcessingItems
      };
    }

    // BACKWARDS COMPATIBILITY: Fall back to MediaRequest fields
    const request = await prisma.mediaRequest.findUnique({
      where: { id: requestId },
      select: {
        releaseFileSize: true,
        releaseIndexerName: true,
        releaseSeeders: true,
        releaseLeechers: true,
        releaseResolution: true,
        releaseSource: true,
        releaseCodec: true,
        releaseScore: true,
        releasePublishDate: true,
        releaseName: true,
      },
    });

    if (!request?.releaseIndexerName) {
      return null;
    }

    // Map old fields to new structure
    return {
      fileSize: Number(request.releaseFileSize || 0),
      indexerName: request.releaseIndexerName,
      seeders: request.releaseSeeders,
      leechers: request.releaseLeechers,
      resolution: request.releaseResolution,
      source: request.releaseSource,
      codec: request.releaseCodec,
      score: request.releaseScore,
      publishDate: request.releasePublishDate,
      name: request.releaseName,
      episodeCount: null,
    };
  }
}

// Singleton instance
export const requestStatusComputer = new RequestStatusComputer();
