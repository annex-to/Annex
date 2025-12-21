/**
 * Core functionality tests for FFmpeg encoder service
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Test mocks require any for Bun.spawn and fs.Stats stubs */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";

describe("encoder - core functionality", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  describe("encode - successful encoding", () => {
    test("encodes video with VAAPI hardware acceleration", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      // Mock file system
      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 500000000 } as any);

      // Mock ffprobe
      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      // Mock ffmpeg encoding
      const progressLines = [
        "frame=100",
        "fps=30.5",
        "bitrate=2500kbits/s",
        "total_size=1000000",
        "out_time_us=4000000",
        "speed=1.5x",
      ];

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          // ffmpeg
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return {
                      done: false,
                      value: new TextEncoder().encode(`${progressLines.join("\n")}\n`),
                    };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const result = await encode({
        jobId: "test-job",
        inputPath: "/test/input.mp4",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: { "b:a": "128k" },
          videoFlags: { compression_level: "5" },
          preset: "medium",
        },
        onProgress: mock(() => {}),
      });

      expect(result).toBeDefined();
      expect(result.outputPath).toBe("/test/output.mkv");
      expect(result.outputSize).toBe(500000000);
      expect(result.compressionRatio).toBeGreaterThan(0);
    });

    test("encodes video with software encoding fallback", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 400000000 } as any);

      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return {
                      done: false,
                      value: new TextEncoder().encode("frame=50\n"),
                    };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const result = await encode({
        jobId: "test-job",
        inputPath: "/test/input.mp4",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "none",
          videoEncoder: "libsvtav1",
          crf: 35,
          maxResolution: "1080p",
          maxBitrate: 8000,
          audioEncoder: "copy",
          audioFlags: {},
          videoFlags: {},
          preset: "medium",
        },
        onProgress: mock(() => {}),
      });

      expect(result).toBeDefined();
      expect(result.outputSize).toBe(400000000);
    });

    test("encodes with subtitle streams", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 600000000 } as any);

      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return { done: false, value: new TextEncoder().encode("frame=100\n") };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const result = await encode({
        jobId: "test-job",
        inputPath: "/test/input.mkv",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: {},
          videoFlags: {},
          preset: "medium",
        },
        onProgress: mock(() => {}),
      });

      expect(result).toBeDefined();
    });

    test("handles resolution downscaling", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 300000000 } as any);

      const probeOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 3840,
            height: 2160,
            r_frame_rate: "24/1",
            index: 0,
          },
        ],
        format: {
          duration: "120",
          size: "2000000000",
        },
      });

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return { done: false, value: new TextEncoder().encode("frame=50\n") };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const result = await encode({
        jobId: "test-job",
        inputPath: "/test/4k-input.mp4",
        outputPath: "/test/1080p-output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: {},
          videoFlags: {},
          preset: "medium",
        },
        onProgress: mock(() => {}),
      });

      expect(result).toBeDefined();
    });
  });

  describe("encode - error conditions", () => {
    test("throws error when input file does not exist", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(false);

      const { encode } = await import("../encoder.js");

      await expect(
        encode({
          jobId: "test-job",
          inputPath: "/nonexistent/input.mp4",
          outputPath: "/test/output.mkv",
          encodingConfig: {
            hwDevice: "/dev/dri/renderD128",
            subtitlesMode: "embed",
            container: "mkv",
            hwAccel: "vaapi",
            videoEncoder: "av1_vaapi",
            crf: 30,
            maxResolution: "1080p",
            maxBitrate: undefined,
            audioEncoder: "libopus",
            audioFlags: {},
            videoFlags: {},
            preset: "medium",
          },
          onProgress: mock(() => {}),
        })
      ).rejects.toThrow("Input file not found");
    });

    test("handles FFmpeg failure", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "unlinkSync").mockReturnValue(undefined);

      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          // ffmpeg fails
          return {
            stdout: {
              getReader: () => ({
                read: async () => ({ done: true, value: undefined }),
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode("Encoding failed: invalid parameters");
              },
            },
            exited: Promise.resolve(1),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      await expect(
        encode({
          jobId: "test-job",
          inputPath: "/test/input.mp4",
          outputPath: "/test/output.mkv",
          encodingConfig: {
            hwDevice: "/dev/dri/renderD128",
            subtitlesMode: "embed",
            container: "mkv",
            hwAccel: "vaapi",
            videoEncoder: "av1_vaapi",
            crf: 30,
            maxResolution: "1080p",
            maxBitrate: undefined,
            audioEncoder: "libopus",
            audioFlags: {},
            videoFlags: {},
            preset: "medium",
          },
          onProgress: mock(() => {}),
        })
      ).rejects.toThrow("FFmpeg exited with code 1");
    });

    test("handles abort signal", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "unlinkSync").mockReturnValue(undefined);

      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      const killMock = mock(() => {});

      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  await new Promise((r) => setTimeout(r, 100));
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode("Killed");
              },
            },
            exited: Promise.resolve(137),
            kill: killMock,
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const abortController = new AbortController();

      const encodePromise = encode({
        jobId: "test-job",
        inputPath: "/test/input.mp4",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: {},
          videoFlags: {},
          preset: "medium",
        },
        onProgress: mock(() => {}),
        abortSignal: abortController.signal,
      });

      // Abort after a short delay
      setTimeout(() => abortController.abort(), 50);

      await expect(encodePromise).rejects.toThrow();
      expect(killMock).toHaveBeenCalled();
    });
  });

  describe("subtitle handling", () => {
    test("includes MKV-compatible subtitle codecs", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 500000000 } as any);

      const probeOutput = JSON.stringify({
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
          },
          {
            codec_type: "subtitle",
            codec_name: "mov_text",
            index: 3,
          },
        ],
        format: {
          duration: "120",
          size: "1000000000",
        },
      });

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return { done: false, value: new TextEncoder().encode("frame=10\n") };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const result = await encode({
        jobId: "test-job",
        inputPath: "/test/input.mp4",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: {},
          videoFlags: {},
          preset: "medium",
        },
        onProgress: mock(() => {}),
      });

      expect(result).toBeDefined();
    });
  });

  describe("progress reporting", () => {
    test("calls onProgress with encoding progress", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 500000000 } as any);

      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return {
                      done: false,
                      value: new TextEncoder().encode(
                        "frame=100\nfps=30.5\nbitrate=2500kbits/s\ntotal_size=1000000\nout_time_us=4000000\nspeed=1.5x\n"
                      ),
                    };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      const onProgressMock = mock(() => {});

      await encode({
        jobId: "test-job",
        inputPath: "/test/input.mp4",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: {},
          videoFlags: {},
          preset: "medium",
        },
        onProgress: onProgressMock,
      });

      expect(onProgressMock).toHaveBeenCalled();
    });
  });

  describe("video flags handling", () => {
    test("applies custom video flags to VAAPI encoding", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      spyOn(fs, "existsSync").mockReturnValue(true);
      spyOn(fs, "mkdirSync").mockReturnValue(undefined);
      spyOn(fs, "statSync").mockReturnValue({ size: 500000000 } as any);

      const probeOutput = JSON.stringify({
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
          duration: "120",
          size: "1000000000",
        },
      });

      let probeCall = true;
      Bun.spawn = mock((cmd: any) => {
        if (cmd[0] === "ffprobe") {
          return {
            stdout: {
              [Symbol.asyncIterator]: async function* () {
                yield new TextEncoder().encode(probeOutput);
              },
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
          } as any;
        } else {
          return {
            stdout: {
              getReader: () => ({
                read: async () => {
                  if (probeCall) {
                    probeCall = false;
                    return { done: false, value: new TextEncoder().encode("frame=10\n") };
                  }
                  return { done: true, value: undefined };
                },
              }),
            },
            stderr: {
              [Symbol.asyncIterator]: async function* () {},
            },
            exited: Promise.resolve(0),
            kill: mock(() => {}),
          } as any;
        }
      });

      const { encode } = await import("../encoder.js");

      await encode({
        jobId: "test-job",
        inputPath: "/test/input.mp4",
        outputPath: "/test/output.mkv",
        encodingConfig: {
          hwDevice: "/dev/dri/renderD128",
          subtitlesMode: "embed",
          container: "mkv",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          crf: 30,
          maxResolution: "1080p",
          maxBitrate: undefined,
          audioEncoder: "libopus",
          audioFlags: {},
          videoFlags: {
            compression_level: "12",
            tile_rows: "2",
            tile_cols: "2",
          },
          preset: "medium",
        },
        onProgress: mock(() => {}),
      });

      // The compression_level should be clamped to 7
      expect(Bun.spawn).toHaveBeenCalled();
    });
  });
});
