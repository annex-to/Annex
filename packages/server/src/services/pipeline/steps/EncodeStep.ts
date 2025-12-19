import { BaseStep, type StepOutput } from "./BaseStep.js";
import type { PipelineContext } from "../PipelineContext.js";
import { StepType, RequestStatus, ActivityType, AssignmentStatus } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getEncoderDispatchService } from "../../encoderDispatch.js";

interface EncodeStepConfig {
  crf?: number; // Quality (18-28 recommended, lower = better)
  maxResolution?: "480p" | "720p" | "1080p" | "2160p";
  preset?: "fast" | "medium" | "slow";
  pollInterval?: number;
  timeout?: number;
}

/**
 * Encode Step - Encode video file to AV1
 *
 * Inputs:
 * - requestId, mediaType
 * - download.sourceFilePath: Path to the source video file
 * - targets: Array of target servers with encoding profiles
 *
 * Outputs:
 * - encode.jobId: The encoding job ID
 * - encode.outputPath: Path to the encoded file
 * - encode.encodedAt: Timestamp of completion
 * - encode.fileSize: Size of encoded file in bytes
 * - encode.duration: Encoding duration in seconds
 *
 * Side effects:
 * - Creates EncodingJob record in database
 * - Dispatches job to available encoder
 * - Monitors encoding progress
 * - Updates MediaRequest status and progress
 */
export class EncodeStep extends BaseStep {
  readonly type = StepType.ENCODE;

  validateConfig(config: unknown): void {
    if (config !== undefined && typeof config !== "object") {
      throw new Error("EncodeStep config must be an object");
    }

    const cfg = config as EncodeStepConfig | undefined;
    if (!cfg) return;

    if (cfg.crf !== undefined && (typeof cfg.crf !== "number" || cfg.crf < 0 || cfg.crf > 51)) {
      throw new Error("crf must be a number between 0 and 51");
    }

    if (cfg.maxResolution && !["480p", "720p", "1080p", "2160p"].includes(cfg.maxResolution)) {
      throw new Error("maxResolution must be one of: 480p, 720p, 1080p, 2160p");
    }

    if (cfg.preset && !["fast", "medium", "slow"].includes(cfg.preset)) {
      throw new Error("preset must be one of: fast, medium, slow");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as EncodeStepConfig | undefined) || {};

    const { requestId, mediaType } = context;
    const sourceFilePath = context.download?.sourceFilePath as string | undefined;

    if (!sourceFilePath) {
      return {
        success: false,
        error: "No source file path available from download step",
      };
    }

    const pollInterval = cfg.pollInterval || 5000;
    const timeout = cfg.timeout || 12 * 60 * 60 * 1000; // 12 hours

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.ENCODING,
        progress: 50,
        currentStep: "Encoding...",
      },
    });

    // Get targets from context
    const targets = context.targets || [];
    if (targets.length === 0) {
      return {
        success: false,
        error: "No target servers configured",
      };
    }

    // Use first target's encoding profile (for now)
    const target = targets[0];
    const profileId = target.encodingProfileId;

    if (!profileId) {
      return {
        success: false,
        error: "No encoding profile configured for target server",
      };
    }

    await this.logActivity(requestId, ActivityType.INFO, "Starting encoding job");

    // Create Job record
    const job = await prisma.job.create({
      data: {
        type: "remote:encode",
        payload: {
          requestId,
          mediaType,
          inputPath: sourceFilePath,
          profileId,
          crf: cfg.crf,
          maxResolution: cfg.maxResolution,
          preset: cfg.preset,
        },
        dedupeKey: `encode:${requestId}`,
      },
    });

    // Determine output path (same directory, .mkv extension)
    const inputDir = sourceFilePath.substring(0, sourceFilePath.lastIndexOf("/"));
    const outputPath = `${inputDir}/encoded_${Date.now()}.mkv`;

    // Queue encoding job with encoder dispatch service
    const encoderService = getEncoderDispatchService();
    const assignment = await encoderService.queueEncodingJob(
      job.id,
      sourceFilePath,
      outputPath,
      profileId
    );

    this.reportProgress(0, `Encoding job created: ${assignment.id}`);

    // Monitor encoding progress
    const startTime = Date.now();
    const endTime = startTime + timeout;

    while (Date.now() < endTime) {
      const assignmentStatus = await prisma.encoderAssignment.findUnique({
        where: { id: assignment.id },
      });

      if (!assignmentStatus) {
        return {
          success: false,
          error: "Encoding assignment not found",
        };
      }

      // Update progress
      if (assignmentStatus.progress !== null) {
        const overallProgress = 50 + assignmentStatus.progress * 0.4; // 50-90%
        const speed = assignmentStatus.speed ? ` - ${assignmentStatus.speed}x` : "";
        const eta = assignmentStatus.eta ? ` - ETA: ${this.formatDuration(assignmentStatus.eta)}` : "";

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            progress: overallProgress,
            currentStep: `Encoding: ${assignmentStatus.progress.toFixed(1)}%${speed}${eta}`,
          },
        });

        this.reportProgress(assignmentStatus.progress, `Encoding: ${assignmentStatus.progress.toFixed(1)}%${speed}${eta}`);
      }

      // Check if complete
      if (assignmentStatus.status === AssignmentStatus.COMPLETED) {
        await this.logActivity(
          requestId,
          ActivityType.SUCCESS,
          `Encoding complete in ${this.formatDuration((Date.now() - startTime) / 1000)}`
        );

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            progress: 90,
            currentStep: "Encoding complete",
          },
        });

        return {
          success: true,
          data: {
            jobId: job.id,
            assignmentId: assignment.id,
            outputPath: assignmentStatus.outputPath,
            encodedAt: new Date().toISOString(),
            duration: (Date.now() - startTime) / 1000,
            outputSize: assignmentStatus.outputSize ? Number(assignmentStatus.outputSize) : undefined,
            compressionRatio: assignmentStatus.compressionRatio || undefined,
          },
        };
      }

      // Check if failed
      if (assignmentStatus.status === AssignmentStatus.FAILED) {
        await this.logActivity(
          requestId,
          ActivityType.ERROR,
          `Encoding failed: ${assignmentStatus.error || "Unknown error"}`
        );

        return {
          success: false,
          error: assignmentStatus.error || "Encoding failed",
        };
      }

      // Check if cancelled
      if (assignmentStatus.status === AssignmentStatus.CANCELLED) {
        return {
          success: false,
          error: "Encoding job was cancelled",
        };
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // Timeout
    await this.logActivity(requestId, ActivityType.ERROR, "Encoding timeout");

    return {
      success: false,
      error: `Encoding timeout after ${timeout / 1000 / 60} minutes`,
    };
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

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
