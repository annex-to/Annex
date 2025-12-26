import {
  ActivityType,
  DownloadStatus,
  MediaType,
  Prisma,
  RequestStatus,
  StepType,
  TvEpisodeStatus,
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

    // Check if SearchStep already created downloads in bulk (TV multi-episode mode)
    const bulkDownloadsCreated = (context.search as { bulkDownloadsCreated?: boolean })
      ?.bulkDownloadsCreated;
    if (bulkDownloadsCreated) {
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        "Multiple episodes downloading in parallel - will encode/deliver each as it completes"
      );

      // Update request status to DOWNLOADING
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.DOWNLOADING,
          currentStep: "Downloading multiple episodes in parallel...",
          progress: 30,
        },
      });

      // End pipeline - episodes will be processed individually via download monitor
      return {
        success: true,
        nextStep: null, // End pipeline, download monitor will handle per-episode processing
        data: {},
      };
    }

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
        // Already complete - get video file(s)
        const qb = getDownloadService();

        if (mediaType === MediaType.MOVIE) {
          // Movie: Get single main video file
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
        } else {
          // TV: Extract all episode files
          const episodeFiles = await this.extractEpisodeFiles(torrentHash, requestId);

          if (episodeFiles.length === 0) {
            return {
              success: false,
              shouldRetry: false,
              nextStep: null,
              error: "No episode files found in season pack",
            };
          }

          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Found ${episodeFiles.length} episodes in season pack`
          );

          return {
            success: true,
            nextStep: "encode",
            data: {
              download: {
                torrentHash,
                episodeFiles,
                downloadedAt: new Date().toISOString(),
              },
            },
          };
        }
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

      // For TV shows, mark episodes as DOWNLOADING
      if (mediaType === MediaType.TV) {
        // Parse episode info from torrent name or mark all PENDING episodes as DOWNLOADING
        const episodeMatches = download.torrentName.matchAll(/S(\d{1,2})E(\d{1,2})/gi);
        const releaseEpisodes = Array.from(episodeMatches, (match) => ({
          season: Number.parseInt(match[1], 10),
          episode: Number.parseInt(match[2], 10),
        }));

        if (releaseEpisodes.length > 0) {
          // Individual episode(s) or specific episodes - mark them as DOWNLOADING
          for (const ep of releaseEpisodes) {
            await prisma.tvEpisode.updateMany({
              where: {
                requestId,
                season: ep.season,
                episode: ep.episode,
                status: { in: [TvEpisodeStatus.PENDING, TvEpisodeStatus.SEARCHING] },
              },
              data: {
                status: TvEpisodeStatus.DOWNLOADING,
                downloadId: download.id,
              },
            });
          }
        } else {
          // Season pack - parse season number and mark only that season's episodes
          const seasonMatch = download.torrentName.match(/S(\d{1,2})/i);

          if (seasonMatch) {
            const season = Number.parseInt(seasonMatch[1], 10);
            await prisma.tvEpisode.updateMany({
              where: {
                requestId,
                season,
                status: { in: [TvEpisodeStatus.PENDING, TvEpisodeStatus.SEARCHING] },
              },
              data: {
                status: TvEpisodeStatus.DOWNLOADING,
                downloadId: download.id,
              },
            });
          } else {
            // No season number found - mark all PENDING/SEARCHING episodes (fallback)
            console.warn(
              `[DownloadStep] No season number found in torrent name: ${download.torrentName}`
            );
            await prisma.tvEpisode.updateMany({
              where: {
                requestId,
                status: { in: [TvEpisodeStatus.PENDING, TvEpisodeStatus.SEARCHING] },
              },
              data: {
                status: TvEpisodeStatus.DOWNLOADING,
                downloadId: download.id,
              },
            });
          }
        }
      }
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

    // Handle movie vs TV show differently
    if (mediaType === MediaType.MOVIE) {
      // Movie: Get single main video file
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
    } else {
      // TV: Extract all episode files from season pack
      const episodeFiles = await this.extractEpisodeFiles(torrentHash, requestId);

      if (episodeFiles.length === 0) {
        await prisma.download.update({
          where: { id: downloadId },
          data: {
            status: DownloadStatus.FAILED,
            failureReason: "No episode files found in season pack",
          },
        });

        return {
          success: false,
          shouldRetry: false,
          nextStep: null,
          error: "No episode files found in season pack",
        };
      }

      await this.logActivity(
        requestId,
        ActivityType.SUCCESS,
        `Extracted ${episodeFiles.length} episodes from season pack`
      );

      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          progress: 50,
          currentStep: `Download complete (${episodeFiles.length} episodes)`,
          currentStepStartedAt: new Date(),
        },
      });

      return {
        success: true,
        nextStep: "encode",
        data: {
          download: {
            torrentHash,
            episodeFiles,
            downloadedAt: new Date().toISOString(),
          },
        },
      };
    }
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

  /**
   * Extract all episode files from a season pack torrent
   * Maps files to existing TvEpisode records created during request creation
   */
  private async extractEpisodeFiles(
    torrentHash: string,
    requestId: string
  ): Promise<
    Array<{ season: number; episode: number; path: string; size: number; episodeId: string }>
  > {
    const qb = getDownloadService();
    const progress = await qb.getProgress(torrentHash);

    if (!progress) return [];

    const files = await qb.getTorrentFiles(torrentHash);
    if (files.length === 0) return [];

    // Filter to video files only
    const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
    const minSizeBytes = 100 * 1024 * 1024; // 100MB

    const videoFiles = files.filter(
      (f) =>
        videoExtensions.some((ext) => f.name.toLowerCase().endsWith(ext)) &&
        !isSampleFile(f.name) &&
        f.size >= minSizeBytes
    );

    const episodeFiles: Array<{
      season: number;
      episode: number;
      path: string;
      size: number;
      episodeId: string;
    }> = [];

    // Get download record
    const download = await prisma.download.findFirst({
      where: { torrentHash },
    });

    if (!download) {
      throw new Error(`Download not found for torrent ${torrentHash}`);
    }

    // Parse each file for S##E## pattern
    const episodeRegex = /S(\d{1,2})E(\d{1,2})/i;

    for (const file of videoFiles) {
      const match = file.name.match(episodeRegex);

      if (!match) {
        console.warn(`[DownloadStep] Could not parse episode info from: ${file.name}`);
        continue;
      }

      const season = Number.parseInt(match[1], 10);
      const episode = Number.parseInt(match[2], 10);
      const fullPath = `${progress.savePath}/${file.name}`;

      // Find existing TvEpisode record (created during request creation)
      let tvEpisode = await prisma.tvEpisode.findUnique({
        where: {
          requestId_season_episode: {
            requestId,
            season,
            episode,
          },
        },
      });

      // If TvEpisode doesn't exist (e.g., Trakt API failed during request creation),
      // create it now so the episode can be tracked
      if (!tvEpisode) {
        console.log(
          `[DownloadStep] Creating missing TvEpisode record for S${season}E${episode} in request ${requestId}`
        );
        tvEpisode = await prisma.tvEpisode.create({
          data: {
            requestId,
            season,
            episode,
            status: TvEpisodeStatus.PENDING,
          },
        });
      }

      // Skip episode if it's already completed or delivered
      if (
        tvEpisode.status === TvEpisodeStatus.COMPLETED ||
        tvEpisode.status === TvEpisodeStatus.SKIPPED
      ) {
        console.log(
          `[DownloadStep] Skipping S${season}E${episode} - already ${tvEpisode.status.toLowerCase()}`
        );
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Skipped S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} - already on storage server`,
          { season, episode, status: tvEpisode.status }
        );
        continue;
      }

      // Update TvEpisode with download info
      await prisma.tvEpisode.update({
        where: { id: tvEpisode.id },
        data: {
          downloadId: download.id,
          sourceFilePath: fullPath,
          status: TvEpisodeStatus.DOWNLOADED,
          downloadedAt: new Date(),
        },
      });

      episodeFiles.push({
        season,
        episode,
        path: fullPath,
        size: file.size,
        episodeId: tvEpisode.id,
      });

      await this.logActivity(
        requestId,
        ActivityType.INFO,
        `Found episode S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}: ${file.name}`,
        { season, episode, size: file.size }
      );
    }

    // Sort by season then episode
    episodeFiles.sort((a, b) => {
      if (a.season !== b.season) return a.season - b.season;
      return a.episode - b.episode;
    });

    console.log(
      `[DownloadStep] Extracted ${episodeFiles.length} episodes from ${videoFiles.length} video files`
    );

    return episodeFiles;
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
