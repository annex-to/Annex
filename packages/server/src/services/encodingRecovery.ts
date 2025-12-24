import { AssignmentStatus, type Prisma, RequestStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { getPipelineExecutor } from "./pipeline/PipelineExecutor.js";

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
    // Find the encoding job for this request
    const job = await prisma.job.findFirst({
      where: {
        type: "remote:encode",
        payload: { path: ["requestId"], equals: request.id },
      },
      select: {
        id: true,
        payload: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!job) {
      console.log(`[EncodingRecovery] ${request.title}: No encoding job found`);
      continue;
    }

    // Find the most recent assignment for this job
    const assignment = await prisma.encoderAssignment.findFirst({
      where: { jobId: job.id },
      orderBy: { assignedAt: "desc" },
    });

    if (!assignment) {
      console.log(`[EncodingRecovery] ${request.title}: No assignment found`);
      continue;
    }

    // Check if encoding completed while server was down
    if (assignment.status === AssignmentStatus.COMPLETED && assignment.outputPath) {
      console.log(
        `[EncodingRecovery] ${request.title}: Encoding completed at ${assignment.completedAt?.toISOString()} - recovering`
      );

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
      const context = pipelineExecution.context as {
        targets?: Array<{ serverId: string; encodingProfileId?: string }>;
      };
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

      // Update request status
      await prisma.mediaRequest.update({
        where: { id: request.id },
        data: {
          status: RequestStatus.ENCODING,
          progress: 90,
          currentStep: "Encoding complete (recovered)",
        },
      });

      console.log(
        `[EncodingRecovery] ${request.title}: Updated context with encoded file, resuming pipeline ${pipelineExecution.id}`
      );

      // Resume tree-based pipeline execution with updated context
      const executor = getPipelineExecutor();
      await executor.resumeTreeExecution(pipelineExecution.id);

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
      stillRunning++;
      // Don't auto-resume active encodings - they may complete on their own
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
