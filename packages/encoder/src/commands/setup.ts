/**
 * Setup Command
 *
 * Generates and optionally installs platform-specific service files.
 */

import type { CliArgs } from "../cli.js";
import { runSetup } from "../platform/index.js";

export async function setup(args: CliArgs): Promise<void> {
  await runSetup(args);
}
