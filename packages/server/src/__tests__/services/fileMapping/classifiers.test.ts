import { describe, expect, it } from "bun:test";
import { classifyFile } from "../../../services/fileMapping/classifiers";

describe("classifyFile", () => {
  it("flags sample files", () => {
    expect(classifyFile({ name: "Show.S01E01.sample.mkv", sizeBytes: 50_000_000 })).toEqual({
      kind: "VIDEO_SAMPLE",
      rejected: true,
      rejectReason: "sample",
    });
  });

  it("flags too-small video files", () => {
    expect(classifyFile({ name: "Show.S01E01.mkv", sizeBytes: 10_000_000 })).toEqual({
      kind: "VIDEO_SAMPLE",
      rejected: true,
      rejectReason: "too_small",
    });
  });

  it("classifies .srt as SUBTITLE", () => {
    const result = classifyFile({ name: "Show.S01E01.en.srt", sizeBytes: 30_000 });
    expect(result.kind).toBe("SUBTITLE");
    expect(result.rejected).toBe(false);
  });

  it("classifies .nfo as EXTRA", () => {
    expect(classifyFile({ name: "Show.nfo", sizeBytes: 1000 }).kind).toBe("EXTRA");
  });

  it("accepts a normal video file", () => {
    const result = classifyFile({ name: "Show.S01E01.1080p.mkv", sizeBytes: 2_000_000_000 });
    expect(result.kind).toBe("VIDEO_MAIN");
    expect(result.rejected).toBe(false);
  });
});
