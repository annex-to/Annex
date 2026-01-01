/**
 * Recovery script: Mark episodes as COMPLETED if they're already on Plex
 *
 * For episodes in DELIVERING status with missing encoded files,
 * check if they're already delivered to Plex. If so, mark as COMPLETED.
 */

import { prisma } from "./src/db/client.js";
import { ProcessingStatus } from "@prisma/client";

const REQUEST_ID = "26fe8e2d-c0b0-4091-8742-0e27c87f2343"; // The Sopranos

async function recoverDeliveredEpisodes() {
  console.log(`[Recovery] Checking episodes for request ${REQUEST_ID}...`);

  // Get episodes in DELIVERING status
  const deliveringEpisodes = await prisma.processingItem.findMany({
    where: {
      requestId: REQUEST_ID,
      status: ProcessingStatus.DELIVERING,
    },
    select: {
      id: true,
      title: true,
      season: true,
      episode: true,
      tmdbId: true,
    },
  });

  console.log(`[Recovery] Found ${deliveringEpisodes.length} episodes in DELIVERING status`);

  if (deliveringEpisodes.length === 0) {
    console.log("[Recovery] No episodes to recover");
    return;
  }

  // Get Plex server
  const plexServer = await prisma.storageServer.findFirst({
    where: {
      name: "Plex",
      mediaServerType: "PLEX",
    },
  });

  if (!plexServer) {
    console.error("[Recovery] Plex server not found");
    return;
  }

  console.log(`[Recovery] Checking against Plex library...`);

  // Get all library items for The Sopranos from Plex
  const libraryEpisodes = await prisma.libraryItem.findMany({
    where: {
      serverId: plexServer.id,
      tmdbId: deliveringEpisodes[0]?.tmdbId, // Use first episode's tmdbId (series tmdbId)
      type: "TV",
    },
    select: {
      season: true,
      episode: true,
      title: true,
    },
  });

  console.log(`[Recovery] Found ${libraryEpisodes.length} episodes in Plex library`);

  // Create a set of delivered episodes (season-episode pairs)
  const deliveredSet = new Set(
    libraryEpisodes.map((e) => `S${e.season}E${e.episode}`)
  );

  let markedComplete = 0;
  let missing = 0;

  for (const episode of deliveringEpisodes) {
    const episodeKey = `S${episode.season}E${episode.episode}`;
    const isDelivered = deliveredSet.has(episodeKey);

    if (isDelivered) {
      console.log(
        `[Recovery] ✓ ${episodeKey} ${episode.title}: Already on Plex - marking COMPLETED`
      );

      await prisma.processingItem.update({
        where: { id: episode.id },
        data: {
          status: ProcessingStatus.COMPLETED,
          progress: 100,
          completedAt: new Date(),
          lastError: null,
        },
      });

      markedComplete++;
    } else {
      console.log(
        `[Recovery] ✗ ${episodeKey} ${episode.title}: NOT on Plex - needs re-encoding`
      );
      missing++;
    }
  }

  console.log(`\n[Recovery] Summary:`);
  console.log(`  ${markedComplete} episodes marked as COMPLETED (already delivered)`);
  console.log(`  ${missing} episodes need re-encoding`);

  // Update request aggregates
  const stats = await prisma.processingItem.groupBy({
    by: ["status"],
    where: { requestId: REQUEST_ID },
    _count: { status: true },
  });

  console.log(`\n[Recovery] Request stats:`);
  stats.forEach((stat) => {
    console.log(`  ${stat.status}: ${stat._count.status}`);
  });
}

recoverDeliveredEpisodes()
  .then(() => {
    console.log("\n[Recovery] Done");
    process.exit(0);
  })
  .catch((error) => {
    console.error("[Recovery] Error:", error);
    process.exit(1);
  });
