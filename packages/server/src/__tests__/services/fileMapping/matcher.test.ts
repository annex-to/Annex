import { describe, expect, it } from "bun:test";
import { matchFilesToItems } from "../../../services/fileMapping/matcher";

const candidateFile = (overrides: {
  season?: number;
  episode?: number;
  episodeEnd?: number;
  relativePath: string;
}) => ({
  relativePath: overrides.relativePath,
  parsed: {
    season: overrides.season,
    episode: overrides.episode,
    episodeEnd: overrides.episodeEnd,
    confidence: 0.99,
    parserName: "seasonEpisode",
  },
});

describe("matchFilesToItems", () => {
  it("matches a single S01E01 file to the S01E01 item", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 1, relativePath: "Show.S01E01.mkv" })],
      items: [{ id: "pi1", season: 1, episode: 1 }],
    });
    expect(result.assignments).toEqual([
      { relativePath: "Show.S01E01.mkv", processingItemId: "pi1" },
    ]);
    expect(result.misses).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  it("assigns multi-episode file to lowest-episode PI only and marks the rest as miss (v1 scope)", () => {
    const result = matchFilesToItems({
      files: [
        candidateFile({ season: 1, episode: 1, episodeEnd: 2, relativePath: "Show.S01E01E02.mkv" }),
      ],
      items: [
        { id: "pi1", season: 1, episode: 1 },
        { id: "pi2", season: 1, episode: 2 },
      ],
    });
    expect(result.assignments).toEqual([
      { relativePath: "Show.S01E01E02.mkv", processingItemId: "pi1" },
    ]);
    expect(result.misses).toEqual(["pi2"]);
  });

  it("returns orphans when a file matches no item", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 99, relativePath: "Show.S01E99.mkv" })],
      items: [{ id: "pi1", season: 1, episode: 1 }],
    });
    expect(result.orphans).toEqual(["Show.S01E99.mkv"]);
    expect(result.misses).toEqual(["pi1"]);
  });

  it("returns misses when an item has no file", () => {
    const result = matchFilesToItems({
      files: [candidateFile({ season: 1, episode: 1, relativePath: "Show.S01E01.mkv" })],
      items: [
        { id: "pi1", season: 1, episode: 1 },
        { id: "pi2", season: 1, episode: 2 },
      ],
    });
    expect(result.misses).toEqual(["pi2"]);
  });
});
