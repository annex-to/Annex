import { prisma } from "../../db/client";
import { getDownloadService } from "../downloadClients/QBittorrentClient";
import { classifyFile } from "./classifiers";
import { matchFilesToItems } from "./matcher";
import { dailyAirParser } from "./parsers/dailyAir";
import { multiEpisodeParser } from "./parsers/multiEpisode";
import { seasonEpisodeParser } from "./parsers/seasonEpisode";
import { type FilenameParser, PARSER_VERSION, type ParsedFile } from "./types";

const PARSERS: FilenameParser[] = [multiEpisodeParser, seasonEpisodeParser, dailyAirParser];

function parseFilename(filename: string): ParsedFile {
  for (const parser of PARSERS) {
    const result = parser.parse(filename);
    if (result) return result;
  }
  return { confidence: 0, parserName: "none" };
}

export interface MapDownloadFilesResult {
  fileMapStatus: "MAPPED" | "FAILED";
  orphans: string[];
  misses: string[];
}

export async function mapDownloadFiles(downloadId: string): Promise<MapDownloadFilesResult> {
  const download = await prisma.download.findUniqueOrThrow({
    where: { id: downloadId },
    select: {
      id: true,
      torrentHash: true,
      contentPath: true,
      savePath: true,
      requestId: true,
    },
  });

  await prisma.download.update({
    where: { id: downloadId },
    data: { fileMapStatus: "MAPPING" },
  });

  const client = getDownloadService();
  const torrentFiles = await client.getTorrentFiles(download.torrentHash);
  const progress = await client.getProgress(download.torrentHash);
  const root = download.contentPath || download.savePath || progress?.savePath || "";

  const items = await prisma.processingItem.findMany({
    where: {
      downloadId,
      status: { notIn: ["COMPLETED", "CANCELLED"] },
    },
    select: { id: true, season: true, episode: true },
  });

  const matcherFiles: Array<{ relativePath: string; parsed: ParsedFile }> = [];

  for (const file of torrentFiles) {
    const classification = classifyFile({ name: file.name, sizeBytes: file.size });
    const parsed =
      classification.kind === "VIDEO_MAIN"
        ? parseFilename(file.name)
        : { confidence: 0, parserName: "none" };
    const absolutePath = root ? `${root.replace(/\/$/, "")}/${file.name}` : file.name;

    await prisma.downloadFile.upsert({
      where: {
        downloadId_relativePath: { downloadId, relativePath: file.name },
      },
      create: {
        downloadId,
        relativePath: file.name,
        absolutePath,
        sizeBytes: BigInt(file.size),
        kind: classification.kind,
        season: parsed.season,
        episode: parsed.episode,
        episodeEnd: parsed.episodeEnd,
        airDate: parsed.airDate,
        absoluteNumber: parsed.absoluteNumber,
        parserVersion: PARSER_VERSION,
        confidence: parsed.confidence,
        rejected: classification.rejected,
        rejectReason: classification.rejectReason,
      },
      update: {
        absolutePath,
        sizeBytes: BigInt(file.size),
        kind: classification.kind,
        season: parsed.season,
        episode: parsed.episode,
        episodeEnd: parsed.episodeEnd,
        airDate: parsed.airDate,
        absoluteNumber: parsed.absoluteNumber,
        parserVersion: PARSER_VERSION,
        confidence: parsed.confidence,
        rejected: classification.rejected,
        rejectReason: classification.rejectReason,
      },
    });

    if (classification.kind === "VIDEO_MAIN" && !classification.rejected) {
      matcherFiles.push({ relativePath: file.name, parsed });
    }
  }

  const match = matchFilesToItems({ files: matcherFiles, items });

  for (const assignment of match.assignments) {
    await prisma.downloadFile.update({
      where: {
        downloadId_relativePath: { downloadId, relativePath: assignment.relativePath },
      },
      data: { processingItemId: assignment.processingItemId },
    });
  }

  await prisma.download.update({
    where: { id: downloadId },
    data: { fileMapStatus: "MAPPED" },
  });

  return { fileMapStatus: "MAPPED", orphans: match.orphans, misses: match.misses };
}
