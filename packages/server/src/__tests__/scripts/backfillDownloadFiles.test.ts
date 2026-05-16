import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../setup";

const mockPrisma = createMockPrisma();
mock.module("../../db/client", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

const { backfillDownloadFiles } = await import("../../../scripts/backfill-download-files");

describe("backfillDownloadFiles", () => {
  beforeEach(() => {
    mockPrisma._clear();
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  test("creates a DownloadFile row for each ProcessingItem with sourceFilePath", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 1, type: "TV", title: "Test Show", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "abc123",
        torrentName: "Test.Show.S01.Pack",
        mediaType: "TV",
        isSeasonPack: true,
        season: 1,
        status: "COMPLETED",
        fileMapStatus: "PENDING",
        contentPath: "/downloads/Test.Show.S01.Pack",
      },
    });
    const item = await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 1,
        title: "Test Show",
        season: 1,
        episode: 1,
        status: "ENCODED",
        downloadId: download.id,
        sourceFilePath: "/downloads/Test.Show.S01.Pack/Test.Show.S01E01.mkv",
      },
    });

    const result = await backfillDownloadFiles();

    expect(result.filesCreated).toBe(1);
    const files = await mockPrisma.downloadFile.findMany({ where: { downloadId: download.id } });
    expect(files).toHaveLength(1);
    expect(files[0].processingItemId).toBe(item.id);
    expect(files[0].absolutePath).toBe("/downloads/Test.Show.S01.Pack/Test.Show.S01E01.mkv");
    expect(files[0].relativePath).toBe("Test.Show.S01E01.mkv");
    expect(files[0].season).toBe(1);
    expect(files[0].episode).toBe(1);
    expect(files[0].kind).toBe("VIDEO_MAIN");
    expect(files[0].parserVersion).toBe("backfill-v1");
  });

  test("sets Download.fileMapStatus to MAPPED for downloads whose items reached DOWNLOADED", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 2, type: "MOVIE", title: "Movie", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "def456",
        torrentName: "Movie.2024.mkv",
        mediaType: "MOVIE",
        status: "COMPLETED",
        fileMapStatus: "PENDING",
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "MOVIE",
        tmdbId: 2,
        title: "Movie",
        status: "ENCODED",
        downloadId: download.id,
        sourceFilePath: "/downloads/Movie.2024.mkv",
      },
    });

    await backfillDownloadFiles();

    const reloaded = await mockPrisma.download.findUnique({ where: { id: download.id } });
    expect(reloaded.fileMapStatus).toBe("MAPPED");
  });

  test("is idempotent — running twice does not duplicate rows", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 3, type: "MOVIE", title: "M", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "h",
        torrentName: "M.mkv",
        mediaType: "MOVIE",
        status: "COMPLETED",
        fileMapStatus: "PENDING",
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "MOVIE",
        tmdbId: 3,
        title: "M",
        status: "ENCODED",
        downloadId: download.id,
        sourceFilePath: "/downloads/M.mkv",
      },
    });

    await backfillDownloadFiles();
    await backfillDownloadFiles();

    const count = await mockPrisma.downloadFile.count({ where: { downloadId: download.id } });
    expect(count).toBe(1);
  });
});
