/**
 * Mock Download Manager - For testing pipeline steps without real downloads
 */

import type { MatchResult } from "../../../../types/download.js";

interface MockTorrent {
  hash: string;
  name: string;
  progress: number;
  isComplete: boolean;
}

export class MockDownloadManager {
  private mockTorrents: Map<string, MockTorrent> = new Map();
  private findMovieCalls: Array<{ title: string; year: number }> = [];
  private findSeasonCalls: Array<{ showName: string; season: number }> = [];

  /**
   * Add a mock torrent to the download manager
   */
  addMockTorrent(torrent: MockTorrent): void {
    this.mockTorrents.set(torrent.hash, torrent);
  }

  /**
   * Clear all mock torrents
   */
  clearMockTorrents(): void {
    this.mockTorrents.clear();
  }

  /**
   * Get all find movie download calls
   */
  getFindMovieCalls() {
    return this.findMovieCalls;
  }

  /**
   * Get all find season download calls
   */
  getFindSeasonCalls() {
    return this.findSeasonCalls;
  }

  /**
   * Clear call history
   */
  clearCalls(): void {
    this.findMovieCalls = [];
    this.findSeasonCalls = [];
  }

  /**
   * Mock findExistingMovieDownload
   */
  async findExistingMovieDownload(movieTitle: string, year: number): Promise<MatchResult> {
    this.findMovieCalls.push({ title: movieTitle, year });

    // Simple mock: look for any torrent with matching title
    for (const [hash, torrent] of this.mockTorrents) {
      if (torrent.name.toLowerCase().includes(movieTitle.toLowerCase())) {
        return {
          found: true,
          isComplete: torrent.isComplete,
          match: {
            torrent: {
              hash,
              name: torrent.name,
              size: 5_000_000_000,
              progress: torrent.progress,
              downloadSpeed: 0,
              uploadSpeed: 0,
              seeds: 10,
              peers: 5,
              ratio: 1.0,
              eta: 0,
              state: torrent.isComplete ? "seeding" : "downloading",
              savePath: "/downloads",
              contentPath: `/downloads/${torrent.name}`,
              addedOn: 0,
              completedOn: torrent.isComplete ? Date.now() / 1000 : 0,
            },
            parsed: {
              title: movieTitle,
              year,
              resolution: "1080p",
            },
            score: 80,
          },
        };
      }
    }

    return { found: false, isComplete: false };
  }

  /**
   * Mock findExistingSeasonDownload
   */
  async findExistingSeasonDownload(showName: string, season: number): Promise<MatchResult> {
    this.findSeasonCalls.push({ showName, season });

    // Simple mock: look for any torrent with matching show and season
    for (const [hash, torrent] of this.mockTorrents) {
      if (
        torrent.name.toLowerCase().includes(showName.toLowerCase()) &&
        torrent.name.includes(`S${String(season).padStart(2, "0")}`)
      ) {
        return {
          found: true,
          isComplete: torrent.isComplete,
          match: {
            torrent: {
              hash,
              name: torrent.name,
              size: 10_000_000_000,
              progress: torrent.progress,
              downloadSpeed: 0,
              uploadSpeed: 0,
              seeds: 10,
              peers: 5,
              ratio: 1.0,
              eta: 0,
              state: torrent.isComplete ? "seeding" : "downloading",
              savePath: "/downloads",
              contentPath: `/downloads/${torrent.name}`,
              addedOn: 0,
              completedOn: torrent.isComplete ? Date.now() / 1000 : 0,
            },
            parsed: {
              title: showName,
              season,
              resolution: "1080p",
            },
            score: 80,
          },
        };
      }
    }

    return { found: false, isComplete: false };
  }
}

/**
 * Helper to create a mock torrent
 */
export function createMockTorrent(
  name: string,
  options: { isComplete?: boolean; progress?: number; hash?: string } = {}
): MockTorrent {
  return {
    hash: options.hash || `hash-${Date.now()}`,
    name,
    progress: options.progress ?? (options.isComplete ? 1 : 0.5),
    isComplete: options.isComplete ?? false,
  };
}
