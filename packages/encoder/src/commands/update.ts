/**
 * Update Command
 *
 * Downloads and installs encoder updates from the server.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CliArgs } from "../cli.js";
import { detectPlatform, getPlatformBinaryName } from "../platform/index.js";
import { VERSION } from "../version.js";

interface ManifestResponse {
  version: string;
  buildDate: string;
  platforms: Record<string, { size: number; sha256: string }>;
}

// GitHub repository for releases
const GITHUB_REPO = "annex-to/annex";
const GITHUB_API_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

/**
 * Get update source URL
 * Defaults to GitHub releases, can be overridden with --server flag
 */
function getUpdateSource(args: CliArgs): { type: "github" | "server"; url: string } {
  if (args.flags.server) {
    // Use custom server for updates
    const serverUrl = args.flags.server
      .replace(/^ws:\/\//, "http://")
      .replace(/^wss:\/\//, "https://")
      .replace(/\/encoder$/, "");
    return { type: "server", url: serverUrl };
  }

  // Default to GitHub releases
  return { type: "github", url: GITHUB_API_URL };
}

/**
 * Fetch manifest from GitHub releases
 */
async function fetchManifestFromGitHub(): Promise<ManifestResponse> {
  console.log(`[Update] Checking GitHub for latest release...`);

  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "annex-encoder",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const release = (await response.json()) as {
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    // Find the manifest.json asset
    const manifestAsset = release.assets.find((a) => a.name === "manifest.json");
    if (!manifestAsset) {
      throw new Error("No manifest.json found in latest release");
    }

    // Download the manifest
    const manifestResponse = await fetch(manifestAsset.browser_download_url);
    if (!manifestResponse.ok) {
      throw new Error(`Failed to download manifest: ${manifestResponse.status}`);
    }

    return (await manifestResponse.json()) as ManifestResponse;
  } catch (error) {
    throw new Error(`Failed to fetch from GitHub: ${error}`);
  }
}

/**
 * Fetch manifest from Annex server
 */
async function fetchManifestFromServer(serverUrl: string): Promise<ManifestResponse> {
  const url = `${serverUrl}/api/encoder/package/info`;
  console.log(`[Update] Fetching manifest from ${url}...`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const manifest = (await response.json()) as ManifestResponse;
    return manifest;
  } catch (error) {
    throw new Error(`Failed to fetch manifest: ${error}`);
  }
}

/**
 * Download binary from GitHub releases
 */
async function downloadBinaryFromGitHub(platform: string, outputPath: string): Promise<void> {
  console.log(`[Update] Downloading ${platform} binary from GitHub...`);

  try {
    // Get latest release info
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "annex-encoder",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const release = (await response.json()) as {
      assets: Array<{ name: string; browser_download_url: string }>;
    };

    // Find the binary asset for this platform
    const binaryName = `annex-encoder-${platform}${platform.startsWith("windows") ? ".exe" : ""}`;
    const binaryAsset = release.assets.find((a) => a.name === binaryName);

    if (!binaryAsset) {
      throw new Error(`Binary for ${platform} not found in latest release`);
    }

    // Download the binary
    const binaryResponse = await fetch(binaryAsset.browser_download_url);
    if (!binaryResponse.ok) {
      throw new Error(`HTTP ${binaryResponse.status}: ${binaryResponse.statusText}`);
    }

    const arrayBuffer = await binaryResponse.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    fs.writeFileSync(outputPath, buffer);
    fs.chmodSync(outputPath, 0o755); // Make executable
    console.log(`[Update] Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    throw new Error(`Failed to download binary: ${error}`);
  }
}

/**
 * Download binary from Annex server
 */
async function downloadBinaryFromServer(
  serverUrl: string,
  platform: string,
  outputPath: string
): Promise<void> {
  const url = `${serverUrl}/api/encoder/binary/${platform}`;
  console.log(`[Update] Downloading binary from ${url}...`);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    fs.writeFileSync(outputPath, buffer);
    fs.chmodSync(outputPath, 0o755); // Make executable
    console.log(`[Update] Downloaded ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  } catch (error) {
    throw new Error(`Failed to download binary: ${error}`);
  }
}

/**
 * Calculate SHA256 checksum of a file
 */
function calculateChecksum(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Get path to current binary
 */
function getCurrentBinaryPath(): string {
  // Try to resolve the actual binary path
  // When running as a compiled binary, process.execPath points to the binary
  // When running with bun src/index.ts, it points to the bun executable
  const execPath = process.execPath;

  // Check if we're running as a compiled binary
  if (execPath.includes("annex-encoder")) {
    return execPath;
  }

  // Fallback: assume we're in the same directory
  return path.resolve(process.cwd(), "annex-encoder");
}

/**
 * Stop platform-specific service
 */
async function stopService(): Promise<boolean> {
  const platform = detectPlatform();

  try {
    if (platform === "linux") {
      // Try to stop systemd service
      const proc = Bun.spawn(["systemctl", "stop", "annex-encoder"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    } else if (platform === "darwin") {
      // Try to stop launchd service
      const proc = Bun.spawn(["launchctl", "stop", "com.annex.encoder"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    } else if (platform === "windows") {
      // Try to stop Windows service
      const proc = Bun.spawn(["sc.exe", "stop", "AnnexEncoder"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    }
  } catch {
    // Service might not be installed, ignore error
  }

  return false;
}

/**
 * Start platform-specific service
 */
async function startService(): Promise<boolean> {
  const platform = detectPlatform();

  try {
    if (platform === "linux") {
      const proc = Bun.spawn(["systemctl", "start", "annex-encoder"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    } else if (platform === "darwin") {
      const proc = Bun.spawn(["launchctl", "start", "com.annex.encoder"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    } else if (platform === "windows") {
      const proc = Bun.spawn(["sc.exe", "start", "AnnexEncoder"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      return proc.exitCode === 0;
    }
  } catch {
    // Service might not be installed, ignore error
  }

  return false;
}

/**
 * Update command implementation
 */
export async function update(args: CliArgs): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║    Annex Encoder - Self Update                                ║
╚═══════════════════════════════════════════════════════════════╝

Current Version: ${VERSION}
Platform: ${getPlatformBinaryName()}
`);

  const updateSource = getUpdateSource(args);
  const platform = getPlatformBinaryName();
  const force = args.flags.force ?? false;

  console.log(
    `Update Source: ${updateSource.type === "github" ? "GitHub Releases" : updateSource.url}\n`
  );

  // Step 1: Fetch manifest
  console.log("[1/7] Checking for updates...");
  let manifest: ManifestResponse;
  try {
    if (updateSource.type === "github") {
      manifest = await fetchManifestFromGitHub();
    } else {
      manifest = await fetchManifestFromServer(updateSource.url);
    }
  } catch (error) {
    console.error(`Failed to fetch manifest: ${error}`);
    process.exit(1);
  }

  console.log(`  Current:   ${VERSION}`);
  console.log(`  Available: ${manifest.version}`);

  // Step 2: Check version
  if (manifest.version === VERSION && !force) {
    console.log("\nAlready up to date!");
    console.log("Use --force to reinstall anyway");
    return;
  }

  if (force) {
    console.log("\n  Force update requested");
  }

  // Check if platform is available
  if (!manifest.platforms[platform]) {
    console.error(`\nPlatform ${platform} not available in manifest`);
    process.exit(1);
  }

  const platformInfo = manifest.platforms[platform];
  console.log(`  Size: ${(platformInfo.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  SHA256: ${platformInfo.sha256.slice(0, 16)}...`);

  // Step 3: Download new binary
  console.log("\n[2/7] Downloading new binary...");
  const tempPath = path.join(os.tmpdir(), `annex-encoder-${randomUUID()}`);
  try {
    if (updateSource.type === "github") {
      await downloadBinaryFromGitHub(platform, tempPath);
    } else {
      await downloadBinaryFromServer(updateSource.url, platform, tempPath);
    }
  } catch (error) {
    console.error(`Failed to download binary: ${error}`);
    process.exit(1);
  }

  // Step 4: Verify checksum
  console.log("\n[3/7] Verifying checksum...");
  const downloadedChecksum = calculateChecksum(tempPath);
  if (downloadedChecksum !== platformInfo.sha256) {
    console.error("  ✗ Checksum mismatch!");
    console.error(`    Expected: ${platformInfo.sha256}`);
    console.error(`    Got:      ${downloadedChecksum}`);
    fs.unlinkSync(tempPath);
    process.exit(1);
  }
  console.log("  ✓ Checksum verified");

  // Step 5: Stop service if running
  console.log("\n[4/7] Stopping service (if running)...");
  const serviceStopped = await stopService();
  if (serviceStopped) {
    console.log("  ✓ Service stopped");
    // Wait a bit for service to fully stop
    await Bun.sleep(2000);
  } else {
    console.log("  ⚠ Service not running or not installed");
  }

  // Step 6: Backup current binary
  console.log("\n[5/7] Backing up current binary...");
  const currentPath = getCurrentBinaryPath();
  const backupPath = `${currentPath}.bak`;

  try {
    if (fs.existsSync(currentPath)) {
      fs.copyFileSync(currentPath, backupPath);
      console.log(`  ✓ Backed up to ${backupPath}`);
    } else {
      console.log("  ⚠ No existing binary to backup");
    }
  } catch (error) {
    console.error(`  ✗ Failed to backup: ${error}`);
    fs.unlinkSync(tempPath);
    process.exit(1);
  }

  // Step 7: Replace binary
  console.log("\n[6/7] Installing new binary...");
  try {
    // On Windows, renameSync fails if target exists or is locked
    // Use copy+delete pattern for cross-platform compatibility
    if (fs.existsSync(currentPath)) {
      fs.unlinkSync(currentPath);
    }
    fs.copyFileSync(tempPath, currentPath);
    fs.unlinkSync(tempPath);
    fs.chmodSync(currentPath, 0o755);
    console.log(`  ✓ Installed to ${currentPath}`);
  } catch (error) {
    console.error(`  ✗ Failed to install: ${error}`);
    // Try to restore backup
    if (fs.existsSync(backupPath)) {
      console.log("  Attempting to restore backup...");
      try {
        fs.copyFileSync(backupPath, currentPath);
        console.log("  ✓ Backup restored");
      } catch {
        console.error("  ✗ Failed to restore backup");
      }
    }
    process.exit(1);
  }

  // Step 8: Restart service
  console.log("\n[7/7] Starting service...");
  if (serviceStopped) {
    await Bun.sleep(1000);
    const serviceStarted = await startService();
    if (serviceStarted) {
      console.log("  ✓ Service started");
    } else {
      console.log("  ✗ Failed to start service");
      console.log("  Start manually or check service logs");
    }
  } else {
    console.log("  ⚠ Service was not running, not starting");
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║    Update Complete                                            ║
╚═══════════════════════════════════════════════════════════════╝

Updated from ${VERSION} to ${manifest.version}

If the service is not running, start it manually:
  Linux:   sudo systemctl start annex-encoder
  macOS:   launchctl start com.annex.encoder
  Windows: Start-Service AnnexEncoder
`);
}
