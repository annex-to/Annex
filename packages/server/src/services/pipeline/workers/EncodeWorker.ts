import type { MediaType, ProcessingItem } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import type { PipelineContext } from "../PipelineContext";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
import { EncodeStep } from "../steps/EncodeStep";
import { BaseWorker } from "./BaseWorker";

/**
 * EncodeWorker - Encodes media for items in DOWNLOADED status
 * Transitions items from DOWNLOADED → ENCODING → ENCODED
 */
export class EncodeWorker extends BaseWorker {
  readonly processingStatus = "DOWNLOADED" as const;
  readonly nextStatus = "ENCODED" as const;
  readonly name = "EncodeWorker";

  private encodeStep = new EncodeStep();

  protected async processItem(item: ProcessingItem): Promise<void> {
    console.log(`[${this.name}] ========== ENCODE WORKER CALLED ==========`);
    console.log(
      `[${this.name}] Processing ${item.type} ${item.title} S${item.season}E${item.episode}`
    );

    // Transition to ENCODING
    await pipelineOrchestrator.transitionStatus(item.id, "ENCODING", {
      currentStep: "encode",
    });

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
      throw new Error(`No ENCODE step found in pipeline template for request ${item.requestId}`);
    }

    console.log(`[${this.name}] Using encoding config from pipeline:`, encodeConfig);

    // Extract previous step contexts
    const stepContext = item.stepContext as Record<string, unknown>;
    const searchData = stepContext.search as PipelineContext["search"];
    const downloadData = stepContext.download as PipelineContext["download"];

    console.log(`[${this.name}] Item ${item.title} S${item.season}E${item.episode}`);
    console.log(`[${this.name}] downloadData.sourceFilePath:`, downloadData?.sourceFilePath);

    if (!downloadData?.sourceFilePath && !downloadData?.episodeFiles) {
      throw new Error("No download data found in item context");
    }

    // Build pipeline context
    const context: PipelineContext = {
      requestId: item.requestId,
      mediaType: request.type as MediaType,
      tmdbId: item.tmdbId,
      title: item.type === "EPISODE" ? request.title : item.title, // Use series title for episodes
      year: item.year || new Date().getFullYear(),
      targets: request.targets
        ? (request.targets as Array<{ serverId: string; encodingProfileId?: string }>)
        : [],
      search: searchData,
      download: downloadData,
      processingItemId: item.id, // Pass item ID for deterministic filename generation
    };

    // For TV episodes, add episode context
    if (item.type === "EPISODE" && item.season !== null && item.episode !== null) {
      context.requestedEpisodes = [{ season: item.season, episode: item.episode }];
      context.season = item.season;
      context.episode = item.episode;
    }

    // Create encoding job directly (non-blocking)
    const { getEncoderDispatchService } = await import("../../encoderDispatch.js");

    // Build encoding configuration
    const encodingConfig = {
      videoEncoder: (encodeConfig as any).videoEncoder || "av1_vaapi",
      crf: (encodeConfig as any).crf || 20,
      maxResolution: (encodeConfig as any).maxResolution || "2160p",
      maxBitrate: (encodeConfig as any).maxBitrate,
      hwAccel: (encodeConfig as any).hwAccel || "VAAPI",
      hwDevice: (encodeConfig as any).hwDevice || "/dev/dri/renderD128",
      videoFlags: (encodeConfig as any).videoFlags || {},
      preset: (encodeConfig as any).preset || "medium",
      audioEncoder: (encodeConfig as any).audioEncoder || "copy",
      audioFlags: (encodeConfig as any).audioFlags || {},
      subtitlesMode: (encodeConfig as any).subtitlesMode || "COPY",
      container: (encodeConfig as any).container || "MKV",
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

    // Determine output path using processingItemId
    const inputDir = (downloadData.sourceFilePath as string).substring(
      0,
      (downloadData.sourceFilePath as string).lastIndexOf("/")
    );
    const outputPath = `${inputDir}/encoded_${item.id}.mkv`;

    // Queue encoding job
    const encoderService = getEncoderDispatchService();
    console.log(`[${this.name}] Queueing encoding job ${job.id} for ${item.title}`);
    console.log(`[${this.name}]   inputPath: ${downloadData.sourceFilePath as string}`);
    console.log(`[${this.name}]   outputPath: ${outputPath}`);

    const assignment = await encoderService.queueEncodingJob(
      job.id,
      downloadData.sourceFilePath as string,
      outputPath,
      encodingConfig
    );

    console.log(
      `[${this.name}] queueEncodingJob returned assignment ${assignment.id} status=${assignment.status}`
    );

    // Update ProcessingItem with encodingJobId immediately so progress can be tracked
    await prisma.processingItem.update({
      where: { id: item.id },
      data: {
        encodingJobId: job.id,
        updatedAt: new Date(),
      },
    });

    console.log(`[${this.name}] Created encoding job ${job.id} for ${item.title}`);

    // Check if assignment is already completed (reused from previous encoding)
    if (assignment.status === "COMPLETED") {
      console.log(`[${this.name}] Assignment already completed - reusing existing encoded file`);

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
      const codec =
        codecMap[encodingConfig.videoEncoder as string] || (encodingConfig.videoEncoder as string);

      // Transition to ENCODED with encoded files in stepContext (expected format)
      await pipelineOrchestrator.transitionStatus(item.id, "ENCODED", {
        currentStep: "deliver",
        stepContext: {
          ...(item.stepContext as Record<string, unknown>),
          encode: {
            encodedFiles: [
              {
                path: assignment.outputPath,
                resolution: encodingConfig.maxResolution as string,
                codec,
                targetServerIds,
                season: item.season,
                episode: item.episode,
                episodeTitle: item.type === "EPISODE" ? item.title : undefined,
              },
            ],
            encodedAt: assignment.completedAt?.toISOString() || new Date().toISOString(),
          },
        },
        progress: 100,
      });

      console.log(`[${this.name}] Transitioned ${item.title} to ENCODED (reused encoding)`);
      return;
    }

    // Note: We don't wait for encoding to complete here - that's handled by EncoderMonitorWorker
    // The item will stay in ENCODING status with encodingJobId set, and EncoderDispatch will sync progress
  }
}

export const encodeWorker = new EncodeWorker();
