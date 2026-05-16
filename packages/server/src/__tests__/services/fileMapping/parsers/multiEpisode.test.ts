import { describe, expect, it } from "bun:test";
import { multiEpisodeParser } from "../../../../services/fileMapping/parsers/multiEpisode";

describe("multiEpisodeParser", () => {
  it("parses S01E01E02", () => {
    const r = multiEpisodeParser.parse("Show.S01E01E02.mkv");
    expect(r?.season).toBe(1);
    expect(r?.episode).toBe(1);
    expect(r?.episodeEnd).toBe(2);
  });

  it("parses S01E01-E03", () => {
    const r = multiEpisodeParser.parse("Show.S01E01-E03.mkv");
    expect(r?.episode).toBe(1);
    expect(r?.episodeEnd).toBe(3);
  });

  it("parses S01E01-02", () => {
    const r = multiEpisodeParser.parse("Show.S01E01-02.mkv");
    expect(r?.episode).toBe(1);
    expect(r?.episodeEnd).toBe(2);
  });

  it("returns null for single episode", () => {
    expect(multiEpisodeParser.parse("Show.S01E01.mkv")).toBeNull();
  });
});
