/**
 * FFmpeg Encoder Service
 *
 * Handles FFmpeg execution for AV1 encoding with VAAPI hardware acceleration.
 */

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { EncodingProfileData, JobProgressMessage } from "@annex/shared";
import { getConfig } from "./config.js";

export interface EncodeJob {
  jobId: string;
  inputPath: string;
  outputPath: string;
  profile: EncodingProfileData;
  onProgress: (progress: JobProgressMessage) => void;
  abortSignal?: AbortSignal;
}

export interface EncodeResult {
  outputPath: string;
  outputSize: number;
  compressionRatio: number;
  duration: number;
}

interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  fileSize: number;
}

/**
 * Probe a media file to get its properties
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);

    let stdout = "";
    let stderr = "";

    ffprobe.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    ffprobe.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffprobe.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr}`));
        return;
      }

      try {
        const data = JSON.parse(stdout);
        const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === "video");

        if (!videoStream) {
          reject(new Error("No video stream found"));
          return;
        }

        // Parse frame rate
        let fps = 24;
        if (videoStream.r_frame_rate) {
          const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
          if (den > 0) fps = num / den;
        }

        resolve({
          duration: parseFloat(data.format?.duration || "0"),
          width: videoStream.width || 1920,
          height: videoStream.height || 1080,
          fps: fps,
          fileSize: parseInt(data.format?.size || "0", 10),
        });
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e}`));
      }
    });

    ffprobe.on("error", reject);
  });
}

/**
 * Build FFmpeg arguments for encoding
 */
function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  profile: EncodingProfileData,
  mediaInfo: MediaInfo,
  gpuDevice: string
): string[] {
  const args: string[] = [
    "-hide_banner",
    "-y",
    "-progress", "pipe:1",
  ];

  // Hardware acceleration for both decode and encode
  // Note: hwAccel comes from DB as uppercase enum value (VAAPI, QSV, etc.)
  const hwAccel = profile.hwAccel?.toUpperCase();
  console.log(`[Encoder] hwAccel from profile: "${profile.hwAccel}" (normalized: "${hwAccel}")`);
  if (hwAccel === "VAAPI") {
    console.log(`[Encoder] Using VAAPI hardware decode + encode on ${gpuDevice}`);
    // Hardware decode
    args.push("-hwaccel", "vaapi");
    args.push("-hwaccel_device", gpuDevice);
    args.push("-hwaccel_output_format", "vaapi");
  } else {
    console.log(`[Encoder] Using SOFTWARE encoding (hwAccel="${hwAccel}" is not VAAPI)`);
  }

  // Input
  args.push("-i", inputPath);

  // Video encoding
  const videoArgs = buildVideoArgs(profile, mediaInfo, gpuDevice);
  args.push(...videoArgs);

  // Audio encoding
  const audioArgs = buildAudioArgs(profile);
  args.push(...audioArgs);

  // Subtitles
  args.push("-c:s", "copy");

  // Output
  args.push(outputPath);

  return args;
}

/**
 * Build video encoding arguments
 */
function buildVideoArgs(
  profile: EncodingProfileData,
  mediaInfo: MediaInfo,
  gpuDevice: string
): string[] {
  const args: string[] = [];
  const hwAccel = profile.hwAccel?.toUpperCase();

  // Calculate target resolution
  const targetRes = getTargetResolution(profile.videoMaxResolution, mediaInfo);

  // Video filter chain
  const filters: string[] = [];

  if (hwAccel === "VAAPI") {
    // With hardware decode, frames are already on GPU in VAAPI format
    // Use scale_vaapi for GPU-based scaling
    if (targetRes.width !== mediaInfo.width || targetRes.height !== mediaInfo.height) {
      filters.push(`scale_vaapi=w=${targetRes.width}:h=${targetRes.height}`);
    }
  } else {
    // Software path
    if (targetRes.width !== mediaInfo.width || targetRes.height !== mediaInfo.height) {
      filters.push(`scale=${targetRes.width}:${targetRes.height}`);
    }
  }

  if (filters.length > 0) {
    args.push("-vf", filters.join(","));
  }

  // Video codec
  if (hwAccel === "VAAPI") {
    args.push("-c:v", "av1_vaapi");
    args.push("-rc_mode", "CQP");
    args.push("-qp", String(profile.videoQuality));
  } else {
    // Software encoding fallback
    args.push("-c:v", "libsvtav1");
    args.push("-crf", String(profile.videoQuality));
    args.push("-preset", "6");
  }

  // Max bitrate if set
  if (profile.videoMaxBitrate) {
    args.push("-maxrate", `${profile.videoMaxBitrate}k`);
    args.push("-bufsize", `${profile.videoMaxBitrate * 2}k`);
  }

  // Additional video flags from profile
  if (profile.videoFlags && typeof profile.videoFlags === "object") {
    for (const [key, value] of Object.entries(profile.videoFlags)) {
      // Skip rc_mode since it's already set above for VAAPI
      if (key === "rc_mode") continue;
      if (value !== null && value !== undefined && value !== "") {
        args.push(`-${key}`, String(value));
      }
    }
  }

  return args;
}

/**
 * Build audio encoding arguments
 */
function buildAudioArgs(profile: EncodingProfileData): string[] {
  const args: string[] = [];

  if (profile.audioEncoder === "copy" || profile.audioEncoder === "passthrough") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", profile.audioEncoder);

    // Apply audio flags from profile
    if (profile.audioFlags && typeof profile.audioFlags === "object") {
      for (const [key, value] of Object.entries(profile.audioFlags)) {
        if (value !== null && value !== undefined && value !== "") {
          args.push(`-${key}`, String(value));
        }
      }
    }
  }

  return args;
}

/**
 * Calculate target resolution based on max resolution setting
 */
function getTargetResolution(
  maxResolution: string,
  mediaInfo: MediaInfo
): { width: number; height: number } {
  const resolutionMap: Record<string, { width: number; height: number }> = {
    // Standard format
    "4K": { width: 3840, height: 2160 },
    "2K": { width: 2560, height: 1440 },
    "1080p": { width: 1920, height: 1080 },
    "720p": { width: 1280, height: 720 },
    "480p": { width: 854, height: 480 },
    // Prisma enum format (RES_*)
    "RES_4K": { width: 3840, height: 2160 },
    "RES_2K": { width: 2560, height: 1440 },
    "RES_1080P": { width: 1920, height: 1080 },
    "RES_720P": { width: 1280, height: 720 },
    "RES_480P": { width: 854, height: 480 },
  };

  const maxRes = resolutionMap[maxResolution] || resolutionMap["1080p"];

  // Don't upscale
  if (mediaInfo.width <= maxRes.width && mediaInfo.height <= maxRes.height) {
    return { width: mediaInfo.width, height: mediaInfo.height };
  }

  // Scale down while maintaining aspect ratio
  const aspectRatio = mediaInfo.width / mediaInfo.height;
  if (aspectRatio > maxRes.width / maxRes.height) {
    // Width-limited
    return {
      width: maxRes.width,
      height: Math.round(maxRes.width / aspectRatio / 2) * 2, // Ensure even
    };
  } else {
    // Height-limited
    return {
      width: Math.round(maxRes.height * aspectRatio / 2) * 2,
      height: maxRes.height,
    };
  }
}

/**
 * Parse FFmpeg progress output
 */
function parseProgress(line: string): Partial<{
  frame: number;
  fps: number;
  bitrate: number;
  totalSize: number;
  outTimeUs: number;
  speed: number;
}> {
  const result: ReturnType<typeof parseProgress> = {};

  const matches: Record<string, (v: string) => void> = {
    "frame=": (v) => { result.frame = parseInt(v, 10); },
    "fps=": (v) => { result.fps = parseFloat(v); },
    "bitrate=": (v) => { result.bitrate = parseFloat(v.replace("kbits/s", "")); },
    "total_size=": (v) => { result.totalSize = parseInt(v, 10); },
    "out_time_us=": (v) => { result.outTimeUs = parseInt(v, 10); },
    "speed=": (v) => { result.speed = parseFloat(v.replace("x", "")); },
  };

  for (const [prefix, parser] of Object.entries(matches)) {
    if (line.startsWith(prefix)) {
      parser(line.slice(prefix.length).trim());
    }
  }

  return result;
}

/**
 * Execute an encoding job
 */
export async function encode(job: EncodeJob): Promise<EncodeResult> {
  const config = getConfig();
  const startTime = Date.now();

  // Verify input file exists
  if (!fs.existsSync(job.inputPath)) {
    throw new Error(`Input file not found: ${job.inputPath}`);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(job.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Probe input file
  const mediaInfo = await probeMedia(job.inputPath);
  console.log(`[Encoder] Input: ${mediaInfo.width}x${mediaInfo.height} @ ${mediaInfo.fps.toFixed(2)}fps, ${(mediaInfo.fileSize / 1024 / 1024 / 1024).toFixed(2)}GB`);

  // Build FFmpeg arguments
  const args = buildFfmpegArgs(
    job.inputPath,
    job.outputPath,
    job.profile,
    mediaInfo,
    config.gpuDevice
  );

  console.log(`[Encoder] Starting: ffmpeg ${args.join(" ")}`);

  return new Promise((resolve, reject) => {
    const ffmpeg: ChildProcess = spawn("ffmpeg", args);

    let progressState: {
      frame: number;
      fps: number;
      bitrate: number;
      totalSize: number;
      outTimeUs: number;
      speed: number;
    } = {
      frame: 0,
      fps: 0,
      bitrate: 0,
      totalSize: 0,
      outTimeUs: 0,
      speed: 0,
    };

    // Handle abort signal
    if (job.abortSignal) {
      job.abortSignal.addEventListener("abort", () => {
        console.log(`[Encoder] Job ${job.jobId} cancelled`);
        ffmpeg.kill("SIGKILL");
      });
    }

    // Parse progress from stdout
    ffmpeg.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        const parsed = parseProgress(line.trim());
        Object.assign(progressState, parsed);

        // Calculate progress percentage
        const elapsedTime = progressState.outTimeUs / 1_000_000;
        const progress = mediaInfo.duration > 0
          ? Math.min(100, (elapsedTime / mediaInfo.duration) * 100)
          : 0;

        // Calculate ETA
        const eta = progressState.speed > 0
          ? Math.round((mediaInfo.duration - elapsedTime) / progressState.speed)
          : 0;

        job.onProgress({
          type: "job:progress",
          jobId: job.jobId,
          progress,
          frame: progressState.frame,
          fps: progressState.fps,
          bitrate: progressState.bitrate,
          totalSize: progressState.totalSize,
          elapsedTime,
          speed: progressState.speed,
          eta,
        });
      }
    });

    let stderr = "";
    ffmpeg.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on("close", (code) => {
      const duration = (Date.now() - startTime) / 1000;

      if (code !== 0) {
        // Clean up partial output
        try {
          if (fs.existsSync(job.outputPath)) {
            fs.unlinkSync(job.outputPath);
          }
        } catch { /* ignore */ }

        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
        return;
      }

      // Get output file size
      let outputSize = 0;
      try {
        outputSize = fs.statSync(job.outputPath).size;
      } catch { /* ignore */ }

      const compressionRatio = mediaInfo.fileSize > 0
        ? mediaInfo.fileSize / outputSize
        : 1;

      console.log(`[Encoder] Complete: ${(outputSize / 1024 / 1024 / 1024).toFixed(2)}GB (${compressionRatio.toFixed(1)}x compression) in ${duration.toFixed(0)}s`);

      resolve({
        outputPath: job.outputPath,
        outputSize,
        compressionRatio,
        duration,
      });
    });

    ffmpeg.on("error", reject);
  });
}
