import {
  ActivityType,
  MediaType,
  Prisma,
  ProcessingStatus,
  RequestStatus,
  StepType,
} from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getDeliveryService } from "../../delivery.js";
import { getNamingService } from "../../naming.js";
import type { PipelineContext } from "../PipelineContext.js";
import { pipelineOrchestrator } from "../PipelineOrchestrator.js";
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
    const processingItemId = (context as { processingItemId?: string }).processingItemId;

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
            tmdbId,
            quality: resolution,
            codec,
            container,
          });
        } else {
          // TV show - use actual episode metadata
          if (season === undefined || episode === undefined) {
            throw new Error("Missing season/episode metadata for TV recovery check");
          }

          // Extract episode title from encodedFile
          const episodeTitle = (encodedFile as { episodeTitle?: string }).episodeTitle;

          remotePath = naming.getTvDestinationPath(server.pathTv, {
            series: title,
            year,
            season,
            episode,
            episodeTitle,
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
    const failedServers: Array<{ serverId: string; serverName: string; error: string }> = [];

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
            tmdbId,
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

          // Extract episode title from encodedFile
          const episodeTitle = (encodedFile as { episodeTitle?: string }).episodeTitle;

          remotePath = naming.getTvDestinationPath(server.pathTv, {
            series: title,
            year,
            season,
            episode,
            episodeTitle,
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
            const speed = `${this.formatBytes(progress.speed)}/s`;
            const eta = progress.eta > 0 ? `ETA: ${this.formatDuration(progress.eta)}` : "";
            const progressMessage = `${server.name}: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`;

            // Update ProcessingItem progress (works for both movies and TV episodes)
            const itemId = episodeId || processingItemId;
            if (itemId) {
              try {
                await prisma.processingItem.update({
                  where: { id: itemId },
                  data: {
                    progress: progress.progress,
                    currentStep: progressMessage,
                  },
                });
              } catch (error) {
                // Silently ignore P2025 (record not found) - acceptable during delivery
                if (
                  error instanceof Prisma.PrismaClientKnownRequestError &&
                  error.code === "P2025"
                ) {
                  return;
                }
                // Re-throw other errors
                throw error;
              }
            }
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

          // Update deliveredAt timestamp if this is a TV episode
          if (episodeId) {
            await prisma.processingItem.update({
              where: { id: episodeId },
              data: {
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
          failedServers.push({
            serverId: server.id,
            serverName: server.name,
            error: result.error || "Unknown error",
          });

          // Don't update episode status here - will be handled at the end based on retry decision

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
      let inProgressEpisodes = 0;

      if (mediaType === MediaType.TV) {
        const episodeStats = await prisma.processingItem.groupBy({
          by: ["status"],
          where: { requestId, type: "EPISODE" },
          _count: { status: true },
        });

        const totalEpisodes = episodeStats.reduce(
          (sum: number, stat: { _count: { status: number } }) => sum + stat._count.status,
          0
        );
        const completedEpisodes = episodeStats
          .filter(
            (stat: { status: ProcessingStatus }) =>
              stat.status === ProcessingStatus.COMPLETED ||
              stat.status === ProcessingStatus.CANCELLED
          )
          .reduce(
            (sum: number, stat: { _count: { status: number } }) => sum + stat._count.status,
            0
          );

        remainingEpisodes = totalEpisodes - completedEpisodes;
        allEpisodesComplete = remainingEpisodes === 0;

        // Check if remaining episodes are in-progress (any non-terminal status) or need searching
        // Count all statuses except terminal ones (COMPLETED, FAILED, CANCELLED)
        inProgressEpisodes = episodeStats
          .filter(
            (stat: { status: ProcessingStatus }) =>
              stat.status !== ProcessingStatus.COMPLETED &&
              stat.status !== ProcessingStatus.FAILED &&
              stat.status !== ProcessingStatus.CANCELLED
          )
          .reduce(
            (sum: number, stat: { _count: { status: number } }) => sum + stat._count.status,
            0
          );

        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Episode progress: ${completedEpisodes}/${totalEpisodes} complete, ${inProgressEpisodes} in progress`,
          { completedEpisodes, totalEpisodes, remainingEpisodes, inProgressEpisodes }
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
        // Check if remaining episodes are in-progress or need to be searched for
        const needsSearch = remainingEpisodes > inProgressEpisodes;

        if (needsSearch) {
          // More episodes needed - reset to pending to search for remaining episodes
          await prisma.mediaRequest.update({
            where: { id: requestId },
            data: {
              status: RequestStatus.PENDING,
              progress: 50,
              currentStep: `${remainingEpisodes - inProgressEpisodes} episode${remainingEpisodes - inProgressEpisodes !== 1 ? "s" : ""} needed`,
              currentStepStartedAt: new Date(),
              error: null,
              // Clear selected release to force new search
              selectedRelease: Prisma.JsonNull,
            },
          });

          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `Delivered episode(s), ${remainingEpisodes - inProgressEpisodes} more needed - continuing search`
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
        } else {
          // All remaining episodes are in progress (encoding/delivering) - just wait for them
          await this.logActivity(
            requestId,
            ActivityType.INFO,
            `Delivered episode(s), ${inProgressEpisodes} more in progress (will complete shortly)`
          );
        }
      }

      // Clean up encoded files ONLY on complete success (keep source files for seeding)
      // Only delete if ALL servers succeeded - this prevents deleting files that may be
      // needed for retry when partial delivery fails or when adding to additional servers
      if (failedServers.length === 0) {
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
      } else {
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Preserving encoded files for retry (${failedServers.length} server(s) failed delivery)`
        );
      }

      return {
        success: true,
        nextStep: null,
        data: {
          deliver: {
            deliveredServers,
            failedServers,
            completedAt: new Date().toISOString(),
          },
        },
      };
    } else {
      // Build detailed error message with actual failure reasons
      const errorDetails = failedServers.map((f) => `${f.serverName}: ${f.error}`).join("; ");

      const error =
        deliveredServers.length === 0
          ? `Failed to deliver to all servers - ${errorDetails}`
          : `Delivered to ${deliveredServers.length} servers, failed ${failedServers.length} - ${errorDetails}`;

      if (deliveredServers.length > 0) {
        // Partial success - log as warning since some servers failed
        await this.logActivity(
          requestId,
          ActivityType.WARNING,
          `Partial delivery success: ${deliveredServers.length} succeeded, ${failedServers.length} failed`
        );
        await this.logActivity(
          requestId,
          ActivityType.INFO,
          `Encoded files preserved for retry to failed servers`
        );

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
        await this.logActivity(requestId, ActivityType.ERROR, `Delivery failed: ${error}`);
        await this.logActivity(requestId, ActivityType.INFO, `Encoded files preserved for retry`);

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            status: RequestStatus.FAILED,
            error,
            completedAt: new Date(),
          },
        });
      }

      // Update episode status if delivery failed completely
      // Mark as FAILED if no servers succeeded (even if we plan to retry, since retry mechanism
      // will need to detect and resume FAILED episodes with DELIVERING pipelines)
      if (deliveredServers.length === 0) {
        for (const encodedFile of encodedFiles) {
          const { episodeId } = encodedFile as { episodeId?: string };
          if (episodeId) {
            await pipelineOrchestrator.transitionStatus(episodeId, ProcessingStatus.FAILED, {
              currentStep: "delivery_failed",
              error,
            });
          }
        }
      }

      return {
        success: deliveredServers.length > 0,
        shouldRetry: failedServers.length > 0,
        nextStep: null,
        error,
        data: {
          deliver: {
            deliveredServers,
            failedServers: failedServers.map((f) => f.serverId),
            completedAt: new Date().toISOString(),
          },
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
