import { basename } from "node:path";
import { prisma } from "../src/db/client";

export async function backfillDownloadFiles(): Promise<{
  filesCreated: number;
  downloadsMarked: number;
}> {
  let filesCreated = 0;
  let downloadsMarked = 0;

  const items = await prisma.processingItem.findMany({
    where: {
      sourceFilePath: { not: null },
      downloadId: { not: null },
      downloadFile: { is: null },
    },
    select: {
      id: true,
      downloadId: true,
      sourceFilePath: true,
      season: true,
      episode: true,
      type: true,
    },
  });

  for (const item of items) {
    if (!item.downloadId || !item.sourceFilePath) continue;

    const download = await prisma.download.findUnique({
      where: { id: item.downloadId },
      select: { contentPath: true, savePath: true },
    });
    if (!download) continue;

    const root = download.contentPath || download.savePath || "";
    const relativePath =
      root && item.sourceFilePath.startsWith(root)
        ? item.sourceFilePath.slice(root.length).replace(/^\//, "")
        : basename(item.sourceFilePath);

    await prisma.downloadFile.upsert({
      where: {
        downloadId_relativePath: { downloadId: item.downloadId, relativePath },
      },
      create: {
        downloadId: item.downloadId,
        relativePath,
        absolutePath: item.sourceFilePath,
        sizeBytes: BigInt(0),
        kind: "VIDEO_MAIN",
        season: item.season ?? undefined,
        episode: item.episode ?? undefined,
        parserVersion: "backfill-v1",
        confidence: 1.0,
        processingItemId: item.id,
      },
      update: { processingItemId: item.id },
    });
    filesCreated += 1;
  }

  const downloads = await prisma.download.findMany({
    where: {
      fileMapStatus: "PENDING",
      processingItems: {
        some: {
          status: { in: ["DOWNLOADED", "ENCODING", "ENCODED", "DELIVERING", "COMPLETED"] },
        },
      },
    },
    select: { id: true },
  });

  for (const d of downloads) {
    await prisma.download.update({
      where: { id: d.id },
      data: { fileMapStatus: "MAPPED" },
    });
    downloadsMarked += 1;
  }

  return { filesCreated, downloadsMarked };
}

if (import.meta.main) {
  const result = await backfillDownloadFiles();
  console.log(
    `[backfill] Created ${result.filesCreated} DownloadFile rows, marked ${result.downloadsMarked} downloads`
  );
  process.exit(0);
}
