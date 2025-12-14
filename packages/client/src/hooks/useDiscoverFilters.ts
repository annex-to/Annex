import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams, useLocation } from "react-router-dom";

// TMDB Genre IDs
export const MOVIE_GENRES = [
  { id: 28, name: "Action" },
  { id: 12, name: "Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 14, name: "Fantasy" },
  { id: 36, name: "History" },
  { id: 27, name: "Horror" },
  { id: 10402, name: "Music" },
  { id: 9648, name: "Mystery" },
  { id: 10749, name: "Romance" },
  { id: 878, name: "Sci-Fi" },
  { id: 10770, name: "TV Movie" },
  { id: 53, name: "Thriller" },
  { id: 10752, name: "War" },
  { id: 37, name: "Western" },
] as const;

export const TV_GENRES = [
  { id: 10759, name: "Action & Adventure" },
  { id: 16, name: "Animation" },
  { id: 35, name: "Comedy" },
  { id: 80, name: "Crime" },
  { id: 99, name: "Documentary" },
  { id: 18, name: "Drama" },
  { id: 10751, name: "Family" },
  { id: 10762, name: "Kids" },
  { id: 9648, name: "Mystery" },
  { id: 10763, name: "News" },
  { id: 10764, name: "Reality" },
  { id: 10765, name: "Sci-Fi & Fantasy" },
  { id: 10766, name: "Soap" },
  { id: 10767, name: "Talk" },
  { id: 10768, name: "War & Politics" },
  { id: 37, name: "Western" },
] as const;

export const SORT_OPTIONS = [
  { value: "primary_release_date.desc", label: "Newest" },
  { value: "primary_release_date.asc", label: "Oldest" },
  { value: "popularity.desc", label: "Most Popular" },
  { value: "popularity.asc", label: "Least Popular" },
  { value: "vote_average.desc", label: "Highest Rated" },
  { value: "vote_average.asc", label: "Lowest Rated" },
  { value: "title.asc", label: "Title A-Z" },
  { value: "title.desc", label: "Title Z-A" },
] as const;

// Common languages for filtering (ISO 639-1 codes)
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "hi", name: "Hindi" },
  { code: "ru", name: "Russian" },
  { code: "ar", name: "Arabic" },
  { code: "th", name: "Thai" },
  { code: "tr", name: "Turkish" },
  { code: "pl", name: "Polish" },
  { code: "nl", name: "Dutch" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "no", name: "Norwegian" },
  { code: "fi", name: "Finnish" },
  { code: "ta", name: "Tamil" },
  { code: "te", name: "Telugu" },
  { code: "ml", name: "Malayalam" },
  { code: "id", name: "Indonesian" },
] as const;

export type LanguageCode = typeof LANGUAGES[number]["code"] | null;

// Rating sources with their unique ranges and display info
export const RATING_SOURCES = [
  {
    id: "imdb",
    name: "IMDb",
    field: "imdbScore",
    min: 0,
    max: 10,
    step: 0.5,
    format: (v: number) => v.toFixed(1),
    color: "bg-yellow-500/20 text-yellow-400",
  },
  {
    id: "tmdb",
    name: "TMDB",
    field: "tmdbScore",
    min: 0,
    max: 10,
    step: 0.5,
    format: (v: number) => v.toFixed(1),
    color: "bg-sky-500/20 text-sky-400",
  },
  {
    id: "rt_critic",
    name: "RT Critics",
    field: "rtCriticScore",
    min: 0,
    max: 100,
    step: 5,
    format: (v: number) => `${v}%`,
    color: "bg-red-500/20 text-red-400",
  },
  {
    id: "rt_audience",
    name: "RT Audience",
    field: "rtAudienceScore",
    min: 0,
    max: 100,
    step: 5,
    format: (v: number) => `${v}%`,
    color: "bg-red-500/20 text-red-300",
  },
  {
    id: "metacritic",
    name: "Metacritic",
    field: "metacriticScore",
    min: 0,
    max: 100,
    step: 5,
    format: (v: number) => `${v}`,
    color: "bg-green-500/20 text-green-400",
  },
  {
    id: "trakt",
    name: "Trakt",
    field: "traktScore",
    min: 0,
    max: 100,
    step: 5,
    format: (v: number) => `${v}%`,
    color: "bg-rose-500/20 text-rose-400",
  },
  {
    id: "letterboxd",
    name: "Letterboxd",
    field: "letterboxdScore",
    min: 0,
    max: 100,
    step: 5,
    format: (v: number) => `${v}%`,
    color: "bg-orange-500/20 text-orange-400",
  },
  {
    id: "mdblist",
    name: "MDBList",
    field: "mdblistScore",
    min: 0,
    max: 100,
    step: 5,
    format: (v: number) => `${v}`,
    color: "bg-purple-500/20 text-purple-400",
  },
] as const;

export type RatingSourceId = typeof RATING_SOURCES[number]["id"];

// Get presets for a rating source based on its range
export function getRatingPresets(sourceId: RatingSourceId) {
  const source = RATING_SOURCES.find((s) => s.id === sourceId);
  if (!source) return [];

  if (source.max === 10) {
    // 0-10 scale (IMDb, TMDB)
    return [
      { value: 0, label: "Any" },
      { value: 5, label: "5+" },
      { value: 6, label: "6+" },
      { value: 7, label: "7+" },
      { value: 8, label: "8+" },
      { value: 9, label: "9+" },
    ];
  } else {
    // 0-100 scale (RT, Metacritic, Trakt, Letterboxd, MDBList)
    return [
      { value: 0, label: "Any" },
      { value: 50, label: "50+" },
      { value: 60, label: "60+" },
      { value: 70, label: "70+" },
      { value: 80, label: "80+" },
      { value: 90, label: "90+" },
    ];
  }
}

// Year range options (from current year back to 1900)
const currentYear = new Date().getFullYear();
export const YEAR_OPTIONS = Array.from(
  { length: currentYear - 1899 },
  (_, i) => currentYear - i
);

export interface RatingRange {
  min: number;
  max: number;
}

// Map of source ID to its min/max range
export type RatingFilters = Partial<Record<RatingSourceId, RatingRange>>;

// Legacy single filter type (for backwards compat during migration)
export interface RatingFilter {
  source: RatingSourceId;
  minValue: number;
}

export interface DiscoverFilters {
  type: "movie" | "tv";
  query: string;
  genres: number[];
  yearFrom: number | null;
  yearTo: number | null;
  ratingFilters: RatingFilters;
  language: string | null;
  releasedOnly: boolean;
  hideUnrated: boolean;
  sortBy: string;
  // Legacy - kept for backwards compatibility
  ratingFilter?: RatingFilter | null;
}

export const DEFAULT_SORT = "primary_release_date.desc";
export const DEFAULT_LANGUAGE = "en"; // Default to English

const DEFAULT_FILTERS: DiscoverFilters = {
  type: "movie",
  query: "",
  genres: [],
  yearFrom: null,
  yearTo: null,
  ratingFilters: {},
  language: DEFAULT_LANGUAGE,
  releasedOnly: false,
  hideUnrated: true, // On by default - hide media with no ratings
  sortBy: DEFAULT_SORT,
};

// Helper to check if a rating filter is actually filtering (not at defaults)
export function isRatingFilterActive(
  sourceId: RatingSourceId,
  range: RatingRange | undefined
): boolean {
  if (!range) return false;
  const source = RATING_SOURCES.find((s) => s.id === sourceId);
  if (!source) return false;
  return range.min > source.min || range.max < source.max;
}

// Helper to count active rating filters
export function countActiveRatingFilters(filters: RatingFilters): number {
  return Object.entries(filters).filter(([sourceId, range]) =>
    isRatingFilterActive(sourceId as RatingSourceId, range)
  ).length;
}

// Serialize rating filters to URL-safe string
// Format: "imdb:5-10,rt_critic:70-100"
function serializeRatingFilters(filters: RatingFilters): string {
  const parts: string[] = [];
  for (const [sourceId, range] of Object.entries(filters)) {
    if (range && isRatingFilterActive(sourceId as RatingSourceId, range)) {
      parts.push(`${sourceId}:${range.min}-${range.max}`);
    }
  }
  return parts.join(",");
}

// Parse rating filters from URL string
function parseRatingFilters(str: string | null): RatingFilters {
  if (!str) return {};
  const filters: RatingFilters = {};
  const parts = str.split(",");
  for (const part of parts) {
    const match = part.match(/^(\w+):(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
    if (match) {
      const [, sourceId, minStr, maxStr] = match;
      const source = RATING_SOURCES.find((s) => s.id === sourceId);
      if (source) {
        filters[sourceId as RatingSourceId] = {
          min: parseFloat(minStr),
          max: parseFloat(maxStr),
        };
      }
    }
  }
  return filters;
}

// Session storage key for scroll positions
const SCROLL_STORAGE_KEY = "discover-scroll-positions";

function getScrollPositions(): Record<string, number> {
  try {
    const stored = sessionStorage.getItem(SCROLL_STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveScrollPosition(key: string, position: number): void {
  try {
    const positions = getScrollPositions();
    positions[key] = position;
    sessionStorage.setItem(SCROLL_STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // Ignore storage errors
  }
}

export function useDiscoverFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const isInitialMount = useRef(true);
  const hasRestoredScroll = useRef(false);

  // Parse filters from URL
  const filters = useMemo<DiscoverFilters>(() => {
    const type = searchParams.get("type");
    const query = searchParams.get("q") || "";
    const genresParam = searchParams.get("genres");
    const yearFrom = searchParams.get("yearFrom");
    const yearTo = searchParams.get("yearTo");
    const sortBy = searchParams.get("sort");

    // Parse new rating filters format
    const ratingsParam = searchParams.get("ratings");
    const ratingFilters = parseRatingFilters(ratingsParam);

    // Also check for legacy format and migrate
    const legacySource = searchParams.get("ratingSource") as RatingSourceId | null;
    const legacyMin = searchParams.get("ratingMin");
    if (legacySource && legacyMin && Object.keys(ratingFilters).length === 0) {
      const source = RATING_SOURCES.find((s) => s.id === legacySource);
      if (source) {
        const minValue = parseFloat(legacyMin);
        if (!isNaN(minValue) && minValue > 0) {
          ratingFilters[legacySource] = { min: minValue, max: source.max };
        }
      }
    }

    // Language filter - defaults to English, "any" = all languages
    const langParam = searchParams.get("lang");
    const language = langParam === "any" ? null : (langParam || DEFAULT_LANGUAGE);

    // Released only filter
    const releasedOnly = searchParams.get("released") === "1";

    // Hide unrated filter - defaults to true (on), "0" turns it off
    const hideUnratedParam = searchParams.get("hideUnrated");
    const hideUnrated = hideUnratedParam === null ? true : hideUnratedParam !== "0";

    return {
      type: type === "tv" ? "tv" : "movie",
      query,
      genres: genresParam
        ? genresParam.split(",").map(Number).filter(Boolean)
        : [],
      yearFrom: yearFrom ? parseInt(yearFrom, 10) : null,
      yearTo: yearTo ? parseInt(yearTo, 10) : null,
      ratingFilters,
      language,
      releasedOnly,
      hideUnrated,
      sortBy: sortBy || DEFAULT_SORT,
    };
  }, [searchParams]);

  // Check if any filters are active (beyond defaults)
  const hasActiveFilters = useMemo(() => {
    return (
      filters.genres.length > 0 ||
      filters.yearFrom !== null ||
      filters.yearTo !== null ||
      countActiveRatingFilters(filters.ratingFilters) > 0 ||
      filters.language !== DEFAULT_LANGUAGE || // English is default, so other languages are active
      filters.releasedOnly ||
      !filters.hideUnrated || // hideUnrated is ON by default, so "off" is active
      filters.sortBy !== DEFAULT_SORT
    );
  }, [filters]);

  // Update URL params
  const setFilters = useCallback(
    (updates: Partial<DiscoverFilters>) => {
      setSearchParams(
        (prev) => {
          const newParams = new URLSearchParams(prev);
          const newFilters = { ...filters, ...updates };

          // Type
          if (newFilters.type !== DEFAULT_FILTERS.type) {
            newParams.set("type", newFilters.type);
          } else {
            newParams.delete("type");
          }

          // Query
          if (newFilters.query) {
            newParams.set("q", newFilters.query);
          } else {
            newParams.delete("q");
          }

          // Genres
          if (newFilters.genres.length > 0) {
            newParams.set("genres", newFilters.genres.join(","));
          } else {
            newParams.delete("genres");
          }

          // Year range
          if (newFilters.yearFrom !== null) {
            newParams.set("yearFrom", newFilters.yearFrom.toString());
          } else {
            newParams.delete("yearFrom");
          }

          if (newFilters.yearTo !== null) {
            newParams.set("yearTo", newFilters.yearTo.toString());
          } else {
            newParams.delete("yearTo");
          }

          // Rating filters (new format)
          const serializedRatings = serializeRatingFilters(newFilters.ratingFilters);
          if (serializedRatings) {
            newParams.set("ratings", serializedRatings);
          } else {
            newParams.delete("ratings");
          }
          // Clean up legacy params
          newParams.delete("ratingSource");
          newParams.delete("ratingMin");

          // Language - English is default (no param needed), null means "any" language
          if (newFilters.language === null) {
            newParams.set("lang", "any");
          } else if (newFilters.language !== DEFAULT_LANGUAGE) {
            newParams.set("lang", newFilters.language);
          } else {
            newParams.delete("lang");
          }

          // Released only
          if (newFilters.releasedOnly) {
            newParams.set("released", "1");
          } else {
            newParams.delete("released");
          }

          // Hide unrated - default is ON, so only set param when OFF
          if (!newFilters.hideUnrated) {
            newParams.set("hideUnrated", "0");
          } else {
            newParams.delete("hideUnrated");
          }

          // Sort
          if (newFilters.sortBy !== DEFAULT_FILTERS.sortBy) {
            newParams.set("sort", newFilters.sortBy);
          } else {
            newParams.delete("sort");
          }

          return newParams;
        },
        { replace: true }
      );
    },
    [filters, setSearchParams]
  );

  // Individual filter setters
  const setType = useCallback(
    (type: "movie" | "tv") => {
      // Clear genres when switching type as they're different
      setFilters({ type, genres: [] });
    },
    [setFilters]
  );

  const setQuery = useCallback(
    (query: string) => setFilters({ query }),
    [setFilters]
  );

  const setGenres = useCallback(
    (genres: number[]) => setFilters({ genres }),
    [setFilters]
  );

  const toggleGenre = useCallback(
    (genreId: number) => {
      const newGenres = filters.genres.includes(genreId)
        ? filters.genres.filter((g) => g !== genreId)
        : [...filters.genres, genreId];
      setFilters({ genres: newGenres });
    },
    [filters.genres, setFilters]
  );

  const setYearRange = useCallback(
    (yearFrom: number | null, yearTo: number | null) =>
      setFilters({ yearFrom, yearTo }),
    [setFilters]
  );

  // Set a single rating source's range
  const setRatingRange = useCallback(
    (sourceId: RatingSourceId, range: RatingRange | null) => {
      const newFilters = { ...filters.ratingFilters };
      if (range === null) {
        delete newFilters[sourceId];
      } else {
        newFilters[sourceId] = range;
      }
      setFilters({ ratingFilters: newFilters });
    },
    [filters.ratingFilters, setFilters]
  );

  // Set all rating filters at once
  const setRatingFilters = useCallback(
    (ratingFilters: RatingFilters) => setFilters({ ratingFilters }),
    [setFilters]
  );

  // Clear all rating filters
  const clearRatingFilters = useCallback(() => {
    setFilters({ ratingFilters: {} });
  }, [setFilters]);

  const setLanguage = useCallback(
    (language: string | null) => setFilters({ language }),
    [setFilters]
  );

  const setReleasedOnly = useCallback(
    (releasedOnly: boolean) => setFilters({ releasedOnly }),
    [setFilters]
  );

  const setHideUnrated = useCallback(
    (hideUnrated: boolean) => setFilters({ hideUnrated }),
    [setFilters]
  );

  const setSortBy = useCallback(
    (sortBy: string) => setFilters({ sortBy }),
    [setFilters]
  );

  const clearFilters = useCallback(() => {
    setFilters({
      genres: [],
      yearFrom: null,
      yearTo: null,
      ratingFilters: {},
      language: DEFAULT_LANGUAGE,
      releasedOnly: false,
      hideUnrated: true,
      sortBy: DEFAULT_SORT,
    });
  }, [setFilters]);

  const resetAll = useCallback(() => {
    setSearchParams({}, { replace: true });
  }, [setSearchParams]);

  // Save scroll position before navigation
  useEffect(() => {
    const handleBeforeUnload = () => {
      saveScrollPosition(location.search || "default", window.scrollY);
    };

    // Save on scroll (debounced via requestAnimationFrame)
    let ticking = false;
    const handleScroll = () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          saveScrollPosition(location.search || "default", window.scrollY);
          ticking = false;
        });
        ticking = true;
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("scroll", handleScroll);
      // Save position when unmounting
      saveScrollPosition(location.search || "default", window.scrollY);
    };
  }, [location.search]);

  // Restore scroll position on back/forward navigation
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;

      // Check if this is a back/forward navigation
      const navType =
        performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      if (
        navType?.type === "back_forward" ||
        window.history.state?.idx !== undefined
      ) {
        // Delay scroll restoration to allow content to render
        const restoreScroll = () => {
          if (hasRestoredScroll.current) return;

          const positions = getScrollPositions();
          const savedPosition = positions[location.search || "default"];

          if (savedPosition !== undefined && savedPosition > 0) {
            hasRestoredScroll.current = true;
            window.scrollTo(0, savedPosition);
          }
        };

        // Try multiple times as content loads
        restoreScroll();
        setTimeout(restoreScroll, 100);
        setTimeout(restoreScroll, 300);
        setTimeout(restoreScroll, 500);
      }
    }
  }, [location.search]);

  // Get available genres for current type
  const availableGenres = filters.type === "movie" ? MOVIE_GENRES : TV_GENRES;

  return {
    filters,
    hasActiveFilters,
    availableGenres,
    setType,
    setQuery,
    setGenres,
    toggleGenre,
    setYearRange,
    setRatingRange,
    setRatingFilters,
    clearRatingFilters,
    setLanguage,
    setReleasedOnly,
    setHideUnrated,
    setSortBy,
    clearFilters,
    resetAll,
  };
}
