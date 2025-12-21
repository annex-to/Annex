/**
 * Release Test Fixtures - Common release scenarios for testing
 */

import type { Release } from "../../../indexer.js";

/**
 * Create a mock release with defaults
 */
function createRelease(overrides: Partial<Release>): Release {
  return {
    id: overrides.id || `release-${Date.now()}`,
    title: overrides.title || "Test.Release.1080p.WEB-DL.H264",
    indexerId: overrides.indexerId || "test-indexer",
    indexerName: overrides.indexerName || "Test Indexer",
    resolution: overrides.resolution || "1080p",
    source: overrides.source || "WEB-DL",
    codec: overrides.codec || "H264",
    size: overrides.size ?? 5_000_000_000,
    seeders: overrides.seeders ?? 10,
    leechers: overrides.leechers ?? 5,
    magnetUri: overrides.magnetUri,
    downloadUrl: overrides.downloadUrl,
    downloadHeaders: overrides.downloadHeaders,
    infoUrl: overrides.infoUrl,
    publishDate: overrides.publishDate || new Date(),
    score: overrides.score ?? 50,
    categories: overrides.categories || [2000],
  };
}

/**
 * Movie releases with varying quality
 */
export const MOVIE_RELEASES = {
  INCEPTION_4K_REMUX: createRelease({
    title: "Inception.2010.2160p.UHD.BluRay.REMUX.HDR.HEVC.Atmos-GROUP",
    resolution: "2160p",
    source: "REMUX",
    codec: "HEVC",
    size: 80_000_000_000,
    seeders: 50,
    magnetUri: "magnet:?xt=urn:btih:inception4kremux",
  }),
  INCEPTION_1080P_BLURAY: createRelease({
    title: "Inception.2010.1080p.BluRay.x264.DTS-HD.MA.5.1-GROUP",
    resolution: "1080p",
    source: "BLURAY",
    codec: "H264",
    size: 15_000_000_000,
    seeders: 100,
    magnetUri: "magnet:?xt=urn:btih:inception1080p",
  }),
  INCEPTION_720P_WEBDL: createRelease({
    title: "Inception.2010.720p.WEB-DL.H264.AAC-GROUP",
    resolution: "720p",
    source: "WEB-DL",
    codec: "H264",
    size: 4_000_000_000,
    seeders: 75,
    magnetUri: "magnet:?xt=urn:btih:inception720p",
  }),
  INCEPTION_480P_DVDRIP: createRelease({
    title: "Inception.2010.480p.DVDRip.XviD-GROUP",
    resolution: "480p",
    source: "DVDRIP",
    codec: "XviD",
    size: 1_500_000_000,
    seeders: 20,
    magnetUri: "magnet:?xt=urn:btih:inception480p",
  }),
};

/**
 * TV show releases - season packs
 */
export const TV_SEASON_RELEASES = {
  BREAKING_BAD_S01_4K: createRelease({
    title: "Breaking.Bad.S01.2160p.WEB-DL.DDP5.1.H.265-GROUP",
    resolution: "2160p",
    source: "WEB-DL",
    codec: "H265",
    size: 45_000_000_000,
    seeders: 30,
    magnetUri: "magnet:?xt=urn:btih:breakingbads014k",
  }),
  BREAKING_BAD_S01_1080P: createRelease({
    title: "Breaking.Bad.S01.1080p.BluRay.x264-GROUP",
    resolution: "1080p",
    source: "BLURAY",
    codec: "H264",
    size: 20_000_000_000,
    seeders: 150,
    magnetUri: "magnet:?xt=urn:btih:breakingbads011080p",
  }),
  BREAKING_BAD_S01_720P: createRelease({
    title: "Breaking.Bad.S01.720p.WEB-DL.AAC2.0.H.264-GROUP",
    resolution: "720p",
    source: "WEB-DL",
    codec: "H264",
    size: 10_000_000_000,
    seeders: 200,
    magnetUri: "magnet:?xt=urn:btih:breakingbads01720p",
  }),
};

/**
 * TV show releases - individual episodes
 */
export const TV_EPISODE_RELEASES = {
  BREAKING_BAD_S01E01_1080P: createRelease({
    title: "Breaking.Bad.S01E01.1080p.BluRay.x264-GROUP",
    resolution: "1080p",
    source: "BLURAY",
    codec: "H264",
    size: 1_500_000_000,
    seeders: 50,
    magnetUri: "magnet:?xt=urn:btih:breakingbads01e01",
  }),
  BREAKING_BAD_S01E05_1080P: createRelease({
    title: "Breaking.Bad.S01E05.1080p.BluRay.x264-GROUP",
    resolution: "1080p",
    source: "BLURAY",
    codec: "H264",
    size: 1_500_000_000,
    seeders: 45,
    magnetUri: "magnet:?xt=urn:btih:breakingbads01e05",
  }),
};

/**
 * Edge case releases
 */
export const EDGE_CASE_RELEASES = {
  NO_SEEDERS: createRelease({
    title: "Dead.Torrent.1080p.WEB-DL.H264-GROUP",
    seeders: 0,
    leechers: 0,
  }),
  HUGE_FILE: createRelease({
    title: "Massive.File.2160p.REMUX.H265-GROUP",
    resolution: "2160p",
    size: 200_000_000_000,
    seeders: 5,
  }),
  UNKNOWN_QUALITY: createRelease({
    title: "Unknown.Quality.Release-GROUP",
    resolution: "",
    source: "",
    codec: "",
  }),
};

/**
 * Helper to create multiple releases for the same title
 */
export function createReleaseSet(
  baseTitle: string,
  year: number
): {
  uhd: Release;
  fullHd: Release;
  hd: Release;
  sd: Release;
} {
  return {
    uhd: createRelease({
      title: `${baseTitle}.${year}.2160p.WEB-DL.H265-GROUP`,
      resolution: "2160p",
      codec: "H265",
      size: 40_000_000_000,
      seeders: 20,
    }),
    fullHd: createRelease({
      title: `${baseTitle}.${year}.1080p.BluRay.x264-GROUP`,
      resolution: "1080p",
      codec: "H264",
      size: 15_000_000_000,
      seeders: 100,
    }),
    hd: createRelease({
      title: `${baseTitle}.${year}.720p.WEB-DL.H264-GROUP`,
      resolution: "720p",
      codec: "H264",
      size: 4_000_000_000,
      seeders: 75,
    }),
    sd: createRelease({
      title: `${baseTitle}.${year}.480p.DVDRip.XviD-GROUP`,
      resolution: "480p",
      codec: "XviD",
      size: 1_500_000_000,
      seeders: 25,
    }),
  };
}
