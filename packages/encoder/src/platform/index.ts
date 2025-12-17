/**
 * Platform Detection
 *
 * Detects the current platform and dispatches to platform-specific setup.
 */

import * as os from "os";
import type { CliArgs } from "../cli.js";

export type Platform = "linux" | "windows" | "darwin" | "unknown";

/**
 * Detect current platform
 */
export function detectPlatform(): Platform {
  const platform = os.platform();

  switch (platform) {
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    case "darwin":
      return "darwin";
    default:
      return "unknown";
  }
}

/**
 * Get platform-specific binary name
 */
export function getPlatformBinaryName(): string {
  const platform = detectPlatform();
  const arch = os.arch();

  switch (platform) {
    case "linux":
      return arch === "arm64" ? "linux-arm64" : "linux-x64";
    case "windows":
      return "windows-x64";
    case "darwin":
      return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    default:
      return "unknown";
  }
}

/**
 * Run platform-specific setup
 */
export async function runSetup(args: CliArgs): Promise<void> {
  const platform = detectPlatform();

  switch (platform) {
    case "linux": {
      const { setupLinux } = await import("./linux.js");
      await setupLinux(args);
      break;
    }

    case "windows": {
      const { setupWindows } = await import("./windows.js");
      await setupWindows(args);
      break;
    }

    case "darwin": {
      const { setupDarwin } = await import("./darwin.js");
      await setupDarwin(args);
      break;
    }

    default:
      console.error(`Unsupported platform: ${os.platform()}`);
      process.exit(1);
  }
}
