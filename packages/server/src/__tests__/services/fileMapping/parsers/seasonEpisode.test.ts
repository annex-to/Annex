import { describe, expect, it } from "bun:test";
import { seasonEpisodeParser } from "../../../../services/fileMapping/parsers/seasonEpisode";

describe("seasonEpisodeParser", () => {
  it("parses S01E01", () => {
    const result = seasonEpisodeParser.parse("The.Show.S01E01.1080p.mkv");
    expect(result).not.toBeNull();
    expect(result?.season).toBe(1);
    expect(result?.episode).toBe(1);
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("parses 1x01 form", () => {
    const result = seasonEpisodeParser.parse("Show.1x01.mkv");
    expect(result?.season).toBe(1);
    expect(result?.episode).toBe(1);
  });

  it("parses Season N Episode M form", () => {
    const result = seasonEpisodeParser.parse("Show - Season 2 Episode 5.mkv");
    expect(result?.season).toBe(2);
    expect(result?.episode).toBe(5);
  });

  it("returns null when no pattern matches", () => {
    expect(seasonEpisodeParser.parse("random.video.mkv")).toBeNull();
  });

  it("ignores resolutions that look like episodes (1080p)", () => {
    const result = seasonEpisodeParser.parse("Show.1080p.WEB-DL.mkv");
    expect(result).toBeNull();
  });
});
