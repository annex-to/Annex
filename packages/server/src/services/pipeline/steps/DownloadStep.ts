import {
  ActivityType,
  DownloadStatus,
  MediaType,
  ProcessingStatus,
  StepType,
} from "@prisma/client";
import ptt from "parse-torrent-title";
import { prisma } from "../../../db/client.js";
import { detectRarArchive, extractRar, isSampleFile } from "../../archive.js";
import { getDownloadService } from "../../download.js";
import { downloadManager } from "../../downloadManager.js";
import type { Release } from "../../indexer.js";
import type { PipelineContext } from "../PipelineContext.js";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
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

  // Callback invoked immediately after Download record is created
  private downloadCreatedCallback?: (downloadId: string, torrentHash: string) => Promise<void>;

  // Set callback for when download is created
  setDownloadCreatedCallback(
    callback: (downloadId: string, torrentHash: string) => Promise<void>
  ): void {
    this.downloadCreatedCallback = callback;
  }

  validateConfig(config: unknown): void {
    if (config !== undefined && typeof config !== "object") {
      throw new Error("DownloadStep config must be an object");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as DownloadStepConfig | undefined) || {};

    const { requestId, mediaType, episodeId } = context;
    const pollInterval = cfg.pollInterval || 5000;
    const timeout = cfg.timeout || 24 * 60 * 60 * 1000; // 24 hours

    // Check if download already completed (recovery scenario from pipeline resume)
    if (context.download?.sourceFilePath) {
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        "Download already completed, skipping (recovered from restart)"
      );

      return {
        success: true,
        data: {
          download: context.download,
        },
      };
    }

    // For episode branch pipelines: Check if episode file is already extracted
    console.log(
      `[DownloadStep] Episode recovery check: episodeId=${episodeId}, mediaType=${mediaType}`
    );
    if (episodeId && mediaType === MediaType.TV) {
      const episode = await prisma.processingItem.findUnique({
        where: { id: episodeId as string },
        select: { sourceFilePath: true, season: true, episode: true },
      });

      console.log(
        `[DownloadStep] Episode ${episodeId} sourceFilePath: ${episode?.sourceFilePath || "null"}`
      );

      if (episode?.sourceFilePath && episode.season !== null && episode.episode !== null) {
        // File already extracted - skip download and proceed to encoding
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Episode S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")} already extracted, proceeding to encoding`
        );

        return {
          success: true,
          data: {
            download: {
              sourceFilePath: episode.sourceFilePath,
              downloadedAt: new Date().toISOString(),
            },
          },
        };
      }
    }

    // Check if SearchStep was skipped (episodes already downloaded)
    // IMPORTANT: This must be checked BEFORE bulkDownloadsCreated to handle retries correctly
    const skippedSearch = (context.search as { skippedSearch?: boolean })?.skippedSearch;
    if (skippedSearch && mediaType === MediaType.TV) {
      // Episodes are already DOWNLOADED - extract files and continue to encoding
      const downloadedEpisodes = await prisma.processingItem.findMany({
        where: {
          requestId,
          type: "EPISODE",
          status: {
            in: [ProcessingStatus.DOWNLOADED, ProcessingStatus.ENCODING, ProcessingStatus.ENCODED],
          },
        },
        select: {
          season: true,
          episode: true,
          sourceFilePath: true,
          id: true,
        },
      });

      if (downloadedEpisodes.length === 0) {
        return {
          success: false,
          shouldRetry: false,
          nextStep: null,
          error: "No downloaded episodes found",
        };
      }

      await this.logActivity(
        requestId,
        ActivityType.INFO,
        `Found ${downloadedEpisodes.length} downloaded episodes ready for delivery`
      );

      // DeliverWorker will automatically pick up ENCODED items
      // No manual queuing needed with new pipeline system

      // Return success - episodes ready for delivery
      return {
        success: true,
        nextStep: null,
        data: {
          download: {
            episodesQueued: true,
            queuedCount: downloadedEpisodes.length,
          },
        },
      };
    }

    // Check if SearchStep already created downloads in bulk (TV multi-episode mode)
    const bulkDownloadsCreated = (context.search as { bulkDownloadsCreated?: boolean })
      ?.bulkDownloadsCreated;
    if (bulkDownloadsCreated) {
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        "Multiple episodes downloading in parallel - will encode/deliver each as it completes"
      );

      // Status/progress now handled by ProcessingItem

      // End pipeline - episodes will be processed individually via download monitor
      return {
        success: true,
        nextStep: null, // End pipeline, download monitor will handle per-episode processing
        data: {},
      };
    }

    // Check if SearchStep selected multiple season packs for bulk download
    const bulkDownloadsForSeasonPacks = (
      context.search as { bulkDownloadsForSeasonPacks?: boolean }
    )?.bulkDownloadsForSeasonPacks;
    const selectedPacks = (
      context.search as { selectedPacks?: Array<{ season: number; release: Release }> }
    )?.selectedPacks;

    if (bulkDownloadsForSeasonPacks && selectedPacks && selectedPacks.length > 0) {
      // Create downloads for all season packs in parallel
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        `Creating downloads for ${selectedPacks.length} season pack(s)`
      );

      const downloadPromises = selectedPacks.map((pack) =>
        downloadManager.createDownload({
          requestId,
          mediaType: mediaType as MediaType,
          release: pack.release,
          alternativeReleases: undefined,
        })
      );

      await Promise.all(downloadPromises);

      await this.logActivity(
        requestId,
        ActivityType.SUCCESS,
        `Started ${selectedPacks.length} season pack download(s) - will extract episodes when complete`
      );

      // Return success - download monitor will handle extraction and branch spawning
      return {
        success: true,
        nextStep: null, // Download monitor will spawn branches after extraction
        data: {
          search: {
            bulkDownloadsCreated: true,
            downloadCount: selectedPacks.length,
          },
        },
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

      // Notify that download record is created (set downloadId on ProcessingItem immediately)
      if (this.downloadCreatedCallback) {
        await this.downloadCreatedCallback(downloadId, torrentHash);
      }

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

          // sourceFilePath is returned in step context, no need to store in MediaRequest

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

        // Status/error now handled by ProcessingItem
        // selectedRelease clearing now handled by stepContext

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

      // Notify that download record is created (set downloadId on ProcessingItem immediately)
      if (this.downloadCreatedCallback) {
        await this.downloadCreatedCallback(downloadId, torrentHash);
      }

      // For TV shows, mark episodes as DOWNLOADING
      if (mediaType === MediaType.TV) {
        // Parse torrent name to get season/episode info
        const parsed = ptt.parse(download.torrentName);

        if (parsed.episode !== undefined) {
          // Individual episode(s) - mark specific episodes as DOWNLOADING
          const episodes = Array.isArray(parsed.episode) ? parsed.episode : [parsed.episode];
          const season = parsed.season || 1;

          for (const episode of episodes) {
            const items = await prisma.processingItem.findMany({
              where: {
                requestId,
                type: "EPISODE",
                season,
                episode,
                status: { in: [ProcessingStatus.PENDING, ProcessingStatus.SEARCHING] },
              },
              select: { id: true },
            });

            for (const item of items) {
              await pipelineOrchestrator.transitionStatus(item.id, ProcessingStatus.DOWNLOADING, {
                currentStep: "downloading",
              });

              await prisma.processingItem.update({
                where: { id: item.id },
                data: { downloadId: download.id },
              });
            }
          }
        } else if (parsed.season !== undefined) {
          // Season pack - mark all episodes in this season as DOWNLOADING
          const items = await prisma.processingItem.findMany({
            where: {
              requestId,
              type: "EPISODE",
              season: parsed.season,
              status: { in: [ProcessingStatus.PENDING, ProcessingStatus.SEARCHING] },
            },
            select: { id: true },
          });

          for (const item of items) {
            await pipelineOrchestrator.transitionStatus(item.id, ProcessingStatus.DOWNLOADING, {
              currentStep: "downloading",
            });

            await prisma.processingItem.update({
              where: { id: item.id },
              data: { downloadId: download.id },
            });
          }
        } else {
          // No season/episode info found - mark all PENDING/SEARCHING episodes (fallback)
          console.warn(
            `[DownloadStep] No season/episode info found in torrent name: ${download.torrentName}`
          );

          const items = await prisma.processingItem.findMany({
            where: {
              requestId,
              type: "EPISODE",
              status: { in: [ProcessingStatus.PENDING, ProcessingStatus.SEARCHING] },
            },
            select: { id: true },
          });

          for (const item of items) {
            await pipelineOrchestrator.transitionStatus(item.id, ProcessingStatus.DOWNLOADING, {
              currentStep: "downloading",
            });

            await prisma.processingItem.update({
              where: { id: item.id },
              data: { downloadId: download.id },
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

    // Status/progress now handled by ProcessingItem

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

        // Progress now handled by ProcessingItem
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
      // Progress now handled by ProcessingItem

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

            // sourceFilePath is returned in step context, no need to store in MediaRequest
            // Progress now handled by ProcessingItem

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

      // sourceFilePath is returned in step context, no need to store in MediaRequest
      // Progress now handled by ProcessingItem

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

      // Progress now handled by ProcessingItem

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
   * Maps files to existing ProcessingItem records created during request creation
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

      // Find existing ProcessingItem record (created during request creation)
      let processingItem = await prisma.processingItem.findFirst({
        where: {
          requestId,
          type: "EPISODE",
          season,
          episode,
        },
      });

      // If ProcessingItem doesn't exist (e.g., Trakt API failed during request creation),
      // create it now so the episode can be tracked
      if (!processingItem) {
        console.log(
          `[DownloadStep] Creating missing ProcessingItem record for S${season}E${episode} in request ${requestId}`
        );
        const request = await prisma.mediaRequest.findUnique({
          where: { id: requestId },
          select: { tmdbId: true, title: true, year: true },
        });
        processingItem = await prisma.processingItem.create({
          data: {
            requestId,
            type: "EPISODE",
            tmdbId: request?.tmdbId,
            title: `S${season}E${episode}`,
            year: request?.year,
            season,
            episode,
            status: ProcessingStatus.PENDING,
          },
        });
      }

      // Skip episode if it's already completed or cancelled
      if (
        processingItem.status === ProcessingStatus.COMPLETED ||
        processingItem.status === ProcessingStatus.CANCELLED
      ) {
        console.log(
          `[DownloadStep] Skipping S${season}E${episode} - already ${processingItem.status.toLowerCase()}`
        );
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Skipped S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} - already on storage server`,
          { season, episode, status: processingItem.status }
        );
        continue;
      }

      // Get existing stepContext
      const existingContext = (processingItem.stepContext as Record<string, unknown>) || {};

      // Build download context for this episode
      const downloadContext: PipelineContext["download"] = {
        torrentHash,
        sourceFilePath: fullPath,
        size: file.size,
      };

      // Merge with existing context
      const newStepContext = {
        ...existingContext,
        download: downloadContext,
      };

      // Update ProcessingItem with download info using orchestrator
      await pipelineOrchestrator.transitionStatus(processingItem.id, ProcessingStatus.DOWNLOADED, {
        currentStep: "download",
        stepContext: newStepContext,
        downloadId: download.id,
      });

      // Update additional fields not handled by orchestrator
      await prisma.processingItem.update({
        where: { id: processingItem.id },
        data: {
          sourceFilePath: fullPath,
          downloadedAt: new Date(),
        },
      });

      episodeFiles.push({
        season,
        episode,
        path: fullPath,
        size: file.size,
        episodeId: processingItem.id,
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
}
