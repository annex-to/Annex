/**
 * Advanced tests for FFmpeg encoder service
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("encoder - advanced functionality", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  describe("probeMedia - various video formats", () => {
    test("handles 4K resolution video", async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 3840,
            height: 2160,
            r_frame_rate: "30/1",
            index: 0,
          },
        ],
        format: {
          duration: "200",
          size: "5000000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/4k-video.mp4");

      expect(result.width).toBe(3840);
      expect(result.height).toBe(2160);
      expect(result.fps).toBe(30);
    });

    test("handles 720p resolution video", async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1280,
            height: 720,
            r_frame_rate: "60/1",
            index: 0,
          },
        ],
        format: {
          duration: "150",
          size: "800000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/720p-video.mp4");

      expect(result.width).toBe(1280);
      expect(result.height).toBe(720);
      expect(result.fps).toBe(60);
    });

    test("handles fractional frame rates", async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            r_frame_rate: "30000/1001", // 29.97 fps
            index: 0,
          },
        ],
        format: {
          duration: "120",
          size: "1000000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/ntsc-video.mp4");

      expect(result.fps).toBeCloseTo(29.97, 2);
    });

    test("handles video with zero denominator in frame rate", async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            r_frame_rate: "30/0", // Invalid - should fall back to default
            index: 0,
          },
        ],
        format: {
          duration: "100",
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/video.mp4");

      expect(result.fps).toBe(24); // Default fps
    });

    test("handles very large files", async () => {
      const mockOutput = JSON.stringify({
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
          duration: "7200", // 2 hours
          size: "20000000000", // 20GB
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/large-video.mp4");

      expect(result.duration).toBe(7200);
      expect(result.fileSize).toBe(20000000000);
    });

    test("handles video with multiple audio streams", async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            r_frame_rate: "24/1",
            index: 0,
          },
          {
            codec_type: "audio",
            codec_name: "aac",
            channels: 2,
            index: 1,
          },
          {
            codec_type: "audio",
            codec_name: "ac3",
            channels: 6,
            index: 2,
          },
        ],
        format: {
          duration: "120",
          size: "1000000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/multi-audio.mkv");

      expect(result).toBeDefined();
      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
    });

    test("handles empty subtitle streams array", async () => {
      const mockOutput = JSON.stringify({
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
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/no-subs.mp4");

      expect(result.subtitleStreams).toEqual([]);
    });

    test("handles subtitle without language tag", async () => {
      const mockOutput = JSON.stringify({
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
            // No tags object
          },
        ],
        format: {
          duration: "100",
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/video.mkv");

      expect(result.subtitleStreams.length).toBe(1);
      expect(result.subtitleStreams[0].language).toBeUndefined();
    });

    test("handles missing codec_name in subtitle", async () => {
      const mockOutput = JSON.stringify({
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
            index: 2,
            // No codec_name
          },
        ],
        format: {
          duration: "100",
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/video.mkv");

      expect(result.subtitleStreams.length).toBe(1);
      expect(result.subtitleStreams[0].codec).toBe("unknown");
    });
  });

  describe("probeMedia - error conditions", () => {
    test("handles corrupted video file", async () => {
      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {},
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode("Invalid data found when processing input");
          },
        },
        exited: Promise.resolve(1),
      })) as any;

      const { probeMedia } = require("../encoder.js");

      await expect(probeMedia("/test/corrupted.mp4")).rejects.toThrow("ffprobe failed");
    });

    test("handles missing format section", async () => {
      const mockOutput = JSON.stringify({
        streams: [
          {
            codec_type: "video",
            width: 1920,
            height: 1080,
            r_frame_rate: "24/1",
            index: 0,
          },
        ],
        // Missing format section
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/video.mp4");

      expect(result.duration).toBe(0);
      expect(result.fileSize).toBe(0);
    });

    test("handles empty streams array", async () => {
      const mockOutput = JSON.stringify({
        streams: [],
        format: {
          duration: "100",
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");

      await expect(probeMedia("/test/video.mp4")).rejects.toThrow("No video stream found");
    });

    test("handles missing streams property", async () => {
      const mockOutput = JSON.stringify({
        format: {
          duration: "100",
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");

      await expect(probeMedia("/test/video.mp4")).rejects.toThrow("No video stream found");
    });

    test("handles non-numeric duration", async () => {
      const mockOutput = JSON.stringify({
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
          duration: "invalid",
          size: "500000",
        },
      });

      Bun.spawn = (() => ({
        stdout: {
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode(mockOutput);
          },
        },
        stderr: {
          [Symbol.asyncIterator]: async function* () {},
        },
        exited: Promise.resolve(0),
      })) as any;

      const { probeMedia } = require("../encoder.js");
      const result = await probeMedia("/test/video.mp4");

      expect(result.duration).toBeNaN();
    });
  });
});
