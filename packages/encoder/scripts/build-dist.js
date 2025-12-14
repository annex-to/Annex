#!/usr/bin/env node
/**
 * Build script for creating distributable encoder package
 *
 * Creates a tarball containing:
 * - Bundled encoder (single JS file with all dependencies)
 * - Update script
 * - Minimal package.json
 * - Systemd service template
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(ROOT, "dist-package");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

async function build() {
  console.log("[Build] Creating distributable encoder package...");

  // Clean dist directory
  if (fs.existsSync(DIST_DIR)) {
    fs.rmSync(DIST_DIR, { recursive: true });
  }
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // Bundle with esbuild
  console.log("[Build] Bundling with esbuild...");
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src/index.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",  // Use CommonJS to avoid dynamic require issues with ws
    outfile: path.join(DIST_DIR, "encoder.js"),
    banner: {
      js: "#!/usr/bin/env node",
    },
    // Minify for smaller distribution
    minify: false,
    // Keep names for debugging
    keepNames: true,
    // Source maps for debugging
    sourcemap: true,
  });

  // Create minimal package.json
  const distPackage = {
    name: "annex-encoder",
    version: PKG.version,
    description: PKG.description,
    main: "encoder.js",
    bin: {
      "annex-encoder": "./encoder.js",
    },
    scripts: {
      start: "node encoder.js",
    },
    engines: {
      node: ">=20.0.0",
    },
  };
  fs.writeFileSync(
    path.join(DIST_DIR, "package.json"),
    JSON.stringify(distPackage, null, 2)
  );

  // Copy update script from scripts directory
  const updateScriptSrc = path.join(__dirname, "update.sh");
  fs.copyFileSync(updateScriptSrc, path.join(DIST_DIR, "update.sh"));
  fs.chmodSync(path.join(DIST_DIR, "update.sh"), 0o755);

  // Create systemd service template
  const systemdService = `[Unit]
Description=Annex Remote Encoder
After=network-online.target nfs-client.target
Wants=network-online.target

[Service]
Type=simple
User=annex
Group=annex
WorkingDirectory=/opt/annex-encoder
EnvironmentFile=/etc/annex-encoder.env
ExecStart=/usr/bin/node /opt/annex-encoder/encoder.js
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
  fs.writeFileSync(path.join(DIST_DIR, "annex-encoder.service"), systemdService);

  // Create tarball
  console.log("[Build] Creating tarball...");
  const tarballName = `annex-encoder-${PKG.version}.tar.gz`;
  execSync(`tar -czf ${tarballName} -C ${DIST_DIR} .`, { cwd: ROOT });

  // Also create a "latest" symlink-style copy
  fs.copyFileSync(
    path.join(ROOT, tarballName),
    path.join(ROOT, "annex-encoder-latest.tar.gz")
  );

  const stats = fs.statSync(path.join(ROOT, tarballName));
  console.log(`[Build] Created: ${tarballName} (${(stats.size / 1024).toFixed(1)} KB)`);
  console.log(`[Build] Created: annex-encoder-latest.tar.gz`);
  console.log("[Build] Done!");
}

build().catch((err) => {
  console.error("[Build] Error:", err);
  process.exit(1);
});
