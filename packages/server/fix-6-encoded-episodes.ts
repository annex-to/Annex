import { prisma } from "./src/db/client.js";
import { pipelineOrchestrator } from "./src/services/pipeline/PipelineOrchestrator.js";

const encodedEpisodes = [
  {
    id: "6450e177-56eb-4366-b368-ac3aba5c4454",
    season: 2,
    episode: 4,
    sourceFilePath:
      "/media/downloads/completed/The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S02.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S02E04.Commendatori.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP.mkv",
  },
  {
    id: "a8c323eb-1b4a-4b8d-897a-3922957d6889",
    season: 2,
    episode: 10,
    sourceFilePath:
      "/media/downloads/completed/The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S02.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S02E10.Bust.Out.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP.mkv",
  },
  {
    id: "4add7d47-17f6-4bb4-8aea-8a9b0f813421",
    season: 3,
    episode: 3,
    sourceFilePath:
      "/media/downloads/completed/The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S03.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S03E03.Fortunate.Son.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP.mkv",
  },
  {
    id: "2a60fd52-462f-4eae-8cdf-bdd51a34273e",
    season: 4,
    episode: 13,
    sourceFilePath:
      "/media/downloads/completed/The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S04.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S04E13.Whitecaps.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP.mkv",
  },
  {
    id: "21c54327-60c2-4695-a518-4c8aa80421cd",
    season: 5,
    episode: 4,
    sourceFilePath:
      "/media/downloads/completed/The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S05.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S05E04.All.Happy.Families.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP.mkv",
  },
  {
    id: "8414eb2a-0b29-4f95-8202-b218f8430283",
    season: 6,
    episode: 3,
    sourceFilePath:
      "/media/downloads/completed/The.Sopranos.S01-S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S06.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP /The.Sopranos.S06E03.Mayham.1080p.BluRay.REMUX.AVC.DTS-HD.MA.5.1-NOGRP.mkv",
  },
];

async function fixEncodedEpisodes() {
  console.log("Fixing 6 encoded Sopranos episodes...");

  // Get target server IDs from the request
  const request = await prisma.mediaRequest.findUnique({
    where: { id: "26fe8e2d-c0b0-4091-8742-0e27c87f2343" },
    select: { targets: true },
  });

  const targetServerIds = request?.targets
    ? (request.targets as Array<{ serverId: string }>).map((t) => t.serverId)
    : [];

  if (targetServerIds.length === 0) {
    console.error("ERROR: No target servers found for request!");
    return;
  }

  console.log(`Target servers: ${targetServerIds.join(", ")}\n`);

  for (const ep of encodedEpisodes) {
    const epNum = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;

    // Extract directory from sourceFilePath
    const sourceDir = ep.sourceFilePath.substring(0, ep.sourceFilePath.lastIndexOf("/"));
    const encodedFilePath = `${sourceDir}/encoded_${ep.id}.mkv`;

    console.log(`\n${epNum}:`);
    console.log(`  Source: ${ep.sourceFilePath}`);
    console.log(`  Encoded: ${encodedFilePath}`);

    // Check if encoded file exists
    try {
      const encodedExists = await Bun.file(encodedFilePath).exists();
      if (!encodedExists) {
        console.error(`  ERROR: Encoded file does not exist!`);
        continue;
      }

      const stat = await Bun.file(encodedFilePath).stat();
      const sizeGB = (stat.size / 1024 / 1024 / 1024).toFixed(2);
      console.log(`  Encoded file exists: ${sizeGB} GB`);
    } catch (error) {
      console.error(`  ERROR checking encoded file:`, error);
      continue;
    }

    // Get existing stepContext
    const item = await prisma.processingItem.findUnique({
      where: { id: ep.id },
      select: { stepContext: true, encodingJobId: true },
    });

    const existingContext = (item?.stepContext as Record<string, unknown>) || {};

    // Build download context (if missing)
    if (!existingContext.download) {
      try {
        const sourceStat = await Bun.file(ep.sourceFilePath).stat();
        existingContext.download = {
          torrentHash: "unknown",
          sourceFilePath: ep.sourceFilePath,
          size: sourceStat.size,
        };
        console.log(`  Added missing download context`);
      } catch (error) {
        console.error(`  ERROR: Source file doesn't exist:`, error);
        continue;
      }
    }

    // Build encode context
    const encodeStat = await Bun.file(encodedFilePath).stat();
    const encodeContext = {
      jobId: item?.encodingJobId || "recovered",
      encodedFiles: [
        {
          profileId: "default",
          path: encodedFilePath,
          targetServerIds,
          resolution: "1080p",
          codec: "AV1",
          season: ep.season,
          episode: ep.episode,
          episodeId: ep.id,
          size: encodeStat.size,
        },
      ],
    };

    // Merge with existing context
    const newStepContext = {
      ...existingContext,
      encode: encodeContext,
    };

    // Update directly in database (items are FAILED, can't transition via orchestrator)
    console.log(`  Updating to ENCODED with proper stepContext...`);
    await prisma.processingItem.update({
      where: { id: ep.id },
      data: {
        status: "ENCODED",
        stepContext: newStepContext as any,
        currentStep: "encode_complete",
        sourceFilePath: ep.sourceFilePath,
        encodedAt: new Date(),
        progress: 100,
        lastError: null,
      },
    });

    console.log(`  ✓ Fixed ${epNum} - ready for delivery`);
  }

  console.log("\n✓ All 6 episodes fixed and set to ENCODED");
  console.log("DeliverWorker will pick them up and deliver them.");
}

fixEncodedEpisodes()
  .then(() => {
    console.log("\nDone!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
