#!/usr/bin/env bun
/**
 * Backfill script: Copy TvEpisode data to ProcessingItems
 *
 * Copies tracking fields from TvEpisode to ProcessingItem for episodes
 * that exist in both tables. This ensures data consistency during migration.
 */

import { prisma } from "../src/db/client.js";

async function backfillProcessingItems() {
  console.log("[Backfill] Starting TvEpisode → ProcessingItem data migration...\n");

  // Get all TvEpisodes with their associated ProcessingItems
  const tvEpisodes = await prisma.tvEpisode.findMany({
    select: {
      id: true,
      requestId: true,
      season: true,
      episode: true,
      sourceFilePath: true,
      airDate: true,
      downloadedAt: true,
      encodedAt: true,
      deliveredAt: true,
      qualityMet: true,
      availableReleases: true,
    },
  });

  console.log(`[Backfill] Found ${tvEpisodes.length} TvEpisode records`);

  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const tvEpisode of tvEpisodes) {
    try {
      // Find corresponding ProcessingItem
      const processingItem = await prisma.processingItem.findFirst({
        where: {
          requestId: tvEpisode.requestId,
          type: "EPISODE",
          season: tvEpisode.season,
          episode: tvEpisode.episode,
        },
        select: { id: true, sourceFilePath: true },
      });

      if (!processingItem) {
        notFound++;
        continue;
      }

      // Skip if ProcessingItem already has sourceFilePath (already migrated)
      if (processingItem.sourceFilePath) {
        skipped++;
        continue;
      }

      // Copy data from TvEpisode to ProcessingItem
      await prisma.processingItem.update({
        where: { id: processingItem.id },
        data: {
          sourceFilePath: tvEpisode.sourceFilePath,
          airDate: tvEpisode.airDate,
          downloadedAt: tvEpisode.downloadedAt,
          encodedAt: tvEpisode.encodedAt,
          deliveredAt: tvEpisode.deliveredAt,
          qualityMet: tvEpisode.qualityMet ?? false,
          availableReleases: tvEpisode.availableReleases,
        },
      });

      updated++;

      if (updated % 10 === 0) {
        console.log(`[Backfill] Progress: ${updated} updated...`);
      }
    } catch (error) {
      console.error(
        `[Backfill] Error processing S${tvEpisode.season}E${tvEpisode.episode}:`,
        error
      );
    }
  }

  console.log(`\n[Backfill] Complete!`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (already migrated): ${skipped}`);
  console.log(`  Not found (no ProcessingItem): ${notFound}`);

  await prisma.$disconnect();
}

backfillProcessingItems().catch((error) => {
  console.error("[Backfill] Fatal error:", error);
  process.exit(1);
});
