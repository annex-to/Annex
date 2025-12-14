/**
 * Annex Remote Encoder
 *
 * Entry point for the remote encoder service.
 * Connects to the main Annex server and processes encoding jobs.
 */

import { initConfig } from "./config.js";
import { EncoderClient } from "./client.js";
import { testGpuEncoding, isGpuAvailable } from "./gpu.js";

async function main(): Promise<void> {
  // Initialize configuration
  const config = initConfig();

  // Check GPU availability
  console.log(`[Startup] Checking GPU: ${config.gpuDevice}`);

  if (!isGpuAvailable(config.gpuDevice)) {
    console.error(`[Startup] GPU device not accessible: ${config.gpuDevice}`);
    console.error("[Startup] Make sure the device exists and you have read/write permissions");
    process.exit(1);
  }

  // Test GPU encoding capability
  console.log("[Startup] Testing AV1 encoding capability...");
  const gpuWorks = await testGpuEncoding(config.gpuDevice);

  if (!gpuWorks) {
    console.error(`[Startup] GPU ${config.gpuDevice} failed AV1 encoding test`);
    console.error("[Startup] Check FFmpeg VAAPI support and GPU drivers");
    process.exit(1);
  }

  console.log("[Startup] GPU AV1 encoding test passed");

  // Start the encoder client
  const client = new EncoderClient();
  await client.start();

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[Shutdown] Received ${signal}`);
    await client.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep process running
  process.stdin.resume();
}

main().catch((error) => {
  console.error("[Fatal]", error);
  process.exit(1);
});
