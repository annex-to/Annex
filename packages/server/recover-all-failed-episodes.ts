import { prisma } from "./src/db/client.js";

const REQUEST_ID = "26fe8e2d-c0b0-4091-8742-0e27c87f2343";

async function recoverFailedEpisodes() {
  console.log("Recovering failed Sopranos episodes...\n");

  // Get all FAILED episodes
  const failedEpisodes = await prisma.processingItem.findMany({
    where: {
      requestId: REQUEST_ID,
      status: "FAILED",
    },
    select: {
      id: true,
      season: true,
      episode: true,
      lastError: true,
      encodingJobId: true,
      sourceFilePath: true,
      stepContext: true,
    },
    orderBy: [{ season: "asc" }, { episode: "asc" }],
  });

  console.log(`Found ${failedEpisodes.length} failed episodes\n`);

  let hasEncodeContext = 0;
  let needsRecovery = 0;
  let otherErrors = 0;

  for (const ep of failedEpisodes) {
    const epNum = `S${String(ep.season ?? 0).padStart(2, "0")}E${String(ep.episode ?? 0).padStart(2, "0")}`;
    const stepContext = ep.stepContext as Record<string, unknown> | null;
    const hasEncode = !!stepContext?.encode;
    const hasEncodingJob = !!ep.encodingJobId;

    if (hasEncode && hasEncodingJob) {
      // Has full encode context - just reset to ENCODED
      await prisma.processingItem.update({
        where: { id: ep.id },
        data: {
          status: "ENCODED",
          lastError: null,
          progress: 0,
          currentStep: "encode_complete",
        },
      });
      console.log(`✓ ${epNum}: Reset to ENCODED (has encode context)`);
      hasEncodeContext++;
    } else if (ep.lastError?.includes("No downloaded episodes found")) {
      // Pipeline restart error - likely needs full recovery
      console.log(`⚠ ${epNum}: Needs recovery (no encode context)`);
      needsRecovery++;
    } else {
      // Other error - log it
      console.log(`✗ ${epNum}: Other error - ${ep.lastError}`);
      otherErrors++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Reset to ENCODED: ${hasEncodeContext}`);
  console.log(`Needs recovery: ${needsRecovery}`);
  console.log(`Other errors: ${otherErrors}`);

  if (needsRecovery > 0) {
    console.log(`\n⚠ ${needsRecovery} episodes need encode context recovery`);
    console.log(`These are likely the episodes that lost metadata during pipeline restart.`);
    console.log(`Run the specific recovery script for these.`);
  }
}

recoverFailedEpisodes()
  .then(() => {
    console.log("\nDone!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Error:", error);
    process.exit(1);
  });
