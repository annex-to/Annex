import { HTMLAttributes, forwardRef } from "react";
import { Link } from "react-router-dom";
import { Badge } from "./Badge";

interface LibraryCardProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  title: string;
  type: "movie" | "tv";
  year?: number;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  rating?: number;
  quality?: string;
  genres?: string[];
  tmdbId?: number;
  overview?: string;
}

const LibraryCard = forwardRef<HTMLDivElement, LibraryCardProps>(
  (
    {
      id,
      title,
      type,
      year,
      posterUrl,
      rating,
      quality,
      genres,
      tmdbId,
      overview,
      className = "",
      ...props
    },
    ref
  ) => {
    // If we have a TMDB ID, link to our detail page; otherwise just show info
    const detailLink = tmdbId ? `/${type}/${tmdbId}` : undefined;

    const content = (
      <div
        ref={ref}
        className={`
          group relative cursor-pointer
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

          {/* Quality badge */}
          {quality && (
            <div className="absolute top-2 right-2">
              <Badge variant="default" className="text-xs">
                {quality}
              </Badge>
            </div>
          )}

          {/* In Library badge */}
          <div className="absolute top-2 left-2">
            <div className="bg-green-500/80 text-white text-xs px-1.5 py-0.5 rounded flex items-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
              In Library
            </div>
          </div>

          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/80 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col p-3">
            {/* Rating */}
            {rating && rating > 0 && (
              <div className="flex items-center gap-1 mb-2">
                <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                <span className="text-sm text-white font-medium">{rating.toFixed(1)}</span>
              </div>
            )}

            {/* Genres */}
            {genres && genres.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {genres.slice(0, 3).map((genre) => (
                  <span
                    key={genre}
                    className="text-xs bg-white/10 text-white/70 px-1.5 py-0.5 rounded"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {/* Overview */}
            {overview && (
              <p className="text-xs text-white/60 line-clamp-4 flex-1">
                {overview}
              </p>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Type badge */}
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-white/50 uppercase">
                {type === "movie" ? "Movie" : "TV Show"}
              </span>
              {tmdbId && (
                <span className="text-xs text-white/30">
                  TMDB: {tmdbId}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Title and year */}
        <div className="mt-2">
          <h3 className="text-sm font-medium text-white/90 truncate group-hover:text-white">
            {title}
          </h3>
          <p className="text-xs text-white/50">
            {year && year > 0 ? year : "Unknown year"}
          </p>
        </div>
      </div>
    );

    if (detailLink) {
      return <Link to={detailLink}>{content}</Link>;
    }

    return content;
  }
);

LibraryCard.displayName = "LibraryCard";

export { LibraryCard };
export type { LibraryCardProps };
