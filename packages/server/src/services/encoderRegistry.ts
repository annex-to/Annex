/**
 * Encoder Registry
 *
 * Comprehensive documentation of FFmpeg video and audio encoders with their
 * available flags, valid values, and descriptions. This registry enables:
 *
 * 1. Dynamic UI generation for encoder settings
 * 2. Validation of encoder configurations
 * 3. Building FFmpeg command-line arguments
 *
 * Each encoder has metadata about hardware acceleration requirements,
 * quality control mechanisms, and all available flags.
 */

// =============================================================================
// Type Definitions
// =============================================================================

export type FlagType = "number" | "boolean" | "enum" | "string";

export interface NumberFlag {
  type: "number";
  min?: number;
  max?: number;
  default: number;
  description: string;
  unit?: string;
  ffmpegArg?: string; // Override if different from flag name
}

export interface BooleanFlag {
  type: "boolean";
  default: boolean;
  description: string;
  ffmpegArg?: string;
  ffmpegTrue?: string; // Value when true (default: "1")
  ffmpegFalse?: string; // Value when false (default: "0")
}

export interface EnumFlag {
  type: "enum";
  values: readonly string[];
  default: string;
  description: string;
  valueDescriptions?: Record<string, string>;
  ffmpegArg?: string;
}

export interface StringFlag {
  type: "string";
  default: string;
  description: string;
  placeholder?: string;
  pattern?: string; // Regex pattern for validation
  ffmpegArg?: string;
}

export type EncoderFlag = NumberFlag | BooleanFlag | EnumFlag | StringFlag;

export interface VideoEncoderInfo {
  name: string;
  description: string;
  codec: "av1" | "hevc" | "h264" | "vp9";
  hwAccel: "none" | "qsv" | "nvenc" | "vaapi" | "amf" | "videotoolbox";
  qualityMode: "crf" | "qp" | "global_quality" | "cq" | "icq";
  qualityRange: readonly [number, number]; // [min, max]
  qualityDefault: number;
  qualityDescription: string;
  flags: Record<string, EncoderFlag>;
  notes?: string[];
}

export interface AudioEncoderInfo {
  name: string;
  description: string;
  codec: "aac" | "opus" | "ac3" | "eac3" | "flac" | "copy";
  flags: Record<string, EncoderFlag>;
}

// =============================================================================
// Video Encoders
// =============================================================================

export const videoEncoders: Record<string, VideoEncoderInfo> = {
  // ---------------------------------------------------------------------------
  // AV1 Encoders
  // ---------------------------------------------------------------------------

  libsvtav1: {
    name: "SVT-AV1 (Software)",
    description:
      "Intel's Scalable Video Technology for AV1. Best quality-per-encode-time for software AV1 encoding. Recommended for most use cases.",
    codec: "av1",
    hwAccel: "none",
    qualityMode: "crf",
    qualityRange: [0, 63] as const,
    qualityDefault: 30,
    qualityDescription:
      "Constant Rate Factor. Lower = better quality, larger file. 18-28 for high quality, 28-35 for balanced, 35-45 for small files.",
    flags: {
      preset: {
        type: "number",
        min: 0,
        max: 13,
        default: 6,
        description:
          "Speed preset. Lower = slower but better quality. 0-3 for archival, 4-6 for quality, 7-9 for fast, 10-13 for realtime.",
        valueDescriptions: {
          "0": "Placebo (extremely slow)",
          "1": "Very slow",
          "2": "Slower",
          "3": "Slow",
          "4": "Medium-slow (recommended for quality)",
          "5": "Medium",
          "6": "Medium-fast (default, good balance)",
          "7": "Fast",
          "8": "Faster",
          "9": "Very fast",
          "10": "Ultra fast",
          "11": "Super fast",
          "12": "Real-time",
          "13": "Real-time fast",
        },
      } as NumberFlag,
      tune: {
        type: "enum",
        values: ["psnr", "ssim", "vmaf", "fastdecode"] as const,
        default: "ssim",
        description: "Tune encoder for specific metric or use case.",
        valueDescriptions: {
          psnr: "Peak Signal-to-Noise Ratio - mathematical quality metric",
          ssim: "Structural Similarity - perceptual quality metric (recommended)",
          vmaf: "Video Multimethod Assessment Fusion - Netflix's perceptual metric",
          fastdecode: "Optimize for playback performance on weak devices",
        },
      } as EnumFlag,
      "film-grain": {
        type: "number",
        min: 0,
        max: 50,
        default: 0,
        description:
          "Film grain synthesis level. Removes grain during encode, re-adds on decode. Improves compression of grainy content. 0 = disabled, 8-15 for light grain, 20-30 for heavy grain.",
        ffmpegArg: "svtav1-params",
      } as NumberFlag,
      "film-grain-denoise": {
        type: "boolean",
        default: true,
        description:
          "Apply denoising when using film grain synthesis. Recommended when film-grain > 0.",
        ffmpegArg: "svtav1-params",
      } as BooleanFlag,
      "enable-qm": {
        type: "boolean",
        default: false,
        description:
          "Enable quantization matrices. Can improve quality at the cost of encode speed.",
        ffmpegArg: "svtav1-params",
      } as BooleanFlag,
      "qm-min": {
        type: "number",
        min: 0,
        max: 15,
        default: 8,
        description:
          "Minimum quantization matrix flatness. Lower = more aggressive QM. Only used if enable-qm is true.",
        ffmpegArg: "svtav1-params",
      } as NumberFlag,
      "keyint": {
        type: "number",
        min: -1,
        max: 999,
        default: -1,
        description:
          "Keyframe interval in frames. -1 = auto (5 seconds), -2 = scene-based only. Shorter = better seeking, larger file.",
        ffmpegArg: "svtav1-params",
      } as NumberFlag,
      "scd": {
        type: "boolean",
        default: true,
        description:
          "Scene change detection. Inserts keyframes at scene changes for better seeking and quality.",
        ffmpegArg: "svtav1-params",
      } as BooleanFlag,
      "lookahead": {
        type: "number",
        min: -1,
        max: 120,
        default: -1,
        description:
          "Number of frames to look ahead for rate control. -1 = auto. Higher = better quality, more memory.",
        ffmpegArg: "svtav1-params",
      } as NumberFlag,
    },
    notes: [
      "Recommended for 1080p and 4K content",
      "Excellent quality-to-speed ratio",
      "Supports 10-bit HDR content natively",
      "Good for batch encoding",
    ],
  },

  av1_qsv: {
    name: "AV1 (Intel QSV)",
    description:
      "Intel Quick Sync Video AV1 encoder. Hardware-accelerated encoding on Intel Arc GPUs and 12th+ gen CPUs with integrated graphics. Very fast with good quality.",
    codec: "av1",
    hwAccel: "qsv",
    qualityMode: "global_quality",
    qualityRange: [1, 51] as const,
    qualityDefault: 25,
    qualityDescription:
      "Global quality level. Lower = better quality, larger file. 18-23 for high quality, 23-28 for balanced, 28-35 for small files.",
    flags: {
      preset: {
        type: "enum",
        values: [
          "veryfast",
          "faster",
          "fast",
          "medium",
          "slow",
          "slower",
          "veryslow",
        ] as const,
        default: "medium",
        description:
          "Encoding speed preset. Slower presets produce better quality at the same bitrate.",
        valueDescriptions: {
          veryfast: "Fastest encoding, lowest quality",
          faster: "Very fast encoding",
          fast: "Fast encoding",
          medium: "Balanced speed and quality (default)",
          slow: "Slower encoding, better quality",
          slower: "Much slower, even better quality",
          veryslow: "Slowest, best quality",
        },
      } as EnumFlag,
      look_ahead: {
        type: "boolean",
        default: true,
        description:
          "Enable look-ahead for better rate control. Adds latency but significantly improves quality, especially for variable bitrate.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      look_ahead_depth: {
        type: "number",
        min: 1,
        max: 100,
        default: 40,
        description:
          "Number of frames to look ahead. Higher = better rate control and quality, but more memory and latency.",
      } as NumberFlag,
      extbrc: {
        type: "boolean",
        default: true,
        description:
          "Extended bitrate control. Improves quality consistency across the video.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      adaptive_i: {
        type: "boolean",
        default: true,
        description:
          "Adaptive I-frame placement. Inserts keyframes at scene changes for better quality.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      adaptive_b: {
        type: "boolean",
        default: true,
        description:
          "Adaptive B-frame placement. Optimizes B-frame usage based on content.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      b_strategy: {
        type: "number",
        min: 0,
        max: 2,
        default: 1,
        description:
          "B-frame placement strategy. 0 = off, 1 = fast (default), 2 = accurate but slower.",
      } as NumberFlag,
      low_power: {
        type: "boolean",
        default: false,
        description:
          "Low power mode. Uses less power but may reduce quality. Good for laptops on battery.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      tile_cols: {
        type: "number",
        min: 0,
        max: 6,
        default: 0,
        description:
          "Log2 of tile columns. 0 = auto. Higher values enable parallel decoding but may reduce efficiency.",
      } as NumberFlag,
      tile_rows: {
        type: "number",
        min: 0,
        max: 6,
        default: 0,
        description:
          "Log2 of tile rows. 0 = auto. Higher values enable parallel decoding but may reduce efficiency.",
      } as NumberFlag,
    },
    notes: [
      "Requires Intel Arc GPU or 12th+ gen Intel CPU",
      "Best for real-time or near-real-time encoding",
      "Lower quality than SVT-AV1 at same settings, but much faster",
      "Supports 10-bit HDR",
    ],
  },

  av1_nvenc: {
    name: "AV1 (NVIDIA NVENC)",
    description:
      "NVIDIA hardware AV1 encoder. Available on RTX 40-series GPUs. Extremely fast with good quality.",
    codec: "av1",
    hwAccel: "nvenc",
    qualityMode: "cq",
    qualityRange: [1, 51] as const,
    qualityDefault: 25,
    qualityDescription:
      "Constant Quality level. Lower = better quality, larger file. 18-23 for high quality, 23-28 for balanced.",
    flags: {
      preset: {
        type: "enum",
        values: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const,
        default: "p4",
        description:
          "Encoding preset. Higher numbers = slower but better quality.",
        valueDescriptions: {
          p1: "Fastest (lowest quality)",
          p2: "Faster",
          p3: "Fast",
          p4: "Medium (default, good balance)",
          p5: "Slow",
          p6: "Slower",
          p7: "Slowest (highest quality)",
        },
      } as EnumFlag,
      tune: {
        type: "enum",
        values: ["hq", "ll", "ull", "lossless"] as const,
        default: "hq",
        description: "Tuning mode for specific use cases.",
        valueDescriptions: {
          hq: "High quality (default, best for archival)",
          ll: "Low latency (streaming)",
          ull: "Ultra low latency (real-time)",
          lossless: "Lossless encoding (large files)",
        },
      } as EnumFlag,
      rc: {
        type: "enum",
        values: ["constqp", "vbr", "cbr"] as const,
        default: "vbr",
        description: "Rate control mode.",
        valueDescriptions: {
          constqp: "Constant QP - consistent quality, variable size",
          vbr: "Variable Bitrate - best quality/size ratio (default)",
          cbr: "Constant Bitrate - predictable size, may waste bits",
        },
      } as EnumFlag,
      multipass: {
        type: "enum",
        values: ["disabled", "qres", "fullres"] as const,
        default: "fullres",
        description:
          "Multi-pass encoding for better rate control and quality.",
        valueDescriptions: {
          disabled: "Single pass only",
          qres: "Two-pass with quarter resolution first pass",
          fullres: "Two-pass with full resolution (best quality)",
        },
      } as EnumFlag,
      "b:v": {
        type: "number",
        min: 0,
        max: 100000,
        default: 0,
        description:
          "Target bitrate in kbps. 0 = use CQ mode. Set this for VBR/CBR modes.",
        unit: "kbps",
        ffmpegArg: "b:v",
      } as NumberFlag,
      "maxrate:v": {
        type: "number",
        min: 0,
        max: 200000,
        default: 0,
        description:
          "Maximum bitrate in kbps. Useful to cap VBR. 0 = no limit.",
        unit: "kbps",
        ffmpegArg: "maxrate:v",
      } as NumberFlag,
      "spatial-aq": {
        type: "boolean",
        default: true,
        description:
          "Spatial adaptive quantization. Allocates more bits to complex regions.",
        ffmpegArg: "spatial_aq",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "temporal-aq": {
        type: "boolean",
        default: true,
        description:
          "Temporal adaptive quantization. Allocates bits based on motion complexity.",
        ffmpegArg: "temporal_aq",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "aq-strength": {
        type: "number",
        min: 1,
        max: 15,
        default: 8,
        description: "Adaptive quantization strength. Higher = more aggressive.",
        ffmpegArg: "aq-strength",
      } as NumberFlag,
      "lookahead": {
        type: "number",
        min: 0,
        max: 32,
        default: 16,
        description:
          "Number of frames to look ahead for rate control. 0 = disabled.",
        ffmpegArg: "rc-lookahead",
      } as NumberFlag,
      "bf": {
        type: "number",
        min: 0,
        max: 4,
        default: 3,
        description: "Maximum number of B-frames between I/P frames.",
        ffmpegArg: "bf",
      } as NumberFlag,
    },
    notes: [
      "Requires NVIDIA RTX 40-series GPU",
      "Fastest AV1 encoding option",
      "Good for real-time streaming",
      "Quality between QSV and SVT-AV1",
    ],
  },

  av1_vaapi: {
    name: "AV1 (VAAPI)",
    description:
      "Linux Video Acceleration API AV1 encoder. Works with Intel and AMD GPUs on Linux.",
    codec: "av1",
    hwAccel: "vaapi",
    qualityMode: "qp",
    qualityRange: [1, 255] as const,
    qualityDefault: 120,
    qualityDescription:
      "Quantization Parameter. Lower = better quality. Range varies by driver. 80-120 typical for good quality.",
    flags: {
      compression_level: {
        type: "number",
        min: 0,
        max: 15,
        default: 8,
        description: "Compression level. Higher = slower but better compression.",
      } as NumberFlag,
      "rc_mode": {
        type: "enum",
        values: ["CQP", "VBR", "CBR", "ICQ"] as const,
        default: "CQP",
        description: "Rate control mode.",
        ffmpegArg: "rc_mode",
      } as EnumFlag,
    },
    notes: [
      "Linux only",
      "Driver support varies",
      "Intel Arc and AMD RDNA2+ recommended",
    ],
  },

  av1_amf: {
    name: "AV1 (AMD AMF)",
    description:
      "AMD Advanced Media Framework AV1 encoder. Available on RDNA3+ GPUs (RX 7000 series).",
    codec: "av1",
    hwAccel: "amf",
    qualityMode: "qp",
    qualityRange: [0, 51] as const,
    qualityDefault: 25,
    qualityDescription: "Quality level. Lower = better quality, larger file.",
    flags: {
      quality: {
        type: "enum",
        values: ["speed", "balanced", "quality"] as const,
        default: "balanced",
        description: "Quality/speed tradeoff preset.",
      } as EnumFlag,
      usage: {
        type: "enum",
        values: ["transcoding", "lowlatency", "ultralowlatency"] as const,
        default: "transcoding",
        description: "Usage profile.",
      } as EnumFlag,
      rc: {
        type: "enum",
        values: ["cqp", "vbr_peak", "vbr_latency", "cbr"] as const,
        default: "cqp",
        description: "Rate control mode.",
      } as EnumFlag,
    },
    notes: [
      "Requires AMD RX 7000 series or newer",
      "Windows and Linux support",
    ],
  },

  // ---------------------------------------------------------------------------
  // HEVC/H.265 Encoders
  // ---------------------------------------------------------------------------

  libx265: {
    name: "x265 (Software)",
    description:
      "Software HEVC encoder. Excellent quality but slow. Best for offline encoding when quality is paramount.",
    codec: "hevc",
    hwAccel: "none",
    qualityMode: "crf",
    qualityRange: [0, 51] as const,
    qualityDefault: 23,
    qualityDescription:
      "Constant Rate Factor. Lower = better quality. 18-22 for high quality, 23-28 for balanced.",
    flags: {
      preset: {
        type: "enum",
        values: [
          "ultrafast",
          "superfast",
          "veryfast",
          "faster",
          "fast",
          "medium",
          "slow",
          "slower",
          "veryslow",
          "placebo",
        ] as const,
        default: "medium",
        description: "Encoding speed preset.",
        valueDescriptions: {
          ultrafast: "Fastest, lowest quality",
          superfast: "Very fast",
          veryfast: "Fast",
          faster: "Somewhat fast",
          fast: "Faster than default",
          medium: "Default balance",
          slow: "Slower, better quality",
          slower: "Much slower, even better",
          veryslow: "Very slow, excellent quality",
          placebo: "Extremely slow, marginal gains",
        },
      } as EnumFlag,
      tune: {
        type: "enum",
        values: [
          "psnr",
          "ssim",
          "grain",
          "fastdecode",
          "zerolatency",
          "animation",
        ] as const,
        default: "ssim",
        description: "Tune for specific content or metric.",
        valueDescriptions: {
          psnr: "Optimize for PSNR metric",
          ssim: "Optimize for SSIM metric (recommended)",
          grain: "Preserve film grain",
          fastdecode: "Faster decoding",
          zerolatency: "Real-time streaming",
          animation: "Animated content",
        },
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["main", "main10", "main444-8", "main444-10"] as const,
        default: "main10",
        description: "HEVC profile. main10 recommended for HDR.",
      } as EnumFlag,
      "x265-params": {
        type: "string",
        default: "",
        description:
          "Additional x265 parameters. Format: param1=value1:param2=value2",
        placeholder: "sao=0:bframes=8:ref=6",
        ffmpegArg: "x265-params",
      } as StringFlag,
    },
    notes: [
      "Best HEVC quality",
      "Very slow compared to hardware encoders",
      "Excellent for archival",
    ],
  },

  hevc_qsv: {
    name: "HEVC (Intel QSV)",
    description:
      "Intel Quick Sync Video HEVC encoder. Fast hardware encoding on Intel integrated and discrete GPUs.",
    codec: "hevc",
    hwAccel: "qsv",
    qualityMode: "global_quality",
    qualityRange: [1, 51] as const,
    qualityDefault: 23,
    qualityDescription:
      "Global quality level. Lower = better quality. 18-23 for high quality.",
    flags: {
      preset: {
        type: "enum",
        values: [
          "veryfast",
          "faster",
          "fast",
          "medium",
          "slow",
          "slower",
          "veryslow",
        ] as const,
        default: "medium",
        description: "Encoding speed preset.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["main", "main10", "mainsp"] as const,
        default: "main10",
        description: "HEVC profile.",
      } as EnumFlag,
      look_ahead: {
        type: "boolean",
        default: true,
        description: "Enable look-ahead for better quality.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      look_ahead_depth: {
        type: "number",
        min: 1,
        max: 100,
        default: 40,
        description: "Look-ahead depth in frames.",
      } as NumberFlag,
      extbrc: {
        type: "boolean",
        default: true,
        description: "Extended bitrate control.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
    },
    notes: [
      "Requires Intel GPU (6th gen or newer)",
      "Good balance of speed and quality",
      "Excellent for batch encoding",
    ],
  },

  hevc_nvenc: {
    name: "HEVC (NVIDIA NVENC)",
    description:
      "NVIDIA hardware HEVC encoder. Available on GTX 900 series and newer.",
    codec: "hevc",
    hwAccel: "nvenc",
    qualityMode: "cq",
    qualityRange: [1, 51] as const,
    qualityDefault: 23,
    qualityDescription: "Constant Quality level. Lower = better quality.",
    flags: {
      preset: {
        type: "enum",
        values: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const,
        default: "p4",
        description: "Quality preset. Higher = slower but better.",
      } as EnumFlag,
      tune: {
        type: "enum",
        values: ["hq", "ll", "ull", "lossless"] as const,
        default: "hq",
        description: "Tuning mode.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["main", "main10", "rext"] as const,
        default: "main10",
        description: "HEVC profile.",
      } as EnumFlag,
      tier: {
        type: "enum",
        values: ["main", "high"] as const,
        default: "high",
        description: "HEVC tier. High tier allows higher bitrates.",
      } as EnumFlag,
      rc: {
        type: "enum",
        values: ["constqp", "vbr", "cbr", "vbr_hq", "cbr_hq"] as const,
        default: "vbr",
        description: "Rate control mode.",
      } as EnumFlag,
      multipass: {
        type: "enum",
        values: ["disabled", "qres", "fullres"] as const,
        default: "fullres",
        description: "Multi-pass encoding.",
      } as EnumFlag,
      "spatial-aq": {
        type: "boolean",
        default: true,
        description: "Spatial adaptive quantization.",
        ffmpegArg: "spatial_aq",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "temporal-aq": {
        type: "boolean",
        default: true,
        description: "Temporal adaptive quantization.",
        ffmpegArg: "temporal_aq",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "lookahead": {
        type: "number",
        min: 0,
        max: 32,
        default: 16,
        description: "Look-ahead frames.",
        ffmpegArg: "rc-lookahead",
      } as NumberFlag,
      "bf": {
        type: "number",
        min: 0,
        max: 4,
        default: 3,
        description: "Max B-frames.",
        ffmpegArg: "bf",
      } as NumberFlag,
    },
    notes: [
      "Requires NVIDIA GTX 900 series or newer",
      "Very fast encoding",
      "Good for streaming and batch processing",
    ],
  },

  hevc_vaapi: {
    name: "HEVC (VAAPI)",
    description: "Linux VAAPI HEVC encoder for Intel and AMD GPUs.",
    codec: "hevc",
    hwAccel: "vaapi",
    qualityMode: "qp",
    qualityRange: [1, 51] as const,
    qualityDefault: 23,
    qualityDescription: "Quantization Parameter. Lower = better quality.",
    flags: {
      rc_mode: {
        type: "enum",
        values: ["CQP", "VBR", "CBR", "ICQ"] as const,
        default: "CQP",
        description: "Rate control mode.",
      } as EnumFlag,
    },
    notes: ["Linux only", "Requires VAAPI-compatible GPU"],
  },

  hevc_amf: {
    name: "HEVC (AMD AMF)",
    description: "AMD hardware HEVC encoder for RX 400 series and newer.",
    codec: "hevc",
    hwAccel: "amf",
    qualityMode: "qp",
    qualityRange: [0, 51] as const,
    qualityDefault: 23,
    qualityDescription: "Quality level. Lower = better quality.",
    flags: {
      quality: {
        type: "enum",
        values: ["speed", "balanced", "quality"] as const,
        default: "balanced",
        description: "Quality/speed tradeoff.",
      } as EnumFlag,
      usage: {
        type: "enum",
        values: [
          "transcoding",
          "ultralowlatency",
          "lowlatency",
          "webcam",
        ] as const,
        default: "transcoding",
        description: "Usage profile.",
      } as EnumFlag,
      rc: {
        type: "enum",
        values: ["cqp", "cbr", "vbr_peak", "vbr_latency"] as const,
        default: "cqp",
        description: "Rate control mode.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["main", "main10"] as const,
        default: "main10",
        description: "HEVC profile.",
      } as EnumFlag,
    },
    notes: ["Requires AMD RX 400 series or newer"],
  },

  hevc_videotoolbox: {
    name: "HEVC (VideoToolbox)",
    description: "macOS hardware HEVC encoder using Apple Silicon or T2 chip.",
    codec: "hevc",
    hwAccel: "videotoolbox",
    qualityMode: "qp",
    qualityRange: [1, 100] as const,
    qualityDefault: 65,
    qualityDescription:
      "Quality level (1-100). Higher = better quality. VideoToolbox uses inverse scale.",
    flags: {
      profile: {
        type: "enum",
        values: ["main", "main10"] as const,
        default: "main10",
        description: "HEVC profile.",
      } as EnumFlag,
      realtime: {
        type: "boolean",
        default: false,
        description: "Prioritize encoding speed over quality.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      allow_sw: {
        type: "boolean",
        default: false,
        description: "Allow software fallback if hardware unavailable.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
    },
    notes: [
      "macOS only",
      "Requires Apple Silicon or T2 chip",
      "Very power efficient",
    ],
  },

  // ---------------------------------------------------------------------------
  // H.264/AVC Encoders
  // ---------------------------------------------------------------------------

  libx264: {
    name: "x264 (Software)",
    description:
      "The standard software H.264 encoder. Excellent compatibility and quality.",
    codec: "h264",
    hwAccel: "none",
    qualityMode: "crf",
    qualityRange: [0, 51] as const,
    qualityDefault: 20,
    qualityDescription:
      "Constant Rate Factor. Lower = better quality. 17-20 for high quality, 20-24 for balanced.",
    flags: {
      preset: {
        type: "enum",
        values: [
          "ultrafast",
          "superfast",
          "veryfast",
          "faster",
          "fast",
          "medium",
          "slow",
          "slower",
          "veryslow",
          "placebo",
        ] as const,
        default: "medium",
        description: "Encoding speed preset.",
      } as EnumFlag,
      tune: {
        type: "enum",
        values: [
          "film",
          "animation",
          "grain",
          "stillimage",
          "psnr",
          "ssim",
          "fastdecode",
          "zerolatency",
        ] as const,
        default: "film",
        description: "Tune for specific content type.",
        valueDescriptions: {
          film: "Live action film content",
          animation: "Animated content (flat colors)",
          grain: "Preserve film grain",
          stillimage: "Still image / slideshow",
          psnr: "Optimize for PSNR metric",
          ssim: "Optimize for SSIM metric",
          fastdecode: "Faster decoding",
          zerolatency: "Real-time streaming",
        },
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["baseline", "main", "high", "high10", "high422", "high444"] as const,
        default: "high",
        description: "H.264 profile. Higher = more features, less compatibility.",
      } as EnumFlag,
      level: {
        type: "enum",
        values: [
          "1",
          "1.1",
          "1.2",
          "1.3",
          "2",
          "2.1",
          "2.2",
          "3",
          "3.1",
          "3.2",
          "4",
          "4.1",
          "4.2",
          "5",
          "5.1",
          "5.2",
          "6",
          "6.1",
          "6.2",
        ] as const,
        default: "4.1",
        description: "H.264 level. Determines max resolution and bitrate.",
      } as EnumFlag,
      "x264-params": {
        type: "string",
        default: "",
        description: "Additional x264 parameters.",
        placeholder: "ref=6:bframes=8:me=umh",
        ffmpegArg: "x264-params",
      } as StringFlag,
    },
    notes: [
      "Universal compatibility",
      "Slower than hardware encoders",
      "Best quality for H.264",
    ],
  },

  h264_qsv: {
    name: "H.264 (Intel QSV)",
    description: "Intel Quick Sync Video H.264 encoder.",
    codec: "h264",
    hwAccel: "qsv",
    qualityMode: "global_quality",
    qualityRange: [1, 51] as const,
    qualityDefault: 20,
    qualityDescription: "Global quality level. Lower = better quality.",
    flags: {
      preset: {
        type: "enum",
        values: [
          "veryfast",
          "faster",
          "fast",
          "medium",
          "slow",
          "slower",
          "veryslow",
        ] as const,
        default: "medium",
        description: "Encoding speed preset.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["baseline", "main", "high"] as const,
        default: "high",
        description: "H.264 profile.",
      } as EnumFlag,
      look_ahead: {
        type: "boolean",
        default: true,
        description: "Enable look-ahead.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
    },
    notes: ["Widely compatible", "Fast encoding", "Requires Intel GPU"],
  },

  h264_nvenc: {
    name: "H.264 (NVIDIA NVENC)",
    description: "NVIDIA hardware H.264 encoder.",
    codec: "h264",
    hwAccel: "nvenc",
    qualityMode: "cq",
    qualityRange: [1, 51] as const,
    qualityDefault: 20,
    qualityDescription: "Constant Quality level. Lower = better quality.",
    flags: {
      preset: {
        type: "enum",
        values: ["p1", "p2", "p3", "p4", "p5", "p6", "p7"] as const,
        default: "p4",
        description: "Quality preset.",
      } as EnumFlag,
      tune: {
        type: "enum",
        values: ["hq", "ll", "ull", "lossless"] as const,
        default: "hq",
        description: "Tuning mode.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["baseline", "main", "high", "high444p"] as const,
        default: "high",
        description: "H.264 profile.",
      } as EnumFlag,
      rc: {
        type: "enum",
        values: ["constqp", "vbr", "cbr", "vbr_hq", "cbr_hq"] as const,
        default: "vbr",
        description: "Rate control mode.",
      } as EnumFlag,
      "spatial-aq": {
        type: "boolean",
        default: true,
        description: "Spatial adaptive quantization.",
        ffmpegArg: "spatial_aq",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "temporal-aq": {
        type: "boolean",
        default: true,
        description: "Temporal adaptive quantization.",
        ffmpegArg: "temporal_aq",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "lookahead": {
        type: "number",
        min: 0,
        max: 32,
        default: 16,
        description: "Look-ahead frames.",
        ffmpegArg: "rc-lookahead",
      } as NumberFlag,
    },
    notes: ["Requires NVIDIA GPU", "Very fast", "Good compatibility"],
  },

  h264_vaapi: {
    name: "H.264 (VAAPI)",
    description: "Linux VAAPI H.264 encoder.",
    codec: "h264",
    hwAccel: "vaapi",
    qualityMode: "qp",
    qualityRange: [1, 51] as const,
    qualityDefault: 20,
    qualityDescription: "Quantization Parameter. Lower = better quality.",
    flags: {
      rc_mode: {
        type: "enum",
        values: ["CQP", "VBR", "CBR", "ICQ"] as const,
        default: "CQP",
        description: "Rate control mode.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["constrained_baseline", "main", "high"] as const,
        default: "high",
        description: "H.264 profile.",
      } as EnumFlag,
    },
    notes: ["Linux only"],
  },

  h264_amf: {
    name: "H.264 (AMD AMF)",
    description: "AMD hardware H.264 encoder.",
    codec: "h264",
    hwAccel: "amf",
    qualityMode: "qp",
    qualityRange: [0, 51] as const,
    qualityDefault: 20,
    qualityDescription: "Quality level. Lower = better quality.",
    flags: {
      quality: {
        type: "enum",
        values: ["speed", "balanced", "quality"] as const,
        default: "balanced",
        description: "Quality/speed tradeoff.",
      } as EnumFlag,
      usage: {
        type: "enum",
        values: [
          "transcoding",
          "ultralowlatency",
          "lowlatency",
          "webcam",
        ] as const,
        default: "transcoding",
        description: "Usage profile.",
      } as EnumFlag,
      rc: {
        type: "enum",
        values: ["cqp", "cbr", "vbr_peak", "vbr_latency"] as const,
        default: "cqp",
        description: "Rate control mode.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["baseline", "main", "high"] as const,
        default: "high",
        description: "H.264 profile.",
      } as EnumFlag,
    },
    notes: ["Requires AMD GPU"],
  },

  h264_videotoolbox: {
    name: "H.264 (VideoToolbox)",
    description: "macOS hardware H.264 encoder.",
    codec: "h264",
    hwAccel: "videotoolbox",
    qualityMode: "qp",
    qualityRange: [1, 100] as const,
    qualityDefault: 65,
    qualityDescription: "Quality level (1-100). Higher = better quality.",
    flags: {
      profile: {
        type: "enum",
        values: ["baseline", "main", "high"] as const,
        default: "high",
        description: "H.264 profile.",
      } as EnumFlag,
      realtime: {
        type: "boolean",
        default: false,
        description: "Prioritize speed over quality.",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
    },
    notes: ["macOS only", "Power efficient"],
  },

  // ---------------------------------------------------------------------------
  // VP9 Encoders
  // ---------------------------------------------------------------------------

  libvpx_vp9: {
    name: "VP9 (Software)",
    description: "Google's VP9 software encoder. Good for web delivery.",
    codec: "vp9",
    hwAccel: "none",
    qualityMode: "crf",
    qualityRange: [0, 63] as const,
    qualityDefault: 31,
    qualityDescription: "Constant Rate Factor. Lower = better quality.",
    flags: {
      cpu_used: {
        type: "number",
        min: -8,
        max: 8,
        default: 2,
        description:
          "CPU usage. Negative = quality mode (slower). Positive = realtime (faster).",
        ffmpegArg: "cpu-used",
      } as NumberFlag,
      deadline: {
        type: "enum",
        values: ["best", "good", "realtime"] as const,
        default: "good",
        description: "Encoding deadline/quality tradeoff.",
      } as EnumFlag,
      row_mt: {
        type: "boolean",
        default: true,
        description: "Row-based multi-threading for faster encoding.",
        ffmpegArg: "row-mt",
        ffmpegTrue: "1",
        ffmpegFalse: "0",
      } as BooleanFlag,
      "tile-columns": {
        type: "number",
        min: 0,
        max: 6,
        default: 2,
        description: "Log2 of tile columns. More tiles = faster but less efficient.",
        ffmpegArg: "tile-columns",
      } as NumberFlag,
      "tile-rows": {
        type: "number",
        min: 0,
        max: 2,
        default: 0,
        description: "Log2 of tile rows.",
        ffmpegArg: "tile-rows",
      } as NumberFlag,
    },
    notes: [
      "YouTube, WebM support",
      "Good web compatibility",
      "Slower than hardware options",
    ],
  },

  vp9_qsv: {
    name: "VP9 (Intel QSV)",
    description: "Intel Quick Sync Video VP9 encoder.",
    codec: "vp9",
    hwAccel: "qsv",
    qualityMode: "global_quality",
    qualityRange: [1, 255] as const,
    qualityDefault: 100,
    qualityDescription: "Global quality level. Lower = better quality.",
    flags: {
      preset: {
        type: "enum",
        values: [
          "veryfast",
          "faster",
          "fast",
          "medium",
          "slow",
          "slower",
          "veryslow",
        ] as const,
        default: "medium",
        description: "Encoding speed preset.",
      } as EnumFlag,
    },
    notes: ["Requires Intel GPU", "Limited availability"],
  },

  vp9_vaapi: {
    name: "VP9 (VAAPI)",
    description: "Linux VAAPI VP9 encoder.",
    codec: "vp9",
    hwAccel: "vaapi",
    qualityMode: "qp",
    qualityRange: [1, 255] as const,
    qualityDefault: 100,
    qualityDescription: "Quantization Parameter.",
    flags: {
      rc_mode: {
        type: "enum",
        values: ["CQP", "VBR", "CBR", "ICQ"] as const,
        default: "CQP",
        description: "Rate control mode.",
      } as EnumFlag,
    },
    notes: ["Linux only"],
  },
};

// =============================================================================
// Audio Encoders
// =============================================================================

export const audioEncoders: Record<string, AudioEncoderInfo> = {
  copy: {
    name: "Copy (Passthrough)",
    description:
      "Copy audio stream without re-encoding. Fastest and preserves quality.",
    codec: "copy",
    flags: {},
  },

  aac: {
    name: "AAC (Native)",
    description: "FFmpeg's native AAC encoder. Good quality and compatibility.",
    codec: "aac",
    flags: {
      "b:a": {
        type: "number",
        min: 32,
        max: 512,
        default: 192,
        description: "Audio bitrate in kbps per channel.",
        unit: "kbps",
        ffmpegArg: "b:a",
      } as NumberFlag,
      ac: {
        type: "enum",
        values: ["1", "2", "6", "8"] as const,
        default: "2",
        description: "Number of audio channels.",
        valueDescriptions: {
          "1": "Mono",
          "2": "Stereo",
          "6": "5.1 Surround",
          "8": "7.1 Surround",
        },
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["aac_low", "aac_he", "aac_he_v2"] as const,
        default: "aac_low",
        description: "AAC profile.",
        valueDescriptions: {
          aac_low: "AAC-LC - Standard quality (default)",
          aac_he: "HE-AAC - Better at low bitrates",
          aac_he_v2: "HE-AACv2 - Best at very low bitrates",
        },
        ffmpegArg: "profile:a",
      } as EnumFlag,
    },
  },

  libfdk_aac: {
    name: "AAC (Fraunhofer FDK)",
    description:
      "High-quality AAC encoder. Better than native AAC but requires separate installation.",
    codec: "aac",
    flags: {
      "b:a": {
        type: "number",
        min: 32,
        max: 512,
        default: 192,
        description: "Audio bitrate in kbps.",
        unit: "kbps",
        ffmpegArg: "b:a",
      } as NumberFlag,
      ac: {
        type: "enum",
        values: ["1", "2", "6", "8"] as const,
        default: "2",
        description: "Number of audio channels.",
      } as EnumFlag,
      profile: {
        type: "enum",
        values: ["aac_low", "aac_he", "aac_he_v2", "aac_ld", "aac_eld"] as const,
        default: "aac_low",
        description: "AAC profile.",
        ffmpegArg: "profile:a",
      } as EnumFlag,
      vbr: {
        type: "number",
        min: 1,
        max: 5,
        default: 4,
        description: "VBR mode (1-5). Higher = better quality but larger.",
      } as NumberFlag,
    },
  },

  libopus: {
    name: "Opus",
    description:
      "Modern audio codec with excellent quality at low bitrates. Great for voice and music.",
    codec: "opus",
    flags: {
      "b:a": {
        type: "number",
        min: 6,
        max: 510,
        default: 128,
        description: "Audio bitrate in kbps. Opus is efficient; 128kbps is often enough.",
        unit: "kbps",
        ffmpegArg: "b:a",
      } as NumberFlag,
      ac: {
        type: "enum",
        values: ["1", "2", "6", "8"] as const,
        default: "2",
        description: "Number of audio channels.",
      } as EnumFlag,
      application: {
        type: "enum",
        values: ["voip", "audio", "lowdelay"] as const,
        default: "audio",
        description: "Optimize for specific use case.",
        valueDescriptions: {
          voip: "Voice/speech (lower latency)",
          audio: "Music and general audio (default)",
          lowdelay: "Lowest latency",
        },
      } as EnumFlag,
      vbr: {
        type: "enum",
        values: ["off", "on", "constrained"] as const,
        default: "on",
        description: "Variable bitrate mode.",
        valueDescriptions: {
          off: "Constant bitrate",
          on: "Variable bitrate (recommended)",
          constrained: "VBR with max limit",
        },
      } as EnumFlag,
      compression_level: {
        type: "number",
        min: 0,
        max: 10,
        default: 10,
        description: "Compression effort (0-10). Higher = slower but better.",
      } as NumberFlag,
    },
  },

  ac3: {
    name: "AC3 (Dolby Digital)",
    description:
      "Dolby Digital audio. Good compatibility with home theater systems.",
    codec: "ac3",
    flags: {
      "b:a": {
        type: "number",
        min: 64,
        max: 640,
        default: 384,
        description: "Audio bitrate in kbps.",
        unit: "kbps",
        ffmpegArg: "b:a",
      } as NumberFlag,
      ac: {
        type: "enum",
        values: ["1", "2", "6"] as const,
        default: "6",
        description: "Number of audio channels. 6 for 5.1.",
      } as EnumFlag,
    },
  },

  eac3: {
    name: "E-AC3 (Dolby Digital Plus)",
    description:
      "Enhanced AC3. Better quality and efficiency than AC3. Supports 7.1.",
    codec: "eac3",
    flags: {
      "b:a": {
        type: "number",
        min: 64,
        max: 6144,
        default: 640,
        description: "Audio bitrate in kbps.",
        unit: "kbps",
        ffmpegArg: "b:a",
      } as NumberFlag,
      ac: {
        type: "enum",
        values: ["1", "2", "6", "8"] as const,
        default: "6",
        description: "Number of audio channels.",
      } as EnumFlag,
    },
  },

  flac: {
    name: "FLAC (Lossless)",
    description: "Free Lossless Audio Codec. Perfect quality, larger files.",
    codec: "flac",
    flags: {
      compression_level: {
        type: "number",
        min: 0,
        max: 12,
        default: 5,
        description:
          "Compression level. Higher = smaller but slower. 5 is a good balance.",
      } as NumberFlag,
      ac: {
        type: "enum",
        values: ["1", "2", "6", "8"] as const,
        default: "2",
        description: "Number of audio channels.",
      } as EnumFlag,
    },
  },

  libmp3lame: {
    name: "MP3 (LAME)",
    description: "Classic MP3 format. Maximum compatibility.",
    codec: "aac", // Actually mp3, but keeping structure
    flags: {
      "b:a": {
        type: "number",
        min: 32,
        max: 320,
        default: 192,
        description: "Audio bitrate in kbps.",
        unit: "kbps",
        ffmpegArg: "b:a",
      } as NumberFlag,
      q: {
        type: "number",
        min: 0,
        max: 9,
        default: 2,
        description: "VBR quality (0 = best, 9 = worst). Alternative to bitrate.",
        ffmpegArg: "q:a",
      } as NumberFlag,
    },
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get list of video encoders for a specific codec
 */
export function getEncodersForCodec(codec: "av1" | "hevc" | "h264" | "vp9"): string[] {
  return Object.entries(videoEncoders)
    .filter(([, info]) => info.codec === codec)
    .map(([key]) => key);
}

/**
 * Get list of video encoders for a specific hardware acceleration
 */
export function getEncodersForHwAccel(
  hwAccel: "none" | "qsv" | "nvenc" | "vaapi" | "amf" | "videotoolbox"
): string[] {
  return Object.entries(videoEncoders)
    .filter(([, info]) => info.hwAccel === hwAccel)
    .map(([key]) => key);
}

/**
 * Get a flat list of all video encoder IDs grouped by codec
 */
export function getVideoEncodersByCodec(): Record<string, string[]> {
  const result: Record<string, string[]> = {
    av1: [],
    hevc: [],
    h264: [],
    vp9: [],
  };

  for (const [key, info] of Object.entries(videoEncoders)) {
    result[info.codec].push(key);
  }

  return result;
}

/**
 * Validate encoder flags against the registry
 */
export function validateEncoderFlags(
  encoderName: string,
  flags: Record<string, unknown>
): { valid: boolean; errors: string[] } {
  const encoder = videoEncoders[encoderName];
  if (!encoder) {
    return { valid: false, errors: [`Unknown encoder: ${encoderName}`] };
  }

  const errors: string[] = [];

  for (const [key, value] of Object.entries(flags)) {
    const flagDef = encoder.flags[key];
    if (!flagDef) {
      errors.push(`Unknown flag for ${encoderName}: ${key}`);
      continue;
    }

    switch (flagDef.type) {
      case "number": {
        if (typeof value !== "number") {
          errors.push(`Flag ${key} must be a number`);
        } else {
          if (flagDef.min !== undefined && value < flagDef.min) {
            errors.push(`Flag ${key} must be >= ${flagDef.min}`);
          }
          if (flagDef.max !== undefined && value > flagDef.max) {
            errors.push(`Flag ${key} must be <= ${flagDef.max}`);
          }
        }
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          errors.push(`Flag ${key} must be a boolean`);
        }
        break;
      }
      case "enum": {
        if (!flagDef.values.includes(value as string)) {
          errors.push(
            `Flag ${key} must be one of: ${flagDef.values.join(", ")}`
          );
        }
        break;
      }
      case "string": {
        if (typeof value !== "string") {
          errors.push(`Flag ${key} must be a string`);
        } else if (flagDef.pattern) {
          const regex = new RegExp(flagDef.pattern);
          if (!regex.test(value)) {
            errors.push(`Flag ${key} does not match required pattern`);
          }
        }
        break;
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get default flags for an encoder
 */
export function getDefaultFlags(encoderName: string): Record<string, unknown> {
  const encoder = videoEncoders[encoderName];
  if (!encoder) return {};

  const defaults: Record<string, unknown> = {};
  for (const [key, flag] of Object.entries(encoder.flags)) {
    defaults[key] = flag.default;
  }
  return defaults;
}

/**
 * Check if an encoder supports hardware acceleration
 */
export function isHardwareEncoder(encoderName: string): boolean {
  const encoder = videoEncoders[encoderName];
  return encoder ? encoder.hwAccel !== "none" : false;
}
