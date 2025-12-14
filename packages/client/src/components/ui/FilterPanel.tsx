import { useState, useCallback, useEffect } from "react";
import { Button } from "./Button";
import { RangeSlider } from "./RangeSlider";
import {
  MOVIE_GENRES,
  TV_GENRES,
  SORT_OPTIONS,
  RATING_SOURCES,
  YEAR_OPTIONS,
  LANGUAGES,
  DEFAULT_SORT,
  DEFAULT_LANGUAGE,
  isRatingFilterActive,
  countActiveRatingFilters,
  type DiscoverFilters,
  type RatingRange,
  type RatingSourceId,
  type DiscoveryMode,
} from "../../hooks/useDiscoverFilters";

interface FilterPanelProps {
  filters: DiscoverFilters;
  mode: DiscoveryMode;
  hasActiveFilters: boolean;
  onToggleGenre: (genreId: number) => void;
  onSetYearRange: (yearFrom: number | null, yearTo: number | null) => void;
  onSetRatingRange: (sourceId: RatingSourceId, range: RatingRange | null) => void;
  onClearRatingFilters: () => void;
  onSetLanguage: (language: string | null) => void;
  onSetReleasedOnly: (releasedOnly: boolean) => void;
  onSetHideUnrated: (hideUnrated: boolean) => void;
  onSetSortBy: (sortBy: string) => void;
  onClearFilters: () => void;
}

interface FilterSectionProps {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  badge?: string | number;
}

function FilterSection({
  title,
  isOpen,
  onToggle,
  children,
  badge,
}: FilterSectionProps) {
  return (
    <div className="border-b border-white/10 last:border-b-0">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between py-3 px-1 text-left text-sm font-medium text-white/80 hover:text-white transition-colors"
      >
        <span className="flex items-center gap-2">
          {title}
          {badge !== undefined && badge !== 0 && (
            <span className="px-1.5 py-0.5 text-xs bg-annex-500/20 text-annex-400 rounded">
              {badge}
            </span>
          )}
        </span>
        <svg
          className={`w-4 h-4 text-white/40 transition-transform duration-200 ${
            isOpen ? "rotate-180" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          isOpen ? "max-h-[800px] pb-4" : "max-h-0"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function FilterPanel({
  filters,
  mode,
  hasActiveFilters,
  onToggleGenre,
  onSetYearRange,
  onSetRatingRange,
  onClearRatingFilters,
  onSetLanguage,
  onSetReleasedOnly,
  onSetHideUnrated,
  onSetSortBy,
  onClearFilters,
}: FilterPanelProps) {
  const isCustomMode = mode === "custom";

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    genres: true,
    year: false,
    language: false,
    advanced: isCustomMode, // Only open by default in custom mode
    sort: false,
  });

  // Auto-expand/collapse advanced section when mode changes
  useEffect(() => {
    setOpenSections((prev) => ({ ...prev, advanced: isCustomMode }));
  }, [isCustomMode]);

  const toggleSection = useCallback((section: string) => {
    setOpenSections((prev) => ({ ...prev, [section]: !prev[section] }));
  }, []);

  const genres = filters.type === "movie" ? MOVIE_GENRES : TV_GENRES;

  // Count active rating filters
  const activeRatingCount = countActiveRatingFilters(filters.ratingFilters);

  // Handle slider change for a rating source
  const handleRatingChange = (sourceId: RatingSourceId) => (value: [number, number]) => {
    const source = RATING_SOURCES.find((s) => s.id === sourceId);
    if (!source) return;

    // If range is at defaults, clear the filter
    if (value[0] === source.min && value[1] === source.max) {
      onSetRatingRange(sourceId, null);
    } else {
      onSetRatingRange(sourceId, { min: value[0], max: value[1] });
    }
  };

  // Get current range for a source (with defaults)
  const getRangeForSource = (sourceId: RatingSourceId): [number, number] => {
    const source = RATING_SOURCES.find((s) => s.id === sourceId);
    if (!source) return [0, 100];
    const range = filters.ratingFilters[sourceId];
    return range ? [range.min, range.max] : [source.min, source.max];
  };

  return (
    <div className="bg-white/5 border border-white/10 rounded backdrop-blur-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h3 className="text-sm font-semibold text-white/90">Filters</h3>
        {hasActiveFilters && (
          <button
            onClick={onClearFilters}
            className="text-xs text-annex-400 hover:text-annex-300 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      <div className="px-4">
        {/* Quick toggles - only show in custom mode */}
        {isCustomMode && (
          <div className="py-3 space-y-3 border-b border-white/10">
            {/* Hide unrated toggle - ON by default */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <span className={`text-sm font-medium ${filters.hideUnrated ? "text-white/90" : "text-white/70"}`}>
                  Hide unrated
                </span>
                <p className="text-xs text-white/40">Only show rated media</p>
              </div>
              <button
                onClick={() => onSetHideUnrated(!filters.hideUnrated)}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                  filters.hideUnrated
                    ? "bg-annex-500"
                    : "bg-white/10 hover:bg-white/15"
                }`}
                role="switch"
                aria-checked={filters.hideUnrated}
              >
                <span
                  className={`absolute top-1 left-1 w-4 h-4 rounded-full shadow-sm transition-all duration-200 ${
                    filters.hideUnrated
                      ? "translate-x-5 bg-white"
                      : "translate-x-0 bg-white/70"
                  }`}
                />
              </button>
            </div>

            {/* Released only toggle */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <span className={`text-sm font-medium ${filters.releasedOnly ? "text-white/90" : "text-white/70"}`}>
                  Released only
                </span>
                <p className="text-xs text-white/40">Hide upcoming content</p>
              </div>
              <button
                onClick={() => onSetReleasedOnly(!filters.releasedOnly)}
                className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${
                  filters.releasedOnly
                    ? "bg-annex-500"
                    : "bg-white/10 hover:bg-white/15"
                }`}
                role="switch"
                aria-checked={filters.releasedOnly}
              >
                <span
                  className={`absolute top-1 left-1 w-4 h-4 rounded-full shadow-sm transition-all duration-200 ${
                    filters.releasedOnly
                      ? "translate-x-5 bg-white"
                      : "translate-x-0 bg-white/70"
                  }`}
                />
              </button>
            </div>
          </div>
        )}

        {/* Genres */}
        <FilterSection
          title="Genres"
          isOpen={openSections.genres}
          onToggle={() => toggleSection("genres")}
          badge={filters.genres.length}
        >
          <div className="flex flex-wrap gap-1.5">
            {genres.map((genre) => {
              const isSelected = filters.genres.includes(genre.id);
              return (
                <button
                  key={genre.id}
                  onClick={() => onToggleGenre(genre.id)}
                  className={`px-2.5 py-1 text-xs rounded transition-all duration-150 ${
                    isSelected
                      ? "bg-annex-500/30 text-annex-300 border border-annex-500/50"
                      : "bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/80"
                  }`}
                >
                  {genre.name}
                </button>
              );
            })}
          </div>
        </FilterSection>

        {/* Year Range */}
        <FilterSection
          title="Year"
          isOpen={openSections.year}
          onToggle={() => toggleSection("year")}
          badge={
            filters.yearFrom || filters.yearTo
              ? `${filters.yearFrom || "Any"} - ${filters.yearTo || "Any"}`
              : undefined
          }
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <select
                  value={filters.yearFrom ?? ""}
                  onChange={(e) =>
                    onSetYearRange(
                      e.target.value ? parseInt(e.target.value, 10) : null,
                      filters.yearTo
                    )
                  }
                  className="w-full appearance-none px-2.5 py-1.5 pr-7 text-xs bg-white/5 border border-white/10 rounded text-white/80 focus:outline-none focus:border-annex-500/50 cursor-pointer [&>option]:bg-zinc-900 [&>option]:text-white"
                >
                  <option value="">From year</option>
                  {YEAR_OPTIONS.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
                <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/40 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
              <span className="text-white/30">-</span>
              <div className="relative flex-1">
                <select
                  value={filters.yearTo ?? ""}
                  onChange={(e) =>
                    onSetYearRange(
                      filters.yearFrom,
                      e.target.value ? parseInt(e.target.value, 10) : null
                    )
                  }
                  className="w-full appearance-none px-2.5 py-1.5 pr-7 text-xs bg-white/5 border border-white/10 rounded text-white/80 focus:outline-none focus:border-annex-500/50 cursor-pointer [&>option]:bg-zinc-900 [&>option]:text-white"
                >
                  <option value="">To year</option>
                  {YEAR_OPTIONS.map((year) => (
                    <option key={year} value={year}>
                      {year}
                    </option>
                  ))}
                </select>
                <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/40 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
            </div>
            {/* Quick year presets */}
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: "2024+", from: 2024, to: null },
                { label: "2020s", from: 2020, to: 2029 },
                { label: "2010s", from: 2010, to: 2019 },
                { label: "2000s", from: 2000, to: 2009 },
                { label: "Classic", from: null, to: 1999 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => onSetYearRange(preset.from, preset.to)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    filters.yearFrom === preset.from &&
                    filters.yearTo === preset.to
                      ? "bg-annex-500/30 text-annex-300"
                      : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </FilterSection>

        {/* Language */}
        <FilterSection
          title="Language"
          isOpen={openSections.language}
          onToggle={() => toggleSection("language")}
          badge={
            filters.language !== DEFAULT_LANGUAGE
              ? filters.language === null
                ? "Any"
                : LANGUAGES.find((l) => l.code === filters.language)?.name || filters.language
              : undefined
          }
        >
          <div className="space-y-3">
            {/* Language select */}
            <div className="relative">
              <select
                value={filters.language ?? "any"}
                onChange={(e) => onSetLanguage(e.target.value === "any" ? null : e.target.value)}
                className="w-full appearance-none px-2.5 py-1.5 pr-7 text-xs bg-white/5 border border-white/10 rounded text-white/80 focus:outline-none focus:border-annex-500/50 cursor-pointer [&>option]:bg-zinc-900 [&>option]:text-white"
              >
                <option value="any">Any language</option>
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name}
                  </option>
                ))}
              </select>
              <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-white/40 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>

            {/* Quick language presets */}
            <div className="flex flex-wrap gap-1.5">
              {[
                { code: null, label: "Any" },
                { code: "en", label: "English" },
                { code: "ja", label: "Japanese" },
                { code: "ko", label: "Korean" },
                { code: "es", label: "Spanish" },
                { code: "fr", label: "French" },
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => onSetLanguage(preset.code)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    filters.language === preset.code
                      ? "bg-annex-500/30 text-annex-300"
                      : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </FilterSection>

        {/* Advanced Filters - Only show in custom mode */}
        {isCustomMode && (
          <FilterSection
            title="Advanced Filters"
            isOpen={openSections.advanced}
            onToggle={() => toggleSection("advanced")}
            badge={activeRatingCount > 0 ? activeRatingCount : undefined}
          >
            <div className="space-y-4">
              {/* Info text */}
              <p className="text-xs text-white/40">
                Fine-tune by individual rating sources. Multiple filters combine with AND logic.
              </p>

              {/* Rating sliders - px-2 gives room for slider handles at edges */}
              <div className="space-y-5 px-2">
                {RATING_SOURCES.map((source) => {
                  const range = getRangeForSource(source.id);
                  const _isActive = isRatingFilterActive(source.id, filters.ratingFilters[source.id]);

                  // Extract the bg color class for the slider
                  const colorMatch = source.color.match(/bg-(\w+)-500/);
                  const sliderColor = colorMatch ? `bg-${colorMatch[1]}-500` : "bg-annex-500";

                  return (
                    <RangeSlider
                      key={source.id}
                      min={source.min}
                      max={source.max}
                      step={source.step}
                      value={range}
                      onChange={handleRatingChange(source.id)}
                      formatValue={source.format}
                      label={source.name}
                      color={sliderColor}
                    />
                  );
                })}
              </div>

              {/* Clear ratings button */}
              {activeRatingCount > 0 && (
                <button
                  onClick={onClearRatingFilters}
                  className="w-full px-3 py-1.5 text-xs text-white/50 hover:text-white/70 bg-white/5 hover:bg-white/10 border border-white/10 rounded transition-colors"
                >
                  Clear all rating filters
                </button>
              )}
            </div>
          </FilterSection>
        )}

        {/* Sort By - Only show in custom mode */}
        {isCustomMode && (
          <FilterSection
            title="Sort"
            isOpen={openSections.sort}
            onToggle={() => toggleSection("sort")}
            badge={
              filters.sortBy !== DEFAULT_SORT
                ? SORT_OPTIONS.find((o) => o.value === filters.sortBy)?.label
                : undefined
            }
          >
            <div className="grid grid-cols-2 gap-1.5">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => onSetSortBy(option.value)}
                  className={`px-2.5 py-1.5 text-xs rounded text-left transition-all duration-150 ${
                    filters.sortBy === option.value
                      ? "bg-annex-500/30 text-annex-300 border border-annex-500/50"
                      : "bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/80"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </FilterSection>
        )}
      </div>
    </div>
  );
}

// Compact filter bar for mobile/collapsed view
export function FilterBar({
  filters,
  mode,
  hasActiveFilters,
  onToggleGenre,
  onClearRatingFilters,
  onSetLanguage,
  onSetReleasedOnly,
  onSetHideUnrated,
  onSetSortBy: _onSetSortBy,
  onClearFilters,
  onExpandFilters,
}: Omit<FilterPanelProps, "onSetYearRange" | "onSetRatingRange"> & { onExpandFilters: () => void }) {
  const genres = filters.type === "movie" ? MOVIE_GENRES : TV_GENRES;
  const activeRatingCount = countActiveRatingFilters(filters.ratingFilters);
  const isCustomMode = mode === "custom";

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-white/10">
      {/* Expand button */}
      <Button
        variant="secondary"
        size="sm"
        onClick={onExpandFilters}
        className="shrink-0"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
          />
        </svg>
        Filters
        {hasActiveFilters && (
          <span className="ml-1 px-1.5 py-0.5 text-xs bg-annex-500/30 text-annex-300 rounded">
            {filters.genres.length +
              (filters.yearFrom ? 1 : 0) +
              (filters.yearTo ? 1 : 0) +
              activeRatingCount +
              (filters.language !== DEFAULT_LANGUAGE ? 1 : 0) +
              (filters.releasedOnly ? 1 : 0) +
              (!filters.hideUnrated ? 1 : 0) +
              (filters.sortBy !== DEFAULT_SORT ? 1 : 0)}
          </span>
        )}
      </Button>

      {/* Active genre pills */}
      {filters.genres.map((genreId) => {
        const genre = genres.find((g) => g.id === genreId);
        if (!genre) return null;
        return (
          <button
            key={genreId}
            onClick={() => onToggleGenre(genreId)}
            className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs bg-annex-500/20 text-annex-300 rounded border border-annex-500/30 hover:bg-annex-500/30 transition-colors"
          >
            {genre.name}
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        );
      })}

      {/* Rating filters summary pill - only in custom mode */}
      {isCustomMode && activeRatingCount > 0 && (
        <button
          onClick={onClearRatingFilters}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs bg-annex-500/20 text-annex-300 rounded border border-annex-500/30 hover:bg-annex-500/30 transition-colors"
        >
          {activeRatingCount} rating{activeRatingCount > 1 ? "s" : ""}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Year range pill */}
      {(filters.yearFrom || filters.yearTo) && (
        <span className="shrink-0 px-2.5 py-1 text-xs bg-white/5 text-white/60 rounded border border-white/10">
          {filters.yearFrom || "Any"} - {filters.yearTo || "Any"}
        </span>
      )}

      {/* Language pill - show when not default (English) */}
      {filters.language !== DEFAULT_LANGUAGE && (
        <button
          onClick={() => onSetLanguage(DEFAULT_LANGUAGE)}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs bg-annex-500/20 text-annex-300 rounded border border-annex-500/30 hover:bg-annex-500/30 transition-colors"
        >
          {filters.language === null
            ? "Any Language"
            : LANGUAGES.find((l) => l.code === filters.language)?.name || filters.language}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Released only pill - only in custom mode */}
      {isCustomMode && filters.releasedOnly && (
        <button
          onClick={() => onSetReleasedOnly(false)}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs bg-annex-500/20 text-annex-300 rounded border border-annex-500/30 hover:bg-annex-500/30 transition-colors"
        >
          Released
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Show unrated pill (when hideUnrated is off) - only in custom mode */}
      {isCustomMode && !filters.hideUnrated && (
        <button
          onClick={() => onSetHideUnrated(true)}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1 text-xs bg-annex-500/20 text-annex-300 rounded border border-annex-500/30 hover:bg-annex-500/30 transition-colors"
        >
          Showing unrated
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      {/* Clear all */}
      {hasActiveFilters && (
        <button
          onClick={onClearFilters}
          className="shrink-0 px-2 py-1 text-xs text-white/40 hover:text-white/60 transition-colors"
        >
          Clear
        </button>
      )}
    </div>
  );
}
