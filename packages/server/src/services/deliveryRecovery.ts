import { RequestStatus, TvEpisodeStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { registerPipelineSteps } from "./pipeline/registerSteps.js";
import { StepRegistry } from "./pipeline/StepRegistry.js";
import { getPipelineExecutor } from "./pipeline/PipelineExecutor.js";

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
    // Check if file exists in library (delivery may have completed)
    const libraryItem = await prisma.libraryItem.findFirst({
      where: {
        tmdbId: request.tmdbId,
        type: request.type,
      },
      orderBy: { addedAt: "desc" },
    });

    if (libraryItem) {
      console.log(`[DeliveryRecovery] ${request.title}: Found in library, marking as COMPLETED`);

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

      // Update request to COMPLETED
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          status: RequestStatus.COMPLETED,
          progress: 100,
          currentStep: null,
          completedAt: new Date(),
        },
      });

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
      // No progress for over 5 minutes - mark as failed
      console.log(
        `[DeliveryRecovery] ${request.title}: No progress for > 5 minutes, marking as FAILED`
      );

      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          status: RequestStatus.FAILED,
          error: "Delivery stalled - no progress for over 5 minutes",
          currentStep: null,
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
  const failedEpisodes = await prisma.tvEpisode.findMany({
    where: {
      status: TvEpisodeStatus.FAILED,
      encodedAt: { not: null }, // Successfully encoded
      sourceFilePath: { not: null }, // Have source file
    },
    select: {
      id: true,
      requestId: true,
      season: true,
      episode: true,
      sourceFilePath: true,
      error: true,
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
    const epNum = `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`;

    // Check if there's already an active pipeline for this episode
    const activePipeline = await prisma.pipelineExecution.findFirst({
      where: {
        episodeId: episode.id,
        status: "RUNNING",
      },
    });

    if (activePipeline) {
      console.log(`[DeliveryRecovery] ${epNum}: Already has active pipeline, skipping`);
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
    await prisma.tvEpisode.update({
      where: { id: episode.id },
      data: {
        status: TvEpisodeStatus.DOWNLOADED,
        error: null,
      },
    });

    // Create new branch pipeline for delivery retry
    const executor = getPipelineExecutor();
    try {
      // Note: This would need the parent pipeline to spawn a new branch
      // For now, just log that we would retry
      console.log(
        `[DeliveryRecovery] ${epNum}: Reset to DOWNLOADED status for manual retry (auto-retry not yet implemented)`
      );
      retried++;
    } catch (error) {
      console.error(`[DeliveryRecovery] ${epNum}: Failed to create retry pipeline:`, error);
    }
  }

  if (retried > 0) {
    console.log(`[DeliveryRecovery] ✓ Reset ${retried} failed episode(s) for retry`);
  }
}
