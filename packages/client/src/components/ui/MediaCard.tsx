import { HTMLAttributes, forwardRef, useState } from "react";
import { Link } from "react-router-dom";
import { TrailerModal } from "./Modal";
import { Tooltip } from "./Tooltip";
import { RequestDialog } from "./RequestDialog";

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

interface LibraryInfo {
  servers: Array<{
    id: string;
    name: string;
    type: string;
    quality?: string;
  }>;
}

interface MediaCardProps extends HTMLAttributes<HTMLDivElement> {
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
  /** YouTube trailer key - if provided, shows trailer button; if null/undefined, hides it */
  trailerKey?: string | null;
  /** Info about which library servers have this item */
  inLibrary?: LibraryInfo | null;
}

// Rating badge component
function RatingBadge({
  label,
  value,
  max = 10,
  color,
}: {
  label: string;
  value: number;
  max?: number;
  color: string;
}) {
  const displayValue = max === 100 ? `${value}%` : value.toFixed(1);
  return (
    <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${color}`}>
      <span className="font-medium opacity-70">{label}</span>
      <span className="font-semibold">{displayValue}</span>
    </div>
  );
}

const MediaCard = forwardRef<HTMLDivElement, MediaCardProps>(
  (
    {
      tmdbId,
      type,
      title,
      posterPath,
      year,
      voteAverage,
      ratings,
      trailerKey,
      inLibrary,
      className = "",
      ...props
    },
    ref
  ) => {
    const [showTrailer, setShowTrailer] = useState(false);
    const [showRequestDialog, setShowRequestDialog] = useState(false);

    // Check if item is in library
    const isInLibrary = inLibrary && inLibrary.servers.length > 0;
    const libraryTooltip = isInLibrary
      ? `In Library: ${inLibrary.servers.map((s) => `${s.name}${s.quality ? ` (${s.quality})` : ""}`).join(", ")}`
      : null;

    const posterUrl = posterPath
      ? `${TMDB_IMAGE_BASE}/w342${posterPath}`
      : null;

    // Only show trailer button if we have a trailer key
    const hasTrailer = Boolean(trailerKey);

    const handleTrailerClick = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (trailerKey) {
        setShowTrailer(true);
      }
    };

    const handleRequestClick = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setShowRequestDialog(true);
    };

    // Collect all available ratings
    const availableRatings: { label: string; value: number; max: number; color: string }[] = [];

    if (ratings?.imdbScore && ratings.imdbScore > 0) {
      availableRatings.push({
        label: "IMDb",
        value: ratings.imdbScore,
        max: 10,
        color: "bg-yellow-500/20 text-yellow-400",
      });
    }
    if (ratings?.rtCriticScore && ratings.rtCriticScore > 0) {
      availableRatings.push({
        label: "RT",
        value: ratings.rtCriticScore,
        max: 100,
        color: "bg-red-500/20 text-red-400",
      });
    }
    if (ratings?.metacriticScore && ratings.metacriticScore > 0) {
      availableRatings.push({
        label: "MC",
        value: ratings.metacriticScore,
        max: 100,
        color: "bg-green-500/20 text-green-400",
      });
    }
    if (ratings?.traktScore && ratings.traktScore > 0) {
      availableRatings.push({
        label: "Trakt",
        value: ratings.traktScore,
        max: 10,
        color: "bg-red-600/20 text-red-300",
      });
    }
    if (ratings?.letterboxdScore && ratings.letterboxdScore > 0) {
      availableRatings.push({
        label: "LB",
        value: ratings.letterboxdScore,
        max: 5,
        color: "bg-orange-500/20 text-orange-400",
      });
    }
    // Fallback to TMDB vote average if no other ratings
    if (availableRatings.length === 0 && voteAverage > 0) {
      availableRatings.push({
        label: "TMDB",
        value: voteAverage,
        max: 10,
        color: "bg-blue-500/20 text-blue-400",
      });
    }

    return (
      <>
        <div
          ref={ref}
          className={`
            group relative cursor-pointer block
            transition-all duration-150
            hover:scale-[1.02] hover:z-10
            ${className}
          `}
          {...props}
        >
          {/* Poster */}
          <div className="relative aspect-[2/3] bg-white/5 rounded overflow-hidden border border-white/10 group-hover:border-white/20">
            {posterUrl ? (
              <img
                src={posterUrl}
                alt={title}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white/20">
                <svg
                  className="w-12 h-12"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z"
                  />
                </svg>
              </div>
            )}

            {/* In Library badge - top left corner */}
            {isInLibrary && (
              <Tooltip content={libraryTooltip ?? "In Library"}>
                <div className="absolute top-2 left-2 z-10">
                  <div className="bg-green-500/90 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1 shadow-lg">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="font-medium">In Library</span>
                  </div>
                </div>
              </Tooltip>
            )}

            {/* Aggregate score badge - top right corner */}
            {ratings?.aggregateScore && ratings.aggregateScore > 0 && ratings.sourceCount && ratings.sourceCount >= 2 && (
              <Tooltip content={`Aggregate score from ${ratings.sourceCount} sources`}>
                <div className="absolute top-2 right-2 z-10">
                  <div
                    className={`text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1 shadow-lg font-semibold ${
                      ratings.aggregateScore >= 80
                        ? "bg-green-500/90"
                        : ratings.aggregateScore >= 70
                          ? "bg-yellow-500/90"
                          : "bg-white/30"
                    }`}
                  >
                    <span>{Math.round(ratings.aggregateScore)}</span>
                    <span className="opacity-70 text-[10px]">({ratings.sourceCount})</span>
                  </div>
                </div>
              </Tooltip>
            )}

            {/* Hover overlay with quick actions */}
            <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col p-4">
              {/* Ratings section - top */}
              {availableRatings.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {availableRatings.slice(0, 4).map((rating) => (
                    <RatingBadge
                      key={rating.label}
                      label={rating.label}
                      value={rating.value}
                      max={rating.max}
                      color={rating.color}
                    />
                  ))}
                </div>
              )}

              {/* Spacer */}
              <div className="flex-1" />

              {/* Action buttons - bottom */}
              <div className="flex items-center justify-center gap-3">
                {/* Trailer button - only show if trailer is available */}
                {hasTrailer && (
                  <Tooltip content="Watch Trailer">
                    <button
                      onClick={handleTrailerClick}
                      className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 border border-white/20 rounded-full transition-colors"
                      aria-label="Watch Trailer"
                    >
                      <svg
                        className="w-4 h-4 text-white ml-0.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </button>
                  </Tooltip>
                )}

                {/* Request button */}
                <Tooltip content="Request">
                  <button
                    onClick={handleRequestClick}
                    className="w-10 h-10 flex items-center justify-center bg-annex-500/30 hover:bg-annex-500/50 border border-annex-500/50 text-annex-400 hover:text-white rounded-full transition-colors"
                    aria-label="Request"
                  >
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </button>
                </Tooltip>

                {/* View More button */}
                <Tooltip content="View Details">
                  <Link
                    to={`/${type}/${tmdbId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="w-10 h-10 flex items-center justify-center bg-white/10 hover:bg-white/20 border border-white/20 rounded-full transition-colors"
                    aria-label="View Details"
                  >
                    <svg
                      className="w-4 h-4 text-white"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </Link>
                </Tooltip>
              </div>
            </div>
          </div>

          {/* Title and year - clickable to go to detail page */}
          <Link to={`/${type}/${tmdbId}`} className="block mt-2">
            <h3 className="text-sm font-medium text-white/90 truncate group-hover:text-white">
              {title}
            </h3>
            <p className="text-xs text-white/50">
              {year > 0 ? year : "TBA"}
            </p>
          </Link>
        </div>

        {/* Trailer Modal */}
        <TrailerModal
          isOpen={showTrailer}
          onClose={() => setShowTrailer(false)}
          videoKey={trailerKey ?? null}
          title={`${title} - Trailer`}
        />

        {/* Request Dialog */}
        <RequestDialog
          isOpen={showRequestDialog}
          onClose={() => setShowRequestDialog(false)}
          tmdbId={tmdbId}
          type={type}
          title={title}
          year={year}
          posterPath={posterPath}
        />
      </>
    );
  }
);

MediaCard.displayName = "MediaCard";

export { MediaCard };
export type { MediaCardProps, LibraryInfo };
