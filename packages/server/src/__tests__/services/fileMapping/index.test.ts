import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../setup";

const mockPrisma = createMockPrisma();
mock.module("../../../db/client", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

const fakeFiles = [
  { name: "Show.S01E01.1080p.mkv", size: 2_000_000_000 },
  { name: "Show.S01E02.1080p.mkv", size: 2_000_000_000 },
  { name: "Show.sample.mkv", size: 50_000_000 },
];

mock.module("../../../services/downloadClients/QBittorrentClient", () => ({
  getDownloadService: () => ({
    getTorrentFiles: async () => fakeFiles,
    getProgress: async () => ({ savePath: "/downloads/Show.S01" }),
  }),
}));

const { mapDownloadFiles } = await import("../../../services/fileMapping/index");

describe("mapDownloadFiles", () => {
  beforeEach(() => {
    mockPrisma._clear();
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  test("creates DownloadFile rows for video files, links PIs, rejects samples", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 10, type: "TV", title: "Show", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "h1",
        torrentName: "Show.S01",
        mediaType: "TV",
        isSeasonPack: true,
        season: 1,
        status: "COMPLETED",
        fileMapStatus: "PENDING",
      },
    });
    const e1 = await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 10,
        title: "Show",
        season: 1,
        episode: 1,
        status: "DOWNLOADING",
        downloadId: download.id,
      },
    });
    const e2 = await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 10,
        title: "Show",
        season: 1,
        episode: 2,
        status: "DOWNLOADING",
        downloadId: download.id,
      },
    });

    const result = await mapDownloadFiles(download.id);
    expect(result.fileMapStatus).toBe("MAPPED");

    const files = await mockPrisma.downloadFile.findMany({
      where: { downloadId: download.id },
    });
    expect(files).toHaveLength(3);
    const sample = files.find((f: any) => f.rejectReason === "sample");
    expect(sample).toBeDefined();
    expect(files.find((f: any) => f.processingItemId === e1.id)).toBeDefined();
    expect(files.find((f: any) => f.processingItemId === e2.id)).toBeDefined();
  });

  test("is idempotent — second call does not duplicate rows", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 11, type: "TV", title: "Show", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "h2",
        torrentName: "Show",
        mediaType: "TV",
        isSeasonPack: true,
        season: 1,
        status: "COMPLETED",
        fileMapStatus: "PENDING",
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 11,
        title: "Show",
        season: 1,
        episode: 1,
        status: "DOWNLOADING",
        downloadId: download.id,
      },
    });
    await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 11,
        title: "Show",
        season: 1,
        episode: 2,
        status: "DOWNLOADING",
        downloadId: download.id,
      },
    });

    await mapDownloadFiles(download.id);
    await mapDownloadFiles(download.id);

    const count = await mockPrisma.downloadFile.count({ where: { downloadId: download.id } });
    expect(count).toBe(3);
  });
});
