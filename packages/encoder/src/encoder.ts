/**
 * FFmpeg Encoder Service
 *
 * Handles FFmpeg execution for AV1 encoding with VAAPI hardware acceleration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { EncodingConfig, JobProgressMessage } from "@annex/shared";
import { getConfig } from "./config.js";

export interface EncodeJob {
  jobId: string;
  inputPath: string;
  outputPath: string;
  encodingConfig: EncodingConfig;
  onProgress: (progress: JobProgressMessage) => void;
  abortSignal?: AbortSignal;
}

export interface EncodeResult {
  outputPath: string;
  outputSize: number;
  compressionRatio: number;
  duration: number;
}

interface SubtitleStream {
  index: number;
  codec: string;
  language?: string;
}

interface MediaInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  fileSize: number;
  subtitleStreams: SubtitleStream[];
}

// Subtitle codecs that can be directly copied into MKV
// Note: mov_text (MP4 text subs) and ttml CANNOT be copied to MKV - they require conversion
const MKV_COMPATIBLE_SUBTITLE_CODECS = new Set([
  "ass",
  "ssa",
  "subrip",
  "srt",
  "webvtt",
  "dvd_subtitle",
  "dvdsub",
  "hdmv_pgs_subtitle",
  "pgssub",
  "dvb_subtitle",
]);

/**
 * Validate file path to prevent path traversal and command injection
 */
function validateFilePath(filePath: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error("File path must be absolute");
  }
  if (filePath.includes("..")) {
    throw new Error("Path traversal detected");
  }
  // Normalize path to resolve any symbolic links or relative components
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== filePath) {
    throw new Error("Path contains relative components");
  }
}

/**
 * Probe a media file to get its properties
 */
export async function probeMedia(filePath: string): Promise<MediaInfo> {
  validateFilePath(filePath);

  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${stderr}`);
  }

  try {
    const data = JSON.parse(stdout);
    const videoStream = data.streams?.find((s: { codec_type: string }) => s.codec_type === "video");

    if (!videoStream) {
      throw new Error("No video stream found");
    }

    // Parse frame rate
    let fps = 24;
    if (videoStream.r_frame_rate) {
      const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
      if (den > 0) fps = num / den;
    }

    // Parse subtitle streams
    const subtitleStreams: SubtitleStream[] = (data.streams || [])
      .filter((s: { codec_type: string }) => s.codec_type === "subtitle")
      .map((s: { index: number; codec_name: string; tags?: { language?: string } }) => ({
        index: s.index,
        codec: s.codec_name || "unknown",
        language: s.tags?.language,
      }));

    return {
      duration: parseFloat(data.format?.duration || "0"),
      width: videoStream.width || 1920,
      height: videoStream.height || 1080,
      fps: fps,
      fileSize: parseInt(data.format?.size || "0", 10),
      subtitleStreams,
    };
  } catch (e) {
    throw new Error(`Failed to parse ffprobe output: ${e}`);
  }
}

/**
 * Build FFmpeg arguments for encoding
 */
function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  encodingConfig: EncodingConfig,
  mediaInfo: MediaInfo,
  gpuDevice: string
): string[] {
  const args: string[] = ["-hide_banner", "-y", "-progress", "pipe:1"];

  // Hardware acceleration for both decode and encode
  // Note: hwAccel comes from DB as uppercase enum value (VAAPI, QSV, etc.)
  const hwAccel = encodingConfig.hwAccel?.toUpperCase();
  console.log(
    `[Encoder] hwAccel from profile: "${encodingConfig.hwAccel}" (normalized: "${hwAccel}")`
  );
  if (hwAccel === "VAAPI") {
    console.log(`[Encoder] Using VAAPI hardware decode + encode on ${gpuDevice}`);
    // Hardware decode
    args.push("-hwaccel", "vaapi");
    args.push("-hwaccel_device", gpuDevice);
    args.push("-hwaccel_output_format", "vaapi");
    // Limit hardware frame pool to prevent VRAM exhaustion on long encodes
    args.push("-extra_hw_frames", "8");
  } else if (hwAccel === "QSV") {
    console.log(`[Encoder] Using QSV (Quick Sync Video) hardware decode + encode on ${gpuDevice}`);
    // QSV on Linux requires VAAPI device initialization first
    // Initialize VAAPI as parent device, then QSV as child
    args.push("-init_hw_device", `vaapi=va:${gpuDevice}`);
    args.push("-init_hw_device", "qsv@va");
    args.push("-hwaccel", "qsv");
    args.push("-hwaccel_device", "qsv");
    args.push("-hwaccel_output_format", "qsv");
    // Limit hardware frame pool
    args.push("-extra_hw_frames", "8");
  } else {
    console.log(`[Encoder] Using SOFTWARE encoding (hwAccel="${hwAccel}")`);
  }

  // Input
  args.push("-i", inputPath);

  // Explicit stream mapping - video and audio
  args.push("-map", "0:v:0"); // First video stream
  args.push("-map", "0:a?"); // All audio streams (optional)

  // Map compatible subtitle streams (or skip entirely)
  const { subArgs, hasCompatibleSubs } = buildSubtitleMapping(mediaInfo);
  if (hasCompatibleSubs) {
    args.push(...subArgs);
  }

  // Video encoding
  const videoArgs = buildVideoArgs(encodingConfig, mediaInfo, gpuDevice);
  args.push(...videoArgs);

  // Audio encoding
  const audioArgs = buildAudioArgs(encodingConfig);
  args.push(...audioArgs);

  // Subtitle codec settings
  if (hasCompatibleSubs) {
    args.push("-c:s", "copy");
  }

  // Limit internal muxing queue to prevent memory buildup
  args.push("-max_muxing_queue_size", "1024");

  // Output
  args.push(outputPath);

  return args;
}

/**
 * Build subtitle stream mapping - only include MKV-compatible subtitle streams
 */
function buildSubtitleMapping(mediaInfo: MediaInfo): {
  subArgs: string[];
  hasCompatibleSubs: boolean;
} {
  const subArgs: string[] = [];

  if (mediaInfo.subtitleStreams.length === 0) {
    return { subArgs: [], hasCompatibleSubs: false };
  }

  // Filter to only compatible subtitle codecs
  const compatibleSubs = mediaInfo.subtitleStreams.filter((sub) =>
    MKV_COMPATIBLE_SUBTITLE_CODECS.has(sub.codec.toLowerCase())
  );

  if (compatibleSubs.length === 0) {
    // No compatible subtitles
    console.log(
      `[Encoder] Skipping ${mediaInfo.subtitleStreams.length} incompatible subtitle stream(s): ${mediaInfo.subtitleStreams.map((s) => s.codec).join(", ")}`
    );
    return { subArgs: [], hasCompatibleSubs: false };
  }

  // Log what we're doing
  const skipped = mediaInfo.subtitleStreams.length - compatibleSubs.length;
  if (skipped > 0) {
    const skippedCodecs = mediaInfo.subtitleStreams
      .filter((sub) => !MKV_COMPATIBLE_SUBTITLE_CODECS.has(sub.codec.toLowerCase()))
      .map((s) => s.codec);
    console.log(
      `[Encoder] Skipping ${skipped} incompatible subtitle stream(s): ${skippedCodecs.join(", ")}`
    );
  }
  console.log(
    `[Encoder] Including ${compatibleSubs.length} compatible subtitle stream(s): ${compatibleSubs.map((s) => s.codec).join(", ")}`
  );

  // Map only compatible subtitle streams
  for (const sub of compatibleSubs) {
    subArgs.push("-map", `0:${sub.index}`);
  }

  return { subArgs, hasCompatibleSubs: true };
}

/**
 * Build video encoding arguments
 */
function buildVideoArgs(
  encodingConfig: EncodingConfig,
  mediaInfo: MediaInfo,
  gpuDevice: string
): string[] {
  const args: string[] = [];
  const hwAccel = encodingConfig.hwAccel?.toUpperCase();

  // Calculate target resolution
  const targetRes = getTargetResolution(encodingConfig.maxResolution, mediaInfo);

  // Video filter chain
  const filters: string[] = [];

  if (hwAccel === "VAAPI") {
    // Hardware scaling on GPU
    if (targetRes.width !== mediaInfo.width || targetRes.height !== mediaInfo.height) {
      filters.push(`scale_vaapi=w=${targetRes.width}:h=${targetRes.height}`);
    }
  } else if (hwAccel === "QSV") {
    // QSV hardware scaling
    if (targetRes.width !== mediaInfo.width || targetRes.height !== mediaInfo.height) {
      filters.push(`scale_qsv=w=${targetRes.width}:h=${targetRes.height}`);
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
    args.push("-qp", String(encodingConfig.crf));
  } else if (hwAccel === "QSV") {
    args.push("-c:v", "av1_qsv");
    args.push("-global_quality", String(encodingConfig.crf));
  } else {
    // Software encoding fallback
    args.push("-c:v", "libsvtav1");
    args.push("-crf", String(encodingConfig.crf));
    args.push("-preset", "6");
  }

  // Max bitrate if set
  if (encodingConfig.maxBitrate) {
    args.push("-maxrate", `${encodingConfig.maxBitrate}k`);
    args.push("-bufsize", `${encodingConfig.maxBitrate * 2}k`);
  }

  // Additional video flags from profile
  if (encodingConfig.videoFlags && typeof encodingConfig.videoFlags === "object") {
    for (const [key, value] of Object.entries(encodingConfig.videoFlags)) {
      // Skip rc_mode since it's already set above for VAAPI
      if (key === "rc_mode") continue;
      if (value !== null && value !== undefined && value !== "") {
        let flagValue = String(value);

        // For av1_vaapi, compression_level must be 0-7
        if (hwAccel === "VAAPI" && key === "compression_level") {
          const level = parseInt(flagValue, 10);
          if (!Number.isNaN(level)) {
            flagValue = String(Math.min(7, Math.max(0, level)));
            if (flagValue !== String(value)) {
              console.log(
                `[Encoder] Clamped compression_level ${value} -> ${flagValue} for av1_vaapi`
              );
            }
          }
        }

        args.push(`-${key}`, flagValue);
      }
    }
  }

  return args;
}

/**
 * Build audio encoding arguments
 */
function buildAudioArgs(encodingConfig: EncodingConfig): string[] {
  const args: string[] = [];

  if (encodingConfig.audioEncoder === "copy" || encodingConfig.audioEncoder === "passthrough") {
    args.push("-c:a", "copy");
  } else {
    args.push("-c:a", encodingConfig.audioEncoder);

    // Special handling for libopus - downmix to stereo for compatibility
    // Opus is optimized for stereo/mono and has issues with surround layouts
    if (encodingConfig.audioEncoder === "libopus") {
      args.push("-ac", "2");
    }

    // Apply audio flags from profile
    if (encodingConfig.audioFlags && typeof encodingConfig.audioFlags === "object") {
      for (const [key, value] of Object.entries(encodingConfig.audioFlags)) {
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
    // Alternative p-suffix format
    "2160p": { width: 3840, height: 2160 },
    "1440p": { width: 2560, height: 1440 },
    // Prisma enum format (RES_*)
    RES_4K: { width: 3840, height: 2160 },
    RES_2K: { width: 2560, height: 1440 },
    RES_1080P: { width: 1920, height: 1080 },
    RES_720P: { width: 1280, height: 720 },
    RES_480P: { width: 854, height: 480 },
  };

  const maxRes = resolutionMap[maxResolution];
  if (!maxRes) {
    console.log(`[Encoder] WARNING: Unknown maxResolution "${maxResolution}", defaulting to 1080p`);
    return resolutionMap["1080p"];
  }
  console.log(
    `[Encoder] Target max resolution: ${maxResolution} (${maxRes.width}x${maxRes.height})`
  );

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
      width: Math.round((maxRes.height * aspectRatio) / 2) * 2,
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
    "frame=": (v) => {
      result.frame = parseInt(v, 10);
    },
    "fps=": (v) => {
      result.fps = parseFloat(v);
    },
    "bitrate=": (v) => {
      result.bitrate = parseFloat(v.replace("kbits/s", ""));
    },
    "total_size=": (v) => {
      result.totalSize = parseInt(v, 10);
    },
    "out_time_us=": (v) => {
      result.outTimeUs = parseInt(v, 10);
    },
    "speed=": (v) => {
      result.speed = parseFloat(v.replace("x", ""));
    },
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

  // Validate file paths for security
  validateFilePath(job.inputPath);
  validateFilePath(job.outputPath);

  // Verify input file exists
  if (!fs.existsSync(job.inputPath)) {
    throw new Error(`Input file not found: ${job.inputPath}`);
  }

  // Ensure output directory exists
  const outputDir = path.dirname(job.outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Probe input file
  const mediaInfo = await probeMedia(job.inputPath);
  console.log(
    `[Encoder] Input: ${mediaInfo.width}x${mediaInfo.height} @ ${mediaInfo.fps.toFixed(2)}fps, ${(mediaInfo.fileSize / 1024 / 1024 / 1024).toFixed(2)}GB`
  );

  // Build FFmpeg arguments
  const args = buildFfmpegArgs(
    job.inputPath,
    job.outputPath,
    job.encodingConfig,
    mediaInfo,
    config.gpuDevice
  );

  console.log(`[Encoder] Starting: ffmpeg ${args.join(" ")}`);

  const ffmpeg = Bun.spawn(["ffmpeg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const progressState = {
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
      ffmpeg.kill(9); // SIGKILL
    });
  }

  // Process stdout for progress in background
  const stdoutReader = (async () => {
    const reader = ffmpeg.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const parsed = parseProgress(line.trim());
          Object.assign(progressState, parsed);

          // Calculate progress percentage
          const elapsedTime = progressState.outTimeUs / 1_000_000;
          const progress =
            mediaInfo.duration > 0 ? Math.min(100, (elapsedTime / mediaInfo.duration) * 100) : 0;

          // Calculate ETA
          const eta =
            progressState.speed > 0
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
      }
    } catch {
      // Stream closed, ignore
    }
  })();

  // Collect stderr
  const stderrPromise = new Response(ffmpeg.stderr).text();

  // Wait for process to exit
  const [exitCode, stderr] = await Promise.all([ffmpeg.exited, stderrPromise]);

  // Also wait for stdout processing to complete
  await stdoutReader;

  const duration = (Date.now() - startTime) / 1000;

  if (exitCode !== 0) {
    // Clean up partial output
    try {
      if (fs.existsSync(job.outputPath)) {
        fs.unlinkSync(job.outputPath);
      }
    } catch {
      /* ignore */
    }

    throw new Error(`FFmpeg exited with code ${exitCode}: ${stderr.slice(-500)}`);
  }

  // Get output file size
  let outputSize = 0;
  try {
    outputSize = fs.statSync(job.outputPath).size;
  } catch {
    /* ignore */
  }

  const compressionRatio = mediaInfo.fileSize > 0 ? mediaInfo.fileSize / outputSize : 1;

  console.log(
    `[Encoder] Complete: ${(outputSize / 1024 / 1024 / 1024).toFixed(2)}GB (${compressionRatio.toFixed(1)}x compression) in ${duration.toFixed(0)}s`
  );

  return {
    outputPath: job.outputPath,
    outputSize,
    compressionRatio,
    duration,
  };
}
