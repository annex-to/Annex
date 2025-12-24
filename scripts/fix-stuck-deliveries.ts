#!/usr/bin/env bun
/**
 * Manually trigger delivery recovery to fix stuck deliveries
 */
import { recoverStuckDeliveries } from "../packages/server/src/services/deliveryRecovery.js";

console.log("Running delivery recovery...");

await recoverStuckDeliveries();

console.log("Done!");
process.exit(0);
