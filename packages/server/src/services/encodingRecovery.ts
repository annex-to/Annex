import { AssignmentStatus, type Prisma, RequestStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getPipelineExecutor } from "./pipeline/PipelineExecutor.js";
import { registerPipelineSteps } from "./pipeline/registerSteps.js";
import { StepRegistry } from "./pipeline/StepRegistry.js";

/**
 * Recovers requests stuck in ENCODING status due to server restarts.
 *
 * When the server restarts or hot-reloads during encoding, the EncodeStep polling loop is lost,
 * but the encoder keeps running. This function detects completed encodings that
 * weren't processed and updates the pipeline context to continue execution.
 *
 * This recovery works with the tree-based pipeline system by reconstructing the
 * encode step output from the database and updating the pipeline context.
 */
export async function recoverStuckEncodings(): Promise<void> {
  console.log("[EncodingRecovery] Checking for stuck encodings...");

  // Ensure pipeline steps are registered before attempting recovery
  // This prevents "Step type X is not registered" errors during hot reloads
  if (StepRegistry.getRegisteredTypes().length === 0) {
    console.log("[EncodingRecovery] Pipeline steps not registered, registering now...");
    registerPipelineSteps();
  }

  // Find requests stuck in ENCODING status
  const stuckRequests = await prisma.mediaRequest.findMany({
    where: {
      status: RequestStatus.ENCODING,
    },
    select: {
      id: true,
      title: true,
      progress: true,
      currentStep: true,
      updatedAt: true,
    },
  });

  if (stuckRequests.length === 0) {
    console.log("[EncodingRecovery] No stuck encodings found");
    return;
  }

  console.log(`[EncodingRecovery] Found ${stuckRequests.length} requests in ENCODING status`);

  let recovered = 0;
  let stillRunning = 0;

  for (const request of stuckRequests) {
    // Find the encoding job for this request with an assignment
    const job = await prisma.job.findFirst({
      where: {
        type: "remote:encode",
        requestId: request.id, // Use requestId column for efficient querying
        encoderAssignment: {
          isNot: null, // Only get jobs that have an assignment
        },
      },
      select: {
        id: true,
        payload: true,
        encoderAssignment: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!job) {
      console.log(`[EncodingRecovery] ${request.title}: No encoding job found`);
      continue;
    }

    const assignment = job.encoderAssignment;

    if (!assignment) {
      console.log(`[EncodingRecovery] ${request.title}: No assignment found`);
      continue;
    }

    // Check if encoding completed while server was down
    if (assignment.status === AssignmentStatus.COMPLETED && assignment.outputPath) {
      // Find the pipeline execution
      const pipelineExecution = await prisma.pipelineExecution.findFirst({
        where: {
          requestId: request.id,
          status: "RUNNING",
        },
        orderBy: { startedAt: "desc" },
      });

      if (!pipelineExecution) {
        console.log(
          `[EncodingRecovery] ${request.title}: No active pipeline execution found - may need manual retry`
        );
        continue;
      }

      // Check if context already has the encoded file (normal flow is handling it)
      const context = pipelineExecution.context as {
        encode?: { encodedFiles?: unknown[] };
        targets?: Array<{ serverId: string; encodingProfileId?: string }>;
        download?: { sourceFilePath: string };
      };

      if (context.encode?.encodedFiles && context.encode.encodedFiles.length > 0) {
        console.log(
          `[EncodingRecovery] ${request.title}: Encoding already in context, normal flow handling it - skipping recovery`
        );
        continue;
      }

      // Check if request was updated recently (active polling in progress)
      const timeSinceUpdate = Date.now() - request.updatedAt.getTime();
      if (timeSinceUpdate < 60000) {
        // Less than 1 minute since last update
        console.log(
          `[EncodingRecovery] ${request.title}: Request updated ${Math.round(timeSinceUpdate / 1000)}s ago, normal flow active - skipping recovery`
        );
        continue;
      }

      console.log(
        `[EncodingRecovery] ${request.title}: Encoding completed at ${assignment.completedAt?.toISOString()} but pipeline stuck - recovering`
      );

      // Reconstruct the encode step output from the completed assignment
      const jobPayload = job.payload as {
        encodingConfig?: {
          videoEncoder?: string;
          maxResolution?: string;
        };
      };

      const encodingConfig = jobPayload.encodingConfig || {};
      const videoEncoder = encodingConfig.videoEncoder || "libsvtav1";

      // Determine codec from encoder
      const codec =
        videoEncoder.includes("av1") || videoEncoder.includes("AV1")
          ? "AV1"
          : videoEncoder.includes("hevc") || videoEncoder.includes("265")
            ? "HEVC"
            : "H264";

      // Get target servers from context
      const targetServerIds = context.targets?.map((t) => t.serverId) || [];

      // Build the encode step output as it would have been
      const encodeStepOutput = {
        encodedFiles: [
          {
            profileId: context.targets?.[0]?.encodingProfileId || "default",
            path: assignment.outputPath,
            targetServerIds,
            resolution: encodingConfig.maxResolution || "1080p",
            codec,
            size: assignment.outputSize ? Number(assignment.outputSize) : undefined,
            compressionRatio: assignment.compressionRatio || undefined,
          },
        ],
      };

      // Update pipeline context with the encode step output
      const updatedContext = {
        ...context,
        encode: encodeStepOutput,
      };

      await prisma.pipelineExecution.update({
        where: { id: pipelineExecution.id },
        data: {
          context: updatedContext as unknown as Prisma.JsonObject,
        },
      });

      // MediaRequest status computed from ProcessingItems - pipeline will manage state

      console.log(
        `[EncodingRecovery] ${request.title}: Updated context with encoded file, resuming pipeline ${pipelineExecution.id}`
      );

      // Resume tree-based pipeline execution with updated context
      const executor = getPipelineExecutor();
      // Resume in background - don't block recovery on pipeline completion
      executor.resumeTreeExecution(pipelineExecution.id).catch((error) => {
        console.error(
          `[EncodingRecovery] ${request.title}: Failed to resume pipeline after completion:`,
          error
        );
      });

      recovered++;
    } else if (assignment.status === AssignmentStatus.FAILED) {
      console.log(
        `[EncodingRecovery] ${request.title}: Encoding failed - ${assignment.error || "Unknown error"}`
      );
      // Leave it as is - user can retry manually
    } else if (
      assignment.status === AssignmentStatus.ENCODING ||
      assignment.status === AssignmentStatus.ASSIGNED
    ) {
      console.log(
        `[EncodingRecovery] ${request.title}: Encoding still in progress (${assignment.progress}%)`
      );

      // Check if pipeline execution exists and is RUNNING
      const pipelineExecution = await prisma.pipelineExecution.findFirst({
        where: {
          requestId: request.id,
          status: "RUNNING",
        },
        orderBy: { startedAt: "desc" },
      });

      if (pipelineExecution) {
        // Reconstruct pipeline context with download step output
        // This allows EncodeStep to find the existing job and continue polling
        const context = pipelineExecution.context as {
          targets?: Array<{ serverId: string; encodingProfileId?: string }>;
          download?: { sourceFilePath: string };
        };

        // Get job payload to extract input path
        const jobPayload = job.payload as {
          inputPath?: string;
          encodingConfig?: {
            videoEncoder?: string;
            maxResolution?: string;
          };
        };

        const inputPath = jobPayload.inputPath || assignment.inputPath;

        // Update context with download step output if not already present
        if (!context.download?.sourceFilePath && inputPath) {
          const updatedContext = {
            ...context,
            download: {
              sourceFilePath: inputPath,
              downloadedAt: assignment.assignedAt.toISOString(),
            },
          };

          await prisma.pipelineExecution.update({
            where: { id: pipelineExecution.id },
            data: {
              context: updatedContext as unknown as Prisma.JsonObject,
            },
          });

          console.log(
            `[EncodingRecovery] ${request.title}: Updated context with download path, resuming pipeline`
          );
        } else {
          console.log(
            `[EncodingRecovery] ${request.title}: Resuming pipeline to restart polling loop`
          );
        }

        const executor = getPipelineExecutor();
        // Resume pipeline in background (don't wait for completion)
        // The pipeline will handle its own execution and updates
        executor.resumeTreeExecution(pipelineExecution.id).catch((error) => {
          console.error(`[EncodingRecovery] ${request.title}: Failed to resume pipeline:`, error);
        });
        recovered++;
      } else {
        stillRunning++;
      }
    }
  }

  if (recovered > 0) {
    console.log(`[EncodingRecovery] ✓ Recovered ${recovered} stuck encodings`);
  }
  if (stillRunning > 0) {
    console.log(
      `[EncodingRecovery] ${stillRunning} encodings still in progress (not auto-resuming)`
    );
  }
}
