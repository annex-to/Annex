import {
  ActivityType,
  MediaType,
  Prisma,
  RequestStatus,
  StepType,
  TvEpisodeStatus,
} from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDeliveryService } from "../../delivery.js";
import { getNamingService } from "../../naming.js";
import type { PipelineContext } from "../PipelineContext.js";
import { BaseStep, type StepOutput } from "./BaseStep.js";

interface DeliverStepConfig {
  requireAllServersSuccess?: boolean;
}

/**
 * Deliver Step - Transfer encoded files to storage servers
 *
 * Inputs:
 * - requestId, mediaType, tmdbId, title, year, targets
 * - encode.encodedFiles: Array of encoded files with their target servers
 *
 * Outputs:
 * - deliver.deliveredServers: Array of server IDs that received the file
 * - deliver.failedServers: Array of server IDs that failed
 * - deliver.completedAt: Timestamp of delivery completion
 *
 * Side effects:
 * - Transfers files to remote servers via SFTP/rsync/SMB
 * - Triggers media server library scans
 * - Creates LibraryItem records
 * - Updates MediaRequest status and progress
 * - Cleans up temporary encoded files
 */
export class DeliverStep extends BaseStep {
  readonly type = StepType.DELIVER;

  validateConfig(config: unknown): void {
    if (config !== undefined && typeof config !== "object") {
      throw new Error("DeliverStep config must be an object");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = (config as DeliverStepConfig | undefined) || {};

    const { requestId, mediaType, tmdbId, title, year } = context;
    const encodedFiles = context.encode?.encodedFiles;

    if (!encodedFiles || !Array.isArray(encodedFiles) || encodedFiles.length === 0) {
      return {
        success: false,
        shouldRetry: false,
        nextStep: null,
        error: "No encoded files available for delivery",
      };
    }

    // Check if delivery already completed (recovery scenario)
    // Verify that files exist on all target servers
    const delivery = getDeliveryService();
    const naming = getNamingService();
    let allFilesExist = true;
    const recoveredServers: string[] = [];

    for (const encodedFile of encodedFiles) {
      const {
        path: encodedFilePath,
        resolution,
        codec,
        targetServerIds,
        season,
        episode,
      } = encodedFile as {
        path: string;
        profileId: string;
        resolution: string;
        codec: string;
        targetServerIds: string[];
        season?: number;
        episode?: number;
      };

      const servers = await prisma.storageServer.findMany({
        where: { id: { in: targetServerIds } },
      });

      const container = encodedFilePath.split(".").pop() || "mkv";

      for (const server of servers) {
        let remotePath: string;

        if (mediaType === MediaType.MOVIE) {
          remotePath = naming.getMovieDestinationPath(server.pathMovies, {
            title,
            year,
            quality: resolution,
            codec,
            container,
          });
        } else {
          // TV show - use actual episode metadata
          if (season === undefined || episode === undefined) {
            throw new Error("Missing season/episode metadata for TV recovery check");
          }

          remotePath = naming.getTvDestinationPath(server.pathTv, {
            series: title,
            year,
            season,
            episode,
            quality: resolution,
            codec,
            container,
          });
        }

        const fileExists = await delivery.fileExists(server.id, remotePath);
        if (fileExists) {
          recoveredServers.push(server.id);
        } else {
          allFilesExist = false;
        }
      }
    }

    // If all files already exist on all servers, skip delivery and just create records
    if (allFilesExist && recoveredServers.length > 0) {
      await this.logActivity(
        requestId,
        ActivityType.INFO,
        "Files already delivered to all servers, skipping delivery (recovered from restart)"
      );

      // Create LibraryItem records for all servers
      for (const encodedFile of encodedFiles) {
        const { resolution, codec, targetServerIds } = encodedFile as {
          path: string;
          profileId: string;
          resolution: string;
          codec: string;
          targetServerIds: string[];
        };

        for (const serverId of targetServerIds) {
          await prisma.libraryItem.upsert({
            where: {
              tmdbId_type_serverId: {
                tmdbId,
                type: mediaType as MediaType,
                serverId,
              },
            },
            create: {
              tmdbId,
              type: mediaType as MediaType,
              serverId,
              quality: `${resolution} ${codec}`,
              addedAt: new Date(),
            },
            update: {
              quality: `${resolution} ${codec}`,
              syncedAt: new Date(),
            },
          });
        }
      }

      // Mark request as completed
      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.COMPLETED,
          progress: 100,
          currentStep: null,
          currentStepStartedAt: new Date(),
          error: null,
          completedAt: new Date(),
        },
      });

      await this.logActivity(
        requestId,
        ActivityType.SUCCESS,
        "Request completed successfully (recovered)"
      );

      return {
        success: true,
        nextStep: null,
        data: {
          deliver: {
            deliveredServers: recoveredServers,
            failedServers: [],
            completedAt: new Date().toISOString(),
            recovered: true,
          },
        },
      };
    }

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.DELIVERING,
        progress: 75,
        currentStep: "Preparing for delivery...",
        currentStepStartedAt: new Date(),
      },
    });

    const deliveredServers: string[] = [];
    const failedServers: string[] = [];

    // Process each encoded file
    for (const encodedFile of encodedFiles) {
      const {
        path: encodedFilePath,
        resolution,
        codec,
        targetServerIds,
        season,
        episode,
        episodeId,
      } = encodedFile as {
        path: string;
        profileId: string;
        resolution: string;
        codec: string;
        targetServerIds: string[];
        season?: number;
        episode?: number;
        episodeId?: string;
      };

      const servers = await prisma.storageServer.findMany({
        where: { id: { in: targetServerIds } },
      });

      const container = encodedFilePath.split(".").pop() || "mkv";
      let serverIndex = 0;

      for (const server of servers) {
        let remotePath: string;
        let displayName: string;

        if (mediaType === MediaType.MOVIE) {
          remotePath = naming.getMovieDestinationPath(server.pathMovies, {
            title,
            year,
            quality: resolution,
            codec,
            container,
          });
          displayName = `${title} (${year})`;
        } else {
          // TV show - use actual episode metadata
          if (season === undefined || episode === undefined) {
            throw new Error("Missing season/episode metadata for TV delivery");
          }

          remotePath = naming.getTvDestinationPath(server.pathTv, {
            series: title,
            year,
            season,
            episode,
            quality: resolution,
            codec,
            container,
          });
          displayName = `${title} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
        }

        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Delivering ${displayName} to ${server.name}: ${remotePath}`
        );

        // Mark episode as DELIVERING if this is a TV episode
        if (episodeId) {
          await prisma.tvEpisode.update({
            where: { id: episodeId },
            data: { status: TvEpisodeStatus.DELIVERING },
          });
        }

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            progress: 75 + (serverIndex / servers.length) * 20,
            currentStep: `Transferring ${displayName} to ${server.name}...`,
            currentStepStartedAt: new Date(),
          },
        });

        const result = await delivery.deliver(server.id, encodedFilePath, remotePath, {
          onProgress: async (progress) => {
            const stageProgress =
              75 + ((serverIndex + progress.progress / 100) / servers.length) * 20;
            const speed = `${this.formatBytes(progress.speed)}/s`;
            const eta = progress.eta > 0 ? `ETA: ${this.formatDuration(progress.eta)}` : "";

            // Don't update currentStepStartedAt on progress updates - timestamp was set when
            // we started transferring to this server (line 262)
            await prisma.mediaRequest.update({
              where: { id: requestId },
              data: {
                progress: stageProgress,
                currentStep: `${server.name}: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`,
              },
            });
          },
        });

        if (result.success) {
          deliveredServers.push(server.id);
          await this.logActivity(
            requestId,
            ActivityType.SUCCESS,
            `Delivered ${displayName} to ${server.name} in ${this.formatDuration(result.duration)}`,
            {
              server: server.name,
              bytesTransferred: result.bytesTransferred,
              duration: result.duration,
              libraryScanTriggered: result.libraryScanTriggered,
            }
          );

          // Update TvEpisode status if this is a TV episode
          if (episodeId) {
            await prisma.tvEpisode.update({
              where: { id: episodeId },
              data: {
                status: TvEpisodeStatus.COMPLETED,
                deliveredAt: new Date(),
              },
            });
          }

          // Add to library cache
          await prisma.libraryItem.upsert({
            where: {
              tmdbId_type_serverId: {
                tmdbId,
                type: mediaType as MediaType,
                serverId: server.id,
              },
            },
            create: {
              tmdbId,
              type: mediaType as MediaType,
              serverId: server.id,
              quality: `${resolution} ${codec}`,
              addedAt: new Date(),
            },
            update: {
              quality: `${resolution} ${codec}`,
              syncedAt: new Date(),
            },
          });
        } else {
          failedServers.push(server.id);

          // Update TvEpisode status if this is a TV episode
          if (episodeId) {
            await prisma.tvEpisode.update({
              where: { id: episodeId },
              data: {
                status: "FAILED" as never,
                error: result.error,
              },
            });
          }

          await this.logActivity(
            requestId,
            ActivityType.ERROR,
            `Failed to deliver ${displayName} to ${server.name}: ${result.error}`
          );
        }

        serverIndex++;
      }
    }

    // Determine overall success
    const requireAllSuccess = cfg.requireAllServersSuccess !== false;
    const success = requireAllSuccess ? failedServers.length === 0 : deliveredServers.length > 0;

    if (success) {
      // For TV shows, check if all episodes are complete before marking request done
      let allEpisodesComplete = true;
      let remainingEpisodes = 0;

      if (mediaType === MediaType.TV) {
        const episodeStats = await prisma.tvEpisode.groupBy({
          by: ["status"],
          where: { requestId },
          _count: { status: true },
        });

        const totalEpisodes = episodeStats.reduce((sum, stat) => sum + stat._count.status, 0);
        const completedEpisodes = episodeStats
          .filter(
            (stat) =>
              stat.status === TvEpisodeStatus.COMPLETED || stat.status === TvEpisodeStatus.SKIPPED
          )
          .reduce((sum, stat) => sum + stat._count.status, 0);

        remainingEpisodes = totalEpisodes - completedEpisodes;
        allEpisodesComplete = remainingEpisodes === 0;

        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Episode progress: ${completedEpisodes}/${totalEpisodes} complete`,
          { completedEpisodes, totalEpisodes, remainingEpisodes }
        );
      }

      if (allEpisodesComplete) {
        // All episodes done (or this is a movie) - mark request as complete
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: RequestStatus.COMPLETED,
            progress: 100,
            currentStep: null,
            currentStepStartedAt: new Date(),
            error: null,
            completedAt: new Date(),
          },
        });

        await this.logActivity(requestId, ActivityType.SUCCESS, "Request completed successfully");
      } else {
        // More episodes needed - reset to pending to search for remaining episodes
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: RequestStatus.PENDING,
            progress: 50,
            currentStep: `${remainingEpisodes} episode${remainingEpisodes !== 1 ? "s" : ""} remaining`,
            currentStepStartedAt: new Date(),
            error: null,
            // Clear selected release to force new search
            selectedRelease: Prisma.JsonNull,
          },
        });

        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Delivered episode(s), ${remainingEpisodes} more needed - continuing search`
        );

        // Restart pipeline execution for remaining episodes
        const execution = await prisma.pipelineExecution.findFirst({
          where: { requestId, parentExecutionId: null },
          orderBy: { startedAt: "desc" },
        });

        if (execution) {
          const { getPipelineExecutor } = await import("../PipelineExecutor.js");
          const executor = getPipelineExecutor();
          // Schedule continuation after a brief delay to allow current execution to complete
          setTimeout(() => {
            executor.startExecution(requestId, execution.templateId).catch((error) => {
              console.error(`Failed to continue pipeline for request ${requestId}:`, error);
            });
          }, 2000);
        }
      }

      // Clean up encoded files (keep source files for seeding)
      for (const encodedFile of encodedFiles) {
        const encodedPath = (encodedFile as { path: string }).path;
        try {
          await Bun.file(encodedPath)
            .exists()
            .then((exists) => {
              if (exists) {
                return Bun.file(encodedPath).delete();
              }
            });
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `Cleaned up encoded file: ${encodedPath}`
          );
        } catch (err) {
          // Log but don't fail delivery on cleanup errors
          await this.logActivity(
            requestId,
            ActivityType.WARNING,
            `Failed to clean up encoded file: ${err instanceof Error ? err.message : "Unknown error"}`
          );
        }
      }

      return {
        success: true,
        nextStep: null,
        data: {
          deliveredServers,
          failedServers,
          completedAt: new Date().toISOString(),
        },
      };
    } else {
      const error =
        deliveredServers.length === 0
          ? "Failed to deliver to all servers"
          : `Delivered to ${deliveredServers.length} servers, failed ${failedServers.length}`;

      if (deliveredServers.length > 0) {
        // Partial success
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: RequestStatus.COMPLETED,
            progress: 100,
            currentStep: error,
            currentStepStartedAt: new Date(),
            completedAt: new Date(),
          },
        });
      } else {
        // Total failure - update request to FAILED
        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: RequestStatus.FAILED,
            error,
            completedAt: new Date(),
          },
        });

        await this.logActivity(requestId, ActivityType.ERROR, `Delivery failed: ${error}`);
      }

      return {
        success: deliveredServers.length > 0,
        shouldRetry: failedServers.length > 0,
        nextStep: null,
        error,
        data: {
          deliveredServers,
          failedServers,
        },
      };
    }
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
