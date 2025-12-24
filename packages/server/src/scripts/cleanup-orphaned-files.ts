#!/usr/bin/env bun

/**
 * Cleanup Orphaned Encoded Files
 *
 * Deletes encoded_*.mkv files that are:
 * - Not referenced in any active pipeline context
 * - Older than a certain age (safety threshold)
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COMPLETED_DIR = "/media/completed";
const MIN_AGE_HOURS = 1; // Only delete files older than 1 hour

async function getAllTrackedEncodedFiles(): Promise<Set<string>> {
  const tracked = new Set<string>();

  // Get all pipeline contexts with encode data
  const pipelines = await prisma.pipelineExecution.findMany({
    where: {
      context: {
        path: ["encode", "encodedFiles"],
        not: Prisma.JsonNull,
      },
    },
    select: {
      context: true,
    },
  });

  for (const pipeline of pipelines) {
    const context = pipeline.context as {
      encode?: {
        encodedFiles?: Array<{ path: string }>;
      };
    };

    const encodedFiles = context.encode?.encodedFiles || [];
    for (const file of encodedFiles) {
      tracked.add(file.path);
    }
  }

  return tracked;
}

function* findEncodedFiles(dir: string): Generator<string> {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        yield* findEncodedFiles(fullPath);
      } else if (entry.isFile() && entry.name.match(/^encoded_\d+\.mkv$/)) {
        yield fullPath;
      }
    }
  } catch (err) {
    console.warn(`Failed to read directory ${dir}:`, err);
  }
}

async function cleanupOrphanedFiles() {
  console.log("[Cleanup] Finding all encoded files...\n");

  const trackedFiles = await getAllTrackedEncodedFiles();
  console.log(`Tracked files in database: ${trackedFiles.size}\n`);

  const now = Date.now();
  const minAgeMs = MIN_AGE_HOURS * 60 * 60 * 1000;
  const _cutoffTime = now - minAgeMs;

  let totalFiles = 0;
  let deletedFiles = 0;
  let skippedTracked = 0;
  let skippedTooNew = 0;
  let totalBytes = 0;

  console.log(`Scanning ${COMPLETED_DIR}...\n`);

  for (const filePath of findEncodedFiles(COMPLETED_DIR)) {
    totalFiles++;

    // Check if tracked
    if (trackedFiles.has(filePath)) {
      console.log(`SKIP (tracked): ${filePath}`);
      skippedTracked++;
      continue;
    }

    // Check file age
    try {
      const stats = statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      if (fileAge < minAgeMs) {
        const ageMinutes = Math.floor(fileAge / 1000 / 60);
        console.log(`SKIP (too new, ${ageMinutes}m old): ${filePath}`);
        skippedTooNew++;
        continue;
      }

      // Delete the file
      const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
      const ageHours = (fileAge / 1000 / 60 / 60).toFixed(1);

      await Bun.file(filePath).delete();

      deletedFiles++;
      totalBytes += stats.size;

      console.log(`DELETE (${ageHours}h old, ${sizeMB} MB): ${filePath}`);
    } catch (err) {
      console.error(`ERROR deleting ${filePath}:`, err);
    }
  }

  const totalMB = (totalBytes / 1024 / 1024).toFixed(2);
  const totalGB = (totalBytes / 1024 / 1024 / 1024).toFixed(2);

  console.log(`\n\n=== Summary ===`);
  console.log(`Total encoded files found: ${totalFiles}`);
  console.log(`Skipped (tracked): ${skippedTracked}`);
  console.log(`Skipped (too new): ${skippedTooNew}`);
  console.log(`Deleted (orphaned): ${deletedFiles}`);
  console.log(`Space freed: ${totalMB} MB (${totalGB} GB)`);

  await prisma.$disconnect();
}

cleanupOrphanedFiles().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
