import {
  ActivityType,
  DownloadStatus,
  type MediaType,
  Prisma,
  RequestStatus,
  StepType,
} from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { detectRarArchive, extractRar, isSampleFile } from "../../archive.js";
import { getDownloadService } from "../../download.js";
import { downloadManager } from "../../downloadManager.js";
import type { Release } from "../../indexer.js";
import type { PipelineContext } from "../PipelineContext.js";
import { BaseStep, type StepOutput } from "./BaseStep.js";

interface DownloadStepConfig {
  pollInterval?: number;
  timeout?: number;
}

/**
 * Download Step - Monitor torrent download to completion
 *
 * Inputs:
 * - requestId, mediaType
 * - search.selectedRelease OR existingDownload from search step
 *
 * Outputs:
 * - download.torrentHash: The torrent hash
 * - download.sourceFilePath: Path to the downloaded video file
 * - download.downloadedAt: Timestamp of completion
 *
 * Side effects:
 * - Creates Download record in database
 * - Adds torrent to qBittorrent (if new)
 * - Monitors download progress
 * - Extracts RAR archives if present
 * - Updates MediaRequest status and progress
 */
export class DownloadStep extends BaseStep {
  readonly type = StepType.DOWNLOAD;

  validateConfig(config: unknown): void {
    if (config !== undefined && typeof config !== "object") {
      throw new Error("DownloadStep config must be an object");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as DownloadStepConfig | undefined) || {};

    const { requestId, mediaType } = context;
    const pollInterval = cfg.pollInterval || 5000;
    const timeout = cfg.timeout || 24 * 60 * 60 * 1000; // 24 hours

    // Check if we have an existing download or need to create a new one
    const existingDownload = context.search?.existingDownload;
    const selectedRelease = context.search?.selectedRelease;

    let downloadId: string;
    let torrentHash: string;

    if (existingDownload) {
      // Use existing download (already verified by search step)
      torrentHash = existingDownload.torrentHash as string;
      const download = await downloadManager.createDownloadFromExisting(
        requestId,
        mediaType as MediaType,
        { torrent: { hash: torrentHash } } as never,
        { isComplete: existingDownload.isComplete as boolean }
      );
      downloadId = download.id;

      if (existingDownload.isComplete) {
        // Already complete - get video file
        const qb = getDownloadService();
        const videoFile = await qb.getMainVideoFile(torrentHash);

        if (!videoFile) {
          return {
            success: false,
            shouldRetry: false,
            nextStep: null,
            error: "No video file found in existing download",
          };
        }

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: { sourceFilePath: videoFile.path },
        });

        return {
          success: true,
          nextStep: "encode",
          data: {
            download: {
              torrentHash,
              sourceFilePath: videoFile.path,
              downloadedAt: new Date().toISOString(),
            },
          },
        };
      }
    } else if (selectedRelease) {
      // Create new download
      const download = await downloadManager.createDownload({
        requestId,
        mediaType: mediaType as MediaType,
        release: selectedRelease as unknown as Release,
        alternativeReleases: context.search?.alternativeReleases as unknown[] as
          | Release[]
          | undefined,
      });

      if (!download) {
        // Download creation failed - likely due to stale auth headers or invalid release
        // Clear selectedRelease to force a fresh search with new headers on next attempt
        await this.logActivity(
          requestId,
          ActivityType.WARNING,
          "Download creation failed (likely stale auth headers)"
        );

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            selectedRelease: Prisma.JsonNull,
            availableReleases: Prisma.JsonNull,
            status: RequestStatus.PENDING,
            progress: 0,
            currentStep: null,
            currentStepStartedAt: new Date(),
            error: "Download failed - stale authentication. Please retry the request.",
          },
        });

        // Fail this execution so user can retry with fresh search
        return {
          success: false,
          shouldRetry: false,
          nextStep: null,
          error: "Failed to create download (likely stale auth headers) - please retry the request",
        };
      }

      downloadId = download.id;
      torrentHash = download.torrentHash;
    } else {
      return {
        success: false,
        shouldRetry: false,
        nextStep: null,
        error: "No download source available",
      };
    }

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.DOWNLOADING,
        progress: 20,
        currentStep: "Downloading...",
        currentStepStartedAt: new Date(),
      },
    });

    const download = await prisma.download.findUnique({
      where: { id: downloadId },
    });

    if (!download) {
      throw new Error(`Download not found: ${downloadId}`);
    }

    await this.logActivity(
      requestId,
      ActivityType.INFO,
      `Monitoring download: ${download.torrentName}`
    );

    const qb = getDownloadService();

    // Wait for download completion
    const downloadResult = await qb.waitForCompletion(torrentHash, {
      pollInterval,
      timeout,
      onProgress: async (progress) => {
        await prisma.download.update({
          where: { id: downloadId },
          data: {
            progress: progress.progress,
            lastProgressAt: new Date(),
            seedCount: progress.seeds,
            peerCount: progress.peers,
            savePath: progress.savePath,
            contentPath: progress.contentPath,
          },
        });

        const overallProgress = 20 + progress.progress * 0.3;
        const eta = progress.eta > 0 ? `ETA: ${this.formatDuration(progress.eta)}` : "";
        const speed = `${this.formatBytes(progress.downloadSpeed)}/s`;

        // Don't update currentStepStartedAt on progress updates - timestamp was set when
        // download started (line 166)
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            progress: overallProgress,
            currentStep: `Downloading: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`,
          },
        });
      },
    });

    if (!downloadResult.success) {
      await downloadManager.handleStalledDownload(
        downloadId,
        downloadResult.error || "Download failed"
      );

      return {
        success: false,
        shouldRetry: true,
        nextStep: null,
        error: downloadResult.error || "Download failed",
      };
    }

    // Download complete
    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: DownloadStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
        savePath: downloadResult.progress?.savePath,
        contentPath: downloadResult.progress?.contentPath,
      },
    });

    await this.logActivity(
      requestId,
      ActivityType.SUCCESS,
      `Download complete: ${download.torrentName}`
    );

    // Extract RAR archives if present
    const contentPath =
      downloadResult.progress?.contentPath || downloadResult.progress?.savePath || "";
    const archiveInfo = detectRarArchive(contentPath);

    if (archiveInfo.hasArchive && archiveInfo.archivePath) {
      await this.logActivity(requestId, ActivityType.INFO, "Extracting RAR archive...");
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          progress: 45,
          currentStep: "Extracting archive...",
          currentStepStartedAt: new Date(),
        },
      });

      const extractResult = await extractRar(archiveInfo.archivePath, contentPath);

      if (!extractResult.success) {
        await this.logActivity(
          requestId,
          ActivityType.ERROR,
          `Failed to extract archive: ${extractResult.error}`
        );
      } else {
        await this.logActivity(
          requestId,
          ActivityType.SUCCESS,
          `Extracted ${extractResult.extractedFiles.length} files from archive`
        );
      }
    }

    // Get main video file
    const videoFile = await qb.getMainVideoFile(torrentHash);

    if (!videoFile) {
      // Try scanning directory for extracted files
      if (archiveInfo.hasArchive) {
        const extractedVideoFile = await this.scanForVideoFile(contentPath);

        if (extractedVideoFile) {
          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Video file: ${this.formatBytes(extractedVideoFile.size)}`
          );

          await prisma.mediaRequest.update({
            where: { id: requestId },
            data: {
              sourceFilePath: extractedVideoFile.path,
              progress: 50,
              currentStep: "Download complete",
              currentStepStartedAt: new Date(),
            },
          });

          return {
            success: true,
            nextStep: "encode",
            data: {
              download: {
                torrentHash,
                sourceFilePath: extractedVideoFile.path,
                downloadedAt: new Date().toISOString(),
              },
            },
          };
        }
      }

      await prisma.download.update({
        where: { id: downloadId },
        data: {
          status: DownloadStatus.FAILED,
          failureReason: "No video file found in torrent",
        },
      });

      return {
        success: false,
        shouldRetry: false,
        nextStep: null,
        error: "No video file found in downloaded content",
      };
    }

    await this.logActivity(
      requestId,
      ActivityType.SUCCESS,
      `Video file: ${this.formatBytes(videoFile.size)}`
    );

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        sourceFilePath: videoFile.path,
        progress: 50,
        currentStep: "Download complete",
        currentStepStartedAt: new Date(),
      },
    });

    return {
      success: true,
      nextStep: "encode",
      data: {
        download: {
          torrentHash,
          sourceFilePath: videoFile.path,
          downloadedAt: new Date().toISOString(),
        },
      },
    };
  }

  private async scanForVideoFile(
    contentPath: string
  ): Promise<{ path: string; size: number } | null> {
    const { readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
    const minSizeBytes = 100 * 1024 * 1024; // 100MB

    let extractedVideoFile: { path: string; size: number } | null = null;

    try {
      const files = readdirSync(contentPath);
      for (const filename of files) {
        const lower = filename.toLowerCase();
        if (videoExtensions.some((ext) => lower.endsWith(ext)) && !isSampleFile(filename)) {
          const filePath = join(contentPath, filename);
          try {
            const stat = statSync(filePath);
            if (
              stat.size >= minSizeBytes &&
              (!extractedVideoFile || stat.size > extractedVideoFile.size)
            ) {
              extractedVideoFile = { path: filePath, size: stat.size };
            }
          } catch {
            // Ignore stat errors
          }
        }
      }
    } catch {
      // Ignore directory read errors
    }

    return extractedVideoFile;
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

  private formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}
