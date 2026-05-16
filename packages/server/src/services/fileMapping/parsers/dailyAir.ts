import type { FilenameParser, ParsedFile } from "../types";

const PATTERN = /(?<!\d)(19\d{2}|20\d{2})[.\-_](\d{2})[.\-_](\d{2})(?!\d)/;

export const dailyAirParser: FilenameParser = {
  name: "dailyAir",
  parse(filename: string): ParsedFile | null {
    const match = filename.match(PATTERN);
    if (!match) return null;
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const airDate = new Date(Date.UTC(year, month - 1, day));
    return { airDate, confidence: 0.8, parserName: this.name };
  },
};
