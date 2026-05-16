import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../setup";

const mockPrisma = createMockPrisma();
mock.module("../../../../db/client", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

mock.module("../../../../services/fileMapping", () => ({
  mapDownloadFiles: async (id: string) => {
    await mockPrisma.download.update({
      where: { id },
      data: { fileMapStatus: "MAPPED" },
    });
    await mockPrisma.processingItem.updateMany({
      where: { downloadId: id, status: "DOWNLOADING" },
      data: { status: "DOWNLOADED" },
    });
    return { fileMapStatus: "MAPPED" as const, orphans: [], misses: [] };
  },
}));

const { FileMapWorker } = await import("../../../../services/pipeline/workers/FileMapWorker");

describe("FileMapWorker", () => {
  beforeEach(() => {
    mockPrisma._clear();
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  test("processes a PENDING download whose torrent is COMPLETED", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 50, type: "TV", title: "S", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "x",
        torrentName: "S",
        mediaType: "TV",
        status: "COMPLETED",
        fileMapStatus: "PENDING",
        mapAttempts: 0,
      },
    });
    const item = await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 50,
        title: "S",
        season: 1,
        episode: 1,
        status: "DOWNLOADING",
        downloadId: download.id,
      },
    });

    const worker = new FileMapWorker();
    await worker.processBatch();

    const reloaded = await mockPrisma.download.findUnique({ where: { id: download.id } });
    expect(reloaded.fileMapStatus).toBe("MAPPED");
    const itemReloaded = await mockPrisma.processingItem.findUnique({ where: { id: item.id } });
    expect(itemReloaded.status).toBe("DOWNLOADED");
  });

  test("skips downloads whose torrent is still DOWNLOADING", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 51, type: "TV", title: "S", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "y",
        torrentName: "S",
        mediaType: "TV",
        status: "DOWNLOADING",
        fileMapStatus: "PENDING",
        mapAttempts: 0,
      },
    });

    const worker = new FileMapWorker();
    await worker.processBatch();

    const reloaded = await mockPrisma.download.findUnique({ where: { id: download.id } });
    expect(reloaded.fileMapStatus).toBe("PENDING");
  });
});
