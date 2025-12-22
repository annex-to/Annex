/**
 * Configuration and Environment Validation
 *
 * Validates encoder environment on startup:
 * - NFS directory access (read/write permissions)
 * - GPU device availability
 * - FFmpeg installation and capabilities
 * - Network connectivity to server
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EncoderCapabilities } from "@annex/shared";
import { getConfig } from "./config.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the encoder environment
 */
export async function validateEnvironment(): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const config = getConfig();

  console.log("\n[Validation] Checking encoder environment...\n");

  // 1. Validate NFS paths from environment
  const nfsBasePath = process.env.ANNEX_NFS_BASE_PATH;
  if (nfsBasePath) {
    console.log(`[Validation] NFS Base Path: ${nfsBasePath}`);

    // Check if NFS mount exists
    if (!fs.existsSync(nfsBasePath)) {
      errors.push(`NFS base path does not exist: ${nfsBasePath}`);
    } else {
      // Check read permissions
      try {
        fs.readdirSync(nfsBasePath);
        console.log("  ✓ NFS mount is readable");
      } catch (e) {
        errors.push(`Cannot read NFS base path: ${nfsBasePath} - ${e}`);
      }

      // Check write permissions
      const testFile = path.join(nfsBasePath, `.annex-write-test-${Date.now()}`);
      try {
        fs.writeFileSync(testFile, "test");
        fs.unlinkSync(testFile);
        console.log("  ✓ NFS mount is writable");
      } catch (e) {
        errors.push(`Cannot write to NFS base path: ${nfsBasePath} - ${e}`);
      }

      // Check for expected subdirectories
      const expectedPaths = [
        process.env.ENCODER_REMOTE_DOWNLOADS_PATH,
        process.env.ENCODER_REMOTE_WORKING_PATH,
      ].filter(Boolean);

      for (const expectedPath of expectedPaths) {
        if (expectedPath && !fs.existsSync(expectedPath)) {
          warnings.push(`Expected path not found: ${expectedPath} (will be created on demand)`);
        }
      }
    }
  } else {
    warnings.push("ANNEX_NFS_BASE_PATH not configured - file access may fail");
  }

  // 2. Validate GPU device (optional - for hardware encoding)
  console.log(`\n[Validation] GPU Device: ${config.gpuDevice}`);
  if (!fs.existsSync(config.gpuDevice)) {
    warnings.push(
      `GPU device not found: ${config.gpuDevice} - hardware encoding will not be available`
    );
  } else {
    try {
      fs.accessSync(config.gpuDevice, fs.constants.R_OK | fs.constants.W_OK);
      console.log("  ✓ GPU device is accessible");
    } catch (_e) {
      warnings.push(
        `Cannot access GPU device: ${config.gpuDevice} - hardware encoding will not be available`
      );
    }
  }

  // 3. Validate FFmpeg installation
  console.log("\n[Validation] FFmpeg Installation:");
  try {
    const ffmpegCheck = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const ffmpegOutput = await new Response(ffmpegCheck.stdout).text();
    const ffmpegExit = await ffmpegCheck.exited;

    if (ffmpegExit === 0) {
      const version = ffmpegOutput.split("\n")[0];
      console.log(`  ✓ ${version}`);

      // Check for VAAPI support
      const hasVaapi = ffmpegOutput.includes("--enable-vaapi");
      if (hasVaapi) {
        console.log("  ✓ VAAPI hardware acceleration available");
      } else {
        warnings.push(
          "FFmpeg does not have VAAPI support - hardware encoding will not be available"
        );
      }

      // Check for available video encoders
      const ffmpegEncoders = Bun.spawn(["ffmpeg", "-encoders"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const encodersOutput = await new Response(ffmpegEncoders.stdout).text();
      await ffmpegEncoders.exited;

      // Check for various encoder types
      const encoders = {
        // AV1 encoders
        av1_vaapi: encodersOutput.includes("av1_vaapi"),
        libsvtav1: encodersOutput.includes("libsvtav1"),
        libaom: encodersOutput.includes("libaom-av1"),

        // HEVC/H.265 encoders
        hevc_vaapi: encodersOutput.includes("hevc_vaapi"),
        libx265: encodersOutput.includes("libx265"),

        // H.264 encoders
        h264_vaapi: encodersOutput.includes("h264_vaapi"),
        libx264: encodersOutput.includes("libx264"),
      };

      // Display available encoders
      console.log("\n[Validation] Available Video Encoders:");

      if (encoders.av1_vaapi) console.log("  ✓ AV1 (hardware): av1_vaapi");
      if (encoders.libsvtav1) console.log("  ✓ AV1 (software): libsvtav1");
      if (encoders.libaom) console.log("  ✓ AV1 (software): libaom-av1");

      if (encoders.hevc_vaapi) console.log("  ✓ HEVC/H.265 (hardware): hevc_vaapi");
      if (encoders.libx265) console.log("  ✓ HEVC/H.265 (software): libx265");

      if (encoders.h264_vaapi) console.log("  ✓ H.264 (hardware): h264_vaapi");
      if (encoders.libx264) console.log("  ✓ H.264 (software): libx264");

      // Check if any video encoder is available
      const hasAnyEncoder = Object.values(encoders).some((e) => e);

      if (!hasAnyEncoder) {
        // In CI environments, this is expected (no real encoders installed)
        // Downgrade to warning instead of error
        if (process.env.CI) {
          warnings.push(
            "No video encoders available - FFmpeg cannot encode video (expected in CI)"
          );
        } else {
          errors.push("No video encoders available - FFmpeg cannot encode video");
        }
      } else {
        // Provide helpful recommendations
        if (!encoders.av1_vaapi && !encoders.libsvtav1 && !encoders.libaom) {
          warnings.push(
            "No AV1 encoders available - profiles using AV1 will fail (HEVC/H.264 profiles will work)"
          );
        }
        if (!encoders.av1_vaapi && !encoders.hevc_vaapi && !encoders.h264_vaapi) {
          warnings.push("No hardware encoders available - encoding will use CPU (slower)");
        }
      }
    } else {
      errors.push("FFmpeg check failed");
    }
  } catch (e) {
    errors.push(`FFmpeg not found or not executable: ${e}`);
  }

  // 4. Validate ffprobe installation
  console.log("\n[Validation] FFprobe Installation:");
  try {
    const ffprobeCheck = Bun.spawn(["ffprobe", "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const ffprobeExit = await ffprobeCheck.exited;

    if (ffprobeExit === 0) {
      console.log("  ✓ ffprobe is available");
    } else {
      errors.push("ffprobe check failed");
    }
  } catch (e) {
    errors.push(`ffprobe not found or not executable: ${e}`);
  }

  // 5. Validate network connectivity to server
  console.log(`\n[Validation] Server Connectivity: ${config.serverUrl}`);
  try {
    const url = new URL(config.serverUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    const healthUrl = `${protocol}//${url.host}/health`;

    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      console.log("  ✓ Server is reachable");
    } else {
      warnings.push(`Server returned status ${response.status} - may not be healthy`);
    }
  } catch (e) {
    warnings.push(`Cannot reach server: ${e}`);
  }

  // 6. Validate encoder configuration
  console.log("\n[Validation] Encoder Configuration:");
  console.log(`  Encoder ID: ${config.encoderId}`);
  console.log(`  Max Concurrent: ${config.maxConcurrent}`);
  console.log(`  Heartbeat Interval: ${config.heartbeatInterval}ms`);
  console.log(
    `  Reconnect Interval: ${config.reconnectInterval}ms - ${config.maxReconnectInterval}ms`
  );

  if (config.maxConcurrent < 1 || config.maxConcurrent > 8) {
    warnings.push(`Unusual maxConcurrent value: ${config.maxConcurrent} (recommended: 1-8)`);
  }

  if (config.heartbeatInterval < 5000) {
    warnings.push(
      `Very short heartbeat interval: ${config.heartbeatInterval}ms (may cause excessive traffic)`
    );
  }

  // Summary
  console.log("\n[Validation] Summary:");
  console.log(`  Errors: ${errors.length}`);
  console.log(`  Warnings: ${warnings.length}\n`);

  if (errors.length > 0) {
    console.error("❌ Validation failed with errors:");
    errors.forEach((error) => {
      console.error(`   - ${error}`);
    });
  }

  if (warnings.length > 0) {
    console.warn("⚠️  Validation warnings:");
    warnings.forEach((warning) => {
      console.warn(`   - ${warning}`);
    });
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("✅ All validation checks passed!");
  }

  console.log("");

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Detect encoder capabilities for registration
 */
/**
 * Test if a hardware encoder actually works by attempting a quick encode
 */
async function testHardwareEncoder(encoder: string, gpuDevice?: string): Promise<boolean> {
  try {
    const args = ["-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1", "-frames:v", "1"];

    // Add hardware acceleration setup based on encoder type
    if (encoder.includes("vaapi") && gpuDevice) {
      args.push("-vaapi_device", gpuDevice);
      args.push("-vf", "format=nv12,hwupload");
    } else if (encoder.includes("qsv")) {
      args.push("-init_hw_device", "qsv=hw");
      args.push("-filter_hw_device", "hw");
    } else if (encoder.includes("nvenc")) {
      // NVENC doesn't need special device setup
    } else if (encoder.includes("amf")) {
      // AMF doesn't need special device setup
    }

    args.push("-c:v", encoder);
    args.push("-f", "null", "-");

    const proc = Bun.spawn(["ffmpeg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export async function detectCapabilities(): Promise<EncoderCapabilities> {
  const config = getConfig();
  const capabilities: EncoderCapabilities = {
    videoEncoders: {},
    hwaccel: [],
    audioEncoders: [],
  };

  try {
    // Detect hardware acceleration support
    const hwaccelCheck = Bun.spawn(["ffmpeg", "-hide_banner", "-hwaccels"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const hwaccelOutput = await new Response(hwaccelCheck.stdout).text();
    await hwaccelCheck.exited;

    // Parse hwaccel output (skip first line which is "Hardware acceleration methods:")
    const hwaccels = hwaccelOutput
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    capabilities.hwaccel = hwaccels;

    // Detect video encoders
    const encodersCheck = Bun.spawn(["ffmpeg", "-hide_banner", "-encoders"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const encodersOutput = await new Response(encodersCheck.stdout).text();
    await encodersCheck.exited;

    // Test each hardware encoder to see if it actually works
    const hwEncodersToTest = [
      // AV1
      { codec: "av1", encoder: "av1_vaapi", compiled: encodersOutput.includes("av1_vaapi") },
      { codec: "av1", encoder: "av1_nvenc", compiled: encodersOutput.includes("av1_nvenc") },
      { codec: "av1", encoder: "av1_qsv", compiled: encodersOutput.includes("av1_qsv") },
      { codec: "av1", encoder: "av1_amf", compiled: encodersOutput.includes("av1_amf") },
      // HEVC
      { codec: "hevc", encoder: "hevc_vaapi", compiled: encodersOutput.includes("hevc_vaapi") },
      { codec: "hevc", encoder: "hevc_nvenc", compiled: encodersOutput.includes("hevc_nvenc") },
      { codec: "hevc", encoder: "hevc_qsv", compiled: encodersOutput.includes("hevc_qsv") },
      { codec: "hevc", encoder: "hevc_amf", compiled: encodersOutput.includes("hevc_amf") },
      // H.264
      { codec: "h264", encoder: "h264_vaapi", compiled: encodersOutput.includes("h264_vaapi") },
      { codec: "h264", encoder: "h264_nvenc", compiled: encodersOutput.includes("h264_nvenc") },
      { codec: "h264", encoder: "h264_qsv", compiled: encodersOutput.includes("h264_qsv") },
      { codec: "h264", encoder: "h264_amf", compiled: encodersOutput.includes("h264_amf") },
    ];

    // Test hardware encoders in parallel
    const testResults = await Promise.all(
      hwEncodersToTest.map(async ({ codec, encoder, compiled }) => {
        if (!compiled) return { codec, encoder, works: false };
        const works = await testHardwareEncoder(encoder, config.gpuDevice);
        return { codec, encoder, works };
      })
    );

    // Build hardware encoder lists from test results
    const av1Hardware: string[] = [];
    const hevcHardware: string[] = [];
    const h264Hardware: string[] = [];

    for (const { codec, encoder, works } of testResults) {
      if (works) {
        if (codec === "av1") av1Hardware.push(encoder);
        else if (codec === "hevc") hevcHardware.push(encoder);
        else if (codec === "h264") h264Hardware.push(encoder);
      }
    }

    // Software encoders (always available if compiled)
    const av1Software: string[] = [];
    const hevcSoftware: string[] = [];
    const h264Software: string[] = [];

    if (encodersOutput.includes("libsvtav1")) av1Software.push("libsvtav1");
    if (encodersOutput.includes("libaom-av1")) av1Software.push("libaom-av1");
    if (encodersOutput.includes("libx265")) hevcSoftware.push("libx265");
    if (encodersOutput.includes("libx264")) h264Software.push("libx264");

    // Populate capabilities
    capabilities.videoEncoders.av1 = {};
    if (av1Hardware.length > 0) capabilities.videoEncoders.av1.hardware = av1Hardware;
    if (av1Software.length > 0) capabilities.videoEncoders.av1.software = av1Software;

    capabilities.videoEncoders.hevc = {};
    if (hevcHardware.length > 0) capabilities.videoEncoders.hevc.hardware = hevcHardware;
    if (hevcSoftware.length > 0) capabilities.videoEncoders.hevc.software = hevcSoftware;

    capabilities.videoEncoders.h264 = {};
    if (h264Hardware.length > 0) capabilities.videoEncoders.h264.hardware = h264Hardware;
    if (h264Software.length > 0) capabilities.videoEncoders.h264.software = h264Software;

    // Detect audio encoders
    const audioEncoders: string[] = [];
    if (encodersOutput.includes(" aac ")) audioEncoders.push("aac");
    if (encodersOutput.includes("libopus")) audioEncoders.push("libopus");
    if (encodersOutput.includes("libfdk_aac")) audioEncoders.push("libfdk_aac");
    if (encodersOutput.includes("libmp3lame")) audioEncoders.push("libmp3lame");
    if (encodersOutput.includes(" ac3 ")) audioEncoders.push("ac3");
    if (encodersOutput.includes("libvorbis")) audioEncoders.push("libvorbis");

    capabilities.audioEncoders = audioEncoders;

    // GPU information
    if (config.gpuDevice) {
      capabilities.gpu = {
        device: config.gpuDevice,
        accessible: fs.existsSync(config.gpuDevice),
      };

      // Try to get GPU driver info from vainfo if available
      if (capabilities.hwaccel.includes("vaapi")) {
        try {
          const vainfoCheck = Bun.spawn(
            ["vainfo", "--display", "drm", "--device", config.gpuDevice],
            {
              stdout: "pipe",
              stderr: "pipe",
            }
          );
          const vainfoOutput = await new Response(vainfoCheck.stdout).text();
          await vainfoCheck.exited;

          // Extract driver name from vainfo output
          const driverMatch = vainfoOutput.match(/Driver version: (.+)/);
          if (driverMatch) {
            capabilities.gpu.driver = driverMatch[1].trim();
          }
        } catch {
          // vainfo not available or failed
        }
      }
    }

    // System information
    capabilities.system = {
      cpuCores: os.cpus().length,
      totalMemory: Math.round(os.totalmem() / 1024 / 1024), // Convert to MB
    };
  } catch (error) {
    console.error("[Capabilities] Failed to detect capabilities:", error);
  }

  return capabilities;
}
