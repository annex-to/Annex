import { DownloadStatus, ProcessingStatus } from "@prisma/client";
import { prisma } from "../db/client.js";
import { extractEpisodeFilesFromDownload } from "./pipeline/downloadHelper.js";
import { getPipelineExecutor } from "./pipeline/PipelineExecutor.js";

/**
 * Recovers episodes stuck in DOWNLOADING status when their download is COMPLETED.
 *
 * Root cause: The download completion trigger (download sync task) sometimes fails
 * silently for specific downloads, leaving episodes stuck in DOWNLOADING status even
 * though the torrent has finished downloading.
 *
 * This recovery function:
 * 1. Finds episodes with status=DOWNLOADING
 * 2. Checks if their associated download is status=COMPLETED
 * 3. Calls extractEpisodeFilesFromDownload() to extract files and update statuses
 * 4. Triggers pipeline continuation to proceed to encoding
 */
export async function recoverStuckDownloadExtractions(): Promise<void> {
  console.log("[DownloadExtractionRecovery] Checking for stuck episode extractions...");

  // Find episodes stuck in DOWNLOADING status that have a COMPLETED download
  const stuckEpisodes = await prisma.processingItem.findMany({
    where: {
      type: "EPISODE",
      status: ProcessingStatus.DOWNLOADING,
      download: {
        status: DownloadStatus.COMPLETED,
      },
    },
    select: {
      id: true,
      season: true,
      episode: true,
      requestId: true,
      download: {
        select: {
          id: true,
          torrentHash: true,
          torrentName: true,
          completedAt: true,
        },
      },
      request: {
        select: {
          title: true,
        },
      },
    },
  });

  if (stuckEpisodes.length === 0) {
    console.log("[DownloadExtractionRecovery] No stuck episodes found");
    return;
  }

  console.log(
    `[DownloadExtractionRecovery] Found ${stuckEpisodes.length} episodes stuck in DOWNLOADING with COMPLETED downloads`
  );

  // Group episodes by download to avoid duplicate extraction calls
  const downloadsToProcess = new Map<
    string,
    {
      torrentHash: string;
      requestId: string;
      torrentName: string;
      episodes: Array<{ season: number; episode: number }>;
      title: string;
    }
  >();

  for (const ep of stuckEpisodes) {
    if (!ep.download) continue;

    const downloadId = ep.download.id;
    if (!downloadsToProcess.has(downloadId)) {
      downloadsToProcess.set(downloadId, {
        torrentHash: ep.download.torrentHash,
        requestId: ep.requestId,
        torrentName: ep.download.torrentName,
        episodes: [],
        title: ep.request.title,
      });
    }

    if (ep.season !== null && ep.episode !== null) {
      downloadsToProcess.get(downloadId)?.episodes.push({
        season: ep.season,
        episode: ep.episode,
      });
    }
  }

  let recovered = 0;

  for (const [_downloadId, data] of downloadsToProcess) {
    const episodeList = data.episodes
      .map((e) => `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`)
      .join(", ");

    console.log(
      `[DownloadExtractionRecovery] ${data.title}: Extracting ${data.episodes.length} episodes from "${data.torrentName}"`
    );
    console.log(`[DownloadExtractionRecovery]   Episodes: ${episodeList}`);

    try {
      // Extract episode files from the completed download
      const episodeFiles = await extractEpisodeFilesFromDownload(data.torrentHash, data.requestId);

      console.log(
        `[DownloadExtractionRecovery] ${data.title}: Extracted ${episodeFiles.length} episodes`
      );

      // Check if request is already in a later stage (ENCODING/DELIVERING/COMPLETED)
      // If so, don't restart the pipeline - it would destroy all progress
      const request = await prisma.mediaRequest.findUnique({
        where: { id: data.requestId },
        select: { id: true },
      });

      if (request) {
        const { requestStatusComputer } = await import("./requestStatusComputer.js");
        const computedStatus = await requestStatusComputer.computeStatus(data.requestId);

        if (["ENCODING", "DELIVERING", "COMPLETED"].includes(computedStatus.status)) {
          console.log(
            `[DownloadExtractionRecovery] ${data.title}: Request already in ${computedStatus.status} - skipping pipeline restart to preserve progress`
          );
          continue;
        }
      }

      // MediaRequest status computed from ProcessingItems - pipeline will manage state

      // Continue pipeline to encoding
      const execution = await prisma.pipelineExecution.findFirst({
        where: { requestId: data.requestId },
        orderBy: { startedAt: "desc" },
        select: { id: true, templateId: true },
      });

      if (execution) {
        const executor = getPipelineExecutor();
        executor.startExecution(data.requestId, execution.templateId).catch((error) => {
          console.error(
            `[DownloadExtractionRecovery] ${data.title}: Failed to continue pipeline:`,
            error
          );
        });

        console.log(`[DownloadExtractionRecovery] ${data.title}: Pipeline continued to encoding`);
      } else {
        console.log(
          `[DownloadExtractionRecovery] ${data.title}: No pipeline execution found - may need manual retry`
        );
      }

      recovered += data.episodes.length;
    } catch (error) {
      console.error(
        `[DownloadExtractionRecovery] ${data.title}: Failed to extract episodes:`,
        error
      );
    }
  }

  if (recovered > 0) {
    console.log(
      `[DownloadExtractionRecovery] ✓ Recovered ${recovered} stuck episodes from ${downloadsToProcess.size} downloads`
    );
  }
}
