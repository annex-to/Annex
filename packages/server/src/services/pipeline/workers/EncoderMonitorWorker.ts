import type { ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { BaseWorker } from "./BaseWorker";

/**
 * EncoderMonitorWorker - Monitors ENCODING items and transitions to ENCODED when complete
 * This worker handles the async completion of encoding jobs
 */
export class EncoderMonitorWorker extends BaseWorker {
  readonly processingStatus = "ENCODING" as const;
  readonly nextStatus = "ENCODED" as const;
  readonly name = "EncoderMonitorWorker";

  protected async processItem(item: ProcessingItem): Promise<void> {
    // Check if item has encodingJobId
    if (!item.encodingJobId) {
      // Job hasn't been created yet, skip
      return;
    }

    // Check if request still exists and is active
    const request = await prisma.mediaRequest.findUnique({
      where: { id: item.requestId },
      select: { status: true },
    });

    if (!request) {
      console.warn(
        `[${this.name}] Request ${item.requestId} not found, marking ${item.title} as FAILED (orphaned)`
      );
      await this.transitionToFailed(item.id, "Request no longer exists");
      return;
    }

    if (request.status === "COMPLETED" || request.status === "CANCELLED") {
      console.warn(
        `[${this.name}] Request ${item.requestId} is ${request.status}, marking ${item.title} as FAILED (orphaned)`
      );
      await this.transitionToFailed(item.id, `Request was ${request.status}`);
      return;
    }

    console.log(
      `[${this.name}] Monitoring ${item.type} ${item.title} (job: ${item.encodingJobId})`
    );

    // Get the encoder assignment for this job
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId: item.encodingJobId },
    });

    if (!assignment) {
      console.log(`[${this.name}] No assignment found for job ${item.encodingJobId}`);
      return;
    }

    // Check if encoding is complete
    if (assignment.status === "COMPLETED") {
      console.log(`[${this.name}] Encoding complete for ${item.title}`);

      try {
        // Get the output path from the assignment
        const outputPath = assignment.outputPath;
        if (!outputPath) {
          throw new Error(`No output path for completed encoding job ${item.encodingJobId}`);
        }

        // Get request to extract targets and encoding config
        const requestData = await this.getRequest(item.requestId);
        if (!requestData) {
          throw new Error(`Request ${item.requestId} not found`);
        }

        // Get pipeline execution to load encoding config from template
        const execution = await prisma.pipelineExecution.findFirst({
          where: { requestId: item.requestId, parentExecutionId: null },
          orderBy: { startedAt: "desc" },
        });

        if (!execution) {
          throw new Error(`Pipeline execution not found for request ${item.requestId}`);
        }

        // Extract encoding config from pipeline steps
        type StepConfig = {
          type: string;
          config?: Record<string, unknown>;
          children?: StepConfig[];
        };
        const steps = execution.steps as StepConfig[];

        const findEncodeConfig = (stepList: StepConfig[]): Record<string, unknown> | null => {
          for (const step of stepList) {
            if (step.type === "ENCODE" && step.config) {
              return step.config;
            }
            if (step.children) {
              const found = findEncodeConfig(step.children);
              if (found) return found;
            }
          }
          return null;
        };

        const encodeConfig = findEncodeConfig(steps);
        if (!encodeConfig) {
          throw new Error(
            `No ENCODE step found in pipeline template for request ${item.requestId}`
          );
        }

        // Extract target server IDs from request
        const targetServerIds = requestData.targets
          ? (requestData.targets as Array<{ serverId: string }>).map((t) => t.serverId)
          : [];

        // Map encoder codec to display name
        const codecMap: Record<string, string> = {
          av1_vaapi: "AV1",
          hevc_vaapi: "HEVC",
          h264_vaapi: "H264",
          libx265: "HEVC",
          libx264: "H264",
        };
        const codec =
          codecMap[encodeConfig.videoEncoder as string] || (encodeConfig.videoEncoder as string);

        // Build encode context
        const stepContext = item.stepContext as Record<string, unknown>;
        const encodeContext = {
          jobId: item.encodingJobId,
          encodedFiles: [
            {
              profileId: "default",
              path: outputPath,
              resolution: encodeConfig.maxResolution as string,
              codec,
              targetServerIds,
              season: item.season,
              episode: item.episode,
              episodeTitle: item.type === "EPISODE" ? item.title : undefined,
              size: assignment.outputSize ? Number(assignment.outputSize) : undefined,
              compressionRatio: assignment.compressionRatio || undefined,
            },
          ],
        };

        const newStepContext = {
          ...stepContext,
          encode: encodeContext,
        };

        // Transition to ENCODED
        await this.transitionToNext(item.id, {
          currentStep: "encode_complete",
          stepContext: newStepContext,
        });

        console.log(`[${this.name}] Transitioned ${item.title} to ENCODED`);
      } catch (error) {
        // If we can't transition to ENCODED due to missing data, mark as FAILED
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.name}] Failed to transition ${item.title} to ENCODED: ${errorMsg}`);
        await this.transitionToFailed(item.id, errorMsg);
      }
    } else if (assignment.status === "FAILED") {
      const error = assignment.error || "Encoding failed";
      console.error(`[${this.name}] Encoding failed for ${item.title}: ${error}`);
      // Mark as FAILED instead of throwing to prevent log spam
      await this.transitionToFailed(item.id, error);
    } else if (assignment.status === "CANCELLED") {
      console.warn(`[${this.name}] Encoding cancelled for ${item.title}`);
      await this.transitionToFailed(item.id, "Encoding was cancelled");
    }
    // else: Still encoding, will check again next poll
  }
}

export const encoderMonitorWorker = new EncoderMonitorWorker();
