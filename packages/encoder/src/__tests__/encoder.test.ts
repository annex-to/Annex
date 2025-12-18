/**
 * Tests for FFmpeg encoder service
 */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";

describe("encoder", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  describe("probeMedia", () => {
    describe("happy path", () => {
      test("function exists and is callable", async () => {
        const { probeMedia } = await import("../encoder.js");
        expect(typeof probeMedia).toBe("function");
      });

      test("returns media info for valid video", async () => {
        // Mock ffprobe response
        const mockFfprobeOutput = JSON.stringify({
          streams: [
            {
              codec_type: "video",
              codec_name: "h264",
              width: 1920,
              height: 1080,
              r_frame_rate: "24000/1001",
              index: 0,
            },
            {
              codec_type: "audio",
              codec_name: "aac",
              index: 1,
            },
          ],
          format: {
            duration: "120.5",
            size: "1024000",
          },
        });

        Bun.spawn = mock((cmd: any) => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode(mockFfprobeOutput);
            },
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {},
          },
          exited: Promise.resolve(0),
        })) as any;

        const { probeMedia } = await import("../encoder.js");
        const result = await probeMedia("/test/video.mp4");

        expect(result.duration).toBeCloseTo(120.5);
        expect(result.width).toBe(1920);
        expect(result.height).toBe(1080);
        expect(result.fps).toBeCloseTo(23.976, 2);
        expect(result.fileSize).toBe(1024000);
      });

      test("parses subtitle streams", async () => {
        const mockFfprobeOutput = JSON.stringify({
          streams: [
            {
              codec_type: "video",
              width: 1920,
              height: 1080,
              r_frame_rate: "24/1",
              index: 0,
            },
            {
              codec_type: "subtitle",
              codec_name: "subrip",
              index: 2,
              tags: { language: "eng" },
            },
            {
              codec_type: "subtitle",
              codec_name: "ass",
              index: 3,
              tags: { language: "spa" },
            },
          ],
          format: {
            duration: "100",
            size: "500000",
          },
        });

        Bun.spawn = mock(() => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode(mockFfprobeOutput);
            },
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {},
          },
          exited: Promise.resolve(0),
        })) as any;

        const { probeMedia } = await import("../encoder.js");
        const result = await probeMedia("/test/video.mkv");

        expect(result.subtitleStreams.length).toBe(2);
        expect(result.subtitleStreams[0].codec).toBe("subrip");
        expect(result.subtitleStreams[0].language).toBe("eng");
        expect(result.subtitleStreams[1].codec).toBe("ass");
        expect(result.subtitleStreams[1].language).toBe("spa");
      });

      test("handles missing frame rate", async () => {
        const mockFfprobeOutput = JSON.stringify({
          streams: [
            {
              codec_type: "video",
              width: 1280,
              height: 720,
              // No r_frame_rate field
              index: 0,
            },
          ],
          format: {
            duration: "60",
            size: "250000",
          },
        });

        Bun.spawn = mock(() => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode(mockFfprobeOutput);
            },
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {},
          },
          exited: Promise.resolve(0),
        })) as any;

        const { probeMedia } = await import("../encoder.js");
        const result = await probeMedia("/test/video.mp4");

        expect(result.fps).toBe(24); // Default fps
      });
    });

    describe("non-happy path", () => {
      test("throws error when ffprobe fails", async () => {
        Bun.spawn = mock(() => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {},
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode("File not found");
            },
          },
          exited: Promise.resolve(1),
        })) as any;

        const { probeMedia } = await import("../encoder.js");

        await expect(probeMedia("/nonexistent.mp4")).rejects.toThrow("ffprobe failed");
      });

      test("throws error when no video stream found", async () => {
        const mockFfprobeOutput = JSON.stringify({
          streams: [
            {
              codec_type: "audio",
              codec_name: "aac",
            },
          ],
          format: {
            duration: "60",
            size: "100000",
          },
        });

        Bun.spawn = mock(() => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode(mockFfprobeOutput);
            },
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {},
          },
          exited: Promise.resolve(0),
        })) as any;

        const { probeMedia } = await import("../encoder.js");

        await expect(probeMedia("/audio-only.mp3")).rejects.toThrow("No video stream found");
      });

      test("throws error on invalid JSON", async () => {
        Bun.spawn = mock(() => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode("invalid json{{{");
            },
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {},
          },
          exited: Promise.resolve(0),
        })) as any;

        const { probeMedia } = await import("../encoder.js");

        await expect(probeMedia("/test.mp4")).rejects.toThrow("Failed to parse ffprobe output");
      });
    });
  });

  describe("encode", () => {
    describe("happy path", () => {
      test("function exists and is callable", async () => {
        const { encode } = await import("../encoder.js");
        expect(typeof encode).toBe("function");
      });

      test("encode function exists", async () => {
        const { encode } = await import("../encoder.js");
        expect(typeof encode).toBe("function");
        expect(encode.length).toBeGreaterThan(0); // Takes parameters
      });
    });

    describe("non-happy path", () => {
      test("throws error when input file does not exist", async () => {
        mock.module("../config.js", () => ({
          getConfig: mock(() => ({
            gpuDevice: "/dev/dri/renderD128",
          })),
        }));

        // Mock ffprobe to fail
        Bun.spawn = mock(() => ({
          stdout: {
            [Symbol.asyncIterator]: async function* () {},
          },
          stderr: {
            [Symbol.asyncIterator]: async function* () {
              yield new TextEncoder().encode("No such file or directory");
            },
          },
          exited: Promise.resolve(1),
        })) as any;

        const { encode } = await import("../encoder.js");

        const job = {
          jobId: "test-job",
          inputPath: "/nonexistent.mp4",
          outputPath: "/output.mkv",
          profile: {
            id: "test-profile",
            name: "Test Profile",
            videoEncoder: "av1_vaapi",
            videoQuality: 28,
            videoMaxResolution: "1080p",
            videoMaxBitrate: null,
            hwAccel: "vaapi",
            hwDevice: "/dev/dri/renderD128",
            videoFlags: {},
            audioEncoder: "aac",
            audioFlags: {},
            subtitlesMode: "embed",
            container: "mkv",
          },
          onProgress: mock(() => {}),
        };

        await expect(encode(job)).rejects.toThrow();
      });

      test("handles ffmpeg encoding failure", async () => {
        mock.module("../config.js", () => ({
          getConfig: mock(() => ({
            gpuDevice: "/dev/dri/renderD128",
          })),
        }));

        const mockFfprobeOutput = JSON.stringify({
          streams: [
            {
              codec_type: "video",
              width: 1920,
              height: 1080,
              r_frame_rate: "24/1",
              index: 0,
            },
          ],
          format: {
            duration: "100",
            size: "1000000",
          },
        });

        let callCount = 0;
        Bun.spawn = mock((cmd: any) => {
          callCount++;

          if (cmd[0] === "ffprobe") {
            return {
              stdout: {
                [Symbol.asyncIterator]: async function* () {
                  yield new TextEncoder().encode(mockFfprobeOutput);
                },
              },
              stderr: {
                [Symbol.asyncIterator]: async function* () {},
              },
              exited: Promise.resolve(0),
            };
          }

          // ffmpeg fails
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {},
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode("Encoding error: codec not supported");
              },
            },
            exited: Promise.resolve(1),
            kill: mock(() => {}),
          };
        }) as any;

        const { encode } = await import("../encoder.js");

        const job = {
          jobId: "test-job",
          inputPath: "/input.mp4",
          outputPath: "/output.mkv",
          profile: {
            id: "test-profile",
            name: "Test Profile",
            videoEncoder: "av1_vaapi",
            videoQuality: 28,
            videoMaxResolution: "1080p",
            videoMaxBitrate: null,
            hwAccel: "vaapi",
            hwDevice: "/dev/dri/renderD128",
            videoFlags: {},
            audioEncoder: "aac",
            audioFlags: {},
            subtitlesMode: "embed",
            container: "mkv",
          },
          onProgress: mock(() => {}),
        };

        await expect(encode(job)).rejects.toThrow();
      });
    });
  });
});
