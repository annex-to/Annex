/**
 * Annex Remote Encoder
 *
 * Entry point for the remote encoder CLI.
 * Dispatches to appropriate command based on CLI arguments.
 */

import { parseArgs } from "./cli.js";
import { help } from "./commands/help.js";
import { version } from "./commands/version.js";
import { run } from "./commands/run.js";
import { setup } from "./commands/setup.js";
import { update } from "./commands/update.js";

async function main(): Promise<void> {
  // Parse command-line arguments (skip first two: node/bun and script path)
  const args = parseArgs(process.argv.slice(2));

  // Check for unknown arguments
  if (args.unknown.length > 0) {
    console.error(`Unknown arguments: ${args.unknown.join(", ")}`);
    console.error("Run 'annex-encoder --help' for usage information");
    process.exit(1);
  }

  // Dispatch to appropriate command
  switch (args.command) {
    case "help":
      help();
      break;

    case "version":
      version();
      break;

    case "update":
      await update(args);
      break;

    case "setup":
      await setup(args);
      break;

    case "run":
    default:
      await run();
      break;
  }
}

main().catch((error) => {
  console.error("[Fatal]", error);
  process.exit(1);
});
