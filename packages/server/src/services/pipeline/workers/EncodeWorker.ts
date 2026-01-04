import type { ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { BaseWorker } from "./BaseWorker";

/**
 * Encoding configuration from pipeline template
 */
interface EncodingConfig {
  videoEncoder?: string;
  crf?: number;
  maxResolution?: string;
  maxBitrate?: number;
  hwAccel?: string;
  hwDevice?: string;
  videoFlags?: Record<string, unknown>;
  preset?: string;
  audioEncoder?: string;
  audioFlags?: Record<string, unknown>;
  subtitlesMode?: string;
  container?: string;
}

/**
 * EncodeWorker - Unified worker for starting and monitoring encoding jobs
 * Processes DOWNLOADED → ENCODING → ENCODED
 *
 * No blocking - uses scheduled polling
 * Progress-based stall detection
 * Circuit breaker integration for encoder availability
 */
export class EncodeWorker extends BaseWorker {
  readonly processingStatus = "DOWNLOADED" as const;
  readonly nextStatus = "ENCODED" as const;
  readonly name = "EncodeWorker";
  readonly concurrency = 5;

  /**
   * Process batch - handle both new jobs and active monitoring
   */
  async processBatch(): Promise<void> {
    await this.startNewEncodingJobs();
    await this.monitorActiveJobs();
  }

  /**
   * Override processItem - not used in new design
   */
  protected async processItem(_item: ProcessingItem): Promise<void> {
    // Not used - processBatch handles everything
  }

  /**
   * Start new encoding jobs for DOWNLOADED items
   */
  private async startNewEncodingJobs(): Promise<void> {
    const downloadedItems = await pipelineOrchestrator.getItemsForProcessing("DOWNLOADED");

    for (const item of downloadedItems.slice(0, this.concurrency)) {
      try {
        await this.createEncodingJob(item);
      } catch (error) {
        await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Monitor active encoding jobs for ENCODING items
   */
  private async monitorActiveJobs(): Promise<void> {
    const encodingItems = await pipelineOrchestrator.getItemsForProcessing("ENCODING");

    for (const item of encodingItems) {
      try {
        await this.checkEncodingProgress(item);
      } catch (error) {
        await this.handleError(item, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /**
   * Create a new encoding job from DOWNLOADED item
   */
  private async createEncodingJob(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] Creating encoding job for ${item.title}`);

    // Early exit: if item already has a completed encoding job, skip to ENCODED
    if (item.encodingJobId) {
      const assignment = await prisma.encoderAssignment.findUnique({
        where: { jobId: item.encodingJobId },
      });

      if (assignment && assignment.status === "COMPLETED") {
        console.log(
          `[${this.name}] Early exit: ${item.title} encoding already complete, promoting to ENCODED`
        );
        await this.handleCompletedEncoding(item, assignment, null);
        return;
      }
    }

    // Check if we have available encoders
    const { getEncoderDispatchService } = await import("../../encoderDispatch.js");
    const encoderService = getEncoderDispatchService();
    const encoderCount = encoderService.getEncoderCount();

    if (encoderCount === 0) {
      console.warn(`[${this.name}] No encoders available, skipping ${item.title}`);
      await prisma.processingItem.update({
        where: { id: item.id },
        data: { skipUntil: new Date(Date.now() + 5 * 60 * 1000) }, // Skip for 5 minutes
      });
      return;
    }

    // Get request details
    const request = await this.getRequest(item.requestId);
    if (!request) {
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

    const findEncodeConfig = (stepList: StepConfig[]): EncodingConfig | null => {
      for (const step of stepList) {
        if (step.type === "ENCODE" && step.config) {
          return step.config as EncodingConfig;
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
      throw new Error(`No ENCODE step found in pipeline template for request ${item.requestId}`);
    }

    // Extract previous step contexts
    const stepContext = item.stepContext as Record<string, unknown>;
    const downloadData = stepContext.download as PipelineContext["download"];

    if (!downloadData?.sourceFilePath) {
      throw new Error("No download data found in item context");
    }

    // If sourceFilePath is a directory (from old cached data), find the main video file
    if (item.type === "MOVIE") {
      const { findMainVideoFile } = await import("./fileUtils.js");
      const videoFile = await findMainVideoFile(downloadData.sourceFilePath as string);
      if (videoFile && videoFile !== downloadData.sourceFilePath) {
        console.log(
          `[${this.name}] sourceFilePath was a directory, found video file: ${videoFile}`
        );
        downloadData.sourceFilePath = videoFile;
      }
    }

    // Build encoding configuration
    const encodingConfig = {
      videoEncoder: encodeConfig.videoEncoder || "av1_vaapi",
      crf: encodeConfig.crf || 20,
      maxResolution: encodeConfig.maxResolution || "2160p",
      maxBitrate: encodeConfig.maxBitrate,
      hwAccel: encodeConfig.hwAccel || "VAAPI",
      hwDevice: encodeConfig.hwDevice || "/dev/dri/renderD128",
      videoFlags: encodeConfig.videoFlags || {},
      preset: encodeConfig.preset || "medium",
      audioEncoder: encodeConfig.audioEncoder || "copy",
      audioFlags: encodeConfig.audioFlags || {},
      subtitlesMode: encodeConfig.subtitlesMode || "COPY",
      container: encodeConfig.container || "MKV",
    };

    // Create Job record
    const job = await prisma.job.create({
      data: {
        type: "remote:encode",
        requestId: item.requestId,
        payload: {
          requestId: item.requestId,
          mediaType: request.type,
          inputPath: downloadData.sourceFilePath,
          season: item.season,
          episode: item.episode,
          processingItemId: item.id,
          encodingConfig,
        } as import("@prisma/client").Prisma.JsonObject,
        dedupeKey: `encode:${item.requestId}:${item.id}`,
      },
    });

    // Determine output paths using processingItemId
    const inputDir = (downloadData.sourceFilePath as string).substring(
      0,
      (downloadData.sourceFilePath as string).lastIndexOf("/")
    );
    const finalOutputPath = `${inputDir}/encoded_${item.id}.mkv`;
    const tempOutputPath = `${inputDir}/encoded_${item.id}_temp_${Date.now()}.mkv`;

    // Early exit: Check if final encoded file already exists
    const finalFile = Bun.file(finalOutputPath);
    if (await finalFile.exists()) {
      console.log(
        `[${this.name}] Early exit: ${item.title} final encoded file exists, promoting to ENCODED`
      );
      // Create a mock assignment object for handleCompletedEncoding
      const mockAssignment = {
        outputPath: finalOutputPath,
        outputSize: BigInt(await finalFile.size),
        compressionRatio: null,
      };
      await this.handleCompletedEncoding(item, mockAssignment, encodingConfig);
      return;
    }

    // Cleanup: Delete any stale temp files for this item
    const tempPattern = `encoded_${item.id}_temp_*.mkv`;
    console.log(`[${this.name}] Cleaning up stale temp files: ${inputDir}/${tempPattern}`);
    try {
      await Bun.$`rm -f ${inputDir}/encoded_${item.id}_temp_*.mkv`.quiet();
    } catch (err) {
      console.warn(
        `[${this.name}] Failed to cleanup temp files: ${err instanceof Error ? err.message : "Unknown"}`
      );
    }

    // Queue encoding job
    console.log(`[${this.name}] Queueing encoding job ${job.id} for ${item.title}`);
    console.log(`[${this.name}]   inputPath: ${downloadData.sourceFilePath as string}`);
    console.log(`[${this.name}]   tempOutputPath: ${tempOutputPath}`);
    console.log(`[${this.name}]   finalOutputPath: ${finalOutputPath}`);

    const assignment = await encoderService.queueEncodingJob(
      job.id,
      downloadData.sourceFilePath as string,
      tempOutputPath,
      encodingConfig
    );

    console.log(
      `[${this.name}] queueEncodingJob returned assignment ${assignment.id} status=${assignment.status}`
    );

    // Check if assignment is already completed (reused from previous encoding)
    if (assignment.status === "COMPLETED") {
      console.log(`[${this.name}] Assignment already completed - reusing existing encoded file`);
      await this.handleCompletedEncoding(item, assignment, encodingConfig);
      return;
    }

    // Transition to ENCODING with progress tracking
    await pipelineOrchestrator.transitionStatus(item.id, "ENCODING", {
      currentStep: "encode",
      encodingJobId: job.id,
    });

    // Initialize progress tracking
    await pipelineOrchestrator.updateProgress(item.id, 0, {
      lastProgressUpdate: new Date(),
      lastProgressValue: 0,
    });

    console.log(`[${this.name}] Started encoding job for ${item.title}`);
  }

  /**
   * Check progress of active encoding job
   */
  private async checkEncodingProgress(item: ProcessingItem): Promise<void> {
    if (!item.encodingJobId) {
      console.warn(`[${this.name}] No encodingJobId for ${item.title}, resetting to DOWNLOADED`);
      await pipelineOrchestrator.transitionStatus(item.id, "DOWNLOADED", {
        currentStep: undefined,
      });
      return;
    }

    // Get encoder assignment
    const assignment = await prisma.encoderAssignment.findUnique({
      where: { jobId: item.encodingJobId },
    });

    if (!assignment) {
      console.warn(
        `[${this.name}] No assignment found for job ${item.encodingJobId}, will retry next poll`
      );
      return;
    }

    // Stall detection: Compare progress to last known value
    const progressChanged = assignment.progress !== item.lastProgressValue;

    if (!progressChanged && item.lastProgressUpdate) {
      const stallTime = Date.now() - item.lastProgressUpdate.getTime();

      if (stallTime > 10 * 60 * 1000) {
        // Stalled for >10 minutes - check if assignment status indicates a problem
        if (assignment.status === "FAILED" || assignment.status === "CANCELLED") {
          throw new Error(
            `Encoding ${assignment.status.toLowerCase()}: ${assignment.error || "Unknown error"}`
          );
        }

        // Assignment is still active but not making progress
        console.warn(`[${this.name}] Encoding stalled for ${item.title} (no progress for 10 min)`);
        throw new Error("Encoding stalled: No progress for 10 minutes");
      }
    }

    // Update progress if changed
    if (progressChanged) {
      await pipelineOrchestrator.updateProgress(item.id, assignment.progress, {
        lastProgressUpdate: new Date(),
        lastProgressValue: assignment.progress,
      });
    }

    // Check if complete
    if (assignment.status === "COMPLETED") {
      await this.handleCompletedEncoding(item, assignment, null);
    } else if (assignment.status === "FAILED") {
      const error = assignment.error || "Encoding failed";
      throw new Error(error);
    } else if (assignment.status === "CANCELLED") {
      throw new Error("Encoding was cancelled");
    }
    // else: Still encoding, will check again next poll
  }

  /**
   * Handle completed encoding - build encode context and transition to ENCODED
   */
  private async handleCompletedEncoding(
    item: ProcessingItem,
    assignment: {
      outputPath: string | null;
      outputSize: bigint | null;
      compressionRatio: number | null;
    },
    encodingConfig: EncodingConfig | null
  ): Promise<void> {
    console.log(`[${this.name}] Encoding complete for ${item.title}`);

    let outputPath = assignment.outputPath;
    if (!outputPath) {
      throw new Error(`No output path for completed encoding job ${item.encodingJobId}`);
    }

    // Rename temp file to final path if this is a temp file
    if (outputPath.includes("_temp_")) {
      const inputDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
      const finalPath = `${inputDir}/encoded_${item.id}.mkv`;

      console.log(`[${this.name}] Renaming temp file to final path`);
      console.log(`[${this.name}]   From: ${outputPath}`);
      console.log(`[${this.name}]   To: ${finalPath}`);

      try {
        await Bun.$`mv ${outputPath} ${finalPath}`;
        outputPath = finalPath; // Use final path from now on
      } catch (err) {
        throw new Error(
          `Failed to rename temp file: ${err instanceof Error ? err.message : "Unknown error"}`
        );
      }
    }

    // Get request to extract targets
    const request = await this.getRequest(item.requestId);
    if (!request) {
      throw new Error(`Request ${item.requestId} not found`);
    }

    // If encoding config not provided, load it from pipeline
    let config = encodingConfig;
    if (!config) {
      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: item.requestId, parentExecutionId: null },
        orderBy: { startedAt: "desc" },
      });

      if (!execution) {
        throw new Error(`Pipeline execution not found for request ${item.requestId}`);
      }

      type StepConfig = {
        type: string;
        config?: Record<string, unknown>;
        children?: StepConfig[];
      };
      const steps = execution.steps as StepConfig[];

      const findEncodeConfig = (stepList: StepConfig[]): EncodingConfig | null => {
        for (const step of stepList) {
          if (step.type === "ENCODE" && step.config) {
            return step.config as EncodingConfig;
          }
          if (step.children) {
            const found = findEncodeConfig(step.children);
            if (found) return found;
          }
        }
        return null;
      };

      config = findEncodeConfig(steps);
      if (!config) {
        throw new Error(`No ENCODE step found in pipeline template for request ${item.requestId}`);
      }
    }

    // Extract target server IDs from request
    const targetServerIds = request.targets
      ? (request.targets as Array<{ serverId: string }>).map((t) => t.serverId)
      : [];

    // Map encoder codec to display name
    const codecMap: Record<string, string> = {
      av1_vaapi: "AV1",
      hevc_vaapi: "HEVC",
      h264_vaapi: "H264",
      libx265: "HEVC",
      libx264: "H264",
    };
    const codec = codecMap[config.videoEncoder as string] || (config.videoEncoder as string);

    // Build encode context
    const stepContext = item.stepContext as Record<string, unknown>;
    const encodeContext = {
      jobId: item.encodingJobId,
      encodedFiles: [
        {
          profileId: "default",
          path: outputPath,
          resolution: config.maxResolution as string,
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
    await pipelineOrchestrator.transitionStatus(item.id, "ENCODED", {
      currentStep: "encode_complete",
      stepContext: newStepContext,
    });

    console.log(`[${this.name}] Transitioned ${item.title} to ENCODED`);
  }

  /**
   * Handle error for an item
   */
  private async handleError(item: ProcessingItem, error: Error): Promise<void> {
    console.error(`[${this.name}] Error processing ${item.title}:`, error);

    // If error is about encoder availability, don't pass service parameter
    // to avoid opening circuit breaker for encoder pool
    await pipelineOrchestrator.handleError(item.id, error);
  }
}

export const encodeWorker = new EncodeWorker();
