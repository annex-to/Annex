/**
 * Indexer/tracker configuration
 */

export type IndexerType = "torznab" | "newznab" | "rss";

export interface IndexerCategories {
  movies: number[];
  tv: number[];
}

export interface Indexer {
  id: string;
  name: string;
  type: IndexerType;
  url: string;
  apiKey: string;
  categories: IndexerCategories;
  priority: number; // Lower = higher priority
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IndexerInput {
  name: string;
  type: IndexerType;
  url: string;
  apiKey: string;
  categories: IndexerCategories;
  priority: number;
  enabled: boolean;
}

export interface IndexerTestResult {
  success: boolean;
  message: string;
  capabilities?: {
    search: boolean;
    tvSearch: boolean;
    movieSearch: boolean;
  };
}

export interface TorrentResult {
  indexerId: string;
  indexerName: string;
  title: string;
  magnetUri: string;
  infoUrl: string | null;
  size: number; // bytes
  seeders: number;
  leechers: number;
  publishDate: Date;
  // Parsed quality info
  resolution: string | null;
  source: string | null; // BluRay, WEB-DL, etc.
  codec: string | null;
  releaseGroup: string | null;
}
