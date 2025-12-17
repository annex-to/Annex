/**
 * CLI Argument Parser
 *
 * Parses command-line arguments without external dependencies.
 */

export interface CliArgs {
  command: "run" | "help" | "version" | "update" | "setup";
  flags: {
    help?: boolean;
    version?: boolean;
    force?: boolean;
    install?: boolean;
    server?: string;
    user?: string;
    workDir?: string;
  };
  unknown: string[];
}

/**
 * Parse command-line arguments
 */
export function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {
    command: "run",
    flags: {},
    unknown: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Help flags
    if (arg === "--help" || arg === "-h") {
      result.command = "help";
      result.flags.help = true;
      continue;
    }

    // Version flags
    if (arg === "--version" || arg === "-v") {
      result.command = "version";
      result.flags.version = true;
      continue;
    }

    // Update command
    if (arg === "--update") {
      result.command = "update";
      continue;
    }

    // Setup command
    if (arg === "--setup") {
      result.command = "setup";
      continue;
    }

    // Update flags
    if (arg === "--force" || arg === "-f") {
      result.flags.force = true;
      continue;
    }

    if (arg === "--server") {
      result.flags.server = args[++i];
      continue;
    }

    // Setup flags
    if (arg === "--install") {
      result.flags.install = true;
      continue;
    }

    if (arg === "--user") {
      result.flags.user = args[++i];
      continue;
    }

    if (arg === "--work-dir") {
      result.flags.workDir = args[++i];
      continue;
    }

    // Unknown argument
    result.unknown.push(arg);
  }

  return result;
}
