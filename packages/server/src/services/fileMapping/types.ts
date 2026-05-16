export interface ParsedFile {
  season?: number;
  episode?: number;
  episodeEnd?: number;
  airDate?: Date;
  absoluteNumber?: number;
  confidence: number;
  parserName: string;
}

export interface FilenameParser {
  readonly name: string;
  parse(filename: string): ParsedFile | null;
}

export const PARSER_VERSION = "v1";
