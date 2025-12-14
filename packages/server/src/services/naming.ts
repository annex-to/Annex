/**
 * Naming Service
 *
 * Generates Plex/Emby-compatible filenames from TMDB metadata.
 * Files are named before transfer so they arrive ready for indexing.
 */

export interface MovieNamingParams {
  title: string;
  year: number;
  quality: string; // e.g., "2160p", "1080p", "720p"
  codec?: string; // e.g., "AV1", "HEVC", "H264"
  container: string; // e.g., "mkv", "mp4"
}

export interface TvNamingParams {
  series: string;
  year?: number;
  season: number;
  episode: number;
  episodeTitle?: string;
  quality: string;
  codec?: string;
  container: string;
}

/**
 * Sanitize a string for use in filenames
 * - Replace : with - (Windows compatibility)
 * - Remove invalid characters
 * - Normalize whitespace
 */
function sanitizeFilename(input: string): string {
  return (
    input
      // Replace colon with dash (Windows compatibility)
      .replace(/:/g, " -")
      // Remove characters invalid on Windows/Unix filesystems
      .replace(/[/\\?*"<>|]/g, "")
      // Normalize unicode characters
      .normalize("NFC")
      // Collapse multiple spaces to single space
      .replace(/\s+/g, " ")
      // Trim leading/trailing whitespace and dots
      .replace(/^[\s.]+|[\s.]+$/g, "")
  );
}

/**
 * Format quality tag for filename
 * e.g., "1080p AV1" or just "1080p"
 */
function formatQualityTag(quality: string, codec?: string): string {
  if (codec) {
    return `${quality} ${codec}`;
  }
  return quality;
}

/**
 * Pad number with leading zeros
 */
function padNumber(num: number, length: number): string {
  return num.toString().padStart(length, "0");
}

class NamingService {
  /**
   * Generate movie filename and folder path
   *
   * Format: {title} ({year})/{title} ({year}) [{quality}].{ext}
   *
   * Example: "Inception (2010)/Inception (2010) [2160p AV1].mkv"
   */
  generateMoviePath(params: MovieNamingParams): {
    folder: string;
    filename: string;
    fullPath: string;
  } {
    const { title, year, quality, codec, container } = params;

    const sanitizedTitle = sanitizeFilename(title);
    const qualityTag = formatQualityTag(quality, codec);

    const folder = `${sanitizedTitle} (${year})`;
    const filename = `${sanitizedTitle} (${year}) [${qualityTag}].${container}`;
    const fullPath = `${folder}/${filename}`;

    return { folder, filename, fullPath };
  }

  /**
   * Generate TV show filename and folder path
   *
   * Format: {series}/Season {season:00}/{series} - S{season:00}E{episode:00} - {episodeTitle} [{quality}].{ext}
   *
   * Example: "Breaking Bad/Season 01/Breaking Bad - S01E01 - Pilot [1080p AV1].mkv"
   */
  generateTvPath(params: TvNamingParams): {
    seriesFolder: string;
    seasonFolder: string;
    filename: string;
    fullPath: string;
  } {
    const { series, year, season, episode, episodeTitle, quality, codec, container } = params;

    const sanitizedSeries = sanitizeFilename(series);
    const sanitizedEpisodeTitle = episodeTitle ? sanitizeFilename(episodeTitle) : "";
    const qualityTag = formatQualityTag(quality, codec);

    // Include year in series folder if provided (helps with disambiguation)
    const seriesFolder = year ? `${sanitizedSeries} (${year})` : sanitizedSeries;
    const seasonFolder = `Season ${padNumber(season, 2)}`;

    // Build filename: Series - S01E01 - Episode Title [quality].ext
    let filename = `${sanitizedSeries} - S${padNumber(season, 2)}E${padNumber(episode, 2)}`;
    if (sanitizedEpisodeTitle) {
      filename += ` - ${sanitizedEpisodeTitle}`;
    }
    filename += ` [${qualityTag}].${container}`;

    const fullPath = `${seriesFolder}/${seasonFolder}/${filename}`;

    return { seriesFolder, seasonFolder, filename, fullPath };
  }

  /**
   * Generate multi-episode filename
   *
   * Format: {series} - S{season:00}E{startEp:00}-E{endEp:00} [{quality}].{ext}
   *
   * Example: "The Office - S03E12-E13 [1080p AV1].mkv"
   */
  generateMultiEpisodePath(params: {
    series: string;
    year?: number;
    season: number;
    startEpisode: number;
    endEpisode: number;
    quality: string;
    codec?: string;
    container: string;
  }): {
    seriesFolder: string;
    seasonFolder: string;
    filename: string;
    fullPath: string;
  } {
    const { series, year, season, startEpisode, endEpisode, quality, codec, container } = params;

    const sanitizedSeries = sanitizeFilename(series);
    const qualityTag = formatQualityTag(quality, codec);

    const seriesFolder = year ? `${sanitizedSeries} (${year})` : sanitizedSeries;
    const seasonFolder = `Season ${padNumber(season, 2)}`;

    const filename = `${sanitizedSeries} - S${padNumber(season, 2)}E${padNumber(startEpisode, 2)}-E${padNumber(endEpisode, 2)} [${qualityTag}].${container}`;

    const fullPath = `${seriesFolder}/${seasonFolder}/${filename}`;

    return { seriesFolder, seasonFolder, filename, fullPath };
  }

  /**
   * Parse quality string from resolution
   */
  resolutionToQuality(width: number, height: number): string {
    if (height >= 2160 || width >= 3840) return "2160p";
    if (height >= 1440 || width >= 2560) return "1440p";
    if (height >= 1080 || width >= 1920) return "1080p";
    if (height >= 720 || width >= 1280) return "720p";
    if (height >= 480 || width >= 854) return "480p";
    return "SD";
  }

  /**
   * Generate destination path for movies on a server
   */
  getMovieDestinationPath(
    serverMoviesPath: string,
    params: MovieNamingParams
  ): string {
    const { fullPath } = this.generateMoviePath(params);
    // Ensure no double slashes
    const basePath = serverMoviesPath.replace(/\/+$/, "");
    return `${basePath}/${fullPath}`;
  }

  /**
   * Generate destination path for TV shows on a server
   */
  getTvDestinationPath(
    serverTvPath: string,
    params: TvNamingParams
  ): string {
    const { fullPath } = this.generateTvPath(params);
    const basePath = serverTvPath.replace(/\/+$/, "");
    return `${basePath}/${fullPath}`;
  }
}

// Singleton instance
let namingService: NamingService | null = null;

export function getNamingService(): NamingService {
  if (!namingService) {
    namingService = new NamingService();
  }
  return namingService;
}

export { NamingService };
