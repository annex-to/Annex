/**
 * Request Processing Pipeline (Movies)
 *
 * Orchestrates the complete media acquisition pipeline for movies:
 * PENDING → SEARCHING → DOWNLOADING → ENCODING → DELIVERING → COMPLETED
 *
 * Uses the job queue for each stage to ensure persistence and crash recovery.
 * Supports per-server encoding profiles for flexible quality targeting.
 *
 * Key features:
 * - qBittorrent matching to reuse existing downloads
 * - Quality profile-based release selection
 * - Automatic retry with alternative releases
 * - Robust health monitoring
 */

import { prisma } from "../db/client.js";
import { getJobQueueService, type JobType } from "./jobQueue.js";
import { getIndexerService, type Release } from "./indexer.js";
import { getDownloadService } from "./download.js";
import { getEncodingService } from "./encoding.js";
import { getDeliveryService } from "./delivery.js";
import { getNamingService } from "./naming.js";
import { getTMDBService } from "./tmdb.js";
import { getEncoderDispatchService } from "./encoderDispatch.js";
import {
  downloadManager,
  rankReleases,
} from "./downloadManager.js";
import {
  deriveRequiredResolution,
  filterReleasesByQuality,
  rankReleasesWithQualityFilter,
  releasesToStorageFormat,
  getBestAvailableResolution,
  getResolutionLabel,
  resolutionMeetsRequirement,
  type RequestTarget as QualityRequestTarget,
} from "./qualityService.js";
import {
  detectRarArchive,
  extractRar,
  isSampleFile,
} from "./archive.js";
import { RequestStatus, MediaType, ActivityType, DownloadStatus, TvEpisodeStatus, Prisma, type MediaRequest, type StorageServer, type EncodingProfile, type Download } from "@prisma/client";

// =============================================================================
// Types
// =============================================================================

/**
 * Target specification from MediaRequest.targets JSON field
 */
export interface RequestTarget {
  serverId: string;
  encodingProfileId?: string;
}

export interface PipelinePayload {
  requestId: string;
}

export interface SearchPayload extends PipelinePayload {
  // Additional search options
}

export interface MovieDownloadPayload extends PipelinePayload {
  downloadId: string;
}

export interface EncodePayload extends PipelinePayload {
  downloadId: string;
  sourceFilePath: string;
}

export interface DeliverPayload extends PipelinePayload {
  encodedFilePath: string;
  profileId: string;
  resolution: string;
  codec: string;
  targetServerIds: string[];
}

// Legacy payload for backwards compatibility
export interface DownloadPayload extends PipelinePayload {
  release: Release;
}

// =============================================================================
// Activity Logging
// =============================================================================

async function logActivity(
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

// =============================================================================
// Request Status Updates
// =============================================================================

async function updateRequestStatus(
  requestId: string,
  status: RequestStatus,
  updates: {
    progress?: number;
    currentStep?: string | null;
    error?: string | null;
  } = {}
): Promise<void> {
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status,
      ...updates,
      completedAt: status === RequestStatus.COMPLETED ? new Date() : undefined,
    },
  });
}

/**
 * Get targets from request, parsing the JSON field
 */
function getRequestTargets(request: MediaRequest): RequestTarget[] {
  const targets = request.targets as unknown;
  if (!Array.isArray(targets)) return [];
  return targets as RequestTarget[];
}

// =============================================================================
// Pipeline Handlers
// =============================================================================

/**
 * Handle search stage: Find releases from indexers (with qBittorrent matching)
 */
async function handleSearch(payload: SearchPayload, jobId: string): Promise<void> {
  const { requestId } = payload;
  const jobQueue = getJobQueueService();

  // Check if cancelled
  if (jobQueue.isCancelled(jobId)) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Cancelled during search",
    });
    return;
  }

  // Get request details
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  // Only handle movies here - TV uses its own pipeline
  if (request.type !== MediaType.MOVIE) {
    console.log(`[Pipeline] Request ${requestId} is TV, routing to TV pipeline`);
    await jobQueue.addJob("tv:search" as JobType, { requestId }, { priority: 10, maxAttempts: 3 });
    return;
  }

  await updateRequestStatus(requestId, RequestStatus.SEARCHING, {
    progress: 5,
    currentStep: "Checking for existing downloads...",
  });

  await logActivity(requestId, ActivityType.INFO, "Starting search for movie");

  // =========================================================================
  // STEP 0: Derive quality requirements from target servers (needed for matching)
  // =========================================================================
  const targets = (request.targets as unknown as QualityRequestTarget[]) || [];
  const requiredResolution = await deriveRequiredResolution(targets);
  const resolutionLabel = getResolutionLabel(requiredResolution);

  // Save required resolution to request
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: { requiredResolution },
  });

  await logActivity(requestId, ActivityType.INFO, `Quality requirement: ${resolutionLabel} or better (derived from target servers)`);

  // =========================================================================
  // STEP 1: Check qBittorrent for existing download
  // =========================================================================
  const existingMatch = await downloadManager.findExistingMovieDownload(request.title, request.year);

  if (existingMatch.found && existingMatch.match) {
    // Check if existing download meets quality requirements
    const torrentName = existingMatch.match.torrent.name;
    const meetsQuality = resolutionMeetsRequirement(torrentName, requiredResolution);

    if (meetsQuality) {
      await logActivity(requestId, ActivityType.SUCCESS, `Found existing download in qBittorrent: ${torrentName}`);

      // Create Download record from existing torrent
      const download = await downloadManager.createDownloadFromExisting(
        requestId,
        MediaType.MOVIE,
        existingMatch.match,
        { isComplete: existingMatch.isComplete }
      );

      if (existingMatch.isComplete) {
        // Already complete - find video file and queue encoding
        const qb = getDownloadService();
        const videoFile = await qb.getMainVideoFile(download.torrentHash);

        if (videoFile) {
          await prisma.mediaRequest.update({
            where: { id: requestId },
            data: { sourceFilePath: videoFile.path },
          });

          await jobQueue.addJob("pipeline:encode" as JobType, {
            requestId,
            downloadId: download.id,
            sourceFilePath: videoFile.path,
          } as EncodePayload, { priority: 5, maxAttempts: 2 });
        } else {
          await updateRequestStatus(requestId, RequestStatus.FAILED, {
            error: "No video file found in existing download",
          });
        }
      } else {
        // In progress - queue download monitoring
        await jobQueue.addJob("pipeline:movie-download" as JobType, {
          requestId,
          downloadId: download.id,
        } as MovieDownloadPayload, { priority: 5, maxAttempts: 3 });
      }

      return;
    } else {
      // Existing download doesn't meet quality - log and continue searching
      await logActivity(
        requestId,
        ActivityType.WARNING,
        `Found existing download in qBittorrent but quality too low: ${torrentName} (need ${resolutionLabel})`
      );
    }
  }

  // =========================================================================
  // STEP 2: Search indexers for releases
  // =========================================================================
  await updateRequestStatus(requestId, RequestStatus.SEARCHING, {
    progress: 10,
    currentStep: "Searching indexers...",
  });

  const tmdb = getTMDBService();
  const details = await tmdb.getMovieDetails(request.tmdbId);
  const imdbId = details?.imdbId ?? undefined;

  const indexer = getIndexerService();
  const searchResult = await indexer.searchMovie({
    tmdbId: request.tmdbId,
    imdbId,
    title: request.title,
    year: request.year,
  });

  await logActivity(requestId, ActivityType.INFO, `Found ${searchResult.releases.length} releases from ${searchResult.indexersQueried} indexers`, {
    releasesFound: searchResult.releases.length,
    indexersQueried: searchResult.indexersQueried,
    indexersFailed: searchResult.indexersFailed,
  });

  // =========================================================================
  // STEP 3: Filter and rank releases by quality
  // =========================================================================
  if (searchResult.releases.length === 0) {
    await updateRequestStatus(requestId, RequestStatus.AWAITING, {
      progress: 0,
      currentStep: "Waiting for release availability",
      error: null,
    });
    await logActivity(requestId, ActivityType.WARNING, "No releases found - will retry automatically");
    return;
  }

  // Filter releases by quality requirement
  const { matching, belowQuality } = filterReleasesByQuality(
    searchResult.releases,
    requiredResolution
  );

  await logActivity(requestId, ActivityType.INFO,
    `Quality filter: ${matching.length} releases meet ${resolutionLabel} requirement, ${belowQuality.length} below threshold`
  );

  // If no releases meet quality requirements
  if (matching.length === 0) {
    if (belowQuality.length === 0) {
      // No releases at all (shouldn't happen due to earlier check, but just in case)
      await updateRequestStatus(requestId, RequestStatus.AWAITING, {
        progress: 0,
        currentStep: "Waiting for release availability",
        error: null,
      });
      await logActivity(requestId, ActivityType.WARNING, "No releases found - will retry automatically");
      return;
    }

    // Releases exist but none meet quality - store alternatives and mark as QUALITY_UNAVAILABLE
    const bestAvailable = getBestAvailableResolution(belowQuality);
    const storedAlternatives = releasesToStorageFormat(belowQuality.slice(0, 10));

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.QUALITY_UNAVAILABLE,
        availableReleases: storedAlternatives as unknown as Prisma.InputJsonValue,
        qualitySearchedAt: new Date(),
        progress: 0,
        currentStep: `No ${resolutionLabel} releases found (best: ${bestAvailable})`,
        error: null,
      },
    });

    await logActivity(
      requestId,
      ActivityType.WARNING,
      `Quality unavailable: wanted ${resolutionLabel}, best available is ${bestAvailable}. ${belowQuality.length} alternative(s) stored for manual selection.`,
      {
        requiredResolution,
        bestAvailable,
        alternativesCount: belowQuality.length,
      }
    );
    return;
  }

  // Rank matching releases by quality profile
  const { matching: rankedMatching } = rankReleasesWithQualityFilter(
    matching,
    requiredResolution,
    5
  );

  if (rankedMatching.length === 0) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "No suitable release found within quality constraints",
    });
    await logActivity(requestId, ActivityType.ERROR, "No releases meet quality profile requirements");
    return;
  }

  const bestRelease = rankedMatching[0].release;
  const alternatives = rankedMatching.slice(1).map((r) => r.release);

  await logActivity(requestId, ActivityType.SUCCESS, `Selected release: ${bestRelease.title}`, {
    release: {
      title: bestRelease.title,
      resolution: bestRelease.resolution,
      source: bestRelease.source,
      codec: bestRelease.codec,
      size: bestRelease.size,
      seeders: bestRelease.seeders,
      score: rankedMatching[0].score,
    },
  });

  // Save selected release to request
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      selectedRelease: bestRelease as unknown as Prisma.JsonObject,
      status: RequestStatus.SEARCHING,
      progress: 15,
      currentStep: `Selected: ${bestRelease.title}`,
    },
  });

  // =========================================================================
  // STEP 5: Create Download record and add to qBittorrent
  // =========================================================================
  const download = await downloadManager.createDownload({
    requestId,
    mediaType: MediaType.MOVIE,
    release: bestRelease,
    alternativeReleases: alternatives,
  });

  if (!download) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Failed to create download",
    });
    return;
  }

  // Queue download monitoring
  await jobQueue.addJob("pipeline:movie-download" as JobType, {
    requestId,
    downloadId: download.id,
  } as MovieDownloadPayload, { priority: 5, maxAttempts: 3 });
}

/**
 * Handle movie download monitoring - waits for download completion
 */
async function handleMovieDownload(payload: MovieDownloadPayload, jobId: string): Promise<void> {
  const { requestId, downloadId } = payload;
  const jobQueue = getJobQueueService();

  // Check if cancelled
  if (jobQueue.isCancelled(jobId)) {
    await prisma.download.update({
      where: { id: downloadId },
      data: { status: DownloadStatus.CANCELLED },
    });
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Cancelled during download",
    });
    return;
  }

  const download = await prisma.download.findUnique({
    where: { id: downloadId },
  });

  if (!download) {
    throw new Error(`Download not found: ${downloadId}`);
  }

  await updateRequestStatus(requestId, RequestStatus.DOWNLOADING, {
    progress: 20,
    currentStep: "Downloading...",
  });

  await logActivity(requestId, ActivityType.INFO, `Monitoring download: ${download.torrentName}`);

  const qb = getDownloadService();

  // Wait for download to complete
  const downloadResult = await qb.waitForCompletion(download.torrentHash, {
    pollInterval: 5000,
    timeout: 24 * 60 * 60 * 1000, // 24 hours
    onProgress: async (progress) => {
      // Update Download record
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

      const overallProgress = 20 + (progress.progress * 0.3); // 20-50%
      const eta = progress.eta > 0 ? `ETA: ${formatDuration(progress.eta)}` : "";
      const speed = formatBytes(progress.downloadSpeed) + "/s";

      await updateRequestStatus(requestId, RequestStatus.DOWNLOADING, {
        progress: overallProgress,
        currentStep: `Downloading: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`,
      });
    },
    checkCancelled: () => jobQueue.isCancelled(jobId),
  });

  if (!downloadResult.success) {
    // Handle failure - try alternative if available
    await downloadManager.handleStalledDownload(downloadId, downloadResult.error || "Download failed");

    // Check if retry was successful (status would still be DOWNLOADING)
    const updatedDownload = await prisma.download.findUnique({
      where: { id: downloadId },
    });

    if (updatedDownload?.status === DownloadStatus.DOWNLOADING) {
      // Retry was queued with new hash, re-queue monitoring
      await jobQueue.addJob("pipeline:movie-download" as JobType, {
        requestId,
        downloadId,
      } as MovieDownloadPayload, { priority: 5, maxAttempts: 3 });
    } else {
      await updateRequestStatus(requestId, RequestStatus.FAILED, {
        error: downloadResult.error || "Download failed after retries",
      });
    }
    return;
  }

  // Download complete - update Download record
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

  await logActivity(requestId, ActivityType.SUCCESS, `Download complete: ${download.torrentName}`);

  // Check for RAR archives and extract if needed
  const contentPath = downloadResult.progress?.contentPath || downloadResult.progress?.savePath || "";
  const archiveInfo = detectRarArchive(contentPath);

  if (archiveInfo.hasArchive && archiveInfo.archivePath) {
    await logActivity(requestId, ActivityType.INFO, `Extracting RAR archive...`);
    await updateRequestStatus(requestId, RequestStatus.DOWNLOADING, {
      progress: 45,
      currentStep: "Extracting archive...",
    });

    const extractResult = await extractRar(archiveInfo.archivePath, contentPath, {
      onProgress: (msg) => console.log(`[Pipeline] Extract: ${msg.trim()}`),
    });

    if (!extractResult.success) {
      await logActivity(requestId, ActivityType.ERROR, `Failed to extract archive: ${extractResult.error}`);
      // Continue anyway - there might be video files outside the archive
    } else {
      await logActivity(requestId, ActivityType.SUCCESS, `Extracted ${extractResult.extractedFiles.length} files from archive`);
    }
  }

  // Get the main video file
  const videoFile = await qb.getMainVideoFile(download.torrentHash);
  if (!videoFile) {
    // If no video from torrent files, check if we extracted one
    if (archiveInfo.hasArchive) {
      // Scan the directory for extracted video files
      const { readdirSync, statSync } = await import("fs");
      const { join } = await import("path");
      const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
      const minSizeBytes = 100 * 1024 * 1024; // 100MB minimum

      let extractedVideoFile: { path: string; size: number } | null = null;
      try {
        const files = readdirSync(contentPath);
        for (const filename of files) {
          const lower = filename.toLowerCase();
          if (videoExtensions.some((ext) => lower.endsWith(ext)) && !isSampleFile(filename)) {
            const filePath = join(contentPath, filename);
            try {
              const stat = statSync(filePath);
              if (stat.size >= minSizeBytes && (!extractedVideoFile || stat.size > extractedVideoFile.size)) {
                extractedVideoFile = { path: filePath, size: stat.size };
              }
            } catch {
              // Ignore stat errors
            }
          }
        }
      } catch (err) {
        console.error(`[Pipeline] Failed to scan directory: ${err}`);
      }

      if (extractedVideoFile) {
        await logActivity(requestId, ActivityType.SUCCESS, `Video file: ${formatBytes(extractedVideoFile.size)}`);

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            sourceFilePath: extractedVideoFile.path,
            status: RequestStatus.DOWNLOADING,
            progress: 50,
            currentStep: "Download complete, preparing to encode...",
          },
        });

        await jobQueue.addJob("pipeline:encode" as JobType, {
          requestId,
          downloadId,
          sourceFilePath: extractedVideoFile.path,
        } as EncodePayload, { priority: 5, maxAttempts: 2 });
        return;
      }
    }

    await prisma.download.update({
      where: { id: downloadId },
      data: {
        status: DownloadStatus.FAILED,
        failureReason: "No video file found in torrent (samples excluded)",
      },
    });
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "No video file found in downloaded content (samples excluded)",
    });
    await logActivity(requestId, ActivityType.ERROR, "No video file found in downloaded content (samples excluded)");
    return;
  }

  await logActivity(requestId, ActivityType.SUCCESS, `Video file: ${formatBytes(videoFile.size)}`);

  // Save source file path to request
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      sourceFilePath: videoFile.path,
      status: RequestStatus.DOWNLOADING,
      progress: 50,
      currentStep: "Download complete, preparing to encode...",
    },
  });

  // Queue encoding job
  await jobQueue.addJob("pipeline:encode" as JobType, {
    requestId,
    downloadId,
    sourceFilePath: videoFile.path,
  } as EncodePayload, { priority: 5, maxAttempts: 2 });
}

/**
 * Legacy download handler - for backwards compatibility with existing jobs
 * New jobs should use pipeline:movie-download instead
 */
async function handleDownload(payload: DownloadPayload, jobId: string): Promise<void> {
  const { requestId, release } = payload;
  const jobQueue = getJobQueueService();

  // Check if cancelled
  if (jobQueue.isCancelled(jobId)) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Cancelled during download",
    });
    return;
  }

  await updateRequestStatus(requestId, RequestStatus.DOWNLOADING, {
    progress: 20,
    currentStep: "Starting download...",
  });

  await logActivity(requestId, ActivityType.INFO, `Adding torrent: ${release.title}`);

  // Create Download record using the new system
  const download = await downloadManager.createDownload({
    requestId,
    mediaType: MediaType.MOVIE,
    release,
  });

  if (!download) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Failed to add torrent to qBittorrent",
    });
    return;
  }

  // Use the new movie download handler
  await handleMovieDownload({ requestId, downloadId: download.id }, jobId);
}

/**
 * Handle encoding stage: Encode video with per-server profile settings
 */
async function handleEncode(payload: EncodePayload, jobId: string): Promise<void> {
  const { requestId, downloadId, sourceFilePath } = payload;
  const jobQueue = getJobQueueService();

  // Check if cancelled
  if (jobQueue.isCancelled(jobId)) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Cancelled during encoding",
    });
    return;
  }

  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  await updateRequestStatus(requestId, RequestStatus.ENCODING, {
    progress: 50,
    currentStep: "Analyzing source file...",
  });

  // Get encoding service
  const encoding = getEncodingService();

  // Probe source file
  let probe;
  try {
    probe = await encoding.probe(sourceFilePath);
  } catch (error) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: `Failed to analyze source: ${error}`,
    });
    await logActivity(requestId, ActivityType.ERROR, `Failed to analyze source file: ${error}`);
    return;
  }

  await logActivity(requestId, ActivityType.INFO, `Source: ${probe.width}x${probe.height}, ${probe.videoCodec}, ${formatDuration(probe.duration)}`, {
    probe: {
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      codec: probe.videoCodec,
      hasHdr: probe.hasHdr,
      hdrFormat: probe.hdrFormat,
      fileSize: probe.fileSize,
    },
  });

  // Get targets from request
  const targets = getRequestTargets(request);

  // Get all servers
  const serverIds = targets.map((t) => t.serverId);
  const servers = await prisma.storageServer.findMany({
    where: { id: { in: serverIds } },
  });
  const serverMap = new Map(servers.map((s) => [s.id, s]));

  // Get all profiles referenced
  const profileIds = targets
    .filter((t) => t.encodingProfileId)
    .map((t) => t.encodingProfileId!);

  const profiles = await prisma.encodingProfile.findMany({
    where: { id: { in: profileIds } },
  });
  const profileMap = new Map(profiles.map((p) => [p.id, p]));

  // Get default profile for fallback
  const defaultProfile = await encoding.getDefaultProfile();

  // Group targets by encoding profile to avoid duplicate encodes
  // Key: profileId, Value: { profile, targets }
  const profileGroups = new Map<string, {
    profile: EncodingProfile;
    targets: Array<{ target: RequestTarget; server: StorageServer }>;
  }>();

  for (const target of targets) {
    const server = serverMap.get(target.serverId);
    if (!server) {
      await logActivity(requestId, ActivityType.WARNING, `Server not found: ${target.serverId}, skipping`);
      continue;
    }

    // Resolve profile: target override > server default > system default
    let profile: EncodingProfile | null = null;

    if (target.encodingProfileId) {
      profile = profileMap.get(target.encodingProfileId) || null;
    }

    if (!profile && server.encodingProfileId) {
      // Load server's profile if not already in map
      if (!profileMap.has(server.encodingProfileId)) {
        const serverProfile = await prisma.encodingProfile.findUnique({
          where: { id: server.encodingProfileId },
        });
        if (serverProfile) {
          profileMap.set(serverProfile.id, serverProfile);
          profile = serverProfile;
        }
      } else {
        profile = profileMap.get(server.encodingProfileId) || null;
      }
    }

    if (!profile) {
      profile = defaultProfile;
    }

    if (!profile) {
      await logActivity(requestId, ActivityType.WARNING, `No encoding profile for ${server.name}, skipping`);
      continue;
    }

    const key = profile.id;
    if (!profileGroups.has(key)) {
      profileGroups.set(key, { profile, targets: [] });
    }
    profileGroups.get(key)!.targets.push({ target, server });
  }

  if (profileGroups.size === 0) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "No encoding profiles configured for target servers",
    });
    return;
  }

  // Encode once per unique profile
  const encodedFiles: Array<{
    profile: EncodingProfile;
    path: string;
    targets: Array<{ target: RequestTarget; server: StorageServer }>;
  }> = [];
  let profileIndex = 0;
  const totalProfiles = profileGroups.size;

  for (const [profileId, { profile, targets: profileTargets }] of profileGroups) {
    // Check for cancellation between profiles
    if (jobQueue.isCancelled(jobId)) {
      await updateRequestStatus(requestId, RequestStatus.FAILED, {
        error: "Cancelled during encoding",
      });
      return;
    }

    const outputPath = encoding.generateOutputPath(sourceFilePath, profile);
    const serverNames = profileTargets.map((t) => t.server.name).join(", ");

    await logActivity(requestId, ActivityType.INFO, `Encoding with profile "${profile.name}" for servers: ${serverNames}`);

    await updateRequestStatus(requestId, RequestStatus.ENCODING, {
      progress: 50 + (profileIndex / totalProfiles) * 25,
      currentStep: `Encoding: ${profile.name}...`,
    });

    // Create encoding job record
    const encodingJob = await prisma.encodingJob.create({
      data: {
        sourceFile: sourceFilePath,
        requestId,
        profileId: profile.id,
      },
    });

    // Require remote encoding
    const encoderDispatch = getEncoderDispatchService();
    let result: { success: boolean; outputPath: string; outputSize: number; compressionRatio: number; error?: string };

    if (!encoderDispatch.hasEncoders()) {
      await updateRequestStatus(requestId, RequestStatus.FAILED, {
        error: "No remote encoders available. Please configure at least one encoder.",
      });
      await logActivity(requestId, ActivityType.ERROR, "No remote encoders available");
      return;
    }

    await logActivity(requestId, ActivityType.INFO, `Using remote encoder for ${profile.name}`);

    try {
      // Use the actual job ID for the encoder assignment (foreign key to Job table)
      const { waitForCompletion } = await encoderDispatch.queueEncodingJob(
        jobId,
        sourceFilePath,
        outputPath,
        profileId
      );

      // Set up a progress polling interval since remote progress comes via WebSocket
      const progressPollInterval = setInterval(async () => {
        if (jobQueue.isCancelled(jobId)) {
          clearInterval(progressPollInterval);
          await encoderDispatch.cancelJob(jobId, "Pipeline cancelled");
          return;
        }

        // Get latest progress from database
        const assignment = await prisma.encoderAssignment.findUnique({
          where: { jobId: jobId },
        });

        if (assignment && assignment.status === "ENCODING") {
          const stageProgress = 50 + ((profileIndex + (assignment.progress / 100)) / totalProfiles) * 25;
          const speed = assignment.speed ? `${assignment.speed.toFixed(1)}x` : "";
          const eta = assignment.eta ? `ETA: ${formatDuration(assignment.eta)}` : "";

          await updateRequestStatus(requestId, RequestStatus.ENCODING, {
            progress: stageProgress,
            currentStep: `Encoding ${profile.name}: ${assignment.progress.toFixed(1)}% ${speed} ${eta}`,
          });

          await prisma.encodingJob.update({
            where: { id: encodingJob.id },
            data: { progress: assignment.progress },
          });
        }
      }, 2000);

      // Wait for remote encoding to complete
      const completedAssignment = await waitForCompletion();
      clearInterval(progressPollInterval);

      result = {
        success: true,
        outputPath: completedAssignment.outputPath,
        outputSize: Number(completedAssignment.outputSize || 0),
        compressionRatio: completedAssignment.compressionRatio || 1,
      };
    } catch (error) {
      result = {
        success: false,
        outputPath,
        outputSize: 0,
        compressionRatio: 1,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!result.success) {
      await prisma.encodingJob.update({
        where: { id: encodingJob.id },
        data: { status: "FAILED", error: result.error },
      });

      await logActivity(requestId, ActivityType.ERROR, `Encoding failed for ${profile.name}: ${result.error}`);
      continue; // Try other profiles
    }

    // Update encoding job as completed
    await prisma.encodingJob.update({
      where: { id: encodingJob.id },
      data: {
        status: "COMPLETED",
        outputFile: result.outputPath,
        progress: 100,
        completedAt: new Date(),
      },
    });

    await logActivity(requestId, ActivityType.SUCCESS, `Encoded ${profile.name}: ${formatBytes(result.outputSize)} (${result.compressionRatio.toFixed(1)}x compression)`);

    // Clean up audio/subtitle tracks after encoding
    await updateRequestStatus(requestId, RequestStatus.ENCODING, {
      progress: 50 + ((profileIndex + 0.9) / totalProfiles) * 25,
      currentStep: `Cleaning up tracks for ${profile.name}...`,
    });

    const remuxResult = await encoding.remuxTracks(result.outputPath);
    if (remuxResult.success) {
      if (remuxResult.audioTracksRemoved > 0 || remuxResult.subtitleTracksRemoved > 0) {
        await logActivity(requestId, ActivityType.INFO,
          `Track cleanup: removed ${remuxResult.audioTracksRemoved} audio, ${remuxResult.subtitleTracksRemoved} subtitle tracks`
        );
      }
    } else {
      await logActivity(requestId, ActivityType.WARNING, `Track cleanup failed: ${remuxResult.error} (continuing with original file)`);
    }

    encodedFiles.push({
      profile,
      path: remuxResult.outputPath, // Use remuxed path (same as input if unchanged)
      targets: profileTargets,
    });

    profileIndex++;
  }

  if (encodedFiles.length === 0) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "All encoding attempts failed",
    });
    return;
  }

  await updateRequestStatus(requestId, RequestStatus.ENCODING, {
    progress: 75,
    currentStep: "Encoding complete, preparing delivery...",
  });

  // Queue delivery job for each encoded file
  for (const { profile, path: encodedPath, targets: profileTargets } of encodedFiles) {
    const targetServerIds = profileTargets.map((t) => t.server.id);
    const codec = encoding.getCodecForEncoder(profile.videoEncoder).toUpperCase();

    await jobQueue.addJob("pipeline:deliver" as JobType, {
      requestId,
      encodedFilePath: encodedPath,
      profileId: profile.id,
      resolution: encoding.resolutionToString(profile.videoMaxResolution),
      codec,
      targetServerIds,
    } as DeliverPayload, { priority: 5, maxAttempts: 3 });
  }
}

/**
 * Handle delivery stage: Transfer to storage servers
 */
async function handleDeliver(payload: DeliverPayload, jobId: string): Promise<void> {
  const { requestId, encodedFilePath, profileId, resolution, codec, targetServerIds } = payload;
  const jobQueue = getJobQueueService();

  // Check if cancelled
  if (jobQueue.isCancelled(jobId)) {
    await updateRequestStatus(requestId, RequestStatus.FAILED, {
      error: "Cancelled during delivery",
    });
    return;
  }

  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  await updateRequestStatus(requestId, RequestStatus.DELIVERING, {
    progress: 75,
    currentStep: "Preparing for delivery...",
  });

  // Get servers
  const servers = await prisma.storageServer.findMany({
    where: { id: { in: targetServerIds } },
  });

  const naming = getNamingService();
  const delivery = getDeliveryService();

  // Generate destination paths
  const container = encodedFilePath.split(".").pop() || "mkv";

  let successCount = 0;
  let serverIndex = 0;

  for (const server of servers) {
    // Check for cancellation
    if (jobQueue.isCancelled(jobId)) {
      await updateRequestStatus(requestId, RequestStatus.FAILED, {
        error: "Cancelled during delivery",
      });
      return;
    }

    let remotePath: string;

    if (request.type === MediaType.MOVIE) {
      remotePath = naming.getMovieDestinationPath(server.pathMovies, {
        title: request.title,
        year: request.year,
        quality: resolution,
        codec,
        container,
      });
    } else {
      // For TV, we'd need episode info - simplified for now
      const season = request.requestedSeasons[0] || 1;
      remotePath = naming.getTvDestinationPath(server.pathTv, {
        series: request.title,
        year: request.year,
        season,
        episode: 1, // Would need to track actual episode
        quality: resolution,
        codec,
        container,
      });
    }

    await logActivity(requestId, ActivityType.INFO, `Delivering to ${server.name}: ${remotePath}`);

    await updateRequestStatus(requestId, RequestStatus.DELIVERING, {
      progress: 75 + (serverIndex / servers.length) * 20,
      currentStep: `Transferring to ${server.name}...`,
    });

    const result = await delivery.deliver(server.id, encodedFilePath, remotePath, {
      jobId: `${jobId}-${server.id}`,
      onProgress: async (progress) => {
        const stageProgress = 75 + ((serverIndex + (progress.progress / 100)) / servers.length) * 20;
        const speed = formatBytes(progress.speed) + "/s";
        const eta = progress.eta > 0 ? `ETA: ${formatDuration(progress.eta)}` : "";

        await updateRequestStatus(requestId, RequestStatus.DELIVERING, {
          progress: stageProgress,
          currentStep: `${server.name}: ${progress.progress.toFixed(1)}% - ${speed} ${eta}`,
        });
      },
      checkCancelled: () => jobQueue.isCancelled(jobId),
    });

    if (result.success) {
      successCount++;
      await logActivity(requestId, ActivityType.SUCCESS, `Delivered to ${server.name} in ${formatDuration(result.duration)}`, {
        server: server.name,
        bytesTransferred: result.bytesTransferred,
        duration: result.duration,
        libraryScanTriggered: result.libraryScanTriggered,
      });

      // Add to library cache
      await prisma.libraryItem.upsert({
        where: {
          tmdbId_type_serverId: {
            tmdbId: request.tmdbId,
            type: request.type,
            serverId: server.id,
          },
        },
        create: {
          tmdbId: request.tmdbId,
          type: request.type,
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
      await logActivity(requestId, ActivityType.ERROR, `Failed to deliver to ${server.name}: ${result.error}`);
    }

    serverIndex++;
  }

  // Clean up encoded file after all deliveries
  const encodingService = getEncodingService();
  await encodingService.cleanupTempFiles([encodedFilePath]);

  // Check if all delivery jobs are done (this job handles one profile's servers)
  // For now, mark as completed if this batch succeeded
  // A more robust approach would track all delivery jobs
  if (successCount > 0) {
    // Check if there are other pending delivery jobs for this request
    const pendingDeliveries = await prisma.job.count({
      where: {
        type: "pipeline:deliver",
        status: { in: ["PENDING", "RUNNING"] },
        payload: {
          path: ["requestId"],
          equals: requestId,
        },
        id: { not: jobId }, // Exclude current job
      },
    });

    if (pendingDeliveries === 0) {
      await updateRequestStatus(requestId, RequestStatus.COMPLETED, {
        progress: 100,
        currentStep: null,
        error: null,
      });

      await logActivity(requestId, ActivityType.SUCCESS, "Request completed successfully");
    }
  } else if (successCount === 0 && servers.length > 0) {
    // All deliveries in this batch failed
    await logActivity(requestId, ActivityType.ERROR, `Failed to deliver to any servers in this batch`);
  }
}

// =============================================================================
// Pipeline Registration
// =============================================================================

/**
 * Handle retry of all awaiting requests
 */
async function handleRetryAwaiting(): Promise<void> {
  // Find all requests in AWAITING status
  const awaitingRequests = await prisma.mediaRequest.findMany({
    where: { status: RequestStatus.AWAITING },
  });

  if (awaitingRequests.length === 0) {
    console.log("[Pipeline] No awaiting requests to retry");
    return;
  }

  console.log(`[Pipeline] Retrying ${awaitingRequests.length} awaiting requests`);

  const jobQueue = getJobQueueService();

  for (const request of awaitingRequests) {
    // Update status to PENDING before queueing
    await prisma.mediaRequest.update({
      where: { id: request.id },
      data: {
        status: RequestStatus.PENDING,
        currentStep: "Retrying search...",
      },
    });

    await logActivity(request.id, ActivityType.INFO, "Retrying search for releases (scheduled retry)");

    // Queue a new search job
    await jobQueue.addJob("pipeline:search" as JobType, {
      requestId: request.id,
    } as SearchPayload, { priority: 5, maxAttempts: 3 });
  }
}

/**
 * Register pipeline handlers with the job queue
 */
export function registerPipelineHandlers(): void {
  const jobQueue = getJobQueueService();

  // Register all pipeline handlers
  jobQueue.registerHandler("pipeline:search" as JobType, async (payload, jobId) => {
    await handleSearch(payload as SearchPayload, jobId);
  });

  jobQueue.registerHandler("pipeline:download" as JobType, async (payload, jobId) => {
    await handleDownload(payload as DownloadPayload, jobId);
  });

  jobQueue.registerHandler("pipeline:movie-download" as JobType, async (payload, jobId) => {
    await handleMovieDownload(payload as MovieDownloadPayload, jobId);
  });

  jobQueue.registerHandler("pipeline:encode" as JobType, async (payload, jobId) => {
    await handleEncode(payload as EncodePayload, jobId);
  });

  jobQueue.registerHandler("pipeline:deliver" as JobType, async (payload, jobId) => {
    await handleDeliver(payload as DeliverPayload, jobId);
  });

  jobQueue.registerHandler("pipeline:retry-awaiting" as JobType, async () => {
    await handleRetryAwaiting();
  });

  console.log("[Pipeline] Registered all pipeline handlers");
}

/**
 * Start a new request in the pipeline
 */
export async function startPipeline(requestId: string): Promise<void> {
  const jobQueue = getJobQueueService();

  // Check if this is a TV request - route to TV pipeline
  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
    select: { type: true },
  });

  if (request?.type === MediaType.TV) {
    // TV shows use the specialized TV pipeline
    await jobQueue.addJob("tv:search" as JobType, {
      requestId,
    }, { priority: 10, maxAttempts: 3 });

    // Enable monitoring by default for TV shows
    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: { monitoring: true },
    });

    console.log(`[Pipeline] Started TV pipeline for request ${requestId}`);
    return;
  }

  // Movies use the standard pipeline
  await jobQueue.addJob("pipeline:search" as JobType, {
    requestId,
  } as SearchPayload, { priority: 10, maxAttempts: 3 });

  console.log(`[Pipeline] Started pipeline for request ${requestId}`);
}

/**
 * Retry a TV show request - intelligently resumes from the appropriate step
 * based on each episode's current state
 */
async function retryTvPipeline(requestId: string, request: MediaRequest): Promise<{ step: string }> {
  const jobQueue = getJobQueueService();

  // Get all episodes with their current state
  const episodes = await prisma.tvEpisode.findMany({
    where: { requestId },
    include: { download: true },
  });

  // Clear error state on request
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      error: null,
      status: RequestStatus.PENDING,
      progress: 0,
      currentStep: "Retrying...",
    },
  });

  let encodedCount = 0;
  let downloadedCount = 0;
  let failedCount = 0;

  // Track downloads we've already queued jobs for to avoid duplicates
  // (Multiple episodes can share the same season pack download)
  const queuedDownloadIds = new Set<string>();
  const queuedEncodeEpisodeIds = new Set<string>();

  // Process each episode based on its state
  for (const episode of episodes) {
    // Skip completed or skipped episodes
    if (episode.status === TvEpisodeStatus.COMPLETED || episode.status === TvEpisodeStatus.SKIPPED) {
      continue;
    }

    // ENCODED or DELIVERING episodes need delivery - queue delivery job
    if (episode.status === TvEpisodeStatus.ENCODED || episode.status === TvEpisodeStatus.DELIVERING) {
      // We need to find the encoded file path - check encoding jobs
      const encodingJob = await prisma.encodingJob.findFirst({
        where: {
          requestId,
          sourceFile: episode.sourceFilePath || undefined,
          status: "COMPLETED",
        },
        include: { profile: true },
        orderBy: { completedAt: "desc" },
      });

      if (encodingJob?.outputFile) {
        const targets = (request.targets as unknown as Array<{ serverId: string; encodingProfileId?: string }>) || [];
        const targetServerIds = targets.map(t => t.serverId);
        const encoding = await import("./encoding.js").then(m => m.getEncodingService());

        await jobQueue.addJob("tv:deliver" as JobType, {
          requestId,
          episodeId: episode.id,
          encodedFilePath: encodingJob.outputFile,
          profileId: encodingJob.profileId,
          resolution: encoding.resolutionToString(encodingJob.profile.videoMaxResolution),
          codec: encoding.getCodecForEncoder(encodingJob.profile.videoEncoder).toUpperCase(),
          targetServerIds,
        }, { priority: 5, maxAttempts: 3 });

        encodedCount++;
        await logActivity(requestId, ActivityType.INFO, `Retrying delivery for S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")}`);
      } else {
        // No encoded file found, need to re-encode
        await prisma.tvEpisode.update({
          where: { id: episode.id },
          data: { status: TvEpisodeStatus.DOWNLOADED, error: null },
        });
        downloadedCount++;
      }
      continue;
    }

    // DOWNLOADED or ENCODING episodes need encoding - queue encode job
    if ((episode.status === TvEpisodeStatus.DOWNLOADED || episode.status === TvEpisodeStatus.ENCODING) && episode.sourceFilePath) {
      // Skip if we already queued an encode job for this episode
      if (queuedEncodeEpisodeIds.has(episode.id)) {
        downloadedCount++;
        continue;
      }

      await jobQueue.addJobIfNotExists(
        "tv:encode" as JobType,
        { requestId, episodeId: episode.id },
        `tv:encode:${episode.id}`,
        { priority: 5, maxAttempts: 2 }
      );

      queuedEncodeEpisodeIds.add(episode.id);
      downloadedCount++;
      await logActivity(requestId, ActivityType.INFO, `Retrying encoding for S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")}`);
      continue;
    }

    // DOWNLOADING episodes - check if download exists and is active, otherwise restart search
    if (episode.status === TvEpisodeStatus.DOWNLOADING) {
      if (episode.download && episode.download.status === DownloadStatus.DOWNLOADING) {
        // Download is still active, queue download monitoring job
        await jobQueue.addJob("tv:download" as JobType, {
          requestId,
          downloadId: episode.download.id,
        }, { priority: 5, maxAttempts: 3 });
        downloadedCount++;
        await logActivity(requestId, ActivityType.INFO, `Resuming download for S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")}`);
      } else {
        // Download is gone or failed, restart search
        await prisma.tvEpisode.update({
          where: { id: episode.id },
          data: { status: TvEpisodeStatus.PENDING, error: null, downloadId: null },
        });
        failedCount++;
      }
      continue;
    }

    // FAILED, AWAITING, SEARCHING, QUALITY_UNAVAILABLE, or PENDING episodes
    // First check if we have a usable source file before restarting search
    if (
      episode.status === TvEpisodeStatus.FAILED ||
      episode.status === TvEpisodeStatus.AWAITING ||
      episode.status === TvEpisodeStatus.SEARCHING ||
      episode.status === TvEpisodeStatus.QUALITY_UNAVAILABLE ||
      episode.status === TvEpisodeStatus.PENDING
    ) {
      // Check if sourceFilePath exists and file is accessible
      let sourceExists = false;
      if (episode.sourceFilePath) {
        try {
          const fs = await import("fs/promises");
          await fs.access(episode.sourceFilePath);
          sourceExists = true;
        } catch {
          // File doesn't exist at stored path
        }
      }

      if (sourceExists && episode.sourceFilePath) {
        // Skip if we already queued an encode job for this episode
        if (queuedEncodeEpisodeIds.has(episode.id)) {
          downloadedCount++;
          continue;
        }

        // Source file exists! Queue encoding instead of searching
        await prisma.tvEpisode.update({
          where: { id: episode.id },
          data: { status: TvEpisodeStatus.DOWNLOADED, error: null },
        });
        await jobQueue.addJobIfNotExists(
          "tv:encode" as JobType,
          { requestId, episodeId: episode.id },
          `tv:encode:${episode.id}`,
          { priority: 5, maxAttempts: 2 }
        );
        queuedEncodeEpisodeIds.add(episode.id);
        downloadedCount++;
        await logActivity(requestId, ActivityType.INFO, `Source file exists, retrying encoding for S${episode.season.toString().padStart(2, "0")}E${episode.episode.toString().padStart(2, "0")}`);
        continue;
      }

      // Check if there's a completed download in qBittorrent we can use
      if (episode.download) {
        const downloadId = episode.download.id;

        // Skip if we already queued a job for this download (season pack case)
        if (queuedDownloadIds.has(downloadId)) {
          // Still update this episode's status, but don't queue another job
          await prisma.tvEpisode.update({
            where: { id: episode.id },
            data: { status: TvEpisodeStatus.DOWNLOADING, error: null },
          });
          downloadedCount++;
          continue;
        }

        const qb = getDownloadService();
        const progress = await qb.getProgress(episode.download.torrentHash);

        if (progress?.isComplete) {
          // Download is complete in qBittorrent - queue file mapping (once per download)
          await logActivity(requestId, ActivityType.INFO, `Found completed download in qBittorrent, remapping files for download ${downloadId}`);

          // Update all episodes linked to this download
          await prisma.tvEpisode.updateMany({
            where: { downloadId },
            data: { status: TvEpisodeStatus.DOWNLOADING, error: null },
          });

          await jobQueue.addJob("tv:map-files" as JobType, {
            requestId,
            downloadId,
          }, { priority: 5, maxAttempts: 3 });

          queuedDownloadIds.add(downloadId);
          downloadedCount++;
          continue;
        }
      }

      // No existing source found, reset to PENDING for search
      await prisma.tvEpisode.update({
        where: { id: episode.id },
        data: { status: TvEpisodeStatus.PENDING, error: null },
      });
      failedCount++;
    }
  }

  // If we have episodes that need searching, queue the search job
  const pendingEpisodes = await prisma.tvEpisode.count({
    where: { requestId, status: TvEpisodeStatus.PENDING },
  });

  if (pendingEpisodes > 0) {
    await jobQueue.addJob("tv:search" as JobType, {
      requestId,
    }, { priority: 10, maxAttempts: 3 });
  }

  const actions: string[] = [];
  if (encodedCount > 0) actions.push(`${encodedCount} retrying delivery`);
  if (downloadedCount > 0) actions.push(`${downloadedCount} retrying encoding`);
  if (failedCount > 0) actions.push(`${failedCount} retrying search`);

  await logActivity(requestId, ActivityType.INFO, `Retry started: ${actions.join(", ") || "checking status"}`);

  return { step: encodedCount > 0 ? "delivering" : downloadedCount > 0 ? "encoding" : "searching" };
}

/**
 * Retry a failed/awaiting request, resuming from the appropriate step
 * based on saved pipeline state.
 */
export async function retryPipeline(requestId: string): Promise<{ step: string }> {
  const jobQueue = getJobQueueService();

  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  // TV shows use their own pipeline
  if (request.type === MediaType.TV) {
    return retryTvPipeline(requestId, request);
  }

  // Clear error state
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      error: null,
      status: RequestStatus.PENDING,
    },
  });

  // Check for existing Download record for this request
  const existingDownload = await prisma.download.findFirst({
    where: { requestId },
    orderBy: { createdAt: "desc" },
  });

  // Determine which step to resume from based on saved state
  // Priority: most advanced state first

  // If we have a source file path, we can skip straight to encoding
  if (request.sourceFilePath && existingDownload) {
    await logActivity(requestId, ActivityType.INFO, "Retrying from encoding step (source file exists)");

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.DOWNLOADING,
        progress: 50,
        currentStep: "Resuming encoding...",
      },
    });

    await jobQueue.addJob("pipeline:encode" as JobType, {
      requestId,
      downloadId: existingDownload.id,
      sourceFilePath: request.sourceFilePath,
    } as EncodePayload, { priority: 5, maxAttempts: 2 });

    return { step: "encoding" };
  }

  // If we have a Download record, check its status
  if (existingDownload) {
    const qb = getDownloadService();
    const progress = await qb.getProgress(existingDownload.torrentHash);

    if (progress?.isComplete) {
      // Download complete, get video file and proceed to encoding
      const videoFile = await qb.getMainVideoFile(existingDownload.torrentHash);

      if (videoFile) {
        await logActivity(requestId, ActivityType.INFO, "Retrying from encoding step (download already complete)");

        await prisma.mediaRequest.update({
          where: { id: requestId },
          data: {
            sourceFilePath: videoFile.path,
            status: RequestStatus.DOWNLOADING,
            progress: 50,
            currentStep: "Resuming encoding...",
          },
        });

        await prisma.download.update({
          where: { id: existingDownload.id },
          data: {
            status: DownloadStatus.COMPLETED,
            progress: 100,
            completedAt: new Date(),
          },
        });

        await jobQueue.addJob("pipeline:encode" as JobType, {
          requestId,
          downloadId: existingDownload.id,
          sourceFilePath: videoFile.path,
        } as EncodePayload, { priority: 5, maxAttempts: 2 });

        return { step: "encoding" };
      }
    }

    if (progress) {
      // Torrent exists, resume monitoring download
      await logActivity(requestId, ActivityType.INFO, `Retrying from download step (torrent at ${progress.progress.toFixed(1)}%)`);

      await prisma.mediaRequest.update({
        where: { id: requestId },
        data: {
          status: RequestStatus.DOWNLOADING,
          progress: 20,
          currentStep: "Resuming download...",
        },
      });

      await prisma.download.update({
        where: { id: existingDownload.id },
        data: {
          status: DownloadStatus.DOWNLOADING,
          progress: progress.progress,
        },
      });

      // Queue the movie download handler to resume monitoring
      await jobQueue.addJob("pipeline:movie-download" as JobType, {
        requestId,
        downloadId: existingDownload.id,
      } as MovieDownloadPayload, { priority: 5, maxAttempts: 3 });

      return { step: "downloading" };
    }
  }

  // If we have a selected release but no Download record, create one and start download
  if (request.selectedRelease) {
    await logActivity(requestId, ActivityType.INFO, "Retrying from download step (release already selected)");

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.SEARCHING,
        progress: 15,
        currentStep: "Resuming download...",
      },
    });

    const release = request.selectedRelease as unknown as Release;

    // Create Download using the new system
    const download = await downloadManager.createDownload({
      requestId,
      mediaType: MediaType.MOVIE,
      release,
    });

    if (download) {
      await jobQueue.addJob("pipeline:movie-download" as JobType, {
        requestId,
        downloadId: download.id,
      } as MovieDownloadPayload, { priority: 5, maxAttempts: 3 });
    } else {
      // Fallback to legacy handler if createDownload fails
      await jobQueue.addJob("pipeline:download" as JobType, {
        requestId,
        release,
      } as DownloadPayload, { priority: 5, maxAttempts: 3 });
    }

    return { step: "downloading" };
  }

  // No saved state, start from beginning
  await logActivity(requestId, ActivityType.INFO, "Retrying from search step");

  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.PENDING,
      progress: 0,
      currentStep: "Searching...",
    },
  });

  await jobQueue.addJob("pipeline:search" as JobType, {
    requestId,
  } as SearchPayload, { priority: 10, maxAttempts: 3 });

  return { step: "searching" };
}

/**
 * Cancel a running pipeline
 */
export async function cancelPipeline(requestId: string): Promise<boolean> {
  const jobQueue = getJobQueueService();

  // First, mark the request as cancelled so any new jobs won't start
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.FAILED,
      error: "Cancelled by user",
    },
  });

  // Find ALL running/pending jobs for this request (pipeline:*, tv:*, etc.)
  const jobs = await prisma.job.findMany({
    where: {
      status: { in: ["PENDING", "RUNNING"] },
      payload: {
        path: ["requestId"],
        equals: requestId,
      },
    },
  });

  console.log(`[Pipeline] Cancelling ${jobs.length} jobs for request ${requestId}`);

  let cancelled = false;

  for (const job of jobs) {
    // Cancel running jobs
    if (job.status === "RUNNING") {
      const result = await jobQueue.requestCancellation(job.id);
      if (result) cancelled = true;
    }

    // Also cancel pending jobs directly in DB
    if (job.status === "PENDING") {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: "CANCELLED" },
      });
      cancelled = true;
    }
  }

  await logActivity(requestId, ActivityType.WARNING, `Request cancelled by user (${jobs.length} jobs cancelled)`);

  return cancelled;
}

/**
 * Reprocess a completed movie request
 *
 * This re-encodes and re-delivers a movie that has already been processed.
 * Useful when encoding settings have changed or if there was an issue with the original encode.
 *
 * Flow:
 * 1. Check if source file still exists
 * 2. If yes: queue encode job directly
 * 3. If no: start fresh from search step
 */
export async function reprocessPipeline(requestId: string): Promise<{ step: string; sourceExists: boolean }> {
  const jobQueue = getJobQueueService();
  const { existsSync } = await import("fs");

  const request = await prisma.mediaRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new Error(`Request not found: ${requestId}`);
  }

  if (request.type === MediaType.TV) {
    throw new Error("Use reprocessTvEpisode for TV shows");
  }

  // Check if source file exists
  let sourceFilePath = request.sourceFilePath;
  let sourceExists = false;

  if (sourceFilePath && existsSync(sourceFilePath)) {
    sourceExists = true;
  } else {
    // Try to find source from completed download
    const download = await prisma.download.findFirst({
      where: { requestId, status: DownloadStatus.COMPLETED },
      orderBy: { createdAt: "desc" },
    });

    if (download) {
      const qb = getDownloadService();
      const videoFile = await qb.getMainVideoFile(download.torrentHash);

      if (videoFile && existsSync(videoFile.path)) {
        sourceFilePath = videoFile.path;
        sourceExists = true;
      }
    }
  }

  // Delete any existing encoding jobs (they reference old encoded files)
  await prisma.encodingJob.deleteMany({
    where: { requestId },
  });

  if (sourceExists && sourceFilePath) {
    // Source exists - queue encode job directly
    await logActivity(requestId, ActivityType.INFO, "Reprocessing: source file found, starting encode");

    // Get or create a download record for the encode job
    let download = await prisma.download.findFirst({
      where: { requestId },
      orderBy: { createdAt: "desc" },
    });

    if (!download) {
      // Create a placeholder download record
      download = await prisma.download.create({
        data: {
          requestId,
          mediaType: MediaType.MOVIE,
          torrentHash: "reprocess-" + requestId,
          torrentName: request.title,
          status: DownloadStatus.COMPLETED,
          progress: 100,
          completedAt: new Date(),
        },
      });
    }

    await prisma.mediaRequest.update({
      where: { id: requestId },
      data: {
        status: RequestStatus.ENCODING,
        progress: 50,
        currentStep: "Reprocessing: encoding...",
        error: null,
        sourceFilePath,
      },
    });

    await jobQueue.addJob("pipeline:encode" as JobType, {
      requestId,
      downloadId: download.id,
      sourceFilePath,
    } as EncodePayload, { priority: 5, maxAttempts: 2 });

    return { step: "encoding", sourceExists: true };
  }

  // Source doesn't exist - need to re-download
  await logActivity(requestId, ActivityType.WARNING, "Reprocessing: source file not found, starting fresh download");

  // Clear any existing state
  await prisma.mediaRequest.update({
    where: { id: requestId },
    data: {
      status: RequestStatus.PENDING,
      progress: 0,
      currentStep: "Reprocessing: searching...",
      error: null,
      sourceFilePath: null,
      selectedRelease: Prisma.JsonNull,
    },
  });

  // Delete old downloads
  await prisma.download.deleteMany({
    where: { requestId },
  });

  // Start from search
  await jobQueue.addJob("pipeline:search" as JobType, {
    requestId,
  } as SearchPayload, { priority: 10, maxAttempts: 3 });

  return { step: "searching", sourceExists: false };
}

// =============================================================================
// Helpers
// =============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}
