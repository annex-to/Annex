/**
 * Plex Service
 *
 * Handles communication with Plex Media Server for library management.
 * Uses X-Plex-Token authentication.
 */

// =============================================================================
// Types
// =============================================================================

export interface PlexLibrary {
  key: string; // Section ID (e.g., "1", "2")
  title: string;
  type: "movie" | "show" | "artist" | "photo";
  agent: string;
  scanner: string;
  language: string;
  uuid: string;
  refreshing: boolean;
  createdAt: number;
  scannedAt: number;
  Location: Array<{ id: number; path: string }>;
}

export interface PlexMediaItem {
  ratingKey: string;
  key: string;
  guid: string;
  type: "movie" | "show" | "season" | "episode";
  title: string;
  titleSort?: string;
  originalTitle?: string;
  summary?: string;
  rating?: number;
  audienceRating?: number;
  year?: number;
  thumb?: string;
  art?: string;
  duration?: number; // milliseconds
  originallyAvailableAt?: string; // "YYYY-MM-DD"
  addedAt?: number; // Unix timestamp
  updatedAt?: number;
  // External IDs (via Guid entries)
  Guid?: Array<{ id: string }>; // e.g., "tmdb://12345", "imdb://tt1234567"
  // For TV shows
  childCount?: number; // Number of seasons
  leafCount?: number; // Number of episodes
  viewedLeafCount?: number;
  // For episodes
  parentRatingKey?: string; // Season key
  grandparentRatingKey?: string; // Show key
  grandparentTitle?: string; // Show title
  parentIndex?: number; // Season number
  index?: number; // Episode number
  // Media info
  Media?: Array<{
    id: number;
    duration?: number;
    bitrate?: number;
    width?: number;
    height?: number;
    aspectRatio?: number;
    audioChannels?: number;
    audioCodec?: string;
    videoCodec?: string;
    videoResolution?: string; // "1080", "4k", "720"
    container?: string;
    videoFrameRate?: string;
    Part?: Array<{
      id: number;
      key: string;
      duration?: number;
      file?: string;
      size?: number;
      container?: string;
    }>;
  }>;
  // Genres
  Genre?: Array<{ tag: string }>;
  // Directors/Writers
  Director?: Array<{ tag: string }>;
  Writer?: Array<{ tag: string }>;
  // Roles/Cast
  Role?: Array<{ tag: string; role?: string; thumb?: string }>;
  // Content rating
  contentRating?: string;
  // Studio
  studio?: string;
}

export interface PlexLibraryItem {
  id: string;
  plexKey: string;
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

interface PlexMediaContainer<T> {
  MediaContainer: {
    size: number;
    totalSize?: number;
    offset?: number;
    Metadata?: T[];
    Directory?: T[];
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse external IDs from Plex Guid entries
 */
function parseExternalIds(guids?: Array<{ id: string }>): {
  tmdbId?: number;
  imdbId?: string;
  tvdbId?: number;
} {
  const result: { tmdbId?: number; imdbId?: string; tvdbId?: number } = {};

  if (!guids) return result;

  for (const guid of guids) {
    const id = guid.id;
    if (id.startsWith("tmdb://")) {
      result.tmdbId = parseInt(id.replace("tmdb://", ""), 10);
    } else if (id.startsWith("imdb://")) {
      result.imdbId = id.replace("imdb://", "");
    } else if (id.startsWith("tvdb://")) {
      result.tvdbId = parseInt(id.replace("tvdb://", ""), 10);
    }
  }

  return result;
}

/**
 * Extract quality info from media
 */
function extractQuality(item: PlexMediaItem): string | undefined {
  const media = item.Media?.[0];
  if (!media) return undefined;

  const resolution = media.videoResolution;
  if (!resolution) return undefined;

  if (resolution === "4k" || resolution === "2160") return "4K";
  if (resolution === "1080") return "1080p";
  if (resolution === "720") return "720p";
  if (resolution === "480") return "480p";
  return `${resolution}p`;
}

/**
 * Build image URL for Plex
 */
function buildImageUrl(baseUrl: string, token: string, path?: string): string | undefined {
  if (!path) return undefined;
  return `${baseUrl}${path}?X-Plex-Token=${token}`;
}

/**
 * Convert Plex item to our normalized format
 */
function normalizePlexItem(
  item: PlexMediaItem,
  baseUrl: string,
  token: string
): PlexLibraryItem | null {
  // Only process movies and shows
  if (item.type !== "movie" && item.type !== "show") {
    return null;
  }

  const type = item.type === "movie" ? "movie" : "tv";
  const externalIds = parseExternalIds(item.Guid);

  return {
    id: item.ratingKey,
    plexKey: item.ratingKey,
    title: item.title,
    type,
    year: item.year,
    overview: item.summary,
    tmdbId: externalIds.tmdbId,
    imdbId: externalIds.imdbId,
    tvdbId: externalIds.tvdbId,
    rating: item.audienceRating ?? item.rating,
    runtime: item.duration ? Math.round(item.duration / 60000) : undefined,
    genres: item.Genre?.map((g) => g.tag) || [],
    addedAt: item.addedAt ? new Date(item.addedAt * 1000) : undefined,
    posterUrl: buildImageUrl(baseUrl, token, item.thumb),
    backdropUrl: buildImageUrl(baseUrl, token, item.art),
    quality: extractQuality(item),
    fileSize: item.Media?.[0]?.Part?.[0]?.size,
  };
}

// =============================================================================
// API Functions (with custom server config)
// =============================================================================

/**
 * Make a request to a Plex server
 */
async function plexFetch<T>(
  serverUrl: string,
  token: string,
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const url = `${baseUrl}${endpoint}`;

  // Add token as query parameter (Plex prefers this)
  const urlWithToken = url.includes("?")
    ? `${url}&X-Plex-Token=${token}`
    : `${url}?X-Plex-Token=${token}`;

  const response = await fetch(urlWithToken, {
    ...options,
    headers: {
      Accept: "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`Plex API error (${response.status}): ${errorText}`);
  }

  // Handle empty responses (e.g., from refresh/scan endpoints)
  const text = await response.text();
  if (!text || text.trim() === "") {
    return {} as T;
  }

  return JSON.parse(text) as T;
}

/**
 * Test connection to a Plex server
 */
export async function testPlexConnection(
  serverUrl: string,
  token: string
): Promise<{ success: boolean; serverName?: string; version?: string; error?: string }> {
  try {
    const baseUrl = serverUrl.replace(/\/$/, "");
    const data = await plexFetch<PlexMediaContainer<never>>(baseUrl, token, "/");

    // The root endpoint returns server info in MediaContainer attributes
    const container = data.MediaContainer as unknown as {
      friendlyName?: string;
      version?: string;
    };

    return {
      success: true,
      serverName: container.friendlyName,
      version: container.version,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get all libraries from a Plex server
 */
export async function getPlexLibraries(serverUrl: string, token: string): Promise<PlexLibrary[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const data = await plexFetch<PlexMediaContainer<PlexLibrary>>(
    baseUrl,
    token,
    "/library/sections"
  );

  return data.MediaContainer.Directory || [];
}

/**
 * Get library contents from a Plex server
 */
export async function getPlexLibraryContents(
  serverUrl: string,
  token: string,
  sectionId: string,
  options: {
    type?: "movie" | "show";
    startIndex?: number;
    limit?: number;
    sort?: string;
  } = {}
): Promise<{ items: PlexLibraryItem[]; totalCount: number }> {
  const baseUrl = serverUrl.replace(/\/$/, "");

  // Build query params
  const params = new URLSearchParams();
  if (options.startIndex !== undefined) {
    params.set("X-Plex-Container-Start", options.startIndex.toString());
  }
  if (options.limit !== undefined) {
    params.set("X-Plex-Container-Size", options.limit.toString());
  }
  if (options.sort) {
    params.set("sort", options.sort);
  }
  // Request external IDs
  params.set("includeGuids", "1");

  const queryString = params.toString();
  const endpoint = `/library/sections/${sectionId}/all${queryString ? `?${queryString}` : ""}`;

  const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(baseUrl, token, endpoint);

  const items = (data.MediaContainer.Metadata || [])
    .map((item) => normalizePlexItem(item, baseUrl, token))
    .filter((item): item is PlexLibraryItem => item !== null);

  return {
    items,
    totalCount: data.MediaContainer.totalSize ?? data.MediaContainer.size,
  };
}

/**
 * Fetch all media from a Plex server for library sync
 * @param options.sinceDate - Only fetch items added after this date (for incremental sync)
 */
export async function fetchPlexLibraryForSync(
  serverUrl: string,
  token: string,
  options: {
    type?: "movie" | "tv";
    batchSize?: number;
    sinceDate?: Date;
  } = {}
): Promise<PlexLibraryItem[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const batchSize = options.batchSize ?? 100;
  const allItems: PlexLibraryItem[] = [];

  // First, get all libraries
  const libraries = await getPlexLibraries(serverUrl, token);

  // Filter libraries by type if specified
  const targetLibraries = libraries.filter((lib) => {
    if (!options.type) return lib.type === "movie" || lib.type === "show";
    if (options.type === "movie") return lib.type === "movie";
    if (options.type === "tv") return lib.type === "show";
    return false;
  });

  // Fetch items from each library
  for (const library of targetLibraries) {
    let startIndex = 0;
    let totalCount = 0;

    do {
      const params = new URLSearchParams({
        "X-Plex-Container-Start": startIndex.toString(),
        "X-Plex-Container-Size": batchSize.toString(),
        includeGuids: "1",
      });

      // For incremental sync, only get items added after the given date
      // Plex uses Unix timestamps in seconds
      if (options.sinceDate) {
        const timestamp = Math.floor(options.sinceDate.getTime() / 1000);
        params.set("addedAt>", timestamp.toString());
      }

      const endpoint = `/library/sections/${library.key}/all?${params}`;
      const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(baseUrl, token, endpoint);

      totalCount = data.MediaContainer.totalSize ?? data.MediaContainer.size;

      for (const item of data.MediaContainer.Metadata || []) {
        const normalized = normalizePlexItem(item, baseUrl, token);
        // Only include items with TMDB ID for library tracking
        if (normalized?.tmdbId) {
          allItems.push(normalized);
        }
      }

      startIndex += batchSize;
    } while (startIndex < totalCount);
  }

  return allItems;
}

/**
 * Fetch paginated media from a Plex server
 */
export async function fetchPlexMediaPaginated(
  serverUrl: string,
  token: string,
  options: {
    type?: "movie" | "tv";
    startIndex?: number;
    limit?: number;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    searchTerm?: string;
  } = {}
): Promise<{ items: PlexLibraryItem[]; totalCount: number }> {
  const baseUrl = serverUrl.replace(/\/$/, "");

  // First, get all libraries
  const libraries = await getPlexLibraries(serverUrl, token);

  // Filter libraries by type if specified
  const targetLibraries = libraries.filter((lib) => {
    if (!options.type) return lib.type === "movie" || lib.type === "show";
    if (options.type === "movie") return lib.type === "movie";
    if (options.type === "tv") return lib.type === "show";
    return false;
  });

  if (targetLibraries.length === 0) {
    return { items: [], totalCount: 0 };
  }

  // For now, use the first matching library
  // TODO: Aggregate across multiple libraries if needed
  const library = targetLibraries[0];

  // Map sort options to Plex format
  const sortMap: Record<string, string> = {
    SortName: "titleSort",
    DateCreated: "addedAt",
    PremiereDate: "originallyAvailableAt",
    CommunityRating: "audienceRating",
  };

  const sortField = sortMap[options.sortBy ?? "SortName"] || "titleSort";
  const sortDirection = options.sortOrder === "desc" ? ":desc" : "";

  const params = new URLSearchParams({
    "X-Plex-Container-Start": (options.startIndex ?? 0).toString(),
    "X-Plex-Container-Size": (options.limit ?? 24).toString(),
    sort: `${sortField}${sortDirection}`,
    includeGuids: "1",
  });

  // Add search if provided
  if (options.searchTerm) {
    // Use Plex hub search for better results
    const searchParams = new URLSearchParams({
      query: options.searchTerm,
      limit: (options.limit ?? 24).toString(),
      includeGuids: "1",
    });

    const searchType = options.type === "tv" ? 2 : options.type === "movie" ? 1 : undefined;
    if (searchType) {
      searchParams.set("type", searchType.toString());
    }

    const searchEndpoint = `/hubs/search?${searchParams}`;

    try {
      interface SearchHub {
        type: string;
        Metadata?: PlexMediaItem[];
      }

      const searchData = await plexFetch<{ MediaContainer: { Hub?: SearchHub[] } }>(
        baseUrl,
        token,
        searchEndpoint
      );

      const allResults: PlexLibraryItem[] = [];
      for (const hub of searchData.MediaContainer.Hub || []) {
        if (hub.type === "movie" || hub.type === "show") {
          for (const item of hub.Metadata || []) {
            const normalized = normalizePlexItem(item, baseUrl, token);
            if (normalized) {
              allResults.push(normalized);
            }
          }
        }
      }

      return {
        items: allResults,
        totalCount: allResults.length,
      };
    } catch {
      // Fall back to regular library browse if search fails
    }
  }

  const endpoint = `/library/sections/${library.key}/all?${params}`;
  const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(baseUrl, token, endpoint);

  const items = (data.MediaContainer.Metadata || [])
    .map((item) => normalizePlexItem(item, baseUrl, token))
    .filter((item): item is PlexLibraryItem => item !== null);

  return {
    items,
    totalCount: data.MediaContainer.totalSize ?? data.MediaContainer.size,
  };
}

/**
 * Get library stats from a Plex server
 */
export async function fetchPlexStats(
  serverUrl: string,
  token: string
): Promise<{ movieCount: number; tvShowCount: number; episodeCount: number }> {
  const baseUrl = serverUrl.replace(/\/$/, "");

  // Get all libraries
  const libraries = await getPlexLibraries(serverUrl, token);

  let movieCount = 0;
  let tvShowCount = 0;
  let episodeCount = 0;

  for (const library of libraries) {
    if (library.type === "movie") {
      // Get movie count
      const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(
        baseUrl,
        token,
        `/library/sections/${library.key}/all?X-Plex-Container-Size=0`
      );
      movieCount += data.MediaContainer.totalSize ?? data.MediaContainer.size;
    } else if (library.type === "show") {
      // Get show count and episode count
      const showData = await plexFetch<PlexMediaContainer<PlexMediaItem>>(
        baseUrl,
        token,
        `/library/sections/${library.key}/all?X-Plex-Container-Size=0`
      );
      tvShowCount += showData.MediaContainer.totalSize ?? showData.MediaContainer.size;

      // Get episode count - use type=4 for episodes
      const episodeData = await plexFetch<PlexMediaContainer<PlexMediaItem>>(
        baseUrl,
        token,
        `/library/sections/${library.key}/all?type=4&X-Plex-Container-Size=0`
      );
      episodeCount += episodeData.MediaContainer.totalSize ?? episodeData.MediaContainer.size;
    }
  }

  return { movieCount, tvShowCount, episodeCount };
}

/**
 * Trigger a library scan
 */
export async function triggerPlexLibraryScan(
  serverUrl: string,
  token: string,
  sectionId: string
): Promise<void> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  await plexFetch(baseUrl, token, `/library/sections/${sectionId}/refresh`, {
    method: "GET",
  });
}

/**
 * Trigger a scan of a specific path
 */
export async function triggerPlexPathScan(
  serverUrl: string,
  token: string,
  sectionId: string,
  path: string
): Promise<void> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const encodedPath = encodeURIComponent(path);
  await plexFetch(baseUrl, token, `/library/sections/${sectionId}/refresh?path=${encodedPath}`, {
    method: "GET",
  });
}

/**
 * Find an item by TMDB ID
 */
export async function findPlexItemByTmdbId(
  serverUrl: string,
  token: string,
  tmdbId: number,
  type: "movie" | "tv"
): Promise<PlexLibraryItem | null> {
  const baseUrl = serverUrl.replace(/\/$/, "");

  // Get libraries of the appropriate type
  const libraries = await getPlexLibraries(serverUrl, token);
  const targetLibraries = libraries.filter((lib) => {
    if (type === "movie") return lib.type === "movie";
    if (type === "tv") return lib.type === "show";
    return false;
  });

  // Search using the GUID
  const guid = `tmdb://${tmdbId}`;

  for (const library of targetLibraries) {
    // Use the guid filter
    const params = new URLSearchParams({
      guid,
      includeGuids: "1",
    });

    try {
      const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(
        baseUrl,
        token,
        `/library/sections/${library.key}/all?${params}`
      );

      const items = data.MediaContainer.Metadata || [];
      if (items.length > 0) {
        const normalized = normalizePlexItem(items[0], baseUrl, token);
        if (normalized) {
          return normalized;
        }
      }
    } catch {
      // Continue to next library
    }
  }

  return null;
}

/**
 * Fetch all episodes from a Plex server for library sync
 * Returns episode-level data with TMDB IDs and season/episode numbers
 */
export interface PlexEpisodeItem {
  tmdbId: number;
  season: number;
  episode: number;
  quality?: string;
  addedAt?: Date;
}

export async function fetchPlexEpisodesForSync(
  serverUrl: string,
  token: string,
  options: { batchSize?: number } = {}
): Promise<PlexEpisodeItem[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const batchSize = options.batchSize ?? 100;
  const allEpisodes: PlexEpisodeItem[] = [];

  // Get all TV libraries
  const libraries = await getPlexLibraries(serverUrl, token);
  const tvLibraries = libraries.filter((lib) => lib.type === "show");

  for (const library of tvLibraries) {
    let startIndex = 0;
    let totalCount = 0;

    do {
      const params = new URLSearchParams({
        type: "4", // Episodes
        "X-Plex-Container-Start": startIndex.toString(),
        "X-Plex-Container-Size": batchSize.toString(),
        includeGuids: "1",
      });

      const endpoint = `/library/sections/${library.key}/all?${params}`;
      const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(baseUrl, token, endpoint);

      totalCount = data.MediaContainer.totalSize ?? data.MediaContainer.size;

      for (const item of data.MediaContainer.Metadata || []) {
        if (item.type !== "episode") continue;

        // Episodes don't always have their own TMDB IDs, but they have
        // grandparentRatingKey which links to the show
        // We need to get the show's TMDB ID
        const externalIds = parseExternalIds(item.Guid);
        const seasonNum = item.parentIndex;
        const episodeNum = item.index;

        // Skip if missing essential info
        if (seasonNum === undefined || episodeNum === undefined) continue;

        // For now, we'll store the show's grandparentRatingKey and resolve TMDB later
        // Actually, we need to fetch the show's TMDB ID separately
        // Let's get the TMDB ID from the episode's guids if available
        if (externalIds.tmdbId) {
          // This is the episode's TMDB ID, but we need the show's TMDB ID
          // We'll need to handle this differently
        }

        // Skip episodes without show context for now
        // We'll add proper show->TMDB mapping in a follow-up
        if (!item.grandparentRatingKey) continue;

        allEpisodes.push({
          tmdbId: 0, // Placeholder - will be resolved via show lookup
          season: seasonNum,
          episode: episodeNum,
          quality: extractQuality(item),
          addedAt: item.addedAt ? new Date(item.addedAt * 1000) : undefined,
        });
      }

      startIndex += batchSize;
    } while (startIndex < totalCount);
  }

  return allEpisodes;
}

/**
 * Fetch all TV shows with their episodes from a Plex server
 * This returns shows grouped with all their episodes for efficient sync
 */
export interface PlexShowWithEpisodes {
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
 * Fetch TV shows with their episodes from Plex
 * @param options.sinceDate - Only fetch episodes added after this date (for incremental sync)
 */
export async function fetchPlexShowsWithEpisodes(
  serverUrl: string,
  token: string,
  options: { batchSize?: number; sinceDate?: Date } = {}
): Promise<PlexShowWithEpisodes[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const batchSize = options.batchSize ?? 50;
  const results: PlexShowWithEpisodes[] = [];
  const sinceDateTimestamp = options.sinceDate
    ? Math.floor(options.sinceDate.getTime() / 1000)
    : undefined;

  // Get all TV libraries
  const libraries = await getPlexLibraries(serverUrl, token);
  const tvLibraries = libraries.filter((lib) => lib.type === "show");

  for (const library of tvLibraries) {
    // First, get all shows
    let showStartIndex = 0;
    let showTotalCount = 0;

    do {
      const showParams = new URLSearchParams({
        "X-Plex-Container-Start": showStartIndex.toString(),
        "X-Plex-Container-Size": batchSize.toString(),
        includeGuids: "1",
      });

      const showEndpoint = `/library/sections/${library.key}/all?${showParams}`;
      const showData = await plexFetch<PlexMediaContainer<PlexMediaItem>>(
        baseUrl,
        token,
        showEndpoint
      );

      showTotalCount = showData.MediaContainer.totalSize ?? showData.MediaContainer.size;

      for (const show of showData.MediaContainer.Metadata || []) {
        if (show.type !== "show") continue;

        const externalIds = parseExternalIds(show.Guid);
        if (!externalIds.tmdbId) continue;

        // Fetch episodes for this show
        const episodes: Array<{
          season: number;
          episode: number;
          quality?: string;
          addedAt?: Date;
        }> = [];

        // Get episodes via the show's key
        const episodesEndpoint = `/library/metadata/${show.ratingKey}/allLeaves?includeGuids=1`;
        try {
          const episodeData = await plexFetch<PlexMediaContainer<PlexMediaItem>>(
            baseUrl,
            token,
            episodesEndpoint
          );

          for (const ep of episodeData.MediaContainer.Metadata || []) {
            if (ep.parentIndex === undefined || ep.index === undefined) continue;

            // For incremental sync, skip episodes added before the sinceDate
            if (sinceDateTimestamp && ep.addedAt && ep.addedAt < sinceDateTimestamp) continue;

            episodes.push({
              season: ep.parentIndex,
              episode: ep.index,
              quality: extractQuality(ep),
              addedAt: ep.addedAt ? new Date(ep.addedAt * 1000) : undefined,
            });
          }
        } catch {
          // Skip shows where we can't fetch episodes
          continue;
        }

        if (episodes.length > 0) {
          results.push({
            tmdbId: externalIds.tmdbId,
            title: show.title,
            episodes,
          });
        }
      }

      showStartIndex += batchSize;
    } while (showStartIndex < showTotalCount);
  }

  return results;
}

// =============================================================================
// Watch History
// =============================================================================

export interface PlexWatchedItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  viewCount: number;
  lastViewedAt?: Date;
}

/**
 * Fetch watched items from a Plex server for a user
 * Returns movies and TV shows that have been watched
 */
export async function fetchPlexWatchedItems(
  serverUrl: string,
  token: string
): Promise<PlexWatchedItem[]> {
  const baseUrl = serverUrl.replace(/\/$/, "");
  const watchedItems: PlexWatchedItem[] = [];

  // Get all libraries
  const libraries = await getPlexLibraries(serverUrl, token);

  // Filter to movie and show libraries
  const targetLibraries = libraries.filter((lib) => lib.type === "movie" || lib.type === "show");

  for (const library of targetLibraries) {
    const isMovieLibrary = library.type === "movie";

    // Fetch items - Plex doesn't have a direct "watched only" filter via API params
    // We need to fetch all and filter by viewCount > 0 or viewedLeafCount > 0
    let startIndex = 0;
    const batchSize = 100;
    let totalCount = 0;

    do {
      const params = new URLSearchParams({
        "X-Plex-Container-Start": startIndex.toString(),
        "X-Plex-Container-Size": batchSize.toString(),
        includeGuids: "1",
      });

      // For shows, we can filter to ones with viewed episodes
      // unwatched=0 means "hide unwatched" but this might not work on all Plex versions
      if (!isMovieLibrary) {
        params.set("unwatched", "0");
      }

      const endpoint = `/library/sections/${library.key}/all?${params}`;

      try {
        const data = await plexFetch<PlexMediaContainer<PlexMediaItem>>(baseUrl, token, endpoint);

        totalCount = data.MediaContainer.totalSize ?? data.MediaContainer.size;
        const items = data.MediaContainer.Metadata || [];

        for (const item of items) {
          // For movies: check viewCount (lastViewedAt might also be available)
          // For shows: check viewedLeafCount (number of watched episodes)
          const itemWithViewCount = item as PlexMediaItem & { viewCount?: number };
          const isWatched = isMovieLibrary
            ? itemWithViewCount.viewCount !== undefined && itemWithViewCount.viewCount > 0
            : (item.viewedLeafCount ?? 0) > 0;

          if (!isWatched) continue;

          // Parse external IDs
          const externalIds = parseExternalIds(item.Guid);
          if (!externalIds.tmdbId) continue;

          // Get view count
          const viewCount = isMovieLibrary
            ? ((item as PlexMediaItem & { viewCount?: number }).viewCount ?? 1)
            : (item.viewedLeafCount ?? 1);

          // Get last viewed timestamp if available
          const lastViewedAtRaw = (item as PlexMediaItem & { lastViewedAt?: number }).lastViewedAt;
          const lastViewedAt = lastViewedAtRaw ? new Date(lastViewedAtRaw * 1000) : undefined;

          watchedItems.push({
            tmdbId: externalIds.tmdbId,
            type: isMovieLibrary ? "movie" : "tv",
            title: item.title,
            viewCount,
            lastViewedAt,
          });
        }

        startIndex += batchSize;
      } catch (error) {
        console.error(`[Plex] Error fetching watched items from library ${library.title}:`, error);
        break;
      }
    } while (startIndex < totalCount);
  }

  return watchedItems;
}

/**
 * Check if a Plex user has access to a server
 * Returns true if the user is the owner or has been granted access
 */
export async function checkPlexServerAccess(
  serverUrl: string,
  serverToken: string,
  plexUserId: string
): Promise<boolean> {
  try {
    console.log(`[Plex] Checking access for user ${plexUserId} to server ${serverUrl}`);

    // First, get the server's machine identifier and owner
    const identity = await plexFetch<{
      MediaContainer: {
        machineIdentifier: string;
        myPlexUsername?: string;
        ownerId?: string;
      };
    }>(serverUrl, serverToken, "/identity");

    const machineId = identity.MediaContainer.machineIdentifier;
    console.log(`[Plex] Server machine ID: ${machineId}`);

    // Get the owner's Plex account info to compare
    const accountResponse = await fetch("https://plex.tv/users/account", {
      headers: {
        "X-Plex-Token": serverToken,
        Accept: "application/json",
      },
    });

    console.log(`[Plex] Account API response status: ${accountResponse.status}`);

    if (!accountResponse.ok) {
      const errorText = await accountResponse.text();
      console.error(`[Plex] Failed to get server owner info: ${accountResponse.status}`, errorText);
      throw new Error(`Failed to get server owner info: ${accountResponse.status}`);
    }

    const responseText = await accountResponse.text();
    console.log(`[Plex] Account API response:`, responseText.substring(0, 200));

    let accountData: { user: { id: number; username: string } };
    try {
      accountData = JSON.parse(responseText) as { user: { id: number; username: string } };
    } catch (error) {
      console.error(`[Plex] Failed to parse account response as JSON:`, error);
      throw new Error(`Failed to parse Plex account response`);
    }

    const ownerId = accountData.user.id.toString();
    console.log(`[Plex] Server owner ID: ${ownerId}, username: ${accountData.user.username}`);
    console.log(`[Plex] Checking user ID: ${plexUserId}`);

    // Check if the user is the server owner
    if (plexUserId === ownerId) {
      console.log(`[Plex] User ${plexUserId} is the server owner - access granted`);
      return true;
    }

    // Get shared users for this server from plex.tv
    const sharedResponse = await fetch(`https://plex.tv/api/servers/${machineId}/shared_servers`, {
      headers: {
        "X-Plex-Token": serverToken,
        Accept: "application/json",
      },
    });

    if (!sharedResponse.ok) {
      // If we can't get shared users, only allow owner
      console.warn(
        `[Plex] Failed to get shared users for server ${machineId}: ${sharedResponse.status}`
      );
      return false;
    }

    const sharedData = (await sharedResponse.json()) as {
      SharedServer?: Array<{ userID: number; username: string; accessToken: string }>;
    };

    console.log(
      `[Plex] Shared users:`,
      sharedData.SharedServer?.map((u) => ({ id: u.userID, username: u.username })) || []
    );

    // Check if the user is in the shared users list
    if (sharedData.SharedServer) {
      const hasAccess = sharedData.SharedServer.some(
        (user) => user.userID.toString() === plexUserId
      );
      console.log(
        `[Plex] User ${plexUserId} ${hasAccess ? "found" : "not found"} in shared users list`
      );
      return hasAccess;
    }

    console.log(`[Plex] No shared users found for server ${machineId} - access denied`);
    return false;
  } catch (error) {
    console.error(`[Plex] Error checking server access:`, error);
    return false;
  }
}
