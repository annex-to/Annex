import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../setup";

const mockPrisma = createMockPrisma();
mock.module("../../../../db/client", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

const { resolveSourceFilePath } = await import(
  "../../../../services/pipeline/workers/EncodeWorker"
);

describe("resolveSourceFilePath", () => {
  beforeEach(() => {
    mockPrisma._clear();
  });

  afterEach(() => {
    mockPrisma._clear();
  });

  test("returns the DownloadFile.absolutePath when one exists", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 200, type: "TV", title: "S", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "z1",
        torrentName: "S",
        mediaType: "TV",
        status: "COMPLETED",
        fileMapStatus: "MAPPED",
      },
    });
    const item = await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 200,
        title: "S",
        season: 1,
        episode: 1,
        status: "DOWNLOADED",
        downloadId: download.id,
      },
    });
    await mockPrisma.downloadFile.create({
      data: {
        downloadId: download.id,
        relativePath: "S01E01.mkv",
        absolutePath: "/files/S01E01.mkv",
        sizeBytes: BigInt(1_000_000_000),
        kind: "VIDEO_MAIN",
        parserVersion: "v1",
        confidence: 0.99,
        processingItemId: item.id,
      },
    });

    const reloaded = await mockPrisma.processingItem.findUnique({ where: { id: item.id } });
    const path = await resolveSourceFilePath(reloaded);
    expect(path).toBe("/files/S01E01.mkv");
  });

  test("falls back to stepContext.download.sourceFilePath when no DownloadFile", async () => {
    const request = await mockPrisma.mediaRequest.create({
      data: { tmdbId: 201, type: "TV", title: "S", status: "PROCESSING" },
    });
    const download = await mockPrisma.download.create({
      data: {
        requestId: request.id,
        torrentHash: "z2",
        torrentName: "S",
        mediaType: "TV",
        status: "COMPLETED",
      },
    });
    const item = await mockPrisma.processingItem.create({
      data: {
        requestId: request.id,
        type: "EPISODE",
        tmdbId: 201,
        title: "S",
        season: 1,
        episode: 1,
        status: "DOWNLOADED",
        downloadId: download.id,
        stepContext: { download: { sourceFilePath: "/legacy/path.mkv", torrentHash: "z2" } },
      },
    });

    const path = await resolveSourceFilePath(item);
    expect(path).toBe("/legacy/path.mkv");
  });
});
