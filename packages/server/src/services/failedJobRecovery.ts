import { prisma } from "../db/client.js";

/**
 * Recovers requests stuck in ENCODING status with failed jobs.
 *
 * When jobs fail but the callback doesn't fire (e.g., server restart),
 * requests can get stuck showing "Encoding" when they've actually failed.
 */
export async function recoverFailedJobs(): Promise<void> {
  console.log("[FailedJobRecovery] Checking for requests with failed jobs...");

  // Find ENCODING requests with failed jobs
  const failedJobs = await prisma.job.findMany({
    where: {
      type: "remote:encode",
      requestId: { not: null },
      encoderAssignment: {
        status: "FAILED",
      },
    },
    include: {
      encoderAssignment: true,
      request: {
        select: {
          id: true,
          title: true,
          status: true,
        },
      },
    },
  });

  if (failedJobs.length === 0) {
    console.log("[FailedJobRecovery] No requests with failed jobs found");
    return;
  }

  let recovered = 0;

  for (const job of failedJobs) {
    // Skip if requestId is somehow null (shouldn't happen due to query filter)
    if (!job.requestId) {
      continue;
    }

    // Only update if request is still in ENCODING status
    if (job.request?.status === "ENCODING") {
      const error = job.encoderAssignment?.error || "Unknown encoding error";

      console.log(`[FailedJobRecovery] ${job.request.title}: Marking as FAILED (${error})`);

      // Update MediaRequest to FAILED
      await prisma.mediaRequest.update({
        where: { id: job.requestId },
        data: {
          status: "FAILED",
          error: `Encoding failed: ${error}`,
          currentStep: null,
        },
      });

      // Mark pipeline as FAILED
      await prisma.pipelineExecution.updateMany({
        where: {
          requestId: job.requestId,
          status: "RUNNING",
        },
        data: {
          status: "FAILED",
          error: `Encoding failed: ${error}`,
          completedAt: new Date(),
        },
      });

      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`[FailedJobRecovery] ✓ Recovered ${recovered} failed job(s)`);
  }
}
