import type { FilenameParser, ParsedFile } from "../types";

const PATTERNS: Array<{ regex: RegExp; confidence: number }> = [
  { regex: /S(\d{1,2})E(\d{1,2})(?!\d)/i, confidence: 0.99 },
  { regex: /\b(\d{1,2})x(\d{2})\b/i, confidence: 0.9 },
  { regex: /Season\s+(\d{1,2}).*?Episode\s+(\d{1,2})/i, confidence: 0.85 },
];

export const seasonEpisodeParser: FilenameParser = {
  name: "seasonEpisode",
  parse(filename: string): ParsedFile | null {
    for (const { regex, confidence } of PATTERNS) {
      const match = filename.match(regex);
      if (!match) continue;
      const season = Number.parseInt(match[1], 10);
      const episode = Number.parseInt(match[2], 10);
      if (Number.isNaN(season) || Number.isNaN(episode)) continue;
      return { season, episode, confidence, parserName: this.name };
    }
    return null;
  },
};
