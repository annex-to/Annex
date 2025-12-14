/**
 * Encoding Profiles Router
 *
 * CRUD operations for encoding profiles with dynamic encoder configuration.
 * Profiles can use any FFmpeg encoder with flexible flag settings.
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { prisma } from "../db/client.js";
import { Resolution, HwAccel, SubtitlesMode, Container, Prisma } from "@prisma/client";
import {
  videoEncoders,
  audioEncoders,
  validateEncoderFlags,
  getDefaultFlags,
  getVideoEncodersByCodec,
} from "../services/encoderRegistry.js";

// =============================================================================
// Validation Schemas
// =============================================================================

const resolutionEnum = z.enum(["RES_4K", "RES_2K", "RES_1080P", "RES_720P", "RES_480P"]);
const hwAccelEnum = z.enum(["NONE", "QSV", "NVENC", "VAAPI", "AMF", "VIDEOTOOLBOX"]);
const subtitlesModeEnum = z.enum(["COPY", "COPY_TEXT", "EXTRACT", "NONE"]);
const containerEnum = z.enum(["MKV", "MP4", "WEBM"]);

const createProfileSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),

  // Video encoder
  videoEncoder: z.string().min(1),
  videoQuality: z.number().min(0).max(255),
  videoMaxResolution: resolutionEnum,
  videoMaxBitrate: z.number().positive().nullable().optional(),

  // Hardware acceleration
  hwAccel: hwAccelEnum,
  hwDevice: z.string().nullable().optional(),

  // Video flags (JSON object)
  videoFlags: z.record(z.unknown()).optional(),

  // Audio encoder
  audioEncoder: z.string().default("copy"),
  audioFlags: z.record(z.unknown()).optional(),

  // Subtitles & container
  subtitlesMode: subtitlesModeEnum,
  container: containerEnum,

  isDefault: z.boolean().optional(),
});

const updateProfileSchema = createProfileSchema.partial().extend({
  id: z.string(),
});

// =============================================================================
// Helpers
// =============================================================================

function mapResolutionToDisplay(resolution: Resolution): string {
  const map: Record<Resolution, string> = {
    RES_4K: "4K",
    RES_2K: "2K",
    RES_1080P: "1080p",
    RES_720P: "720p",
    RES_480P: "480p",
  };
  return map[resolution];
}

function mapHwAccelToDisplay(hwAccel: HwAccel): string {
  const map: Record<HwAccel, string> = {
    NONE: "Software",
    QSV: "Intel QSV",
    NVENC: "NVIDIA NVENC",
    VAAPI: "VAAPI",
    AMF: "AMD AMF",
    VIDEOTOOLBOX: "VideoToolbox",
  };
  return map[hwAccel];
}

function mapSubtitlesModeToDisplay(mode: SubtitlesMode): string {
  const map: Record<SubtitlesMode, string> = {
    COPY: "Copy All",
    COPY_TEXT: "Copy Text Only",
    EXTRACT: "Extract to Files",
    NONE: "None",
  };
  return map[mode];
}

// =============================================================================
// Router
// =============================================================================

export const profilesRouter = router({
  /**
   * List all encoding profiles
   */
  list: publicProcedure.query(async () => {
    const profiles = await prisma.encodingProfile.findMany({
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      include: {
        _count: {
          select: { servers: true },
        },
      },
    });

    return profiles.map((p) => {
      const encoderInfo = videoEncoders[p.videoEncoder];

      return {
        id: p.id,
        name: p.name,
        description: p.description,

        video: {
          encoder: p.videoEncoder,
          encoderName: encoderInfo?.name || p.videoEncoder,
          codec: encoderInfo?.codec || "unknown",
          quality: p.videoQuality,
          qualityMode: encoderInfo?.qualityMode || "crf",
          maxResolution: p.videoMaxResolution,
          maxResolutionDisplay: mapResolutionToDisplay(p.videoMaxResolution),
          maxBitrate: p.videoMaxBitrate,
          flags: p.videoFlags as Record<string, unknown>,
        },

        hwAccel: p.hwAccel,
        hwAccelDisplay: mapHwAccelToDisplay(p.hwAccel),
        hwDevice: p.hwDevice,

        audio: {
          encoder: p.audioEncoder,
          encoderName: audioEncoders[p.audioEncoder]?.name || p.audioEncoder,
          flags: p.audioFlags as Record<string, unknown>,
        },

        subtitles: {
          mode: p.subtitlesMode,
          modeDisplay: mapSubtitlesModeToDisplay(p.subtitlesMode),
        },

        container: p.container,
        isDefault: p.isDefault,
        serverCount: p._count.servers,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    });
  }),

  /**
   * Get a single profile by ID
   */
  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const p = await prisma.encodingProfile.findUnique({
        where: { id: input.id },
        include: {
          servers: {
            select: { id: true, name: true },
          },
        },
      });

      if (!p) return null;

      const encoderInfo = videoEncoders[p.videoEncoder];

      return {
        id: p.id,
        name: p.name,
        description: p.description,

        video: {
          encoder: p.videoEncoder,
          encoderName: encoderInfo?.name || p.videoEncoder,
          codec: encoderInfo?.codec || "unknown",
          quality: p.videoQuality,
          qualityMode: encoderInfo?.qualityMode || "crf",
          qualityRange: encoderInfo?.qualityRange || [0, 51],
          qualityDescription: encoderInfo?.qualityDescription || "",
          maxResolution: p.videoMaxResolution,
          maxResolutionDisplay: mapResolutionToDisplay(p.videoMaxResolution),
          maxBitrate: p.videoMaxBitrate,
          flags: p.videoFlags as Record<string, unknown>,
        },

        hwAccel: p.hwAccel,
        hwAccelDisplay: mapHwAccelToDisplay(p.hwAccel),
        hwDevice: p.hwDevice,

        audio: {
          encoder: p.audioEncoder,
          encoderName: audioEncoders[p.audioEncoder]?.name || p.audioEncoder,
          flags: p.audioFlags as Record<string, unknown>,
        },

        subtitles: {
          mode: p.subtitlesMode,
          modeDisplay: mapSubtitlesModeToDisplay(p.subtitlesMode),
        },

        container: p.container,
        isDefault: p.isDefault,
        servers: p.servers,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
    }),

  /**
   * Create a new encoding profile
   */
  create: publicProcedure
    .input(createProfileSchema)
    .mutation(async ({ input }) => {
      // Validate encoder exists
      const encoderInfo = videoEncoders[input.videoEncoder];
      if (!encoderInfo) {
        throw new Error(`Unknown video encoder: ${input.videoEncoder}`);
      }

      // Validate video flags
      if (input.videoFlags) {
        const validation = validateEncoderFlags(
          input.videoEncoder,
          input.videoFlags as Record<string, unknown>
        );
        if (!validation.valid) {
          throw new Error(`Invalid video flags: ${validation.errors.join(", ")}`);
        }
      }

      // If this is being set as default, unset any existing default
      if (input.isDefault) {
        await prisma.encodingProfile.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
      }

      const profile = await prisma.encodingProfile.create({
        data: {
          name: input.name,
          description: input.description,
          videoEncoder: input.videoEncoder,
          videoQuality: input.videoQuality,
          videoMaxResolution: input.videoMaxResolution as Resolution,
          videoMaxBitrate: input.videoMaxBitrate ?? null,
          hwAccel: input.hwAccel as HwAccel,
          hwDevice: input.hwDevice ?? null,
          videoFlags: (input.videoFlags || {}) as Prisma.JsonObject,
          audioEncoder: input.audioEncoder,
          audioFlags: (input.audioFlags || {}) as Prisma.JsonObject,
          subtitlesMode: input.subtitlesMode as SubtitlesMode,
          container: input.container as Container,
          isDefault: input.isDefault ?? false,
        },
      });

      return { id: profile.id };
    }),

  /**
   * Update an existing encoding profile
   */
  update: publicProcedure
    .input(updateProfileSchema)
    .mutation(async ({ input }) => {
      const { id, ...data } = input;

      // Validate encoder if being changed
      if (data.videoEncoder) {
        const encoderInfo = videoEncoders[data.videoEncoder];
        if (!encoderInfo) {
          throw new Error(`Unknown video encoder: ${data.videoEncoder}`);
        }
      }

      // Validate video flags if provided
      if (data.videoFlags && data.videoEncoder) {
        const validation = validateEncoderFlags(
          data.videoEncoder,
          data.videoFlags as Record<string, unknown>
        );
        if (!validation.valid) {
          throw new Error(`Invalid video flags: ${validation.errors.join(", ")}`);
        }
      }

      // If this is being set as default, unset any existing default
      if (data.isDefault) {
        await prisma.encodingProfile.updateMany({
          where: { isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }

      await prisma.encodingProfile.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.videoEncoder !== undefined && { videoEncoder: data.videoEncoder }),
          ...(data.videoQuality !== undefined && { videoQuality: data.videoQuality }),
          ...(data.videoMaxResolution !== undefined && {
            videoMaxResolution: data.videoMaxResolution as Resolution,
          }),
          ...(data.videoMaxBitrate !== undefined && {
            videoMaxBitrate: data.videoMaxBitrate,
          }),
          ...(data.hwAccel !== undefined && {
            hwAccel: data.hwAccel as HwAccel,
          }),
          ...(data.hwDevice !== undefined && { hwDevice: data.hwDevice }),
          ...(data.videoFlags !== undefined && { videoFlags: data.videoFlags as Prisma.JsonObject }),
          ...(data.audioEncoder !== undefined && { audioEncoder: data.audioEncoder }),
          ...(data.audioFlags !== undefined && { audioFlags: data.audioFlags as Prisma.JsonObject }),
          ...(data.subtitlesMode !== undefined && {
            subtitlesMode: data.subtitlesMode as SubtitlesMode,
          }),
          ...(data.container !== undefined && {
            container: data.container as Container,
          }),
          ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
        },
      });

      return { success: true };
    }),

  /**
   * Delete an encoding profile
   */
  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Check if any servers are using this profile
      const serversUsingProfile = await prisma.storageServer.count({
        where: { encodingProfileId: input.id },
      });

      if (serversUsingProfile > 0) {
        throw new Error(
          `Cannot delete profile: ${serversUsingProfile} server(s) are using it`
        );
      }

      await prisma.encodingProfile.delete({
        where: { id: input.id },
      });

      return { success: true };
    }),

  /**
   * Set a profile as default
   */
  setDefault: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      // Unset any existing default
      await prisma.encodingProfile.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });

      // Set new default
      await prisma.encodingProfile.update({
        where: { id: input.id },
        data: { isDefault: true },
      });

      return { success: true };
    }),

  /**
   * Duplicate a profile
   */
  duplicate: publicProcedure
    .input(z.object({ id: z.string(), newName: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const source = await prisma.encodingProfile.findUnique({
        where: { id: input.id },
      });

      if (!source) {
        throw new Error("Profile not found");
      }

      const newProfile = await prisma.encodingProfile.create({
        data: {
          name: input.newName,
          description: source.description,
          videoEncoder: source.videoEncoder,
          videoQuality: source.videoQuality,
          videoMaxResolution: source.videoMaxResolution,
          videoMaxBitrate: source.videoMaxBitrate,
          hwAccel: source.hwAccel,
          hwDevice: source.hwDevice,
          videoFlags: source.videoFlags || {},
          audioEncoder: source.audioEncoder,
          audioFlags: source.audioFlags || {},
          subtitlesMode: source.subtitlesMode,
          container: source.container,
          isDefault: false,
        },
      });

      return { id: newProfile.id };
    }),

  /**
   * Get default profile
   */
  getDefault: publicProcedure.query(async () => {
    const profile = await prisma.encodingProfile.findFirst({
      where: { isDefault: true },
    });

    if (!profile) return null;

    return {
      id: profile.id,
      name: profile.name,
    };
  }),

  // ===========================================================================
  // Encoder Registry Endpoints
  // ===========================================================================

  /**
   * Get all available video encoders
   */
  getVideoEncoders: publicProcedure.query(() => {
    return Object.entries(videoEncoders).map(([id, info]) => ({
      id,
      name: info.name,
      description: info.description,
      codec: info.codec,
      hwAccel: info.hwAccel,
      qualityMode: info.qualityMode,
      qualityRange: info.qualityRange,
      qualityDefault: info.qualityDefault,
      qualityDescription: info.qualityDescription,
      notes: info.notes || [],
    }));
  }),

  /**
   * Get video encoders grouped by codec
   */
  getVideoEncodersByCodec: publicProcedure.query(() => {
    return getVideoEncodersByCodec();
  }),

  /**
   * Get detailed encoder info including all flags
   */
  getEncoderDetails: publicProcedure
    .input(z.object({ encoder: z.string() }))
    .query(({ input }) => {
      const info = videoEncoders[input.encoder];
      if (!info) return null;

      return {
        id: input.encoder,
        name: info.name,
        description: info.description,
        codec: info.codec,
        hwAccel: info.hwAccel,
        qualityMode: info.qualityMode,
        qualityRange: info.qualityRange,
        qualityDefault: info.qualityDefault,
        qualityDescription: info.qualityDescription,
        notes: info.notes || [],
        flags: info.flags,
      };
    }),

  /**
   * Get default flags for an encoder
   */
  getEncoderDefaults: publicProcedure
    .input(z.object({ encoder: z.string() }))
    .query(({ input }) => {
      return getDefaultFlags(input.encoder);
    }),

  /**
   * Get all available audio encoders
   */
  getAudioEncoders: publicProcedure.query(() => {
    return Object.entries(audioEncoders).map(([id, info]) => ({
      id,
      name: info.name,
      description: info.description,
      codec: info.codec,
      flags: info.flags,
    }));
  }),

  /**
   * Validate encoder flags
   */
  validateFlags: publicProcedure
    .input(z.object({
      encoder: z.string(),
      flags: z.record(z.unknown()),
    }))
    .query(({ input }) => {
      return validateEncoderFlags(input.encoder, input.flags as Record<string, unknown>);
    }),

  /**
   * Get profile presets (commonly used configurations)
   */
  getPresets: publicProcedure.query(() => {
    return [
      {
        id: "4k-quality",
        name: "4K Quality (Intel QSV)",
        description: "High quality 4K encoding using Intel Quick Sync",
        config: {
          videoEncoder: "av1_qsv",
          videoQuality: 23,
          videoMaxResolution: "RES_4K",
          hwAccel: "QSV",
          hwDevice: "/dev/dri/renderD128",
          videoFlags: {
            preset: "medium",
            look_ahead: true,
            look_ahead_depth: 40,
          },
          audioEncoder: "copy",
          subtitlesMode: "COPY",
          container: "MKV",
        },
      },
      {
        id: "4k-nvenc",
        name: "4K Quality (NVIDIA)",
        description: "High quality 4K encoding using NVIDIA NVENC",
        config: {
          videoEncoder: "av1_nvenc",
          videoQuality: 23,
          videoMaxResolution: "RES_4K",
          hwAccel: "NVENC",
          videoFlags: {
            preset: "p5",
            tune: "hq",
            multipass: "fullres",
            "spatial-aq": true,
            "temporal-aq": true,
          },
          audioEncoder: "copy",
          subtitlesMode: "COPY",
          container: "MKV",
        },
      },
      {
        id: "1080p-balanced",
        name: "1080p Balanced (Software)",
        description: "Good quality 1080p with SVT-AV1 software encoder",
        config: {
          videoEncoder: "libsvtav1",
          videoQuality: 28,
          videoMaxResolution: "RES_1080P",
          hwAccel: "NONE",
          videoFlags: {
            preset: 6,
            tune: "ssim",
          },
          audioEncoder: "aac",
          audioFlags: {
            "b:a": 192,
            ac: "2",
          },
          subtitlesMode: "COPY",
          container: "MKV",
        },
      },
      {
        id: "720p-compact",
        name: "720p Compact",
        description: "Small file size 720p for mobile/streaming",
        config: {
          videoEncoder: "libsvtav1",
          videoQuality: 35,
          videoMaxResolution: "RES_720P",
          hwAccel: "NONE",
          videoFlags: {
            preset: 8,
            tune: "ssim",
          },
          audioEncoder: "aac",
          audioFlags: {
            "b:a": 128,
            ac: "2",
          },
          subtitlesMode: "NONE",
          container: "MP4",
        },
      },
      {
        id: "hevc-compatibility",
        name: "HEVC Compatibility",
        description: "HEVC for maximum device compatibility",
        config: {
          videoEncoder: "libx265",
          videoQuality: 23,
          videoMaxResolution: "RES_1080P",
          hwAccel: "NONE",
          videoFlags: {
            preset: "medium",
            tune: "ssim",
            profile: "main10",
          },
          audioEncoder: "aac",
          audioFlags: {
            "b:a": 192,
            ac: "2",
          },
          subtitlesMode: "COPY",
          container: "MKV",
        },
      },
    ];
  }),
});
