/**
 * Emby Service
 *
 * Handles communication with Emby server for library management.
 * Uses the configured Emby server URL from environment variables.
 */

import { getConfig } from "../config/index.js";
import { getSecretsService } from "./secrets.js";

// =============================================================================
// Types
// =============================================================================

export interface EmbyLibrary {
  Id: string;
  Name: string;
  CollectionType?: string; // "movies", "tvshows", "music", etc.
  ItemId?: string;
}

export interface EmbyMediaItem {
  Id: string;
  Name: string;
  Type: "Movie" | "Series" | "Episode" | "Season" | "BoxSet" | "MusicAlbum" | "MusicArtist" | "Audio";
  ServerId: string;
  // Identification
  ProviderIds?: {
    Tmdb?: string;
    Imdb?: string;
    Tvdb?: string;
  };
  // Media info
  Overview?: string;
  ProductionYear?: number;
  PremiereDate?: string;
  CommunityRating?: number;
  OfficialRating?: string; // e.g., "PG-13"
  RunTimeTicks?: number;
  // Images
  ImageTags?: {
    Primary?: string;
    Backdrop?: string;
    Logo?: string;
    Thumb?: string;
  };
  BackdropImageTags?: string[];
  // For TV shows
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  SeasonName?: string;
  ParentIndexNumber?: number; // Season number
  IndexNumber?: number; // Episode number
  // Media streams info
  MediaSources?: Array<{
    Id: string;
    Path?: string;
    Container?: string;
    Size?: number;
    Bitrate?: number;
    MediaStreams?: Array<{
      Type: "Video" | "Audio" | "Subtitle";
      Codec?: string;
      Language?: string;
      Width?: number;
      Height?: number;
      BitRate?: number;
    }>;
  }>;
  // Dates
  DateCreated?: string;
  // User data
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayCount?: number;
    IsFavorite?: boolean;
    Played?: boolean;
    LastPlayedDate?: string;
  };
  // Genres and people
  Genres?: string[];
  Studios?: Array<{ Name: string; Id: string }>;
  People?: Array<{
    Id: string;
    Name: string;
    Role?: string;
    Type: string;
    PrimaryImageTag?: string;
  }>;
}

export interface EmbyItemsResponse {
  Items: EmbyMediaItem[];
  TotalRecordCount: number;
  StartIndex: number;
}

export interface EmbyLibraryItem {
  id: string;
  embyId: string;
  title: string;
  type: "movie" | "tv";
  year?: number;
  overview?: string;
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
  rating?: number;
  runtime?: number; // in minutes
  genres: string[];
  addedAt?: Date;
  posterUrl?: string;
  backdropUrl?: string;
  quality?: string;
  fileSize?: number;
}

// =============================================================================
// Helpers
// =============================================================================

// Cache for Emby credentials
let embyCredentialsCache: { url?: string; apiKey?: string } | null = null;

// Listen for secret changes
const embySecrets = getSecretsService();
embySecrets.on("change", (key: string) => {
  if (key.startsWith("emby.")) {
    embyCredentialsCache = null;
  }
});

/**
 * Load Emby credentials from secrets store (preferred) or config (fallback)
 */
async function loadEmbyCredentials(): Promise<{ url?: string; apiKey?: string }> {
  if (embyCredentialsCache) {
    return embyCredentialsCache;
  }

  const secrets = getSecretsService();
  const [secretUrl, secretApiKey] = await Promise.all([
    secrets.getSecret("emby.serverUrl"),
    secrets.getSecret("emby.apiKey"),
  ]);

  const config = getConfig();
  embyCredentialsCache = {
    url: secretUrl || config.emby.serverUrl || undefined,
    apiKey: secretApiKey || config.emby.apiKey || undefined,
  };

  return embyCredentialsCache;
}

/**
 * Get the configured Emby server URL
 */
async function getEmbyServerUrl(): Promise<string> {
  const creds = await loadEmbyCredentials();
  if (!creds.url) {
    throw new Error("Emby server URL is not configured");
  }
  return creds.url.replace(/\/$/, "");
}

/**
 * Get the configured Emby API key
 */
async function getEmbyApiKey(): Promise<string> {
  const creds = await loadEmbyCredentials();
  if (!creds.apiKey) {
    throw new Error("Emby API key is not configured");
  }
  return creds.apiKey;
}

/**
 * Check if Emby is fully configured (URL and API key)
 */
export async function isEmbyFullyConfigured(): Promise<boolean> {
  const creds = await loadEmbyCredentials();
  return !!(creds.url && creds.apiKey);
}

/**
 * Build headers for Emby API requests
 */
async function getEmbyHeaders(): Promise<Record<string, string>> {
  const apiKey = await getEmbyApiKey();
  return {
    "X-Emby-Token": apiKey,
    "Content-Type": "application/json",
  };
}

/**
 * Make a request to the Emby API
 */
async function embyFetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const baseUrl = await getEmbyServerUrl();
  const url = `${baseUrl}${endpoint}`;
  const headers = await getEmbyHeaders();

  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Emby API error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get the primary image URL for an Emby item (sync version using cache)
 * Uses cached credentials if available, otherwise returns null
 */
export function getEmbyImageUrl(
  itemId: string,
  imageType: "Primary" | "Backdrop" | "Logo" | "Thumb" = "Primary",
  imageTag?: string,
  maxWidth?: number
): string | null {
  if (!imageTag) return null;

  // Use cached URL if available (sync-friendly for image rendering)
  const baseUrl = embyCredentialsCache?.url?.replace(/\/$/, "");
  if (!baseUrl) {
    // Fall back to config for sync access
    const config = getConfig();
    if (!config.emby.serverUrl) return null;
    const configUrl = config.emby.serverUrl.replace(/\/$/, "");
    let url = `${configUrl}/Items/${itemId}/Images/${imageType}?tag=${imageTag}`;
    if (maxWidth) {
      url += `&maxWidth=${maxWidth}`;
    }
    return url;
  }

  let url = `${baseUrl}/Items/${itemId}/Images/${imageType}?tag=${imageTag}`;
  if (maxWidth) {
    url += `&maxWidth=${maxWidth}`;
  }
  return url;
}

/**
 * Extract quality info from media sources
 * Uses both width and height to handle ultrawide aspect ratios correctly
 * (e.g., a 1920x800 ultrawide movie should be classified as 1080p, not 720p)
 */
function extractQuality(item: EmbyMediaItem): string | undefined {
  const videoStream = item.MediaSources?.[0]?.MediaStreams?.find(
    (s) => s.Type === "Video"
  );
  if (!videoStream) return undefined;

  const width = videoStream.Width;
  const height = videoStream.Height;
  if (!width && !height) return undefined;

  // Check width OR height to handle ultrawide aspect ratios
  if ((width && width >= 3840) || (height && height >= 2160)) return "4K";
  if ((width && width >= 1920) || (height && height >= 1080)) return "1080p";
  if ((width && width >= 1280) || (height && height >= 720)) return "720p";
  if ((width && width >= 854) || (height && height >= 480)) return "480p";
  return height ? `${height}p` : `${width}w`;
}

/**
 * Convert Emby item to our normalized format
 */
function normalizeEmbyItem(item: EmbyMediaItem): EmbyLibraryItem | null {
  // Only process movies and series
  if (item.Type !== "Movie" && item.Type !== "Series") {
    return null;
  }

  const type = item.Type === "Movie" ? "movie" : "tv";

  return {
    id: item.Id,
    embyId: item.Id,
    title: item.Name,
    type,
    year: item.ProductionYear,
    overview: item.Overview,
    tmdbId: item.ProviderIds?.Tmdb ? parseInt(item.ProviderIds.Tmdb, 10) : undefined,
    imdbId: item.ProviderIds?.Imdb,
    tvdbId: item.ProviderIds?.Tvdb ? parseInt(item.ProviderIds.Tvdb, 10) : undefined,
    rating: item.CommunityRating,
    runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : undefined,
    genres: item.Genres || [],
    addedAt: item.DateCreated ? new Date(item.DateCreated) : undefined,
    posterUrl: getEmbyImageUrl(item.Id, "Primary", item.ImageTags?.Primary, 300) || undefined,
    backdropUrl: getEmbyImageUrl(item.Id, "Backdrop", item.BackdropImageTags?.[0], 1280) || undefined,
    quality: extractQuality(item),
    fileSize: item.MediaSources?.[0]?.Size,
  };
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Get all libraries (views) from Emby
 */
export async function getEmbyLibraries(): Promise<EmbyLibrary[]> {
  const data = await embyFetch<{ Items: EmbyLibrary[] }>("/Library/VirtualFolders");
  return data.Items;
}

/**
 * Get items from a specific library
 */
export async function getEmbyLibraryItems(
  libraryId: string,
  options: {
    type?: "Movie" | "Series";
    startIndex?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "Ascending" | "Descending";
  } = {}
): Promise<{ items: EmbyLibraryItem[]; totalCount: number }> {
  const params = new URLSearchParams({
    ParentId: libraryId,
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated,Studios,People",
    EnableImageTypes: "Primary,Backdrop",
    StartIndex: (options.startIndex ?? 0).toString(),
    Limit: (options.limit ?? 50).toString(),
    SortBy: options.sortBy ?? "SortName",
    SortOrder: options.sortOrder ?? "Ascending",
  });

  if (options.type) {
    params.set("IncludeItemTypes", options.type);
  } else {
    params.set("IncludeItemTypes", "Movie,Series");
  }

  const data = await embyFetch<EmbyItemsResponse>(`/Items?${params}`);

  const items = data.Items.map(normalizeEmbyItem).filter(
    (item): item is EmbyLibraryItem => item !== null
  );

  return {
    items,
    totalCount: data.TotalRecordCount,
  };
}

/**
 * Get all movies from Emby
 */
export async function getEmbyMovies(options: {
  startIndex?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "Ascending" | "Descending";
  searchTerm?: string;
  genres?: string[];
  years?: number[];
} = {}): Promise<{ items: EmbyLibraryItem[]; totalCount: number }> {
  const params = new URLSearchParams({
    IncludeItemTypes: "Movie",
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated,Studios,People",
    EnableImageTypes: "Primary,Backdrop",
    StartIndex: (options.startIndex ?? 0).toString(),
    Limit: (options.limit ?? 50).toString(),
    SortBy: options.sortBy ?? "SortName",
    SortOrder: options.sortOrder ?? "Ascending",
  });

  if (options.searchTerm) {
    params.set("SearchTerm", options.searchTerm);
  }

  if (options.genres?.length) {
    params.set("Genres", options.genres.join(","));
  }

  if (options.years?.length) {
    params.set("Years", options.years.join(","));
  }

  const data = await embyFetch<EmbyItemsResponse>(`/Items?${params}`);

  const items = data.Items.map(normalizeEmbyItem).filter(
    (item): item is EmbyLibraryItem => item !== null
  );

  return {
    items,
    totalCount: data.TotalRecordCount,
  };
}

/**
 * Get all TV shows from Emby
 */
export async function getEmbyTVShows(options: {
  startIndex?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "Ascending" | "Descending";
  searchTerm?: string;
  genres?: string[];
  years?: number[];
} = {}): Promise<{ items: EmbyLibraryItem[]; totalCount: number }> {
  const params = new URLSearchParams({
    IncludeItemTypes: "Series",
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated,Studios,People",
    EnableImageTypes: "Primary,Backdrop",
    StartIndex: (options.startIndex ?? 0).toString(),
    Limit: (options.limit ?? 50).toString(),
    SortBy: options.sortBy ?? "SortName",
    SortOrder: options.sortOrder ?? "Ascending",
  });

  if (options.searchTerm) {
    params.set("SearchTerm", options.searchTerm);
  }

  if (options.genres?.length) {
    params.set("Genres", options.genres.join(","));
  }

  if (options.years?.length) {
    params.set("Years", options.years.join(","));
  }

  const data = await embyFetch<EmbyItemsResponse>(`/Items?${params}`);

  const items = data.Items.map(normalizeEmbyItem).filter(
    (item): item is EmbyLibraryItem => item !== null
  );

  return {
    items,
    totalCount: data.TotalRecordCount,
  };
}

/**
 * Get all media (movies + TV shows) from Emby
 */
export async function getEmbyAllMedia(options: {
  startIndex?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "Ascending" | "Descending";
  searchTerm?: string;
  type?: "movie" | "tv";
  genres?: string[];
  years?: number[];
} = {}): Promise<{ items: EmbyLibraryItem[]; totalCount: number }> {
  const includeTypes = options.type === "movie"
    ? "Movie"
    : options.type === "tv"
      ? "Series"
      : "Movie,Series";

  const params = new URLSearchParams({
    IncludeItemTypes: includeTypes,
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated,Studios,People",
    EnableImageTypes: "Primary,Backdrop",
    StartIndex: (options.startIndex ?? 0).toString(),
    Limit: (options.limit ?? 50).toString(),
    SortBy: options.sortBy ?? "SortName",
    SortOrder: options.sortOrder ?? "Ascending",
  });

  if (options.searchTerm) {
    params.set("SearchTerm", options.searchTerm);
  }

  if (options.genres?.length) {
    params.set("Genres", options.genres.join(","));
  }

  if (options.years?.length) {
    params.set("Years", options.years.join(","));
  }

  const data = await embyFetch<EmbyItemsResponse>(`/Items?${params}`);

  const items = data.Items.map(normalizeEmbyItem).filter(
    (item): item is EmbyLibraryItem => item !== null
  );

  return {
    items,
    totalCount: data.TotalRecordCount,
  };
}

/**
 * Get recently added items from Emby
 */
export async function getEmbyRecentlyAdded(options: {
  limit?: number;
  type?: "movie" | "tv";
} = {}): Promise<EmbyLibraryItem[]> {
  const includeTypes = options.type === "movie"
    ? "Movie"
    : options.type === "tv"
      ? "Series"
      : "Movie,Series";

  const params = new URLSearchParams({
    IncludeItemTypes: includeTypes,
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated",
    EnableImageTypes: "Primary,Backdrop",
    Limit: (options.limit ?? 20).toString(),
    SortBy: "DateCreated",
    SortOrder: "Descending",
  });

  const data = await embyFetch<EmbyItemsResponse>(`/Items?${params}`);

  return data.Items.map(normalizeEmbyItem).filter(
    (item): item is EmbyLibraryItem => item !== null
  );
}

/**
 * Get a single item by ID
 */
export async function getEmbyItem(itemId: string): Promise<EmbyLibraryItem | null> {
  const data = await embyFetch<EmbyMediaItem>(`/Items/${itemId}?Fields=ProviderIds,Overview,Genres,MediaSources,DateCreated,Studios,People`);
  return normalizeEmbyItem(data);
}

/**
 * Get library statistics
 */
export async function getEmbyLibraryStats(): Promise<{
  movieCount: number;
  tvShowCount: number;
  episodeCount: number;
}> {
  const [movies, tvShows, episodes] = await Promise.all([
    embyFetch<EmbyItemsResponse>("/Items?IncludeItemTypes=Movie&Recursive=true&Limit=0"),
    embyFetch<EmbyItemsResponse>("/Items?IncludeItemTypes=Series&Recursive=true&Limit=0"),
    embyFetch<EmbyItemsResponse>("/Items?IncludeItemTypes=Episode&Recursive=true&Limit=0"),
  ]);

  return {
    movieCount: movies.TotalRecordCount,
    tvShowCount: tvShows.TotalRecordCount,
    episodeCount: episodes.TotalRecordCount,
  };
}

/**
 * Search for items in Emby
 */
export async function searchEmby(
  query: string,
  options: {
    limit?: number;
    type?: "movie" | "tv";
  } = {}
): Promise<EmbyLibraryItem[]> {
  const includeTypes = options.type === "movie"
    ? "Movie"
    : options.type === "tv"
      ? "Series"
      : "Movie,Series";

  const params = new URLSearchParams({
    SearchTerm: query,
    IncludeItemTypes: includeTypes,
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated",
    EnableImageTypes: "Primary,Backdrop",
    Limit: (options.limit ?? 20).toString(),
  });

  const data = await embyFetch<EmbyItemsResponse>(`/Items?${params}`);

  return data.Items.map(normalizeEmbyItem).filter(
    (item): item is EmbyLibraryItem => item !== null
  );
}

/**
 * Get all available genres from Emby
 */
export async function getEmbyGenres(type?: "movie" | "tv"): Promise<string[]> {
  const includeTypes = type === "movie"
    ? "Movie"
    : type === "tv"
      ? "Series"
      : "Movie,Series";

  const params = new URLSearchParams({
    IncludeItemTypes: includeTypes,
  });

  const data = await embyFetch<{ Items: Array<{ Name: string }> }>(`/Genres?${params}`);
  return data.Items.map((g) => g.Name).sort();
}

// =============================================================================
// Emby Sync with Custom Server Config
// =============================================================================

/**
 * Fetch all media from an Emby server using custom URL/API key
 * Used for syncing library items to a specific storage server
 * @param options.sinceDate - Only fetch items added/modified after this date (for incremental sync)
 */
export async function fetchEmbyLibraryForSync(
  serverUrl: string,
  apiKey: string,
  options: {
    type?: "movie" | "tv";
    batchSize?: number;
    sinceDate?: Date;
  } = {}
): Promise<EmbyLibraryItem[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const headers = {
    "X-Emby-Token": apiKey,
    "Content-Type": "application/json",
  };

  const includeTypes = options.type === "movie"
    ? "Movie"
    : options.type === "tv"
      ? "Series"
      : "Movie,Series";

  const batchSize = options.batchSize ?? 100;
  const allItems: EmbyLibraryItem[] = [];
  let startIndex = 0;
  let totalCount = 0;

  do {
    const params = new URLSearchParams({
      IncludeItemTypes: includeTypes,
      Recursive: "true",
      Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated",
      EnableImageTypes: "Primary,Backdrop",
      StartIndex: startIndex.toString(),
      Limit: batchSize.toString(),
      SortBy: "DateCreated",
      SortOrder: "Descending",
    });

    // For incremental sync, only get items added after the given date
    if (options.sinceDate) {
      params.set("MinDateCreated", options.sinceDate.toISOString());
    }

    const response = await fetch(`${baseUrl}/Items?${params}`, { headers });
    if (!response.ok) {
      throw new Error(`Emby API error (${response.status}): ${await response.text()}`);
    }

    const data = await response.json() as EmbyItemsResponse;
    totalCount = data.TotalRecordCount;

    // Normalize items with custom image URL builder
    for (const item of data.Items) {
      if (item.Type !== "Movie" && item.Type !== "Series") continue;

      const type = item.Type === "Movie" ? "movie" : "tv";
      const tmdbId = item.ProviderIds?.Tmdb ? parseInt(item.ProviderIds.Tmdb, 10) : undefined;

      // Skip items without TMDB ID - we need it for library tracking
      if (!tmdbId) continue;

      allItems.push({
        id: item.Id,
        embyId: item.Id,
        title: item.Name,
        type,
        year: item.ProductionYear,
        overview: item.Overview,
        tmdbId,
        imdbId: item.ProviderIds?.Imdb,
        tvdbId: item.ProviderIds?.Tvdb ? parseInt(item.ProviderIds.Tvdb, 10) : undefined,
        rating: item.CommunityRating,
        runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : undefined,
        genres: item.Genres || [],
        addedAt: item.DateCreated ? new Date(item.DateCreated) : undefined,
        posterUrl: item.ImageTags?.Primary
          ? `${baseUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=300`
          : undefined,
        backdropUrl: item.BackdropImageTags?.[0]
          ? `${baseUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=1280`
          : undefined,
        quality: extractQuality(item),
        fileSize: item.MediaSources?.[0]?.Size,
      });
    }

    startIndex += batchSize;
  } while (startIndex < totalCount);

  return allItems;
}

/**
 * Fetch paginated media from a custom Emby server
 * Used for browsing a specific storage server's library
 */
export async function fetchEmbyMediaPaginated(
  serverUrl: string,
  apiKey: string,
  options: {
    type?: "movie" | "tv";
    startIndex?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "Ascending" | "Descending";
    searchTerm?: string;
  } = {}
): Promise<{ items: EmbyLibraryItem[]; totalCount: number }> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const headers = {
    "X-Emby-Token": apiKey,
    "Content-Type": "application/json",
  };

  const includeTypes = options.type === "movie"
    ? "Movie"
    : options.type === "tv"
      ? "Series"
      : "Movie,Series";

  const params = new URLSearchParams({
    IncludeItemTypes: includeTypes,
    Recursive: "true",
    Fields: "ProviderIds,Overview,Genres,MediaSources,DateCreated",
    EnableImageTypes: "Primary,Backdrop",
    StartIndex: (options.startIndex ?? 0).toString(),
    Limit: (options.limit ?? 24).toString(),
    SortBy: options.sortBy ?? "SortName",
    SortOrder: options.sortOrder ?? "Ascending",
  });

  if (options.searchTerm) {
    params.set("SearchTerm", options.searchTerm);
  }

  const response = await fetch(`${baseUrl}/Items?${params}`, { headers });
  if (!response.ok) {
    throw new Error(`Emby API error (${response.status}): ${await response.text()}`);
  }

  const data = await response.json() as EmbyItemsResponse;

  const items: EmbyLibraryItem[] = [];
  for (const item of data.Items) {
    if (item.Type !== "Movie" && item.Type !== "Series") continue;

    const type = item.Type === "Movie" ? "movie" : "tv";
    const tmdbId = item.ProviderIds?.Tmdb ? parseInt(item.ProviderIds.Tmdb, 10) : undefined;

    items.push({
      id: item.Id,
      embyId: item.Id,
      title: item.Name,
      type,
      year: item.ProductionYear,
      overview: item.Overview,
      tmdbId,
      imdbId: item.ProviderIds?.Imdb,
      tvdbId: item.ProviderIds?.Tvdb ? parseInt(item.ProviderIds.Tvdb, 10) : undefined,
      rating: item.CommunityRating,
      runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : undefined,
      genres: item.Genres || [],
      addedAt: item.DateCreated ? new Date(item.DateCreated) : undefined,
      posterUrl: item.ImageTags?.Primary
        ? `${baseUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=300`
        : undefined,
      backdropUrl: item.BackdropImageTags?.[0]
        ? `${baseUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=1280`
        : undefined,
      quality: extractQuality(item),
      fileSize: item.MediaSources?.[0]?.Size,
    });
  }

  return {
    items,
    totalCount: data.TotalRecordCount,
  };
}

/**
 * Get library stats from a custom Emby server
 */
export async function fetchEmbyStats(
  serverUrl: string,
  apiKey: string
): Promise<{ movieCount: number; tvShowCount: number; episodeCount: number }> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const headers = {
    "X-Emby-Token": apiKey,
    "Content-Type": "application/json",
  };

  const fetchCount = async (types: string) => {
    const params = new URLSearchParams({
      IncludeItemTypes: types,
      Recursive: "true",
      Limit: "0",
    });
    const response = await fetch(`${baseUrl}/Items?${params}`, { headers });
    if (!response.ok) {
      throw new Error(`Emby API error (${response.status})`);
    }
    const data = await response.json() as EmbyItemsResponse;
    return data.TotalRecordCount;
  };

  const [movieCount, tvShowCount, episodeCount] = await Promise.all([
    fetchCount("Movie"),
    fetchCount("Series"),
    fetchCount("Episode"),
  ]);

  return { movieCount, tvShowCount, episodeCount };
}

/**
 * Test connection to an Emby server
 */
export async function testEmbyConnection(
  serverUrl: string,
  apiKey: string
): Promise<{ success: boolean; serverName?: string; error?: string }> {
  try {
    const baseUrl = serverUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/System/Info`, {
      headers: {
        "X-Emby-Token": apiKey,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json() as { ServerName?: string };
    return {
      success: true,
      serverName: data.ServerName,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Fetch all TV shows with their episodes from an Emby server
 * Returns shows grouped with all their episodes for efficient sync
 */
export interface EmbyShowWithEpisodes {
  tmdbId: number;
  title: string;
  episodes: Array<{
    season: number;
    episode: number;
    quality?: string;
    addedAt?: Date;
  }>;
}

/**
 * Fetch TV shows with their episodes from Emby
 * @param options.sinceDate - Only fetch episodes added after this date (for incremental sync)
 */
export async function fetchEmbyShowsWithEpisodes(
  serverUrl: string,
  apiKey: string,
  options: { batchSize?: number; sinceDate?: Date } = {}
): Promise<EmbyShowWithEpisodes[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const headers = {
    "X-Emby-Token": apiKey,
    "Content-Type": "application/json",
  };
  const batchSize = options.batchSize ?? 50;
  const results: EmbyShowWithEpisodes[] = [];

  // First, get all TV shows
  let startIndex = 0;
  let totalCount = 0;

  do {
    const showParams = new URLSearchParams({
      IncludeItemTypes: "Series",
      Recursive: "true",
      Fields: "ProviderIds",
      StartIndex: startIndex.toString(),
      Limit: batchSize.toString(),
    });

    const showResponse = await fetch(`${baseUrl}/Items?${showParams}`, { headers });
    if (!showResponse.ok) {
      throw new Error(`Emby API error (${showResponse.status}): ${await showResponse.text()}`);
    }

    const showData = await showResponse.json() as EmbyItemsResponse;
    totalCount = showData.TotalRecordCount;

    for (const show of showData.Items) {
      if (show.Type !== "Series") continue;

      const tmdbId = show.ProviderIds?.Tmdb ? parseInt(show.ProviderIds.Tmdb, 10) : undefined;
      if (!tmdbId) continue;

      // Fetch episodes for this show
      const episodes: Array<{
        season: number;
        episode: number;
        quality?: string;
        addedAt?: Date;
      }> = [];

      const episodeParams = new URLSearchParams({
        ParentId: show.Id,
        IncludeItemTypes: "Episode",
        Recursive: "true",
        Fields: "MediaSources",
        Limit: "1000", // Get all episodes at once
      });

      // For incremental sync, only get episodes added after the given date
      if (options.sinceDate) {
        episodeParams.set("MinDateCreated", options.sinceDate.toISOString());
      }

      try {
        const episodeResponse = await fetch(`${baseUrl}/Items?${episodeParams}`, { headers });
        if (!episodeResponse.ok) continue;

        const episodeData = await episodeResponse.json() as EmbyItemsResponse;

        for (const ep of episodeData.Items) {
          if (ep.Type !== "Episode") continue;
          if (ep.ParentIndexNumber === undefined || ep.IndexNumber === undefined) continue;

          episodes.push({
            season: ep.ParentIndexNumber,
            episode: ep.IndexNumber,
            quality: extractQuality(ep),
            addedAt: ep.DateCreated ? new Date(ep.DateCreated) : undefined,
          });
        }
      } catch {
        // Skip shows where we can't fetch episodes
        continue;
      }

      if (episodes.length > 0) {
        results.push({
          tmdbId,
          title: show.Name,
          episodes,
        });
      }
    }

    startIndex += batchSize;
  } while (startIndex < totalCount);

  return results;
}

// =============================================================================
// Watch History
// =============================================================================

export interface EmbyWatchedItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  playCount: number;
  lastPlayedAt?: Date;
}

/**
 * Fetch watched items from an Emby server for a user
 * Returns movies and TV shows that have been watched
 */
export async function fetchEmbyWatchedItems(
  serverUrl: string,
  apiKey: string,
  userId: string
): Promise<EmbyWatchedItem[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const watchedItems: EmbyWatchedItem[] = [];

  // Emby supports filtering by IsPlayed=true directly
  // Fetch watched movies
  const movieParams = new URLSearchParams({
    IncludeItemTypes: "Movie",
    IsPlayed: "true",
    Recursive: "true",
    Fields: "ProviderIds,UserData",
    StartIndex: "0",
    Limit: "1000", // Get all in one request for simplicity
  });

  try {
    const movieResponse = await fetch(
      `${baseUrl}/Users/${userId}/Items?${movieParams}`,
      {
        headers: {
          "X-Emby-Token": apiKey,
          Accept: "application/json",
        },
      }
    );

    if (movieResponse.ok) {
      const movieData = (await movieResponse.json()) as EmbyItemsResponse;

      for (const item of movieData.Items) {
        const tmdbId = item.ProviderIds?.Tmdb
          ? parseInt(item.ProviderIds.Tmdb, 10)
          : undefined;

        if (!tmdbId || isNaN(tmdbId)) continue;

        watchedItems.push({
          tmdbId,
          type: "movie",
          title: item.Name,
          playCount: item.UserData?.PlayCount ?? 1,
          lastPlayedAt: item.UserData?.LastPlayedDate
            ? new Date(item.UserData.LastPlayedDate)
            : undefined,
        });
      }
    }
  } catch (error) {
    console.error("[Emby] Error fetching watched movies:", error);
  }

  // Fetch watched TV shows (series level)
  const tvParams = new URLSearchParams({
    IncludeItemTypes: "Series",
    Recursive: "true",
    Fields: "ProviderIds,UserData",
    StartIndex: "0",
    Limit: "1000",
  });

  try {
    const tvResponse = await fetch(
      `${baseUrl}/Users/${userId}/Items?${tvParams}`,
      {
        headers: {
          "X-Emby-Token": apiKey,
          Accept: "application/json",
        },
      }
    );

    if (tvResponse.ok) {
      const tvData = (await tvResponse.json()) as EmbyItemsResponse;

      for (const item of tvData.Items) {
        // Only include shows that have been played
        if (!item.UserData?.Played && (item.UserData?.PlayCount ?? 0) === 0) {
          continue;
        }

        const tmdbId = item.ProviderIds?.Tmdb
          ? parseInt(item.ProviderIds.Tmdb, 10)
          : undefined;

        if (!tmdbId || isNaN(tmdbId)) continue;

        watchedItems.push({
          tmdbId,
          type: "tv",
          title: item.Name,
          playCount: item.UserData?.PlayCount ?? 1,
          lastPlayedAt: item.UserData?.LastPlayedDate
            ? new Date(item.UserData.LastPlayedDate)
            : undefined,
        });
      }
    }
  } catch (error) {
    console.error("[Emby] Error fetching watched TV shows:", error);
  }

  return watchedItems;
}
