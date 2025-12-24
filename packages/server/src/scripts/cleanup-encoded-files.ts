#!/usr/bin/env bun

/**
 * Cleanup Encoded Files Script
 *
 * Removes encoded files from completed requests that weren't cleaned up
 * due to server restarts or other issues.
 */

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function cleanupEncodedFiles() {
  console.log("[Cleanup] Looking for completed requests with encoded files...\n");

  const completedRequests = await prisma.pipelineExecution.findMany({
    where: {
      status: "COMPLETED",
      context: {
        path: ["encode", "encodedFiles"],
        not: Prisma.JsonNull,
      },
    },
    include: {
      request: {
        select: {
          id: true,
          title: true,
          status: true,
          completedAt: true,
        },
      },
    },
    orderBy: { completedAt: "desc" },
  });

  console.log(`Found ${completedRequests.length} completed requests with encode data\n`);

  let totalFiles = 0;
  let deletedFiles = 0;
  let totalBytes = 0;

  for (const execution of completedRequests) {
    const context = execution.context as {
      encode?: {
        encodedFiles?: Array<{ path: string; size?: number }>;
      };
    };

    const encodedFiles = context.encode?.encodedFiles || [];
    if (encodedFiles.length === 0) continue;

    console.log(`\n--- ${execution.request?.title || "Unknown"} ---`);
    console.log(`Request Status: ${execution.request?.status}`);
    console.log(`Completed: ${execution.completedAt?.toISOString()}`);

    for (const encodedFile of encodedFiles) {
      totalFiles++;
      console.log(`\nChecking: ${encodedFile.path}`);

      try {
        const file = Bun.file(encodedFile.path);
        const exists = await file.exists();

        if (exists) {
          const size = await file.size;
          const sizeMB = (size / 1024 / 1024).toFixed(2);
          console.log(`  Size: ${sizeMB} MB`);

          await file.delete();
          deletedFiles++;
          totalBytes += size;
          console.log(`  ✓ Deleted`);
        } else {
          console.log(`  (Already deleted)`);
        }
      } catch (err) {
        console.error(`  ✗ Failed to delete:`, err);
      }
    }
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  const totalGB = (totalBytes / 1024 / 1024 / 1024).toFixed(2);

  console.log(`\n\n=== Summary ===`);
  console.log(`Total encoded files checked: ${totalFiles}`);
  console.log(`Files deleted: ${deletedFiles}`);
  console.log(`Space freed: ${totalMB} MB (${totalGB} GB)`);

  await prisma.$disconnect();
}

cleanupEncodedFiles().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
