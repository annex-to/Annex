import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { trpc } from "../trpc";
import { Input, ToggleGroup, MediaCard, Button, FilterPanel, LibraryInfo } from "../components/ui";
import { DiscoveryModeTabs } from "../components/ui/DiscoveryModeTabs";
import { QualityTierSelector } from "../components/ui/QualityTierSelector";
import {
  useDiscoverFilters,
  SORT_OPTIONS,
  DEFAULT_SORT,
  DISCOVERY_MODES,
  countActiveRatingFilters,
} from "../hooks/useDiscoverFilters";

const mediaTypeOptions = [
  { value: "movie" as const, label: "Movies" },
  { value: "tv" as const, label: "TV Shows" },
];

// Debounce hook for search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

// Media item type for display (transformed from API response)
interface DisplayMediaItem {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  posterPath: string | null;
  year: number;
  voteAverage: number;
  ratings?: {
    imdbScore?: number | null;
    rtCriticScore?: number | null;
    rtAudienceScore?: number | null;
    metacriticScore?: number | null;
    traktScore?: number | null;
    letterboxdScore?: number | null;
    mdblistScore?: number | null;
    aggregateScore?: number | null;
    sourceCount?: number | null;
  };
  trailerKey?: string | null;
}

// Transform API result to display format
function transformResult(item: {
  tmdbId: number;
  type: "movie" | "tv" | "MOVIE" | "TV";
  title: string;
  posterPath: string | null;
  year: number | null;
  voteAverage: number | null;
  ratings?: {
    imdbScore?: number | null;
    rtCriticScore?: number | null;
    rtAudienceScore?: number | null;
    metacriticScore?: number | null;
    traktScore?: number | null;
    letterboxdScore?: number | null;
    mdblistScore?: number | null;
    aggregateScore?: number | null;
    sourceCount?: number | null;
  } | null;
  trailerKey?: string | null;
}): DisplayMediaItem {
  return {
    tmdbId: item.tmdbId,
    type: (typeof item.type === "string" && item.type.toUpperCase() === "TV" ? "tv" : "movie") as "movie" | "tv",
    title: item.title,
    posterPath: item.posterPath,
    year: item.year ?? 0,
    voteAverage: item.voteAverage ?? 0,
    ratings: item.ratings ? {
      imdbScore: item.ratings.imdbScore,
      rtCriticScore: item.ratings.rtCriticScore,
      rtAudienceScore: item.ratings.rtAudienceScore,
      metacriticScore: item.ratings.metacriticScore,
      traktScore: item.ratings.traktScore,
      letterboxdScore: item.ratings.letterboxdScore,
      mdblistScore: item.ratings.mdblistScore,
      aggregateScore: item.ratings.aggregateScore,
      sourceCount: item.ratings.sourceCount,
    } : undefined,
    trailerKey: item.trailerKey,
  };
}

export default function DiscoverPage() {
  const {
    filters,
    hasActiveFilters,
    setType,
    setMode,
    setQualityTier,
    setQuery,
    toggleGenre,
    setYearRange,
    setRatingRange,
    clearRatingFilters,
    setLanguage,
    setReleasedOnly,
    setHideUnrated,
    setSortBy,
    clearFilters,
  } = useDiscoverFilters();

  // Local search input state (synced with URL via debounce)
  const [searchInput, setSearchInput] = useState(filters.query);
  const [page, setPage] = useState(1);
  const [allResults, setAllResults] = useState<DisplayMediaItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [totalResults, setTotalResults] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const processedDataRef = useRef<string>("");

  // Sync search input with URL query
  useEffect(() => {
    setSearchInput(filters.query);
  }, [filters.query]);

  // Debounce search input to URL update
  const debouncedSearchInput = useDebounce(searchInput, 300);

  // Update URL when debounced search changes
  useEffect(() => {
    if (debouncedSearchInput !== filters.query) {
      setQuery(debouncedSearchInput);
    }
  }, [debouncedSearchInput, filters.query, setQuery]);

  // Create a stable query key for caching
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        type: filters.type,
        mode: filters.mode,
        qualityTier: filters.qualityTier,
        query: filters.query,
        genres: filters.genres,
        yearFrom: filters.yearFrom,
        yearTo: filters.yearTo,
        ratingFilters: filters.ratingFilters,
        language: filters.language,
        releasedOnly: filters.releasedOnly,
        hideUnrated: filters.hideUnrated,
        sortBy: filters.sortBy,
        page,
      }),
    [filters, page]
  );

  // Use the discover endpoint for most modes
  const discoverQuery = trpc.discovery.discover.useQuery(
    {
      type: filters.type,
      mode: filters.mode === "trakt_trending" ? "trending" : filters.mode,
      qualityTier: filters.qualityTier,
      page,
      query: filters.query || undefined,
      genres: filters.genres.length > 0 ? filters.genres : undefined,
      yearFrom: filters.yearFrom ?? undefined,
      yearTo: filters.yearTo ?? undefined,
      ratingFilters: Object.keys(filters.ratingFilters).length > 0
        ? filters.ratingFilters
        : undefined,
      language: filters.language ?? undefined,
      releasedOnly: filters.releasedOnly || undefined,
      hideUnrated: filters.hideUnrated,
      sortBy: filters.sortBy,
    },
    {
      keepPreviousData: true,
      enabled: filters.mode !== "trakt_trending",
    }
  );

  // Use Trakt trending endpoint when in trakt_trending mode
  const traktTrendingQuery = trpc.discovery.traktTrending.useQuery(
    {
      type: filters.type,
      page,
    },
    {
      keepPreviousData: true,
      enabled: filters.mode === "trakt_trending",
    }
  );

  // Combined query state - use whichever query is active
  const activeQuery = filters.mode === "trakt_trending" ? traktTrendingQuery : discoverQuery;

  // Build a list of items to check for library status
  const itemsToCheck = useMemo(() => {
    return allResults.map((item) => ({
      tmdbId: item.tmdbId,
      type: item.type,
    }));
  }, [allResults]);

  // Check library status for displayed items
  const libraryStatusQuery = trpc.servers.checkInLibrary.useQuery(
    { items: itemsToCheck },
    {
      enabled: itemsToCheck.length > 0,
      staleTime: 60000, // Cache for 1 minute
    }
  );

  // Get library info for a specific item
  const getLibraryInfo = useCallback(
    (type: "movie" | "tv", tmdbId: number): LibraryInfo | null => {
      const key = `${type}-${tmdbId}`;
      const info = libraryStatusQuery.data?.inLibrary[key];
      return info || null;
    },
    [libraryStatusQuery.data]
  );

  // Accumulate results when new data arrives
  useEffect(() => {
    const data = activeQuery.data;
    if (!data?.results || activeQuery.isFetching) return;

    // Create a unique key for this data to avoid reprocessing
    const dataKey = `${queryKey}-${data.results.length}`;
    if (processedDataRef.current === dataKey) return;
    processedDataRef.current = dataKey;

    // Transform results to display format
    const transformedResults = data.results.map(transformResult);

    if (page === 1) {
      setAllResults(transformedResults);
      // Only set totalResults on page 1 to ensure consistency
      setTotalResults(data.totalResults ?? 0);
    } else {
      setAllResults((prev) => {
        const existingIds = new Set(prev.map((r) => `${r.type}-${r.tmdbId}`));
        const newItems = transformedResults.filter(
          (r) => !existingIds.has(`${r.type}-${r.tmdbId}`)
        );
        return [...prev, ...newItems];
      });
    }

    setHasMore(page < (data.totalPages ?? 1));
  }, [activeQuery.data, activeQuery.isFetching, page, queryKey]);

  // Reset pagination when filters change
  useEffect(() => {
    setPage(1);
    setAllResults([]);
    setHasMore(true);
    setTotalResults(0);
    processedDataRef.current = "";
  }, [
    filters.type,
    filters.mode,
    filters.qualityTier,
    filters.query,
    filters.genres,
    filters.yearFrom,
    filters.yearTo,
    filters.ratingFilters,
    filters.language,
    filters.releasedOnly,
    filters.hideUnrated,
    filters.sortBy,
  ]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
  };

  const handleMediaTypeChange = (newType: "movie" | "tv") => {
    setType(newType);
  };

  // Load more function
  const loadMore = useCallback(() => {
    if (!activeQuery.isFetching && hasMore) {
      setPage((p) => p + 1);
    }
  }, [activeQuery.isFetching, hasMore]);

  // Intersection observer for infinite scroll
  useEffect(() => {
    const currentRef = loadMoreRef.current;
    if (!currentRef) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const [entry] = entries;
        if (
          entry.isIntersecting &&
          hasMore &&
          !activeQuery.isFetching &&
          allResults.length > 0
        ) {
          loadMore();
        }
      },
      { threshold: 0, rootMargin: "600px" }
    );

    observer.observe(currentRef);

    return () => {
      observer.disconnect();
    };
  }, [loadMore, hasMore, activeQuery.isFetching, allResults.length]);

  const isInitialLoading = activeQuery.isLoading && allResults.length === 0;
  const isLoadingMore = activeQuery.isFetching && allResults.length > 0;

  // Build title based on active filters
  const resultsTitle = useMemo(() => {
    if (filters.query) {
      return `Search Results for "${filters.query}"`;
    }

    // Get mode label
    const modeLabel = DISCOVERY_MODES.find((m) => m.value === filters.mode)?.label || "Discover";
    const prefix = filters.type === "movie" ? "Movies" : "TV Shows";

    // For preset modes, just show mode name + type
    if (filters.mode !== "custom") {
      return `${modeLabel} ${prefix}`;
    }

    // For custom mode, show filter details
    const parts: string[] = [];

    // Show active rating filters count
    const activeRatings = countActiveRatingFilters(filters.ratingFilters);
    if (activeRatings > 0) {
      parts.push(`${activeRatings} rating filter${activeRatings > 1 ? "s" : ""}`);
    }

    if (filters.yearFrom && filters.yearTo && filters.yearFrom === filters.yearTo) {
      parts.push(`from ${filters.yearFrom}`);
    } else if (filters.yearFrom || filters.yearTo) {
      parts.push(`${filters.yearFrom || "earliest"} - ${filters.yearTo || "latest"}`);
    }
    const sortLabel = SORT_OPTIONS.find((o) => o.value === filters.sortBy)?.label;
    if (sortLabel && filters.sortBy !== DEFAULT_SORT) {
      parts.push(`sorted by ${sortLabel.toLowerCase()}`);
    }
    return parts.length > 0 ? `${prefix} (${parts.join(", ")})` : `Custom ${prefix}`;
  }, [filters]);

  return (
    <div className="flex gap-6">
      {/* Sidebar filters (desktop) */}
      <aside className="hidden lg:block w-64 shrink-0">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
          <FilterPanel
            filters={filters}
            mode={filters.mode}
            hasActiveFilters={hasActiveFilters}
            onToggleGenre={toggleGenre}
            onSetYearRange={setYearRange}
            onSetRatingRange={setRatingRange}
            onClearRatingFilters={clearRatingFilters}
            onSetLanguage={setLanguage}
            onSetReleasedOnly={setReleasedOnly}
            onSetHideUnrated={setHideUnrated}
            onSetSortBy={setSortBy}
            onClearFilters={clearFilters}
          />
        </div>
      </aside>

      {/* Mobile filter panel */}
      {showFilters && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowFilters(false)}
          />
          <div className="absolute inset-y-0 left-0 w-80 max-w-[90vw] bg-black/95 border-r border-white/10 overflow-y-auto">
            <div className="sticky top-0 flex items-center justify-between px-4 py-3 bg-black/90 border-b border-white/10">
              <h3 className="text-sm font-semibold">Filters</h3>
              <button
                onClick={() => setShowFilters(false)}
                className="p-1 text-white/60 hover:text-white"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            <div className="p-4">
              <FilterPanel
                filters={filters}
                mode={filters.mode}
                hasActiveFilters={hasActiveFilters}
                onToggleGenre={toggleGenre}
                onSetYearRange={setYearRange}
                onSetRatingRange={setRatingRange}
                onClearRatingFilters={clearRatingFilters}
                onSetLanguage={setLanguage}
                onSetReleasedOnly={setReleasedOnly}
                onSetHideUnrated={setHideUnrated}
                onSetSortBy={setSortBy}
                onClearFilters={clearFilters}
              />
            </div>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 min-w-0 space-y-4">
        {/* Discovery mode tabs */}
        <DiscoveryModeTabs mode={filters.mode} onModeChange={setMode} />

        {/* Search bar and type toggle */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 flex gap-2">
            {/* Mobile filter button */}
            <Button
              variant="secondary"
              onClick={() => setShowFilters(true)}
              className="lg:hidden shrink-0"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              {hasActiveFilters && (
                <span className="ml-1 w-2 h-2 bg-annex-500 rounded-full" />
              )}
            </Button>
            <Input
              type="text"
              placeholder="Search movies and TV shows..."
              value={searchInput}
              onChange={handleSearchChange}
              className="flex-1"
            />
          </div>
          <ToggleGroup
            options={mediaTypeOptions}
            value={filters.type}
            onChange={handleMediaTypeChange}
          />
        </div>

        {/* Quality tier selector (shown for non-custom modes, not for trakt_trending/coming_soon) */}
        {filters.mode !== "custom" && filters.mode !== "coming_soon" && filters.mode !== "trakt_trending" && (
          <QualityTierSelector
            tier={filters.qualityTier}
            onTierChange={setQualityTier}
          />
        )}

        {/* Active filters pills (mobile) */}
        {hasActiveFilters && (
          <div className="lg:hidden flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-white/10">
            {filters.genres.length > 0 && (
              <span className="shrink-0 px-2 py-1 text-xs bg-annex-500/20 text-annex-300 rounded">
                {filters.genres.length} genres
              </span>
            )}
            {countActiveRatingFilters(filters.ratingFilters) > 0 && (
              <button
                onClick={clearRatingFilters}
                className="shrink-0 flex items-center gap-1 px-2 py-1 text-xs bg-annex-500/20 text-annex-300 rounded hover:bg-annex-500/30 transition-colors"
              >
                {countActiveRatingFilters(filters.ratingFilters)} rating{countActiveRatingFilters(filters.ratingFilters) > 1 ? "s" : ""}
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
            {(filters.yearFrom || filters.yearTo) && (
              <span className="shrink-0 px-2 py-1 text-xs bg-annex-500/20 text-annex-300 rounded">
                {filters.yearFrom || "Any"} - {filters.yearTo || "Any"}
              </span>
            )}
            {filters.sortBy !== DEFAULT_SORT && (
              <span className="shrink-0 px-2 py-1 text-xs bg-annex-500/20 text-annex-300 rounded">
                {SORT_OPTIONS.find((o) => o.value === filters.sortBy)?.label}
              </span>
            )}
            <button
              onClick={clearFilters}
              className="shrink-0 px-2 py-1 text-xs text-white/40 hover:text-white/60"
            >
              Clear
            </button>
          </div>
        )}

        {/* Results section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">{resultsTitle}</h2>
            {totalResults > 0 && (
              <span className="text-sm text-white/50">
                {allResults.length.toLocaleString()} of{" "}
                {totalResults.toLocaleString()} items
              </span>
            )}
          </div>

          {/* Error state */}
          {activeQuery.error && (
            <div className="text-center py-12 text-red-400">
              <p>Failed to load content.</p>
              <p className="text-sm mt-2 text-white/30">
                {activeQuery.error.message}
              </p>
            </div>
          )}

          {/* Initial loading state */}
          {isInitialLoading && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {Array.from({ length: 15 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <div className="aspect-[2/3] bg-white/5 rounded animate-pulse" />
                  <div className="h-4 bg-white/5 rounded animate-pulse w-3/4" />
                  <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!isInitialLoading &&
            !activeQuery.isFetching &&
            allResults.length === 0 &&
            activeQuery.data && (
              <div className="text-center py-12 text-white/50">
                {filters.query ? (
                  <>
                    <p>No results found for "{filters.query}".</p>
                    <p className="text-sm mt-2 text-white/30">
                      Try a different search term or adjust your filters.
                    </p>
                  </>
                ) : hasActiveFilters ? (
                  <>
                    <p>No content matches your filters.</p>
                    <p className="text-sm mt-2 text-white/30">
                      Try adjusting your filters or{" "}
                      <button
                        onClick={clearFilters}
                        className="text-annex-400 hover:text-annex-300"
                      >
                        clear all filters
                      </button>
                      .
                    </p>
                  </>
                ) : (
                  <>
                    <p>No trending content available.</p>
                    <p className="text-sm mt-2 text-white/30">
                      Run a sync to populate the database, or configure your TMDB
                      API key.
                    </p>
                  </>
                )}
              </div>
            )}

          {/* Results grid */}
          {allResults.length > 0 && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {allResults.map((item) => (
                  <MediaCard
                    key={`${item.type}-${item.tmdbId}`}
                    tmdbId={item.tmdbId}
                    type={item.type}
                    title={item.title}
                    posterPath={item.posterPath}
                    year={item.year}
                    voteAverage={item.voteAverage}
                    ratings={item.ratings}
                    trailerKey={item.trailerKey}
                    inLibrary={getLibraryInfo(item.type, item.tmdbId)}
                  />
                ))}
              </div>

              {/* Load more section */}
              <div
                ref={loadMoreRef}
                className="flex flex-col items-center gap-4 py-8"
              >
                {isLoadingMore && (
                  <div className="flex items-center gap-3 text-white/50">
                    <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                    <span className="text-sm">Loading more...</span>
                  </div>
                )}

                {hasMore && !isLoadingMore && (
                  <Button
                    variant="secondary"
                    onClick={loadMore}
                    disabled={activeQuery.isFetching}
                  >
                    Load More
                  </Button>
                )}

                {!hasMore && allResults.length > 0 && (
                  <span className="text-sm text-white/30">
                    You've reached the end
                  </span>
                )}
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
