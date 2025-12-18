/**
 * Linux Platform Setup
 *
 * Generates and optionally installs systemd service files.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { CliArgs } from "../cli.js";

interface SetupOptions {
  install: boolean;
  user: string;
  workDir: string;
}

/**
 * Get setup options from CLI args with defaults
 */
function getSetupOptions(args: CliArgs): SetupOptions {
  return {
    install: args.flags.install ?? false,
    user: args.flags.user ?? "annex",
    workDir: args.flags.workDir ?? "/opt/annex-encoder",
  };
}

/**
 * Generate systemd service file content
 */
function generateServiceFile(options: SetupOptions): string {
  return `[Unit]
Description=Annex Remote Encoder
After=network-online.target nfs-client.target
Wants=network-online.target

[Service]
Type=simple
User=${options.user}
Group=${options.user}
WorkingDirectory=${options.workDir}
EnvironmentFile=/etc/annex-encoder.env
ExecStart=/usr/local/bin/annex-encoder
Restart=always
RestartSec=10

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/mnt/downloads
PrivateTmp=true

# GPU access
SupplementaryGroups=video render

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Generate environment file content
 */
function generateEnvFile(): string {
  const hostname = os.hostname();
  return `# Annex Encoder Configuration
# Edit these values to match your setup

# Server connection
ANNEX_SERVER_URL=ws://server:3000/encoder

# Encoder identity
ANNEX_ENCODER_ID=encoder-${hostname}

# GPU configuration
ANNEX_GPU_DEVICE=/dev/dri/renderD128
ANNEX_MAX_CONCURRENT=1

# NFS mount path
ANNEX_NFS_BASE_PATH=/mnt/downloads

# Logging
ANNEX_LOG_LEVEL=info
`;
}

/**
 * Check if running as root
 */
function isRoot(): boolean {
  return process.getuid?.() === 0;
}

/**
 * Check if systemctl is available
 */
function hasSystemctl(): boolean {
  try {
    // Check common systemctl locations
    const systemctlPaths = [
      "/usr/bin/systemctl",
      "/bin/systemctl",
      "/usr/local/bin/systemctl",
    ];

    for (const path of systemctlPaths) {
      if (fs.existsSync(path)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Setup Linux systemd service
 */
export async function setupLinux(args: CliArgs): Promise<void> {
  const options = getSetupOptions(args);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║    Annex Encoder - Linux systemd Setup                       ║
╚═══════════════════════════════════════════════════════════════╝

Configuration:
  Service User:   ${options.user}
  Working Dir:    ${options.workDir}
  Install:        ${options.install ? "Yes" : "No (generate files only)"}
`);

  // Check if systemctl is available (only required for install)
  if (options.install && !hasSystemctl()) {
    console.error("Error: systemctl not found. This system may not use systemd.");
    process.exit(1);
  }

  // Check if install requires root
  if (options.install && !isRoot()) {
    console.error("Error: --install requires root privileges");
    console.error("Run with sudo or as root user");
    process.exit(1);
  }

  // Generate service file
  const serviceContent = generateServiceFile(options);
  const servicePath = "/etc/systemd/system/annex-encoder.service";

  // Generate environment file
  const envContent = generateEnvFile();
  const envPath = "/etc/annex-encoder.env";

  if (options.install) {
    console.log("[1/4] Installing service files...");

    // Write service file
    try {
      fs.writeFileSync(servicePath, serviceContent);
      console.log(`  ✓ Created ${servicePath}`);
    } catch (error) {
      console.error(`  ✗ Failed to write ${servicePath}:`, error);
      process.exit(1);
    }

    // Write environment file (don't overwrite if exists)
    try {
      if (fs.existsSync(envPath)) {
        console.log(`  ⚠ ${envPath} already exists, skipping`);
      } else {
        fs.writeFileSync(envPath, envContent);
        fs.chmodSync(envPath, 0o600); // Secure permissions
        console.log(`  ✓ Created ${envPath}`);
      }
    } catch (error) {
      console.error(`  ✗ Failed to write ${envPath}:`, error);
      process.exit(1);
    }

    // Reload systemd
    console.log("\n[2/4] Reloading systemd...");
    try {
      const proc = Bun.spawn(["systemctl", "daemon-reload"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      console.log("  ✓ Systemd reloaded");
    } catch (error) {
      console.error("  ✗ Failed to reload systemd:", error);
      process.exit(1);
    }

    // Enable service
    console.log("\n[3/4] Enabling service...");
    try {
      const proc = Bun.spawn(["systemctl", "enable", "annex-encoder"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      console.log("  ✓ Service enabled");
    } catch (error) {
      console.error("  ✗ Failed to enable service:", error);
      process.exit(1);
    }

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║    Installation Complete                                      ║
╚═══════════════════════════════════════════════════════════════╝

Next steps:
  1. Edit configuration: sudo nano /etc/annex-encoder.env
  2. Ensure encoder binary is at: ${options.workDir}/annex-encoder
  3. Start service: sudo systemctl start annex-encoder
  4. Check status: sudo systemctl status annex-encoder
  5. View logs: sudo journalctl -u annex-encoder -f
`);
  } else {
    // Generate files only
    console.log("[1/2] Generating service files...");

    const outputDir = process.cwd();
    const serviceFilePath = path.join(outputDir, "annex-encoder.service");
    const envFilePath = path.join(outputDir, "annex-encoder.env");

    try {
      fs.writeFileSync(serviceFilePath, serviceContent);
      console.log(`  ✓ Generated ${serviceFilePath}`);
    } catch (error) {
      console.error(`  ✗ Failed to write ${serviceFilePath}:`, error);
      process.exit(1);
    }

    try {
      fs.writeFileSync(envFilePath, envContent);
      console.log(`  ✓ Generated ${envFilePath}`);
    } catch (error) {
      console.error(`  ✗ Failed to write ${envFilePath}:`, error);
      process.exit(1);
    }

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║    Files Generated                                            ║
╚═══════════════════════════════════════════════════════════════╝

Service files have been generated in the current directory.

To install manually:
  1. Edit annex-encoder.env with your configuration
  2. sudo cp annex-encoder.service /etc/systemd/system/
  3. sudo cp annex-encoder.env /etc/
  4. sudo chmod 600 /etc/annex-encoder.env
  5. sudo systemctl daemon-reload
  6. sudo systemctl enable annex-encoder
  7. sudo systemctl start annex-encoder

Or run with --install to install automatically (requires root).
`);
  }
}
