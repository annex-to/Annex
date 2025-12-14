import { useParams, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { useState, useEffect } from "react";
import { trpc } from "../trpc";
import { Button, Badge, Tooltip, RequestDialog } from "../components/ui";

// Chevron icon for expandable sections
function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-5 h-5 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// Format episode air date
function formatAirDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Helper to check if data has essential fields populated
function hasEssentialData(data: { cast?: unknown[]; videos?: unknown[] } | null): boolean {
  if (!data) return false;
  // Consider data "complete" if it has cast or videos
  const hasCast = Boolean(data.cast && data.cast.length > 0);
  const hasVideos = Boolean(data.videos && data.videos.length > 0);
  return hasCast || hasVideos;
}

function formatCurrency(amount: number | null): string | null {
  if (!amount || amount === 0) return null;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatRuntime(minutes: number | null): string | null {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

export default function MediaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tmdbId = parseInt(id || "0", 10);
  const [showAllCast, setShowAllCast] = useState(false);
  const [hydrationRequested, setHydrationRequested] = useState(false);
  const [showRequestDialog, setShowRequestDialog] = useState(false);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());

  const type = location.pathname.startsWith("/movie") ? "movie" : "tv";

  // Open request dialog if URL has ?request=true
  useEffect(() => {
    if (searchParams.get("request") === "true") {
      setShowRequestDialog(true);
      // Remove the query param so refreshing doesn't reopen
      searchParams.delete("request");
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Query local database first
  const movieLocal = trpc.discovery.movieDetailsLocal.useQuery(
    { tmdbId },
    { enabled: type === "movie" && tmdbId > 0 }
  );

  const tvShowLocal = trpc.discovery.tvShowDetailsLocal.useQuery(
    { tmdbId },
    { enabled: type === "tv" && tmdbId > 0 }
  );

  // Mutation to trigger hydration if needed
  const hydrateMutation = trpc.discovery.hydrateMedia.useMutation();

  // Get the local data
  const localData = type === "movie" ? movieLocal.data : tvShowLocal.data;
  const localIsLoading = type === "movie" ? movieLocal.isLoading : tvShowLocal.isLoading;
  const localError = type === "movie" ? movieLocal.error : tvShowLocal.error;

  // Check if we need to hydrate (no data or missing essential fields)
  const needsHydration = !localIsLoading && (!localData || !hasEssentialData(localData));

  // Trigger hydration if needed
  useEffect(() => {
    if (needsHydration && !hydrationRequested && tmdbId > 0) {
      setHydrationRequested(true);
      hydrateMutation.mutate(
        { tmdbId, type, includeSeasons: type === "tv" },
        {
          onSuccess: () => {
            // Refetch local data after a short delay to allow hydration to complete
            setTimeout(() => {
              if (type === "movie") {
                movieLocal.refetch();
              } else {
                tvShowLocal.refetch();
              }
            }, 2000);
          },
        }
      );
    }
  }, [needsHydration, hydrationRequested, tmdbId, type]);

  // Reset hydration state when navigating to a different item
  useEffect(() => {
    setHydrationRequested(false);
  }, [tmdbId]);

  // Use local data - the ratings are now included in the local response
  const isLoading = localIsLoading;
  const error = localError;
  const data = localData;

  // Extract ratings from local data
  const ratingsData = localData?.ratings;

  if (isLoading) {
    return (
      <div className="animate-pulse">
        <div className="h-[60vh] bg-white/5" />
        <div className="px-8 lg:px-16 -mt-32 relative">
          <div className="flex gap-8">
            <div className="w-[300px] aspect-[2/3] bg-white/10 rounded flex-shrink-0" />
            <div className="flex-1 space-y-4 pt-8">
              <div className="h-10 bg-white/10 rounded w-2/3" />
              <div className="h-6 bg-white/10 rounded w-1/3" />
              <div className="h-24 bg-white/10 rounded" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <p className="text-red-400 text-lg">Failed to load {type === "movie" ? "movie" : "TV show"}</p>
        <p className="text-sm mt-2 text-white/30">{error.message}</p>
        <Button variant="secondary" className="mt-6" onClick={() => navigate("/")}>
          Back to Discover
        </Button>
      </div>
    );
  }

  if (!data) {
    // If we're hydrating, show a loading state
    if (hydrateMutation.isPending || hydrationRequested) {
      return (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="animate-spin w-8 h-8 border-2 border-annex-500/30 border-t-annex-500 rounded-full mb-4" />
          <p className="text-white/70 text-lg">Loading media details...</p>
          <p className="text-white/40 text-sm mt-2">Fetching from TMDB</p>
        </div>
      );
    }

    return (
      <div className="text-center py-24">
        <p className="text-white/50 text-lg">Not found</p>
        <Button variant="secondary" className="mt-6" onClick={() => navigate("/")}>
          Back to Discover
        </Button>
      </div>
    );
  }

  const backdropUrl = data.backdropPath
    ? `${TMDB_IMAGE_BASE}/original${data.backdropPath}`
    : null;

  const posterUrl = data.posterPath
    ? `${TMDB_IMAGE_BASE}/w500${data.posterPath}`
    : null;

  const isTvShow = type === "tv";
  const tvData = isTvShow ? (data as typeof tvShowLocal.data) : null;
  const movieData = !isTvShow ? (data as typeof movieLocal.data) : null;

  const trailer = data.videos?.[0];
  const displayCast = showAllCast ? data.cast : data.cast?.slice(0, 12);

  return (
    <div className="min-h-screen">
      {/* Hero Section with Backdrop */}
      <div className="relative">
        {/* Backdrop Image */}
        {backdropUrl ? (
          <div className="h-[60vh] relative overflow-hidden">
            <img
              src={backdropUrl}
              alt=""
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/30" />
            <div className="absolute inset-0 bg-gradient-to-r from-black/80 via-transparent to-transparent" />
          </div>
        ) : (
          <div className="h-[40vh] bg-gradient-to-b from-white/5 to-black" />
        )}

        {/* Content overlaid on backdrop */}
        <div className="absolute inset-x-0 bottom-0 px-8 lg:px-16 pb-8">
          <div className="flex flex-col lg:flex-row gap-8 items-end lg:items-end">
            {/* Poster */}
            <div className="flex-shrink-0 hidden lg:block">
              {posterUrl ? (
                <img
                  src={posterUrl}
                  alt={data.title}
                  className="w-[280px] rounded border border-white/20 shadow-2xl"
                />
              ) : (
                <div className="w-[280px] aspect-[2/3] bg-white/10 rounded border border-white/20 flex items-center justify-center">
                  <span className="text-white/30">No poster</span>
                </div>
              )}
            </div>

            {/* Title and Quick Info */}
            <div className="flex-1 space-y-4">
              <div>
                <h1 className="text-4xl lg:text-5xl font-bold text-white drop-shadow-lg">
                  {data.title}
                </h1>
                {data.originalTitle !== data.title && (
                  <p className="text-white/60 mt-1 text-lg">{data.originalTitle}</p>
                )}
                {data.tagline && (
                  <p className="text-white/70 mt-3 text-lg italic">"{data.tagline}"</p>
                )}
              </div>

              {/* Quick metadata row */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-white/80">
                <span className="text-lg font-medium">{data.year}</span>
                {movieData?.runtime && (
                  <span className="text-white/60">{formatRuntime(movieData.runtime)}</span>
                )}
                {tvData && (
                  <>
                    <span className="text-white/60">
                      {tvData.numberOfSeasons} Season{tvData.numberOfSeasons !== 1 ? "s" : ""}
                    </span>
                    <Badge
                      variant={
                        tvData.status === "Returning Series"
                          ? "success"
                          : tvData.status === "Ended"
                          ? "default"
                          : "warning"
                      }
                    >
                      {tvData.status}
                    </Badge>
                  </>
                )}
              </div>

              {/* Compact Ratings Row */}
              {ratingsData && (
                <div className="flex flex-wrap items-center gap-2">
                  {ratingsData.aggregateScore !== null && (
                    <Tooltip content="MDBList Aggregate Score">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gradient-to-r from-annex-500/20 to-gold-500/20 border border-annex-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-white">{ratingsData.aggregateScore}</span>
                        <span className="text-white/50">MDBList</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.imdbScore !== null && (
                    <Tooltip content="IMDb (Internet Movie Database)">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-yellow-400">{ratingsData.imdbScore.toFixed(1)}</span>
                        <span className="text-white/50">IMDb</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.rtCriticScore !== null && (
                    <Tooltip content="Rotten Tomatoes Critics Score">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-red-500/10 border border-red-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-red-400">{ratingsData.rtCriticScore}%</span>
                        <span className="text-white/50">RT</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.metacriticScore !== null && (
                    <Tooltip content="Metacritic">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-500/10 border border-green-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-green-400">{ratingsData.metacriticScore}</span>
                        <span className="text-white/50">MC</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.traktScore !== null && (
                    <Tooltip content="Trakt">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-rose-500/10 border border-rose-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-rose-400">{ratingsData.traktScore}</span>
                        <span className="text-white/50">Trakt</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.letterboxdScore !== null && (
                    <Tooltip content="Letterboxd">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-orange-500/10 border border-orange-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-orange-400">{ratingsData.letterboxdScore.toFixed(1)}</span>
                        <span className="text-white/50">LB</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.tmdbScore !== null && (
                    <Tooltip content="The Movie Database">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-sky-500/10 border border-sky-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-sky-400">{ratingsData.tmdbScore.toFixed(1)}</span>
                        <span className="text-white/50">TMDB</span>
                      </div>
                    </Tooltip>
                  )}
                </div>
              )}
              {/* Show hydration status indicator when data is loading or being hydrated */}
              {(hydrateMutation.isPending || needsHydration) && !ratingsData && (
                <div className="flex gap-2 items-center">
                  <div className="animate-spin w-4 h-4 border-2 border-annex-500/30 border-t-annex-500 rounded-full" />
                  <span className="text-white/50 text-sm">Loading ratings...</span>
                </div>
              )}

              {/* Genres */}
              {data.genres.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {data.genres.map((genre) => (
                    <span
                      key={genre}
                      className="px-3 py-1 text-sm bg-white/10 backdrop-blur-sm rounded-full text-white/90 border border-white/20"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <Button variant="primary" size="lg" onClick={() => setShowRequestDialog(true)}>
                  Request {type === "movie" ? "Movie" : "TV Show"}
                </Button>
                {trailer && (
                  <a
                    href={`https://www.youtube.com/watch?v=${trailer.key}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Button variant="secondary" size="lg">
                      <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                      </svg>
                      Watch Trailer
                    </Button>
                  </a>
                )}
                <Button variant="ghost" onClick={() => navigate(-1)}>
                  Back
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="px-8 lg:px-16 py-12 space-y-12">
        {/* Two Column Layout: Overview + Details */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
          {/* Left: Overview */}
          <div className="lg:col-span-2 space-y-8">
            {/* Overview */}
            {data.overview && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-4">Overview</h2>
                <p className="text-white/70 leading-relaxed text-lg">{data.overview}</p>
              </div>
            )}

            {/* Trailer Section */}
            {trailer && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-4">
                  {trailer.type === "Trailer" ? "Trailer" : trailer.type}
                </h2>
                <div className="aspect-video rounded overflow-hidden border border-white/10">
                  <iframe
                    src={`https://www.youtube.com/embed/${trailer.key}`}
                    title={trailer.name}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="w-full h-full"
                  />
                </div>
                {data.videos && data.videos.length > 1 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {data.videos.slice(1, 5).map((video) => (
                      <a
                        key={video.id}
                        href={`https://www.youtube.com/watch?v=${video.key}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm px-3 py-1.5 bg-white/5 text-white/70 rounded border border-white/10 hover:bg-white/10 hover:text-white transition-colors"
                      >
                        {video.type}: {video.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Seasons Section (TV Shows only) */}
            {isTvShow && tvData?.seasons && tvData.seasons.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-4">
                  Seasons ({tvData.seasons.length})
                </h2>
                <div className="space-y-3">
                  {tvData.seasons.map((season) => {
                    const isExpanded = expandedSeasons.has(season.seasonNumber);
                    const toggleSeason = () => {
                      setExpandedSeasons((prev) => {
                        const next = new Set(prev);
                        if (next.has(season.seasonNumber)) {
                          next.delete(season.seasonNumber);
                        } else {
                          next.add(season.seasonNumber);
                        }
                        return next;
                      });
                    };

                    return (
                      <div
                        key={season.seasonNumber}
                        className="bg-white/5 rounded-lg border border-white/10 overflow-hidden"
                      >
                        {/* Season Header */}
                        <button
                          onClick={toggleSeason}
                          className="w-full flex items-center gap-4 p-4 hover:bg-white/5 transition-colors text-left"
                        >
                          {/* Season Poster */}
                          {season.posterPath ? (
                            <img
                              src={`${TMDB_IMAGE_BASE}/w92${season.posterPath}`}
                              alt={season.name}
                              className="w-12 h-18 object-cover rounded flex-shrink-0"
                            />
                          ) : (
                            <div className="w-12 h-18 bg-white/10 rounded flex-shrink-0 flex items-center justify-center">
                              <span className="text-white/30 text-xs">S{season.seasonNumber}</span>
                            </div>
                          )}

                          {/* Season Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <h3 className="text-white font-medium truncate">
                                {season.name || `Season ${season.seasonNumber}`}
                              </h3>
                              {season.airDate && (
                                <span className="text-white/40 text-sm">
                                  ({new Date(season.airDate).getFullYear()})
                                </span>
                              )}
                            </div>
                            <p className="text-white/50 text-sm">
                              {season.episodes?.length || season.episodeCount} episodes
                            </p>
                          </div>

                          {/* Expand Icon */}
                          <div className="text-white/40">
                            <ChevronIcon expanded={isExpanded} />
                          </div>
                        </button>

                        {/* Episodes List (Expanded) */}
                        {isExpanded && season.episodes && season.episodes.length > 0 && (
                          <div className="border-t border-white/10">
                            {season.episodes.map((episode) => (
                              <div
                                key={episode.episodeNumber}
                                className="flex gap-4 p-4 border-b border-white/5 last:border-b-0 hover:bg-white/[0.02] transition-colors"
                              >
                                {/* Episode Still */}
                                {episode.stillPath ? (
                                  <img
                                    src={`${TMDB_IMAGE_BASE}/w185${episode.stillPath}`}
                                    alt={episode.name}
                                    className="w-32 h-18 object-cover rounded flex-shrink-0"
                                  />
                                ) : (
                                  <div className="w-32 h-18 bg-white/5 rounded flex-shrink-0 flex items-center justify-center">
                                    <span className="text-white/20 text-sm">
                                      E{episode.episodeNumber}
                                    </span>
                                  </div>
                                )}

                                {/* Episode Info */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-start justify-between gap-2">
                                    <div>
                                      <h4 className="text-white/90 font-medium">
                                        <span className="text-white/40 mr-2">
                                          {episode.episodeNumber}.
                                        </span>
                                        {episode.name}
                                      </h4>
                                      <div className="flex items-center gap-3 mt-1 text-sm text-white/40">
                                        {episode.airDate && (
                                          <span>{formatAirDate(episode.airDate)}</span>
                                        )}
                                        {episode.runtime && (
                                          <span>{episode.runtime}m</span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                  {episode.overview && (
                                    <p className="text-white/50 text-sm mt-2 line-clamp-2">
                                      {episode.overview}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Show message if no episodes loaded */}
                        {isExpanded && (!season.episodes || season.episodes.length === 0) && (
                          <div className="border-t border-white/10 p-4 text-center text-white/40 text-sm">
                            No episode details available
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>

          {/* Right: Details Sidebar */}
          <div className="space-y-6">
            <div className="bg-white/5 rounded-lg border border-white/10 p-6 space-y-4">
              <h3 className="text-lg font-semibold text-white">Details</h3>

              {movieData?.director && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Director</div>
                  <div className="text-white/90">{movieData.director}</div>
                </div>
              )}

              {tvData?.createdBy && tvData.createdBy.length > 0 && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Created By</div>
                  <div className="text-white/90">{tvData.createdBy.join(", ")}</div>
                </div>
              )}

              {tvData?.networks && tvData.networks.length > 0 && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Network</div>
                  <div className="text-white/90">{tvData.networks.map((n: { name: string }) => n.name).join(", ")}</div>
                </div>
              )}

              {data.spokenLanguages && data.spokenLanguages.length > 0 && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Languages</div>
                  <div className="text-white/90">{data.spokenLanguages.map(l => l.englishName).join(", ")}</div>
                </div>
              )}

              {data.productionCountries && data.productionCountries.length > 0 && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Countries</div>
                  <div className="text-white/90">{data.productionCountries.join(", ")}</div>
                </div>
              )}

              {movieData && formatCurrency(movieData.budget) && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Budget</div>
                  <div className="text-white/90">{formatCurrency(movieData.budget)}</div>
                </div>
              )}

              {movieData && formatCurrency(movieData.revenue) && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Box Office</div>
                  <div className="text-white/90">{formatCurrency(movieData.revenue)}</div>
                </div>
              )}

              {tvData && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Episodes</div>
                  <div className="text-white/90">{tvData.numberOfEpisodes} episodes</div>
                </div>
              )}
            </div>

            {/* External Links */}
            <div className="flex flex-col gap-2">
              {data.imdbId && (
                <a
                  href={`https://www.imdb.com/title/${data.imdbId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-yellow-500/10 text-yellow-400 rounded border border-yellow-500/30 hover:bg-yellow-500/20 transition-colors"
                >
                  <span className="font-semibold">IMDb</span>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              )}
              <a
                href={`https://www.themoviedb.org/${type}/${data.tmdbId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 px-4 py-2.5 bg-sky-500/10 text-sky-400 rounded border border-sky-500/30 hover:bg-sky-500/20 transition-colors"
              >
                <span className="font-semibold">TMDB</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            </div>

            {/* Production Companies */}
            {data.productionCompanies && data.productionCompanies.length > 0 && (
              <div className="bg-white/5 rounded-lg border border-white/10 p-6">
                <h3 className="text-lg font-semibold text-white mb-4">Production</h3>
                <div className="space-y-3">
                  {data.productionCompanies.slice(0, 5).map((company) => (
                    <div key={company.id} className="flex items-center gap-3">
                      {company.logoPath ? (
                        <img
                          src={`${TMDB_IMAGE_BASE}/w92${company.logoPath}`}
                          alt={company.name}
                          className="h-6 w-auto object-contain brightness-0 invert opacity-60"
                        />
                      ) : (
                        <span className="text-sm text-white/60">{company.name}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Cast Section */}
        {data.cast && data.cast.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-6">Cast</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-4">
              {displayCast?.map((person) => (
                <div key={person.id} className="text-center group">
                  {person.profilePath ? (
                    <img
                      src={`${TMDB_IMAGE_BASE}/w185${person.profilePath}`}
                      alt={person.name}
                      className="w-full aspect-[2/3] object-cover rounded border border-white/10 group-hover:border-white/30 transition-colors"
                    />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-white/5 rounded border border-white/10 flex items-center justify-center">
                      <svg className="w-8 h-8 text-white/20" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                      </svg>
                    </div>
                  )}
                  <p className="text-sm text-white/90 mt-2 truncate">{person.name}</p>
                  <p className="text-xs text-white/50 truncate">{person.character}</p>
                </div>
              ))}
            </div>
            {data.cast.length > 12 && (
              <button
                onClick={() => setShowAllCast(!showAllCast)}
                className="mt-6 text-sm text-annex-400 hover:text-annex-300 transition-colors"
              >
                {showAllCast ? "Show less" : `Show all ${data.cast.length} cast members`}
              </button>
            )}
          </div>
        )}

        {/* Crew Section */}
        {data.crew && data.crew.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-6">Crew</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {data.crew.map((person, index) => (
                <div
                  key={`${person.id}-${person.job}-${index}`}
                  className="bg-white/5 rounded px-4 py-3 border border-white/10"
                >
                  <p className="text-sm text-white/90 truncate">{person.name}</p>
                  <p className="text-xs text-white/50 truncate">{person.job}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Request Dialog */}
      <RequestDialog
        isOpen={showRequestDialog}
        onClose={() => setShowRequestDialog(false)}
        tmdbId={tmdbId}
        type={type}
        title={data.title}
        year={data.year}
        posterPath={data.posterPath}
      />
    </div>
  );
}
