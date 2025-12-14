/**
 * Encoding Service
 *
 * Provides media probing, FFmpeg command building, and utility functions.
 * Local encoding is no longer supported - all encoding is handled by remote encoder nodes.
 * Uses the encoder registry for dynamic flag configuration and validation.
 */

import { spawn } from "child_process";
import { promises as fs } from "fs";
import { dirname, basename, extname } from "path";
import { prisma } from "../db/client.js";
import { getConfig } from "../config/index.js";
import {
  videoEncoders,
  audioEncoders,
  validateEncoderFlags,
  type VideoEncoderInfo,
  type AudioEncoderInfo,
} from "./encoderRegistry.js";
import type { EncodingProfile, Resolution } from "@prisma/client";

// =============================================================================
// Types
// =============================================================================

export interface AudioTrack {
  index: number; // Stream index in file
  language: string; // ISO 639-2 code (e.g., "eng", "jpn", "und")
  codec: string;
  channels: number;
  title?: string; // Track title if present
  isDefault: boolean;
}

export interface SubtitleTrack {
  index: number; // Stream index in file
  language: string; // ISO 639-2 code
  codec: string;
  title?: string;
  isForced: boolean;
  isDefault: boolean;
}

export interface ProbeResult {
  duration: number; // seconds
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
  audioChannels: number;
  hasHdr: boolean;
  hdrFormat?: string; // HDR10, HDR10+, Dolby Vision, HLG
  bitrate: number; // kbps
  fileSize: number; // bytes
  // Detailed track information
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
}

export interface EncodingProgress {
  frame: number;
  fps: number;
  bitrate: number; // kbps
  totalSize: number; // bytes
  elapsedTime: number; // seconds
  progress: number; // 0-100
  eta: number; // seconds
  speed: number; // x realtime
}

export interface EncodingResult {
  success: boolean;
  inputPath: string;
  outputPath: string;
  inputSize: number;
  outputSize: number;
  compressionRatio: number;
  duration: number; // seconds to encode
  error?: string;
}


// =============================================================================
// Encoding Service Class
// =============================================================================

class EncodingService {
  private ffmpegPath: string;
  private ffprobePath: string;
  private tempDir: string;

  constructor() {
    const config = getConfig();
    this.ffmpegPath = config.encoding.ffmpegPath;
    this.ffprobePath = config.encoding.ffprobePath;
    this.tempDir = config.encoding.tempDir;
  }

  // ===========================================================================
  // Media Probing
  // ===========================================================================

  /**
   * Probe a video file for metadata
   */
  async probe(inputPath: string): Promise<ProbeResult> {
    console.log(`[Encoding] Probing file: ${inputPath}`);

    return new Promise((resolve, reject) => {
      const args = [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        inputPath,
      ];

      const process = spawn(this.ffprobePath, args);
      let stdout = "";
      let stderr = "";

      process.stdout.on("data", (data) => (stdout += data.toString()));
      process.stderr.on("data", (data) => (stderr += data.toString()));

      process.on("close", (code) => {
        if (code !== 0) {
          console.error(`[Encoding] ffprobe failed for: ${inputPath}`);
          console.error(`[Encoding] ffprobe stderr: ${stderr}`);
          reject(new Error(`ffprobe failed for "${inputPath}": ${stderr || 'unknown error'}`));
          return;
        }

        try {
          const data = JSON.parse(stdout);
          const result = this.parseProbeData(data);
          resolve(result);
        } catch (error) {
          reject(new Error(`Failed to parse probe data: ${error}`));
        }
      });

      process.on("error", reject);
    });
  }

  /**
   * Parse ffprobe JSON output
   */
  private parseProbeData(data: {
    format?: { duration?: string; bit_rate?: string; size?: string };
    streams?: Array<{
      index?: number;
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      channels?: number;
      color_transfer?: string;
      color_primaries?: string;
      side_data_list?: Array<{ side_data_type?: string }>;
      tags?: {
        language?: string;
        title?: string;
      };
      disposition?: {
        default?: number;
        forced?: number;
      };
    }>;
  }): ProbeResult {
    const format = data.format || {};
    const streams = data.streams || [];

    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");

    const duration = parseFloat(format.duration || "0");
    const bitrate = Math.floor(parseInt(format.bit_rate || "0", 10) / 1000);
    const fileSize = parseInt(format.size || "0", 10);

    let fps = 24;
    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split("/");
      if (parts.length === 2) {
        fps = parseInt(parts[0], 10) / parseInt(parts[1], 10);
      }
    }

    const hasHdr = this.detectHdr(videoStream);
    const hdrFormat = this.detectHdrFormat(videoStream);

    // Parse all audio tracks
    const audioTracks: AudioTrack[] = streams
      .filter((s) => s.codec_type === "audio")
      .map((s) => ({
        index: s.index ?? 0,
        language: s.tags?.language || "und",
        codec: s.codec_name || "unknown",
        channels: s.channels || 0,
        title: s.tags?.title,
        isDefault: s.disposition?.default === 1,
      }));

    // Parse all subtitle tracks
    const subtitleTracks: SubtitleTrack[] = streams
      .filter((s) => s.codec_type === "subtitle")
      .map((s) => ({
        index: s.index ?? 0,
        language: s.tags?.language || "und",
        codec: s.codec_name || "unknown",
        title: s.tags?.title,
        isForced: s.disposition?.forced === 1,
        isDefault: s.disposition?.default === 1,
      }));

    return {
      duration,
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      fps,
      videoCodec: videoStream?.codec_name || "unknown",
      audioCodec: audioStream?.codec_name || "unknown",
      audioChannels: audioStream?.channels || 0,
      hasHdr,
      hdrFormat,
      bitrate,
      fileSize,
      audioTracks,
      subtitleTracks,
    };
  }

  /**
   * Detect if video has HDR
   */
  private detectHdr(stream?: {
    color_transfer?: string;
    color_primaries?: string;
  }): boolean {
    if (!stream) return false;

    const hdrTransfers = ["smpte2084", "arib-std-b67", "smpte428"];
    const hdrPrimaries = ["bt2020"];

    return (
      hdrTransfers.includes(stream.color_transfer || "") ||
      hdrPrimaries.includes(stream.color_primaries || "")
    );
  }

  /**
   * Detect HDR format
   */
  private detectHdrFormat(stream?: {
    color_transfer?: string;
    side_data_list?: Array<{ side_data_type?: string }>;
  }): string | undefined {
    if (!stream) return undefined;

    const sideData = stream.side_data_list || [];
    if (sideData.some((s) => s.side_data_type?.includes("Dolby Vision"))) {
      return "Dolby Vision";
    }

    if (sideData.some((s) => s.side_data_type?.includes("HDR10+"))) {
      return "HDR10+";
    }

    if (stream.color_transfer === "smpte2084") {
      return "HDR10";
    }

    if (stream.color_transfer === "arib-std-b67") {
      return "HLG";
    }

    return undefined;
  }

  // ===========================================================================
  // Profile Management
  // ===========================================================================

  /**
   * Get encoding profile from database
   */
  async getProfile(profileId: string): Promise<EncodingProfile | null> {
    return prisma.encodingProfile.findUnique({
      where: { id: profileId },
    });
  }

  /**
   * Get default encoding profile
   */
  async getDefaultProfile(): Promise<EncodingProfile | null> {
    return prisma.encodingProfile.findFirst({
      where: { isDefault: true },
    });
  }

  // ===========================================================================
  // Resolution Helpers
  // ===========================================================================

  /**
   * Map resolution enum to pixel height
   */
  private resolutionToHeight(resolution: Resolution): number {
    const map: Record<Resolution, number> = {
      RES_4K: 2160,
      RES_2K: 1440,
      RES_1080P: 1080,
      RES_720P: 720,
      RES_480P: 480,
    };
    return map[resolution] || 1080;
  }

  /**
   * Map resolution enum to string for naming
   */
  resolutionToString(resolution: Resolution): string {
    const map: Record<Resolution, string> = {
      RES_4K: "2160p",
      RES_2K: "1440p",
      RES_1080P: "1080p",
      RES_720P: "720p",
      RES_480P: "480p",
    };
    return map[resolution] || "1080p";
  }

  // ===========================================================================
  // FFmpeg Command Building
  // ===========================================================================

  /**
   * Build hardware acceleration input arguments
   * @param profile - The encoding profile
   * @param deviceOverride - Optional device path to override profile's hwDevice (for load balancing)
   *
   * Note on VAAPI: We intentionally do NOT use hardware decoding for VAAPI because:
   * 1. Intel Arc GPUs often fail to allocate both decode and encode contexts simultaneously
   * 2. Using software decode + hardware encode is more reliable and still fast
   * 3. The GPU is still used for the expensive encoding operation
   *
   * For VAAPI, we use -vaapi_device to initialize the device, then hwupload filter
   * to send decoded frames to the GPU for encoding.
   */
  private buildHwAccelInputArgs(profile: EncodingProfile, deviceOverride?: string): string[] {
    const args: string[] = [];
    const device = deviceOverride || profile.hwDevice;

    switch (profile.hwAccel) {
      case "QSV":
        args.push("-hwaccel", "qsv");
        if (device) {
          args.push("-hwaccel_device", device);
        }
        args.push("-hwaccel_output_format", "qsv");
        break;

      case "NVENC":
        args.push("-hwaccel", "cuda");
        if (device) {
          args.push("-hwaccel_device", device);
        }
        args.push("-hwaccel_output_format", "cuda");
        break;

      case "VAAPI":
        // Use software decoding + hardware encoding for VAAPI
        // This avoids "Failed to create decode context" errors on Intel Arc
        // The -vaapi_device flag initializes the VAAPI device for encoding
        // Frames are uploaded to GPU via hwupload filter in buildVideoEncoderArgs
        args.push("-vaapi_device", device || "/dev/dri/renderD128");
        break;

      case "AMF":
        args.push("-hwaccel", "d3d11va");
        break;

      case "VIDEOTOOLBOX":
        args.push("-hwaccel", "videotoolbox");
        break;

      case "NONE":
      default:
        // No hardware acceleration
        break;
    }

    return args;
  }

  /**
   * Build video encoder arguments from profile
   */
  private buildVideoEncoderArgs(
    profile: EncodingProfile,
    probe: ProbeResult
  ): string[] {
    const args: string[] = [];
    const encoderInfo = videoEncoders[profile.videoEncoder];

    if (!encoderInfo) {
      console.warn(`Unknown encoder ${profile.videoEncoder}, falling back to libsvtav1`);
      args.push("-c:v", "libsvtav1");
      args.push("-crf", profile.videoQuality.toString());
      return args;
    }

    // Set the video codec
    args.push("-c:v", profile.videoEncoder);

    // Set quality parameter based on encoder's quality mode
    // Note: VAAPI encoders require -rc_mode CQP before -qp will be recognized
    switch (encoderInfo.qualityMode) {
      case "crf":
        args.push("-crf", profile.videoQuality.toString());
        break;
      case "qp":
        // For VAAPI encoders, we must set rc_mode to CQP for -qp to work
        if (profile.hwAccel === "VAAPI") {
          args.push("-rc_mode", "CQP");
        }
        args.push("-qp", profile.videoQuality.toString());
        break;
      case "global_quality":
        args.push("-global_quality", profile.videoQuality.toString());
        break;
      case "cq":
        args.push("-cq", profile.videoQuality.toString());
        break;
      case "icq":
        args.push("-q", profile.videoQuality.toString());
        break;
    }

    // Parse and apply video flags
    const videoFlags = (profile.videoFlags || {}) as Record<string, unknown>;
    const svtParams: string[] = []; // For SVT-AV1 params that need to be combined

    for (const [key, value] of Object.entries(videoFlags)) {
      const flagDef = encoderInfo.flags[key];
      if (!flagDef) continue;

      const ffmpegArg = flagDef.ffmpegArg || key;

      // Special handling for SVT-AV1 params
      if (ffmpegArg === "svtav1-params") {
        if (flagDef.type === "boolean") {
          svtParams.push(`${key}=${value ? "1" : "0"}`);
        } else {
          svtParams.push(`${key}=${value}`);
        }
        continue;
      }

      // Handle different flag types
      switch (flagDef.type) {
        case "boolean": {
          const boolFlag = flagDef;
          const trueVal = boolFlag.ffmpegTrue || "1";
          const falseVal = boolFlag.ffmpegFalse || "0";
          args.push(`-${ffmpegArg}`, value ? trueVal : falseVal);
          break;
        }
        case "number":
        case "enum":
        case "string":
          args.push(`-${ffmpegArg}`, String(value));
          break;
      }
    }

    // Add combined SVT-AV1 params if any
    if (svtParams.length > 0) {
      args.push("-svtav1-params", svtParams.join(":"));
    }

    // Resolution scaling and hardware upload filters
    const targetHeight = this.resolutionToHeight(profile.videoMaxResolution);
    const needsScaling = probe.height > targetHeight;

    if (profile.hwAccel === "VAAPI") {
      // VAAPI uses software decode + hardware encode
      // We need format=nv12,hwupload to upload frames to GPU
      // If scaling is needed, do it on GPU with scale_vaapi after hwupload
      if (needsScaling) {
        args.push("-vf", `format=nv12,hwupload,scale_vaapi=-2:${targetHeight}`);
      } else {
        args.push("-vf", "format=nv12,hwupload");
      }
    } else if (needsScaling) {
      // For other hardware encoders, use appropriate scale filter
      if (profile.hwAccel === "QSV") {
        args.push("-vf", `scale_qsv=-1:${targetHeight}`);
      } else if (profile.hwAccel === "NVENC") {
        args.push("-vf", `scale_cuda=-1:${targetHeight}`);
      } else {
        args.push("-vf", `scale=-2:${targetHeight}`);
      }
    }

    // Max bitrate (if set)
    if (profile.videoMaxBitrate) {
      args.push("-maxrate", `${profile.videoMaxBitrate}k`);
      args.push("-bufsize", `${profile.videoMaxBitrate * 2}k`);
    }

    return args;
  }

  /**
   * Build audio encoder arguments from profile
   * @param profile - The encoding profile
   * @param probe - Probe result to get source audio channels (prevents upmixing)
   */
  private buildAudioEncoderArgs(profile: EncodingProfile, probe: ProbeResult): string[] {
    const args: string[] = [];

    // Handle passthrough
    if (profile.audioEncoder === "copy") {
      args.push("-c:a", "copy");
      return args;
    }

    const encoderInfo = audioEncoders[profile.audioEncoder];
    if (!encoderInfo) {
      console.warn(`Unknown audio encoder ${profile.audioEncoder}, using copy`);
      args.push("-c:a", "copy");
      return args;
    }

    // Set audio codec
    args.push("-c:a", profile.audioEncoder);

    // Parse and apply audio flags
    const audioFlags = (profile.audioFlags || {}) as Record<string, unknown>;

    // Track if we've set channels
    let channelsSet = false;

    for (const [key, value] of Object.entries(audioFlags)) {
      const flagDef = encoderInfo.flags[key];
      if (!flagDef) continue;

      const ffmpegArg = flagDef.ffmpegArg || key;

      // Handle bitrate specially (needs 'k' suffix)
      if (key === "b:a" && typeof value === "number") {
        args.push(`-${ffmpegArg}`, `${value}k`);
        continue;
      }

      // Handle channels - cap to source channels to prevent upmixing
      if (key === "ac") {
        channelsSet = true;
        const requestedChannels = parseInt(String(value), 10);
        const sourceChannels = probe.audioChannels || 2;
        // Never upmix - use minimum of requested and source channels
        const outputChannels = Math.min(requestedChannels, sourceChannels);
        if (outputChannels !== requestedChannels) {
          console.log(`[Encoding] Capping audio channels from ${requestedChannels} to ${outputChannels} (source has ${sourceChannels})`);
        }
        args.push(`-${ffmpegArg}`, String(outputChannels));
        continue;
      }

      args.push(`-${ffmpegArg}`, String(value));
    }

    // If no channels specified but source has audio, preserve source channel count
    if (!channelsSet && probe.audioChannels > 0) {
      args.push("-ac", String(probe.audioChannels));
    }

    return args;
  }

  /**
   * Build subtitle arguments from profile
   */
  private buildSubtitleArgs(profile: EncodingProfile): string[] {
    const args: string[] = [];

    switch (profile.subtitlesMode) {
      case "COPY":
        args.push("-c:s", "copy");
        break;

      case "COPY_TEXT":
        // Copy only text-based subtitle formats
        args.push("-c:s", "copy");
        // Filter for text subs would need -map
        break;

      case "EXTRACT":
        // Don't include subtitles in output - extract separately
        args.push("-sn");
        break;

      case "NONE":
        args.push("-sn");
        break;
    }

    return args;
  }

  /**
   * Build complete FFmpeg arguments for encoding
   * @param deviceOverride - Optional GPU device path for load balancing
   */
  buildFfmpegArgs(
    inputPath: string,
    outputPath: string,
    profile: EncodingProfile,
    probe: ProbeResult,
    deviceOverride?: string
  ): string[] {
    const args: string[] = [];

    // Hardware acceleration input args (must come before -i)
    args.push(...this.buildHwAccelInputArgs(profile, deviceOverride));

    // Input file
    args.push("-i", inputPath);

    // Overwrite output
    args.push("-y");

    // Progress to stdout
    args.push("-progress", "pipe:1");
    args.push("-stats_period", "1");

    // Video encoder args
    args.push(...this.buildVideoEncoderArgs(profile, probe));

    // Audio encoder args
    args.push(...this.buildAudioEncoderArgs(profile, probe));

    // Subtitle args
    args.push(...this.buildSubtitleArgs(profile));

    // Container-specific flags
    const container = profile.container.toLowerCase();
    if (container === "mp4") {
      args.push("-movflags", "+faststart");
    }

    // Output file
    args.push(outputPath);

    return args;
  }

  // ===========================================================================
  // Encoding Execution (Remote Only)
  // ===========================================================================

  /**
   * Local encoding is no longer supported.
   * All encoding is now handled by remote encoder nodes.
   * @deprecated Use remote encoders via encoderDispatch service
   */
  async encode(
    _inputPath: string,
    _outputPath: string,
    _profileId: string,
    _options: {
      jobId?: string;
      onProgress?: (progress: EncodingProgress) => void;
      checkCancelled?: () => boolean;
    } = {}
  ): Promise<EncodingResult> {
    throw new Error(
      "Local encoding is no longer supported. " +
      "All encoding is now handled by remote encoder nodes. " +
      "Please configure at least one remote encoder in Settings > Remote Encoders."
    );
  }

  /**
   * Cancel an active encoding job
   * @deprecated Local encoding is no longer supported
   */
  cancelEncoding(_jobId: string): boolean {
    console.warn("[Encoding] Local encoding cancellation is no longer supported. Use remote encoder management.");
    return false;
  }

  /**
   * Generate output path for encoding
   */
  generateOutputPath(inputPath: string, profile: EncodingProfile): string {
    const ext = extname(inputPath);
    const base = basename(inputPath, ext);
    const container = profile.container.toLowerCase();

    return `${this.tempDir}/${base}.${container}`;
  }

  /**
   * Clean up temporary files
   */
  async cleanupTempFiles(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await fs.unlink(path);
        console.log(`[Encoding] Cleaned up: ${path}`);
      } catch {
        // Ignore errors
      }
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Get codec from encoder name
   */
  getCodecForEncoder(encoderName: string): string {
    const encoder = videoEncoders[encoderName];
    return encoder?.codec || "unknown";
  }

  /**
   * Check if encoder requires hardware acceleration
   */
  isHardwareEncoder(encoderName: string): boolean {
    const encoder = videoEncoders[encoderName];
    return encoder ? encoder.hwAccel !== "none" : false;
  }

  /**
   * Get encoder info for UI
   */
  getEncoderInfo(encoderName: string): VideoEncoderInfo | undefined {
    return videoEncoders[encoderName];
  }

  /**
   * Get all available encoders
   */
  getAvailableEncoders(): Record<string, VideoEncoderInfo> {
    return videoEncoders;
  }

  /**
   * Get audio encoder info
   */
  getAudioEncoderInfo(encoderName: string): AudioEncoderInfo | undefined {
    return audioEncoders[encoderName];
  }

  /**
   * Get all available audio encoders
   */
  getAvailableAudioEncoders(): Record<string, AudioEncoderInfo> {
    return audioEncoders;
  }

  // ===========================================================================
  // Track Cleanup / Remuxing
  // ===========================================================================

  /**
   * Remux a media file to filter audio and subtitle tracks.
   *
   * Rules:
   * - If only 1 audio language exists, keep all audio tracks
   * - If multiple languages exist, keep only English and Japanese audio
   * - Keep only English subtitles, remove all others
   *
   * @param inputPath - Path to the input file
   * @param outputPath - Path for the remuxed output (or same as input to replace in-place)
   * @returns Result with success status and details
   */
  async remuxTracks(
    inputPath: string,
    outputPath?: string
  ): Promise<{
    success: boolean;
    outputPath: string;
    audioTracksKept: number;
    audioTracksRemoved: number;
    subtitleTracksKept: number;
    subtitleTracksRemoved: number;
    error?: string;
  }> {
    console.log(`[Encoding] Analyzing tracks for remux: ${inputPath}`);

    // Probe the file to get track info
    let probe: ProbeResult;
    try {
      probe = await this.probe(inputPath);
    } catch (error) {
      return {
        success: false,
        outputPath: inputPath,
        audioTracksKept: 0,
        audioTracksRemoved: 0,
        subtitleTracksKept: 0,
        subtitleTracksRemoved: 0,
        error: `Failed to probe file: ${error}`,
      };
    }

    const { audioTracks, subtitleTracks } = probe;
    console.log(`[Encoding] Found ${audioTracks.length} audio tracks, ${subtitleTracks.length} subtitle tracks`);

    // Determine unique audio languages
    const audioLanguages = new Set(audioTracks.map((t) => t.language.toLowerCase()));
    console.log(`[Encoding] Audio languages: ${Array.from(audioLanguages).join(", ")}`);

    // Determine which audio tracks to keep
    let audioToKeep: AudioTrack[];
    if (audioLanguages.size <= 1) {
      // Single language (or none) - keep all audio tracks
      audioToKeep = audioTracks;
      console.log(`[Encoding] Single audio language detected, keeping all ${audioTracks.length} audio tracks`);
    } else {
      // Multiple languages - keep only English and Japanese
      const keepLanguages = ["eng", "en", "english", "jpn", "jp", "ja", "japanese", "und"];
      audioToKeep = audioTracks.filter((t) =>
        keepLanguages.some((lang) => t.language.toLowerCase() === lang)
      );
      console.log(`[Encoding] Multiple languages - keeping ${audioToKeep.length} English/Japanese tracks, removing ${audioTracks.length - audioToKeep.length}`);
    }

    // Determine which subtitle tracks to keep - only English
    const englishSubLangs = ["eng", "en", "english"];
    const subtitlesToKeep = subtitleTracks.filter((t) =>
      englishSubLangs.some((lang) => t.language.toLowerCase() === lang)
    );
    console.log(`[Encoding] Keeping ${subtitlesToKeep.length} English subtitle tracks, removing ${subtitleTracks.length - subtitlesToKeep.length}`);

    // Check if any changes are needed
    const audioRemoved = audioTracks.length - audioToKeep.length;
    const subtitlesRemoved = subtitleTracks.length - subtitlesToKeep.length;

    if (audioRemoved === 0 && subtitlesRemoved === 0) {
      console.log(`[Encoding] No track changes needed, skipping remux`);
      return {
        success: true,
        outputPath: inputPath,
        audioTracksKept: audioToKeep.length,
        audioTracksRemoved: 0,
        subtitleTracksKept: subtitlesToKeep.length,
        subtitleTracksRemoved: 0,
      };
    }

    // Build ffmpeg command for remuxing
    const ext = extname(inputPath);
    const tempOutput = outputPath || inputPath.replace(ext, `.remux${ext}`);
    const finalOutput = outputPath || inputPath;

    const args: string[] = [
      "-i", inputPath,
      "-y", // Overwrite output
    ];

    // Map video stream (copy all video)
    args.push("-map", "0:v", "-c:v", "copy");

    // Map selected audio tracks
    for (const track of audioToKeep) {
      args.push("-map", `0:${track.index}`);
    }
    args.push("-c:a", "copy");

    // Map selected subtitle tracks
    if (subtitlesToKeep.length > 0) {
      for (const track of subtitlesToKeep) {
        args.push("-map", `0:${track.index}`);
      }
      args.push("-c:s", "copy");
    }

    args.push(tempOutput);

    console.log(`[Encoding] Remuxing with command: ${this.ffmpegPath} ${args.join(" ")}`);

    return new Promise((resolve) => {
      const process = spawn(this.ffmpegPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", async (code) => {
        if (code === 0) {
          // If we're replacing in-place, move temp to original
          if (!outputPath) {
            try {
              await fs.unlink(inputPath);
              await fs.rename(tempOutput, finalOutput);
              console.log(`[Encoding] Remux complete, replaced original file`);
            } catch (error) {
              console.error(`[Encoding] Failed to replace original: ${error}`);
              resolve({
                success: false,
                outputPath: tempOutput,
                audioTracksKept: audioToKeep.length,
                audioTracksRemoved: audioRemoved,
                subtitleTracksKept: subtitlesToKeep.length,
                subtitleTracksRemoved: subtitlesRemoved,
                error: `Failed to replace original file: ${error}`,
              });
              return;
            }
          }

          console.log(`[Encoding] Remux complete: ${audioRemoved} audio tracks removed, ${subtitlesRemoved} subtitle tracks removed`);
          resolve({
            success: true,
            outputPath: finalOutput,
            audioTracksKept: audioToKeep.length,
            audioTracksRemoved: audioRemoved,
            subtitleTracksKept: subtitlesToKeep.length,
            subtitleTracksRemoved: subtitlesRemoved,
          });
        } else {
          console.error(`[Encoding] Remux failed with code ${code}`);
          console.error(`[Encoding] FFmpeg stderr: ${stderr.slice(-2000)}`);

          // Clean up temp file
          try {
            await fs.unlink(tempOutput);
          } catch {
            // Ignore
          }

          resolve({
            success: false,
            outputPath: inputPath,
            audioTracksKept: audioTracks.length,
            audioTracksRemoved: 0,
            subtitleTracksKept: subtitleTracks.length,
            subtitleTracksRemoved: 0,
            error: stderr || `FFmpeg exited with code ${code}`,
          });
        }
      });

      process.on("error", (error) => {
        resolve({
          success: false,
          outputPath: inputPath,
          audioTracksKept: audioTracks.length,
          audioTracksRemoved: 0,
          subtitleTracksKept: subtitleTracks.length,
          subtitleTracksRemoved: 0,
          error: error.message,
        });
      });
    });
  }
}

// =============================================================================
// Singleton Export
// =============================================================================

let encodingService: EncodingService | null = null;

export function getEncodingService(): EncodingService {
  if (!encodingService) {
    encodingService = new EncodingService();
  }
  return encodingService;
}

export { EncodingService };
