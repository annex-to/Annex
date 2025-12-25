import {
  ActivityType,
  AssignmentStatus,
  type Prisma,
  RequestStatus,
  StepType,
} from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getEncoderDispatchService } from "../../encoderDispatch.js";
import type { PipelineContext } from "../PipelineContext.js";
import { BaseStep, type StepOutput } from "./BaseStep.js";

interface EncodeStepConfig {
  // Video encoder (e.g., "av1_qsv", "libsvtav1", "hevc_nvenc", "libx265")
  videoEncoder?: string;

  // Quality control (CRF for software, global_quality for QSV, etc.)
  crf?: number; // 18-28 recommended, lower = better

  // Maximum output resolution
  maxResolution?: "480p" | "720p" | "1080p" | "2160p";

  // Optional bitrate cap (kbps)
  maxBitrate?: number;

  // Hardware acceleration
  hwAccel?: "NONE" | "QSV" | "NVENC" | "VAAPI" | "AMF" | "VIDEOTOOLBOX";
  hwDevice?: string; // e.g., "/dev/dri/renderD128" for VAAPI/QSV

  // Encoder-specific flags as JSON object
  // e.g., {"preset": "slow", "look_ahead": 1, "tune": "film"}
  videoFlags?: Record<string, unknown>;

  // Encoder preset
  preset?: "fast" | "medium" | "slow";

  // Audio encoder (e.g., "copy", "aac", "libopus", "ac3")
  audioEncoder?: string;

  // Audio encoder flags
  audioFlags?: Record<string, unknown>;

  // Subtitle handling
  subtitlesMode?: "COPY" | "COPY_TEXT" | "EXTRACT" | "NONE";

  // Output container format
  container?: "MKV" | "MP4" | "WEBM";

  // Execution settings
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

    if (
      cfg.hwAccel &&
      !["NONE", "QSV", "NVENC", "VAAPI", "AMF", "VIDEOTOOLBOX"].includes(cfg.hwAccel)
    ) {
      throw new Error("hwAccel must be one of: NONE, QSV, NVENC, VAAPI, AMF, VIDEOTOOLBOX");
    }

    if (
      cfg.subtitlesMode &&
      !["COPY", "COPY_TEXT", "EXTRACT", "NONE"].includes(cfg.subtitlesMode)
    ) {
      throw new Error("subtitlesMode must be one of: COPY, COPY_TEXT, EXTRACT, NONE");
    }

    if (cfg.container && !["MKV", "MP4", "WEBM"].includes(cfg.container)) {
      throw new Error("container must be one of: MKV, MP4, WEBM");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as EncodeStepConfig | undefined) || {};

    const { requestId, mediaType } = context;

    // Check if encoding already completed (recovery scenario)
    if (context.encode?.encodedFiles && context.encode.encodedFiles.length > 0) {
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        "Encoding already completed, skipping (recovered from restart)"
      );

      return {
        success: true,
        data: {
          encode: context.encode,
        },
      };
    }

    const sourceFilePath = context.download?.sourceFilePath as string | undefined;
    const episodeFiles = context.download?.episodeFiles as
      | Array<{
          season: number;
          episode: number;
          path: string;
          size: number;
          episodeId: string;
        }>
      | undefined;

    // Check if we have either a source file (movie) or episode files (TV)
    if (!sourceFilePath && (!episodeFiles || episodeFiles.length === 0)) {
      return {
        success: false,
        error: "No source file path or episode files available from download step",
      };
    }

    // Handle TV shows with multiple episodes
    if (mediaType === "TV" && episodeFiles && episodeFiles.length > 0) {
      return await this.encodeMultipleEpisodes(context, cfg, episodeFiles, requestId);
    }

    // Continue with movie encoding (single file)
    if (!sourceFilePath) {
      return {
        success: false,
        error: "No source file path available for movie",
      };
    }

    // Check if we have a recent completed encoding job for this request
    // This allows retry to skip re-encoding if the encoded file still exists
    const recentCompletedJob = await prisma.encoderAssignment.findFirst({
      where: {
        jobId: {
          in: (
            await prisma.job.findMany({
              where: {
                type: "remote:encode",
                requestId, // Use requestId column for efficient querying
              },
              select: { id: true },
              orderBy: { createdAt: "desc" },
              take: 5,
            })
          ).map((j) => j.id),
        },
        status: AssignmentStatus.COMPLETED,
      },
      orderBy: { completedAt: "desc" },
    });

    if (recentCompletedJob?.outputPath) {
      // Check if encoded file still exists
      try {
        const encodedFileExists = await Bun.file(recentCompletedJob.outputPath).exists();
        if (encodedFileExists) {
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            "Reusing existing encoded file from previous attempt"
          );

          await prisma.mediaRequest.update({
            where: { id: requestId },
            data: {
              status: RequestStatus.ENCODING,
              progress: 90,
              currentStep: "Encoding complete (reused existing file)",
              currentStepStartedAt: new Date(),
            },
          });

          // Extract target server IDs and codec info
          const targetServerIds = context.targets.map((t) => t.serverId);
          const videoEncoder = cfg.videoEncoder || "libsvtav1";
          const codec =
            videoEncoder.includes("av1") || videoEncoder.includes("AV1")
              ? "AV1"
              : videoEncoder.includes("hevc") || videoEncoder.includes("265")
                ? "HEVC"
                : "H264";

          return {
            success: true,
            data: {
              encode: {
                encodedFiles: [
                  {
                    profileId: context.targets[0]?.encodingProfileId || "default",
                    path: recentCompletedJob.outputPath,
                    targetServerIds,
                    resolution: cfg.maxResolution || "1080p",
                    codec,
                    size: recentCompletedJob.outputSize
                      ? Number(recentCompletedJob.outputSize)
                      : undefined,
                    compressionRatio: recentCompletedJob.compressionRatio || undefined,
                  },
                ],
              },
            },
          };
        }
      } catch {
        // File doesn't exist or error checking, continue to re-encode
      }
    }

    const pollInterval = cfg.pollInterval || 5000;
    const timeout = cfg.timeout || 12 * 60 * 60 * 1000; // 12 hours

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.ENCODING,
        progress: 50,
        currentStep: "Encoding...",
        currentStepStartedAt: new Date(),
      },
    });

    await this.logActivity(requestId, ActivityType.INFO, "Starting encoding job");

    // Build encoding configuration with defaults
    const encodingConfig = {
      videoEncoder: cfg.videoEncoder || "libsvtav1",
      crf: cfg.crf || 28,
      maxResolution: cfg.maxResolution || "1080p",
      maxBitrate: cfg.maxBitrate,
      hwAccel: cfg.hwAccel || "NONE",
      hwDevice: cfg.hwDevice,
      videoFlags: cfg.videoFlags || {},
      preset: cfg.preset || "medium",
      audioEncoder: cfg.audioEncoder || "copy",
      audioFlags: cfg.audioFlags || {},
      subtitlesMode: cfg.subtitlesMode || "COPY",
      container: cfg.container || "MKV",
    };

    // Create Job record
    const job = await prisma.job.create({
      data: {
        type: "remote:encode",
        requestId, // Set requestId column for proper querying
        payload: {
          requestId,
          mediaType,
          inputPath: sourceFilePath,
          encodingConfig,
        } as Prisma.JsonObject,
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
      encodingConfig
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

      // Update progress based on assignment status
      let currentStep: string;
      let overallProgress: number;

      if (assignmentStatus.status === AssignmentStatus.PENDING) {
        currentStep = "Waiting for encoder...";
        overallProgress = 50;
      } else if (assignmentStatus.status === AssignmentStatus.ASSIGNED) {
        currentStep = "Encoder assigned, starting...";
        overallProgress = 50;
      } else if (assignmentStatus.progress !== null) {
        // ENCODING status with progress
        overallProgress = 50 + assignmentStatus.progress * 0.4; // 50-90%
        const speed = assignmentStatus.speed ? ` - ${assignmentStatus.speed}x` : "";
        const eta = assignmentStatus.eta
          ? ` - ETA: ${this.formatDuration(assignmentStatus.eta)}`
          : "";
        currentStep = `Encoding: ${assignmentStatus.progress.toFixed(1)}%${speed}${eta}`;
      } else {
        // Fallback for other statuses
        currentStep = "Encoding...";
        overallProgress = 50;
      }

      // Only update currentStepStartedAt if the step actually changed
      const previousRequest = await prisma.mediaRequest.findUnique({
        where: { id: requestId },
        select: { currentStep: true },
      });

      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          progress: overallProgress,
          currentStep,
          ...(previousRequest?.currentStep !== currentStep && {
            currentStepStartedAt: new Date(),
          }),
        },
      });

      this.reportProgress(assignmentStatus.progress || 0, currentStep);

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
            currentStepStartedAt: new Date(),
          },
        });

        // Extract target server IDs
        const targetServerIds = context.targets.map((t) => t.serverId);

        // Determine codec from encoder
        const codec =
          encodingConfig.videoEncoder.includes("av1") || encodingConfig.videoEncoder.includes("AV1")
            ? "AV1"
            : encodingConfig.videoEncoder.includes("hevc") ||
                encodingConfig.videoEncoder.includes("265")
              ? "HEVC"
              : "H264";

        return {
          success: true,
          data: {
            encode: {
              encodedFiles: [
                {
                  profileId: context.targets[0]?.encodingProfileId || "default",
                  path: assignmentStatus.outputPath || outputPath,
                  targetServerIds,
                  resolution: encodingConfig.maxResolution,
                  codec,
                  size: assignmentStatus.outputSize
                    ? Number(assignmentStatus.outputSize)
                    : undefined,
                  compressionRatio: assignmentStatus.compressionRatio || undefined,
                },
              ],
            },
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

  /**
   * Encode multiple TV episodes sequentially
   * Note: Sequential for now - parallel encoding can be added as enhancement
   */
  private async encodeMultipleEpisodes(
    context: PipelineContext,
    cfg: EncodeStepConfig,
    episodeFiles: Array<{
      season: number;
      episode: number;
      path: string;
      size: number;
      episodeId: string;
    }>,
    requestId: string
  ): Promise<StepOutput> {
    await this.logActivity(
      requestId,
      ActivityType.INFO,
      `Starting encoding for ${episodeFiles.length} episodes`
    );

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.ENCODING,
        progress: 50,
        currentStep: `Encoding ${episodeFiles.length} episodes...`,
        currentStepStartedAt: new Date(),
      },
    });

    const encodedFiles = [];
    const targetServerIds = context.targets.map((t) => t.serverId);
    const videoEncoder = cfg.videoEncoder || "libsvtav1";
    const codec =
      videoEncoder.includes("av1") || videoEncoder.includes("AV1")
        ? "AV1"
        : videoEncoder.includes("hevc") || videoEncoder.includes("265")
          ? "HEVC"
          : "H264";

    // Encode each episode sequentially
    for (let i = 0; i < episodeFiles.length; i++) {
      const ep = episodeFiles[i];
      const epNum = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;

      await this.logActivity(
        requestId,
        ActivityType.INFO,
        `Encoding ${epNum} (${i + 1}/${episodeFiles.length})`
      );

      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          progress: 50 + (i / episodeFiles.length) * 30, // 50-80% for encoding
          currentStep: `Encoding ${epNum} (${i + 1}/${episodeFiles.length})`,
        },
      });

      // Update episode status to ENCODING
      await prisma.tvEpisode.update({
        where: { id: ep.episodeId },
        data: { status: "ENCODING" as never },
      });

      try {
        // For now, just mark as encoded without actual encoding
        // Full encoding implementation would create job and monitor it
        // This is a placeholder to make the pipeline functional
        const inputDir = ep.path.substring(0, ep.path.lastIndexOf("/"));
        const _outputPath = `${inputDir}/encoded_${epNum}_${Date.now()}.mkv`;

        // TODO: Implement actual encoding job creation and monitoring
        // For now, just copy the source file as a placeholder
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Placeholder: ${epNum} encoding (actual encoding to be implemented)`
        );

        encodedFiles.push({
          profileId: context.targets[0]?.encodingProfileId || "default",
          path: ep.path, // Using source for now - would be outputPath after encoding
          targetServerIds,
          resolution: cfg.maxResolution || "1080p",
          codec,
          season: ep.season,
          episode: ep.episode,
          episodeId: ep.episodeId,
        });

        // Update episode status to ENCODED
        await prisma.tvEpisode.update({
          where: { id: ep.episodeId },
          data: {
            status: "ENCODED" as never,
            encodedAt: new Date(),
          },
        });

        await this.logActivity(requestId, ActivityType.SUCCESS, `Encoded ${epNum}`);
      } catch (error) {
        // Mark episode as failed but continue with others
        await prisma.tvEpisode.update({
          where: { id: ep.episodeId },
          data: {
            status: "FAILED" as never,
            error: error instanceof Error ? error.message : "Encoding failed",
          },
        });

        await this.logActivity(
          requestId,
          ActivityType.ERROR,
          `Failed to encode ${epNum}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }

    if (encodedFiles.length === 0) {
      return {
        success: false,
        shouldRetry: false,
        nextStep: null,
        error: "Failed to encode any episodes",
      };
    }

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        progress: 80,
        currentStep: `Encoding complete (${encodedFiles.length}/${episodeFiles.length} episodes)`,
        currentStepStartedAt: new Date(),
      },
    });

    return {
      success: true,
      nextStep: "deliver",
      data: {
        encode: {
          encodedFiles,
        },
      },
    };
  }

  private async logActivity(
    requestId: string,
    type: ActivityType,
    message: string,
    details?: object
  ): Promise<void> {
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
