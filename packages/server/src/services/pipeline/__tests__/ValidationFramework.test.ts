import { describe, expect, test } from "bun:test";
import type { ProcessingItem } from "@prisma/client";
import { ValidationError, ValidationFramework } from "../ValidationFramework.js";

const vf = new ValidationFramework();

function createItem(overrides: Partial<ProcessingItem> = {}): ProcessingItem {
  return {
    id: "item-1",
    requestId: "req-1",
    type: "MOVIE",
    tmdbId: 27205,
    title: "Inception",
    year: 2010,
    season: null,
    episode: null,
    status: "PENDING",
    currentStep: null,
    stepContext: null,
    checkpoint: null,
    errorHistory: null,
    attempts: 0,
    maxAttempts: 5,
    lastError: null,
    nextRetryAt: null,
    skipUntil: null,
    progress: 0,
    lastProgressUpdate: null,
    lastProgressValue: null,
    downloadId: null,
    encodingJobId: null,
    sourceFilePath: null,
    downloadedAt: null,
    encodedAt: null,
    deliveredAt: null,
    airDate: null,
    discoveredAt: null,
    cooldownEndsAt: null,
    allSearchResults: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ProcessingItem;
}

describe("ValidationFramework", () => {
  describe("validateEntry", () => {
    test("PENDING is always valid", async () => {
      const result = await vf.validateEntry(createItem(), "PENDING");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    describe("SEARCHING entry", () => {
      test("passes with tmdbId and title", async () => {
        const item = createItem({ tmdbId: 27205, title: "Inception" });
        const result = await vf.validateEntry(item, "SEARCHING");
        expect(result.valid).toBe(true);
      });

      test("fails without tmdbId", async () => {
        const item = createItem({ tmdbId: 0, title: "Inception" });
        const result = await vf.validateEntry(item, "SEARCHING");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("TMDB ID required for searching");
      });

      test("fails without title", async () => {
        const item = createItem({ tmdbId: 27205, title: "" });
        const result = await vf.validateEntry(item, "SEARCHING");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Title required for searching");
      });

      test("fails with both missing", async () => {
        const item = createItem({ tmdbId: 0, title: "" });
        const result = await vf.validateEntry(item, "SEARCHING");
        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(2);
      });
    });

    describe("FOUND entry", () => {
      test("passes with selectedRelease in stepContext", async () => {
        const item = createItem({
          stepContext: { selectedRelease: { title: "test" } } as any,
        });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(true);
      });

      test("passes with selectedPacks in stepContext", async () => {
        const item = createItem({
          stepContext: { selectedPacks: [{ title: "test" }] } as any,
        });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(true);
      });

      test("passes with existingDownload in stepContext", async () => {
        const item = createItem({
          stepContext: { existingDownload: { torrentHash: "abc" } } as any,
        });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(true);
      });

      test("passes with alternativeReleases in stepContext", async () => {
        const item = createItem({
          stepContext: { alternativeReleases: [{ title: "alt" }] } as any,
        });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(true);
      });

      test("fails with no relevant data in stepContext", async () => {
        const item = createItem({ stepContext: {} as any });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("No release selected from search results");
      });

      test("fails with null stepContext", async () => {
        const item = createItem({ stepContext: null });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(false);
      });

      test("fails with empty alternativeReleases array", async () => {
        const item = createItem({
          stepContext: { alternativeReleases: [] } as any,
        });
        const result = await vf.validateEntry(item, "FOUND");
        expect(result.valid).toBe(false);
      });
    });

    describe("DISCOVERED entry", () => {
      test("passes with selectedRelease and cooldownEndsAt", async () => {
        const item = createItem({
          stepContext: { selectedRelease: { title: "test" } } as any,
          cooldownEndsAt: new Date(Date.now() + 60000),
        });
        const result = await vf.validateEntry(item, "DISCOVERED");
        expect(result.valid).toBe(true);
      });

      test("fails without cooldownEndsAt", async () => {
        const item = createItem({
          stepContext: { selectedRelease: { title: "test" } } as any,
          cooldownEndsAt: null,
        });
        const result = await vf.validateEntry(item, "DISCOVERED");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Cooldown end time must be set for DISCOVERED status");
      });

      test("fails without release data", async () => {
        const item = createItem({
          stepContext: {} as any,
          cooldownEndsAt: new Date(),
        });
        const result = await vf.validateEntry(item, "DISCOVERED");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain(
          "No release, packs, or existing download selected for discovery cooldown"
        );
      });
    });

    describe("DOWNLOADING entry", () => {
      test("is always valid (downloadId optional)", async () => {
        const item = createItem();
        const result = await vf.validateEntry(item, "DOWNLOADING");
        expect(result.valid).toBe(true);
      });
    });

    describe("DOWNLOADED entry", () => {
      test("passes with sourceFilePath in download context", async () => {
        const item = createItem({
          stepContext: { download: { sourceFilePath: "/path/to/file.mkv" } } as any,
        });
        const result = await vf.validateEntry(item, "DOWNLOADED");
        expect(result.valid).toBe(true);
      });

      test("passes with episodeFiles in download context", async () => {
        const item = createItem({
          stepContext: {
            download: { episodeFiles: [{ path: "/path/ep1.mkv" }] },
          } as any,
        });
        const result = await vf.validateEntry(item, "DOWNLOADED");
        expect(result.valid).toBe(true);
      });

      test("fails without sourceFilePath or episodeFiles", async () => {
        const item = createItem({
          stepContext: { download: {} } as any,
        });
        const result = await vf.validateEntry(item, "DOWNLOADED");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Download file path required for downloaded state");
      });

      test("fails with no download data at all", async () => {
        const item = createItem({ stepContext: {} as any });
        const result = await vf.validateEntry(item, "DOWNLOADED");
        expect(result.valid).toBe(false);
      });
    });

    describe("ENCODING entry", () => {
      test("passes with download sourceFilePath", async () => {
        const item = createItem({
          stepContext: { download: { sourceFilePath: "/path/file.mkv" } } as any,
        });
        const result = await vf.validateEntry(item, "ENCODING");
        expect(result.valid).toBe(true);
      });

      test("passes with download episodeFiles", async () => {
        const item = createItem({
          stepContext: {
            download: { episodeFiles: [{ path: "/ep.mkv" }] },
          } as any,
        });
        const result = await vf.validateEntry(item, "ENCODING");
        expect(result.valid).toBe(true);
      });

      test("fails without download data", async () => {
        const item = createItem({ stepContext: {} as any });
        const result = await vf.validateEntry(item, "ENCODING");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Download data required for encoding");
      });
    });

    describe("ENCODED entry", () => {
      test("passes with encodedFiles containing path", async () => {
        const item = createItem({
          stepContext: {
            encode: { encodedFiles: [{ path: "/encoded.mkv" }] },
          } as any,
        });
        const result = await vf.validateEntry(item, "ENCODED");
        expect(result.valid).toBe(true);
      });

      test("fails with empty encodedFiles", async () => {
        const item = createItem({
          stepContext: { encode: { encodedFiles: [] } } as any,
        });
        const result = await vf.validateEntry(item, "ENCODED");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Encoded file path required for encoded state");
      });

      test("fails with no encode data", async () => {
        const item = createItem({ stepContext: {} as any });
        const result = await vf.validateEntry(item, "ENCODED");
        expect(result.valid).toBe(false);
      });

      test("fails when first file has no path", async () => {
        const item = createItem({
          stepContext: {
            encode: { encodedFiles: [{ size: 100 }] },
          } as any,
        });
        const result = await vf.validateEntry(item, "ENCODED");
        expect(result.valid).toBe(false);
      });
    });

    describe("DELIVERING entry", () => {
      test("passes with encodedFiles", async () => {
        const item = createItem({
          stepContext: {
            encode: { encodedFiles: [{ path: "/encoded.mkv" }] },
          } as any,
        });
        const result = await vf.validateEntry(item, "DELIVERING");
        expect(result.valid).toBe(true);
      });

      test("fails without encodedFiles", async () => {
        const item = createItem({ stepContext: {} as any });
        const result = await vf.validateEntry(item, "DELIVERING");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Encoded file path required for delivery");
      });
    });

    describe("COMPLETED entry", () => {
      test("passes with deliveryResults", async () => {
        const item = createItem({
          stepContext: { deliveryResults: [{ serverId: "s1" }] } as any,
        });
        const result = await vf.validateEntry(item, "COMPLETED");
        expect(result.valid).toBe(true);
      });

      test("fails without deliveryResults", async () => {
        const item = createItem({ stepContext: {} as any });
        const result = await vf.validateEntry(item, "COMPLETED");
        expect(result.valid).toBe(false);
        expect(result.errors).toContain("Delivery results required for completion");
      });
    });

    describe("FAILED and CANCELLED entry", () => {
      test("FAILED is always valid", async () => {
        const result = await vf.validateEntry(createItem(), "FAILED");
        expect(result.valid).toBe(true);
      });

      test("CANCELLED is always valid", async () => {
        const result = await vf.validateEntry(createItem(), "CANCELLED");
        expect(result.valid).toBe(true);
      });
    });
  });

  describe("validateExit", () => {
    test("PENDING exit has no validation", async () => {
      const result = await vf.validateExit(createItem(), "PENDING");
      expect(result.valid).toBe(true);
    });

    test("SEARCHING exit requires search results", async () => {
      const item = createItem({ stepContext: {} as any });
      const result = await vf.validateExit(item, "SEARCHING");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("No search results found");
    });

    test("SEARCHING exit passes with selectedRelease", async () => {
      const item = createItem({
        stepContext: { selectedRelease: { title: "test" } } as any,
      });
      const result = await vf.validateExit(item, "SEARCHING");
      expect(result.valid).toBe(true);
    });

    test("DOWNLOADING exit requires complete download data", async () => {
      const item = createItem({ stepContext: { download: {} } as any });
      const result = await vf.validateExit(item, "DOWNLOADING");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Download not marked as complete");
    });

    test("DOWNLOADING exit passes with isComplete", async () => {
      const item = createItem({
        stepContext: { download: { isComplete: true } } as any,
      });
      const result = await vf.validateExit(item, "DOWNLOADING");
      expect(result.valid).toBe(true);
    });

    test("DOWNLOADING exit passes with sourceFilePath", async () => {
      const item = createItem({
        stepContext: { download: { sourceFilePath: "/path" } } as any,
      });
      const result = await vf.validateExit(item, "DOWNLOADING");
      expect(result.valid).toBe(true);
    });

    test("ENCODING exit requires encoded files", async () => {
      const item = createItem({ stepContext: {} as any });
      const result = await vf.validateExit(item, "ENCODING");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Encoding not complete - no encoded files found");
    });

    test("ENCODING exit passes with encoded files", async () => {
      const item = createItem({
        stepContext: {
          encode: { encodedFiles: [{ path: "/out.mkv" }] },
        } as any,
      });
      const result = await vf.validateExit(item, "ENCODING");
      expect(result.valid).toBe(true);
    });

    test("DELIVERING exit requires allDeliveriesComplete", async () => {
      const item = createItem({ stepContext: {} as any });
      const result = await vf.validateExit(item, "DELIVERING");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Not all deliveries marked as complete");
    });

    test("DELIVERING exit passes with allDeliveriesComplete", async () => {
      const item = createItem({
        stepContext: { allDeliveriesComplete: true } as any,
      });
      const result = await vf.validateExit(item, "DELIVERING");
      expect(result.valid).toBe(true);
    });

    test("terminal states have no exit validation", async () => {
      for (const status of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
        const result = await vf.validateExit(createItem(), status);
        expect(result.valid).toBe(true);
      }
    });

    test("DISCOVERED exit requires selected release or packs", async () => {
      const item = createItem({ stepContext: {} as any });
      const result = await vf.validateExit(item, "DISCOVERED");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("No release selected");
    });
  });

  describe("validateTransition", () => {
    test("combines entry and exit validation", async () => {
      const item = createItem({
        status: "SEARCHING",
        stepContext: { selectedRelease: { title: "test" } } as any,
      });
      const result = await vf.validateTransition(item, "SEARCHING", "FOUND", {
        stepContext: { selectedRelease: { title: "test" } },
      });
      expect(result.valid).toBe(true);
    });

    test("skips exit validation for FAILED transition", async () => {
      const item = createItem({
        status: "SEARCHING",
        stepContext: {} as any,
      });
      const result = await vf.validateTransition(item, "SEARCHING", "FAILED");
      expect(result.valid).toBe(true);
    });

    test("skips exit validation for CANCELLED transition", async () => {
      const item = createItem({
        status: "ENCODING",
        stepContext: {} as any,
      });
      const result = await vf.validateTransition(item, "ENCODING", "CANCELLED");
      expect(result.valid).toBe(true);
    });

    test("returns exit errors when non-terminal", async () => {
      const item = createItem({
        status: "SEARCHING",
        stepContext: {} as any,
      });
      const result = await vf.validateTransition(item, "SEARCHING", "FOUND");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("Exit validation failed");
    });

    test("uses newContext for validation if provided", async () => {
      const item = createItem({
        status: "PENDING",
        stepContext: null,
        tmdbId: 27205,
        title: "Inception",
      });
      const result = await vf.validateTransition(item, "PENDING", "FOUND", {
        stepContext: { selectedRelease: { title: "Inception.2010.1080p" } },
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("assertValid", () => {
    test("does not throw for valid entry", async () => {
      const item = createItem({ tmdbId: 27205, title: "Inception" });
      await expect(vf.assertValid(item, "SEARCHING", "entry")).resolves.toBeUndefined();
    });

    test("throws ValidationError for invalid entry", async () => {
      const item = createItem({ tmdbId: 0, title: "" });
      try {
        await vf.assertValid(item, "SEARCHING", "entry");
        expect(true).toBe(false); // Should not reach
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).itemId).toBe("item-1");
        expect((e as ValidationError).status).toBe("SEARCHING");
        expect((e as ValidationError).validationType).toBe("entry");
      }
    });

    test("throws ValidationError for invalid exit", async () => {
      const item = createItem({ stepContext: {} as any });
      try {
        await vf.assertValid(item, "SEARCHING", "exit");
        expect(true).toBe(false);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        expect((e as ValidationError).validationType).toBe("exit");
      }
    });
  });
});
