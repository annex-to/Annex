/**
 * Mock Indexer Service - For testing pipeline steps without real indexer calls
 */

import type { Release, SearchOptions, SearchResult } from "../../../indexer.js";

type MockRelease = Partial<Release> & Pick<Release, "title" | "indexerId">;

export class MockIndexerService {
  private mockReleases: MockRelease[] = [];
  private searchCalls: SearchOptions[] = [];

  /**
   * Configure mock releases to return for searches
   */
  setMockReleases(releases: MockRelease[]): void {
    this.mockReleases = releases;
  }

  /**
   * Add a single mock release
   */
  addMockRelease(release: MockRelease): void {
    this.mockReleases.push(release);
  }

  /**
   * Clear all mock releases
   */
  clearMockReleases(): void {
    this.mockReleases = [];
  }

  /**
   * Get all search calls made (for assertions)
   */
  getSearchCalls(): SearchOptions[] {
    return this.searchCalls;
  }

  /**
   * Clear search call history
   */
  clearSearchCalls(): void {
    this.searchCalls = [];
  }

  /**
   * Mock search method
   */
  async search(options: SearchOptions): Promise<SearchResult> {
    this.searchCalls.push(options);

    const releases: Release[] = this.mockReleases.map((mock, idx) => ({
      id: mock.id || `release-${idx}`,
      title: mock.title,
      indexerId: mock.indexerId,
      indexerName: mock.indexerName || "Mock Indexer",
      resolution: mock.resolution || "1080p",
      source: mock.source || "WEB-DL",
      codec: mock.codec || "H264",
      size: mock.size || 5_000_000_000,
      seeders: mock.seeders || 10,
      leechers: mock.leechers || 5,
      magnetUri: mock.magnetUri || `magnet:?xt=urn:btih:${idx}`,
      downloadUrl: mock.downloadUrl,
      infoUrl: mock.infoUrl,
      publishDate: mock.publishDate || new Date(),
      score: mock.score || 50,
      categories: mock.categories || [2000],
    }));

    return {
      releases,
      indexersQueried: 1,
      indexersFailed: 0,
      errors: [],
    };
  }

  /**
   * Mock searchMovie method
   */
  async searchMovie(options: {
    tmdbId?: number;
    imdbId?: string;
    title: string;
    year: number;
  }): Promise<SearchResult> {
    return this.search({
      type: "movie",
      ...options,
    });
  }

  /**
   * Mock searchTvSeason method
   */
  async searchTvSeason(options: {
    tmdbId?: number;
    imdbId?: string;
    title: string;
    year: number;
    season: number;
  }): Promise<SearchResult> {
    return this.search({
      type: "tv",
      ...options,
    });
  }

  /**
   * Mock searchTvEpisode method
   */
  async searchTvEpisode(options: {
    tmdbId?: number;
    imdbId?: string;
    title: string;
    year: number;
    season: number;
    episode: number;
  }): Promise<SearchResult> {
    return this.search({
      type: "tv",
      ...options,
    });
  }
}

/**
 * Helper to create a mock release
 */
export function createMockRelease(overrides: Partial<Release> = {}): MockRelease {
  return {
    title: "Test.Release.1080p.WEB-DL.H264",
    indexerId: "test-indexer",
    indexerName: "Test Indexer",
    resolution: "1080p",
    source: "WEB-DL",
    codec: "H264",
    size: 5_000_000_000,
    seeders: 10,
    leechers: 5,
    magnetUri: "magnet:?xt=urn:btih:test",
    publishDate: new Date(),
    score: 50,
    categories: [2000],
    ...overrides,
  };
}

/**
 * Helper to create multiple mock releases with varying quality
 */
export function createQualityVariants(baseTitle: string): {
  sd: MockRelease;
  hd: MockRelease;
  fullHd: MockRelease;
  uhd: MockRelease;
} {
  return {
    sd: createMockRelease({
      title: `${baseTitle}.480p.WEB-DL.H264`,
      resolution: "480p",
      size: 1_000_000_000,
      score: 30,
    }),
    hd: createMockRelease({
      title: `${baseTitle}.720p.WEB-DL.H264`,
      resolution: "720p",
      size: 2_500_000_000,
      score: 60,
    }),
    fullHd: createMockRelease({
      title: `${baseTitle}.1080p.WEB-DL.H264`,
      resolution: "1080p",
      size: 5_000_000_000,
      score: 80,
    }),
    uhd: createMockRelease({
      title: `${baseTitle}.2160p.WEB-DL.H265`,
      resolution: "2160p",
      codec: "H265",
      size: 15_000_000_000,
      score: 100,
    }),
  };
}
