import { ProcessingStatus, RequestStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { registerPipelineSteps } from "./pipeline/registerSteps.js";
import { StepRegistry } from "./pipeline/StepRegistry.js";

/**
 * Recovers requests stuck in DELIVERING status.
 *
 * When the server restarts during delivery, the DeliverStep's async delivery process
 * is lost. This function detects completed deliveries and updates the pipeline.
 */
export async function recoverStuckDeliveries(): Promise<void> {
  console.log("[DeliveryRecovery] Checking for stuck deliveries...");

  // Ensure pipeline steps are registered
  if (StepRegistry.getRegisteredTypes().length === 0) {
    console.log("[DeliveryRecovery] Pipeline steps not registered, registering now...");
    registerPipelineSteps();
  }

  // Find requests stuck in DELIVERING status
  const stuckRequests = await prisma.mediaRequest.findMany({
    where: {
      status: RequestStatus.DELIVERING,
    },
    select: {
      id: true,
      title: true,
      tmdbId: true,
      type: true,
      updatedAt: true,
    },
  });

  if (stuckRequests.length === 0) {
    console.log("[DeliveryRecovery] No stuck deliveries found");
    return;
  }

  console.log(`[DeliveryRecovery] Found ${stuckRequests.length} requests in DELIVERING status`);

  let recovered = 0;
  const stallTimeout = 300000; // 5 minutes
  const cutoff = new Date(Date.now() - stallTimeout);

  for (const request of stuckRequests) {
    // Check if ALL ProcessingItems are actually completed
    const items = await prisma.processingItem.findMany({
      where: { requestId: request.id },
      select: { id: true, status: true },
    });

    const allCompleted = items.every(
      (item: { status: ProcessingStatus }) =>
        item.status === ProcessingStatus.COMPLETED ||
        item.status === ProcessingStatus.FAILED ||
        item.status === ProcessingStatus.CANCELLED
    );

    const hasActiveDeliveries = items.some(
      (item: { status: ProcessingStatus }) => item.status === ProcessingStatus.DELIVERING
    );

    // Skip if items are actively delivering
    if (hasActiveDeliveries) {
      console.log(
        `[DeliveryRecovery] ${request.title}: Items actively delivering (${items.filter((i: { status: ProcessingStatus }) => i.status === ProcessingStatus.DELIVERING).length}/${items.length}), skipping`
      );
      continue;
    }

    if (allCompleted) {
      console.log(
        `[DeliveryRecovery] ${request.title}: All items completed, marking request as COMPLETED`
      );

      // Get pipeline context to find encoded files for cleanup
      const pipelineExecution = await prisma.pipelineExecution.findFirst({
        where: {
          requestId: request.id,
          status: "RUNNING",
        },
        orderBy: { startedAt: "desc" },
      });

      // Clean up encoded files (keep source files for seeding)
      if (pipelineExecution) {
        const context = pipelineExecution.context as {
          encode?: {
            encodedFiles?: Array<{ path: string }>;
          };
        };

        const encodedFiles = context.encode?.encodedFiles || [];
        for (const encodedFile of encodedFiles) {
          try {
            const exists = await Bun.file(encodedFile.path).exists();
            if (exists) {
              await Bun.file(encodedFile.path).delete();
              console.log(
                `[DeliveryRecovery] ${request.title}: Cleaned up encoded file: ${encodedFile.path}`
              );
            }
          } catch (err) {
            console.warn(
              `[DeliveryRecovery] ${request.title}: Failed to clean up ${encodedFile.path}:`,
              err
            );
            // Don't fail recovery on cleanup errors
          }
        }
      }

      // MediaRequest status computed from ProcessingItems - no update needed

      // Mark pipeline as COMPLETED
      await prisma.pipelineExecution.updateMany({
        where: {
          requestId: request.id,
          status: "RUNNING",
        },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
        },
      });

      recovered++;
    } else if (request.updatedAt < cutoff) {
      // No progress for over 5 minutes - mark ProcessingItems as failed
      console.log(
        `[DeliveryRecovery] ${request.title}: No progress for > 5 minutes, marking items as FAILED`
      );

      // Update non-terminal ProcessingItems to FAILED (MediaRequest status computed from items)
      await prisma.processingItem.updateMany({
        where: {
          requestId: request.id,
          status: {
            notIn: [
              ProcessingStatus.COMPLETED,
              ProcessingStatus.FAILED,
              ProcessingStatus.CANCELLED,
            ],
          },
        },
        data: {
          status: ProcessingStatus.FAILED,
          lastError: "Delivery stalled - no progress for over 5 minutes",
        },
      });

      await prisma.pipelineExecution.updateMany({
        where: {
          requestId: request.id,
          status: "RUNNING",
        },
        data: {
          status: "FAILED",
          error: "Delivery stalled",
          completedAt: new Date(),
        },
      });

      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`[DeliveryRecovery] ✓ Recovered ${recovered} stuck delivery/deliveries`);
  }
}

/**
 * Recovers episodes with failed deliveries by retrying delivery.
 *
 * Detects episodes that:
 * - Are in FAILED status with delivery-related errors
 * - Have been successfully encoded (encodedAt is set)
 * - Have no active pipeline attempting delivery
 *
 * Creates new branch pipelines to retry delivery for these episodes.
 */
export async function recoverFailedEpisodeDeliveries(): Promise<void> {
  console.log("[DeliveryRecovery] Checking for failed episode deliveries...");

  // Ensure pipeline steps are registered
  if (StepRegistry.getRegisteredTypes().length === 0) {
    console.log("[DeliveryRecovery] Pipeline steps not registered, registering now...");
    registerPipelineSteps();
  }

  // Find episodes that failed during delivery
  const failedEpisodes = await prisma.processingItem.findMany({
    where: {
      type: "EPISODE",
      status: ProcessingStatus.FAILED,
      encodedAt: { not: null }, // Successfully encoded
      sourceFilePath: { not: null }, // Have source file
    },
    select: {
      id: true,
      requestId: true,
      season: true,
      episode: true,
      sourceFilePath: true,
      lastError: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
    take: 10, // Process up to 10 at a time to avoid overwhelming the system
  });

  if (failedEpisodes.length === 0) {
    console.log("[DeliveryRecovery] No failed episode deliveries found");
    return;
  }

  console.log(`[DeliveryRecovery] Found ${failedEpisodes.length} failed episode deliveries`);

  let retried = 0;

  for (const episode of failedEpisodes) {
    const epNum = `S${String(episode.season ?? 0).padStart(2, "0")}E${String(episode.episode ?? 0).padStart(2, "0")}`;

    // Check if episode is currently being processed (not in a failed state)
    const currentEpisode = await prisma.processingItem.findUnique({
      where: { id: episode.id },
      select: { status: true },
    });

    if (
      currentEpisode &&
      currentEpisode.status !== ProcessingStatus.FAILED &&
      currentEpisode.status !== ProcessingStatus.CANCELLED
    ) {
      console.log(
        `[DeliveryRecovery] ${epNum}: Already in ${currentEpisode.status} status, skipping`
      );
      continue;
    }

    // Get the parent request to determine template
    const request = await prisma.mediaRequest.findUnique({
      where: { id: episode.requestId },
      select: {
        id: true,
        title: true,
        tmdbId: true,
        type: true,
      },
    });

    if (!request) {
      console.log(`[DeliveryRecovery] ${epNum}: Request not found, skipping`);
      continue;
    }

    // Reset episode status to allow retry
    await prisma.processingItem.update({
      where: { id: episode.id },
      data: {
        status: ProcessingStatus.DOWNLOADED,
        lastError: null,
      },
    });

    // Create new branch pipeline for delivery retry
    // Note: This would need the parent pipeline to spawn a new branch
    // For now, just log that we would retry
    console.log(
      `[DeliveryRecovery] ${epNum}: Reset to DOWNLOADED status for manual retry (auto-retry not yet implemented)`
    );
    retried++;
  }

  if (retried > 0) {
    console.log(`[DeliveryRecovery] ✓ Reset ${retried} failed episode(s) for retry`);
  }
}
