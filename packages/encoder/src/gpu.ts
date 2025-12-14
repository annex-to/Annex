/**
 * GPU Detection
 *
 * Detects available GPU devices for VAAPI encoding.
 */

import { spawn } from "child_process";
import * as fs from "fs";

export interface GpuInfo {
  devicePath: string;
  vendor: string;
  model: string;
  supported: boolean;
}

/**
 * Check if a GPU device exists and is accessible
 */
export function isGpuAvailable(devicePath: string): boolean {
  try {
    fs.accessSync(devicePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * List all available render devices
 */
export function listRenderDevices(): string[] {
  try {
    const driPath = "/dev/dri";
    const files = fs.readdirSync(driPath);
    return files
      .filter((f) => f.startsWith("renderD"))
      .map((f) => `${driPath}/${f}`)
      .filter(isGpuAvailable);
  } catch {
    return [];
  }
}

/**
 * Test if a GPU can perform AV1 encoding
 */
export async function testGpuEncoding(devicePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Quick test: encode a few frames of test pattern
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-vaapi_device", devicePath,
      "-vf", "format=nv12,hwupload",
      "-c:v", "av1_vaapi",
      "-rc_mode", "CQP",
      "-qp", "30",
      "-frames:v", "5",
      "-f", "null",
      "-",
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        console.warn(`[GPU] Device ${devicePath} failed AV1 test: ${stderr}`);
        resolve(false);
      }
    });

    ffmpeg.on("error", () => {
      resolve(false);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      ffmpeg.kill("SIGKILL");
      resolve(false);
    }, 10000);
  });
}

/**
 * Get info about a specific GPU device
 */
export async function getGpuInfo(devicePath: string): Promise<GpuInfo | null> {
  if (!isGpuAvailable(devicePath)) {
    return null;
  }

  // Try to get device info via vainfo
  const vainfo = await getVaInfo(devicePath);

  return {
    devicePath,
    vendor: vainfo?.vendor || "Unknown",
    model: vainfo?.model || "Unknown",
    supported: await testGpuEncoding(devicePath),
  };
}

interface VaInfo {
  vendor: string;
  model: string;
}

async function getVaInfo(devicePath: string): Promise<VaInfo | null> {
  return new Promise((resolve) => {
    const proc = spawn("vainfo", ["--display", "drm", "--device", devicePath]);

    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      // Parse vainfo output
      const vendorMatch = stdout.match(/vainfo: Driver version: (.+)/);
      const modelMatch = stdout.match(/vainfo: VA-API version: (.+)/);

      resolve({
        vendor: vendorMatch?.[1]?.trim() || "Unknown",
        model: modelMatch?.[1]?.trim() || "Unknown",
      });
    });

    proc.on("error", () => {
      resolve(null);
    });

    setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(null);
    }, 5000);
  });
}
