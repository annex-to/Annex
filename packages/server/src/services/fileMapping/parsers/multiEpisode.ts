import type { FilenameParser, ParsedFile } from "../types";

const PATTERN = /S(\d{1,2})E(\d{1,2})(?:[-E]+)(\d{1,2})/i;

export const multiEpisodeParser: FilenameParser = {
  name: "multiEpisode",
  parse(filename: string): ParsedFile | null {
    const match = filename.match(PATTERN);
    if (!match) return null;
    const season = Number.parseInt(match[1], 10);
    const episode = Number.parseInt(match[2], 10);
    const episodeEnd = Number.parseInt(match[3], 10);
    if (episodeEnd <= episode) return null;
    return { season, episode, episodeEnd, confidence: 0.97, parserName: this.name };
  },
};
