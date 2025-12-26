import { TvEpisodeStatus } from "@prisma/client";
import { prisma } from "../../db/client.js";
import { getDownloadService } from "../download.js";
import { isSampleFile } from "../archive.js";

/**
 * Extract episode files from a completed download
 * Updates TvEpisode records with DOWNLOADED status and file paths
 */
export async function extractEpisodeFilesFromDownload(
  torrentHash: string,
  requestId: string
): Promise<
  Array<{
    season: number;
    episode: number;
    path: string;
    size: number;
    episodeId: string;
  }>
> {
  const qb = getDownloadService();

  // Get torrent progress to get file list
  const progress = await qb.getProgress(torrentHash);
  if (!progress) {
    throw new Error(`Torrent ${torrentHash} not found`);
  }

  // Get all files in the torrent
  const files = await qb.getTorrentFiles(torrentHash);

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
      console.warn(`[DownloadHelper] Could not parse episode info from: ${file.name}`);
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
        `[DownloadHelper] Creating missing TvEpisode record for S${season}E${episode} in request ${requestId}`
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
        `[DownloadHelper] Skipping S${season}E${episode} - already ${tvEpisode.status.toLowerCase()}`
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

    console.log(
      `[DownloadHelper] Updated S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} to DOWNLOADED: ${file.name}`
    );
  }

  // Sort by season then episode
  episodeFiles.sort((a, b) => {
    if (a.season !== b.season) return a.season - b.season;
    return a.episode - b.episode;
  });

  console.log(
    `[DownloadHelper] Extracted ${episodeFiles.length} episodes from ${videoFiles.length} video files`
  );

  return episodeFiles;
}
