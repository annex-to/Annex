/**
 * Encoding profiles and configuration
 */

import type { Resolution } from "./server.js";

export type HdrMode = "preserve" | "tonemap" | "strip";
export type AudioMode = "passthrough" | "transcode";
export type AudioCodec = "aac" | "libopus" | "passthrough";
export type AudioChannels = "stereo" | "5.1" | "7.1" | "original";
export type SubtitleInclude = "all" | "english" | "none";
export type Container = "mkv" | "mp4";

export interface VideoSettings {
  codec: "av1";
  maxResolution: Resolution;
  crf: number;
  preset: string;
  hdrMode: HdrMode;
  maxBitrate: number | null; // kbps
}

export interface AudioSettings {
  mode: AudioMode;
  codec: AudioCodec;
  channels: AudioChannels;
  bitrate: number; // kbps, ignored if passthrough
}

export interface SubtitleSettings {
  include: SubtitleInclude;
  convertToSrt: boolean;
}

export interface EncodingProfile {
  id: string;
  name: string;
  video: VideoSettings;
  audio: AudioSettings;
  subtitles: SubtitleSettings;
  container: Container;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface EncodingProfileInput {
  name: string;
  video: VideoSettings;
  audio: AudioSettings;
  subtitles: SubtitleSettings;
  container: Container;
  isDefault?: boolean;
}

export interface EncoderConfig {
  binaryPath: string;
  commandTemplate: string;
  progressPattern: string; // Regex pattern as string
  hwAccel: "none" | "nvenc" | "qsv" | "vaapi";
}
