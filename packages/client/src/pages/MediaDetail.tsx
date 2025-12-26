import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Badge, Button, RequestDialog, Tooltip } from "../components/ui";
import { trpc } from "../trpc";

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

interface ServerAvailability {
  serverId: string;
  serverName: string;
  quality: string | null;
  addedAt: Date | null;
}

interface Season {
  seasonNumber: number;
  name: string | null;
  posterPath: string | null;
  airDate: string | null;
  episodeCount: number;
  episodes?: Episode[];
}

interface Episode {
  episodeNumber: number;
  name: string | null;
  stillPath: string | null;
  airDate: string | null;
  runtime: number | null;
  overview: string | null;
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// Build image URL - handles both full URLs (Trakt) and TMDB paths
function buildImageUrl(path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${TMDB_IMAGE_BASE}/${size}${path}`;
}

// Format episode air date
function formatAirDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
  const [showRequestDialog, setShowRequestDialog] = useState(false);
  const [expandedSeasons, setExpandedSeasons] = useState<Set<number>>(new Set());
  const [selectedSeasons, setSelectedSeasons] = useState<Set<number>>(new Set());
  const [selectedEpisodes, setSelectedEpisodes] = useState<Set<string>>(new Set());
  const [showRequestWithSelections, setShowRequestWithSelections] = useState(false);

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

  // JIT data fetching - handles caching and background refresh automatically
  const movieQuery = trpc.discovery.traktMovieDetails.useQuery(
    { tmdbId },
    { enabled: type === "movie" && tmdbId > 0 }
  );

  const tvShowQuery = trpc.discovery.traktTvShowDetails.useQuery(
    { tmdbId },
    { enabled: type === "tv" && tmdbId > 0 }
  );

  // Fetch library availability for TV shows
  const tvAvailabilityQuery = trpc.library.tvShowAvailability.useQuery(
    { tmdbId },
    { enabled: type === "tv" && tmdbId > 0 }
  );

  // Fetch library availability for movies
  const movieAvailabilityQuery = trpc.library.checkInLibrary.useQuery(
    { tmdbId, type: "movie" },
    { enabled: type === "movie" && tmdbId > 0 }
  );

  // Get the data based on type
  const isLoading = type === "movie" ? movieQuery.isLoading : tvShowQuery.isLoading;
  const error = type === "movie" ? movieQuery.error : tvShowQuery.error;
  const data = type === "movie" ? movieQuery.data : tvShowQuery.data;

  // Extract ratings from data
  const ratingsData = data?.ratings;

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
        <p className="text-red-400 text-lg">
          Failed to load {type === "movie" ? "movie" : "TV show"}
        </p>
        <p className="text-sm mt-2 text-white/30">{error.message}</p>
        <Button variant="secondary" className="mt-6" onClick={() => navigate("/")}>
          Back to Discover
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-24">
        <p className="text-white/50 text-lg">Not found</p>
        <Button variant="secondary" className="mt-6" onClick={() => navigate("/")}>
          Back to Discover
        </Button>
      </div>
    );
  }

  const backdropUrl = buildImageUrl(data.backdropPath, "original");
  const posterUrl = buildImageUrl(data.posterPath, "w500");

  const isTvShow = type === "tv";
  const tvData = isTvShow ? (data as NonNullable<typeof tvShowQuery.data>) : null;
  const movieData = !isTvShow ? (data as NonNullable<typeof movieQuery.data>) : null;

  // Library availability data
  const tvAvailability = tvAvailabilityQuery.data;
  const movieAvailability = movieAvailabilityQuery.data;

  // Helper to check if an episode is available on any server
  const getEpisodeAvailability = (seasonNumber: number, episodeNumber: number) => {
    if (!tvAvailability?.servers) return [];
    const available: Array<{ serverName: string; quality: string | null }> = [];
    for (const server of tvAvailability.servers) {
      const season = server.seasons.find((s) => s.seasonNumber === seasonNumber);
      const episode = season?.episodes.find((e) => e.episode === episodeNumber);
      if (episode) {
        available.push({ serverName: server.serverName, quality: episode.quality });
      }
    }
    return available;
  };

  // Helper to get season availability summary per server
  const getSeasonAvailability = (seasonNumber: number, totalEpisodes: number) => {
    if (!tvAvailability?.servers) return [];
    return tvAvailability.servers
      .map((server) => {
        const season = server.seasons.find((s) => s.seasonNumber === seasonNumber);
        return {
          serverName: server.serverName,
          availableCount: season?.episodeCount || 0,
          totalCount: totalEpisodes,
          isComplete: season?.episodeCount === totalEpisodes && totalEpisodes > 0,
        };
      })
      .filter((s) => s.availableCount > 0);
  };

  // Episode selection helpers
  const isSeasonFullySelected = (seasonNumber: number, episodeCount: number): boolean => {
    if (selectedSeasons.has(seasonNumber)) return true;

    const seasonEpisodes = Array.from({ length: episodeCount }, (_, i) => i + 1);
    return seasonEpisodes.every(ep => selectedEpisodes.has(`${seasonNumber}-${ep}`));
  };

  const isSeasonPartiallySelected = (seasonNumber: number, episodeCount: number): boolean => {
    if (selectedSeasons.has(seasonNumber)) return false;

    const seasonEpisodes = Array.from({ length: episodeCount }, (_, i) => i + 1);
    return seasonEpisodes.some(ep => selectedEpisodes.has(`${seasonNumber}-${ep}`));
  };

  const toggleSeasonSelection = (seasonNumber: number, episodeCount: number) => {
    const newSelectedSeasons = new Set(selectedSeasons);
    const newSelectedEpisodes = new Set(selectedEpisodes);

    if (newSelectedSeasons.has(seasonNumber)) {
      newSelectedSeasons.delete(seasonNumber);
    } else if (isSeasonFullySelected(seasonNumber, episodeCount)) {
      for (let i = 1; i <= episodeCount; i++) {
        newSelectedEpisodes.delete(`${seasonNumber}-${i}`);
      }
    } else {
      newSelectedSeasons.add(seasonNumber);
      for (let i = 1; i <= episodeCount; i++) {
        newSelectedEpisodes.delete(`${seasonNumber}-${i}`);
      }
    }

    setSelectedSeasons(newSelectedSeasons);
    setSelectedEpisodes(newSelectedEpisodes);
  };

  const toggleEpisodeSelection = (seasonNumber: number, episodeNumber: number, episodeCount: number) => {
    const newSelectedSeasons = new Set(selectedSeasons);
    const newSelectedEpisodes = new Set(selectedEpisodes);
    const key = `${seasonNumber}-${episodeNumber}`;

    if (newSelectedSeasons.has(seasonNumber)) {
      newSelectedSeasons.delete(seasonNumber);
      for (let i = 1; i <= episodeCount; i++) {
        if (i !== episodeNumber) {
          newSelectedEpisodes.add(`${seasonNumber}-${i}`);
        }
      }
    } else {
      if (newSelectedEpisodes.has(key)) {
        newSelectedEpisodes.delete(key);
      } else {
        newSelectedEpisodes.add(key);
      }
    }

    setSelectedSeasons(newSelectedSeasons);
    setSelectedEpisodes(newSelectedEpisodes);
  };

  const getSelectedCount = (): { seasons: number; episodes: number } => {
    let totalEpisodes = 0;

    if (tvData?.seasons) {
      for (const season of tvData.seasons) {
        if (selectedSeasons.has(season.seasonNumber)) {
          totalEpisodes += season.episodes?.length || season.episodeCount || 0;
        }
      }
    }

    for (const key of selectedEpisodes) {
      const [season] = key.split('-').map(Number);
      if (!selectedSeasons.has(season)) {
        totalEpisodes++;
      }
    }

    return { seasons: selectedSeasons.size, episodes: totalEpisodes };
  };

  const buildRequestPayload = () => {
    const seasons: number[] = Array.from(selectedSeasons);
    const episodes: Array<{ season: number; episode: number }> = [];

    for (const key of selectedEpisodes) {
      const [season, episode] = key.split('-').map(Number);
      if (!selectedSeasons.has(season)) {
        episodes.push({ season, episode });
      }
    }

    return {
      seasons: seasons.length > 0 ? seasons : undefined,
      episodes: episodes.length > 0 ? episodes : undefined,
    };
  };

  // Trailer key is now provided directly instead of videos array
  const trailerKey = data.trailerKey;
  const cast = (data.cast || []) as Array<{
    id: number;
    name: string;
    character: string;
    profilePath: string | null;
  }>;
  const crew = (data.crew || []) as Array<{ id: number; name: string; job: string }>;
  const displayCast = showAllCast ? cast : cast.slice(0, 12);

  return (
    <div className="min-h-screen">
      {/* Hero Section with Backdrop */}
      <div className="relative">
        {/* Backdrop Image */}
        {backdropUrl ? (
          <div className="h-[60vh] relative overflow-hidden">
            <img src={backdropUrl} alt="" className="w-full h-full object-cover" />
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
                {movieData?.tagline && (
                  <p className="text-white/70 mt-3 text-lg italic">"{movieData.tagline}"</p>
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
                  {ratingsData.mdblistScore !== null && (
                    <Tooltip content="MDBList Score">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-gradient-to-r from-annex-500/20 to-gold-500/20 border border-annex-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-white">{ratingsData.mdblistScore}</span>
                        <span className="text-white/50">MDBList</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.imdbScore !== null && (
                    <Tooltip content="IMDb (Internet Movie Database)">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-yellow-500/10 border border-yellow-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-yellow-400">
                          {ratingsData.imdbScore.toFixed(1)}
                        </span>
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
                        <span className="font-bold text-green-400">
                          {ratingsData.metacriticScore}
                        </span>
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
                        <span className="font-bold text-orange-400">
                          {ratingsData.letterboxdScore.toFixed(1)}
                        </span>
                        <span className="text-white/50">LB</span>
                      </div>
                    </Tooltip>
                  )}
                  {ratingsData.tmdbScore !== null && (
                    <Tooltip content="The Movie Database">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 bg-sky-500/10 border border-sky-500/30 rounded text-sm cursor-default">
                        <span className="font-bold text-sky-400">
                          {ratingsData.tmdbScore.toFixed(1)}
                        </span>
                        <span className="text-white/50">TMDB</span>
                      </div>
                    </Tooltip>
                  )}
                </div>
              )}

              {/* Genres */}
              {data.genres.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {data.genres.map((genre: string) => (
                    <span
                      key={genre}
                      className="px-3 py-1 text-sm bg-white/10 backdrop-blur-sm rounded-full text-white/90 border border-white/20"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              )}

              {/* Movie Library Availability */}
              {!isTvShow &&
                movieAvailability?.inLibrary &&
                movieAvailability.servers.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-white/50 text-sm">In Library:</span>
                    {movieAvailability.servers.map((server: ServerAvailability) => (
                      <span
                        key={server.serverId}
                        className="flex items-center gap-1.5 px-2.5 py-1 bg-green-500/20 text-green-400 border border-green-500/30 rounded text-sm"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                        {server.serverName}
                        {server.quality && (
                          <span className="text-green-400/70">{server.quality}</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

              {/* TV Show Library Summary */}
              {isTvShow && tvAvailability?.hasAnyEpisodes && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-white/50 text-sm">In Library:</span>
                  {tvAvailability.servers.map((server) => (
                    <span
                      key={server.serverId}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-green-500/20 text-green-400 border border-green-500/30 rounded text-sm"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                      {server.serverName}
                      <span className="text-green-400/70">
                        {server.totalEpisodes} ep{server.totalEpisodes !== 1 ? "s" : ""}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3 pt-2">
                <Button variant="primary" size="lg" onClick={() => setShowRequestDialog(true)}>
                  Request {type === "movie" ? "Movie" : "TV Show"}
                </Button>
                {trailerKey && (
                  <a
                    href={`https://www.youtube.com/watch?v=${trailerKey}`}
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
            {trailerKey && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-4">Trailer</h2>
                <div className="aspect-video rounded overflow-hidden border border-white/10">
                  <iframe
                    src={`https://www.youtube.com/embed/${trailerKey}`}
                    title="Trailer"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="w-full h-full"
                  />
                </div>
              </div>
            )}

            {/* Seasons Section (TV Shows only) */}
            {isTvShow && tvData?.seasons && tvData.seasons.length > 0 && (
              <div>
                <h2 className="text-xl font-semibold text-white mb-4">
                  Seasons ({tvData.seasons.length})
                </h2>
                <div className="space-y-3">
                  {tvData.seasons.map((season: Season) => {
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
                          {/* Season checkbox */}
                          <div
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSeasonSelection(season.seasonNumber, season.episodes?.length || season.episodeCount || 0);
                            }}
                            className={`
                              w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
                              transition-colors cursor-pointer
                              ${
                                selectedSeasons.has(season.seasonNumber) || isSeasonFullySelected(season.seasonNumber, season.episodes?.length || season.episodeCount || 0)
                                  ? "bg-annex-500 border-annex-500 text-white"
                                  : isSeasonPartiallySelected(season.seasonNumber, season.episodes?.length || season.episodeCount || 0)
                                  ? "bg-annex-500/50 border-annex-500 text-white"
                                  : "border-white/20 bg-white/5 hover:border-white/40"
                              }
                            `}
                          >
                            {(selectedSeasons.has(season.seasonNumber) || isSeasonFullySelected(season.seasonNumber, season.episodes?.length || season.episodeCount || 0)) && (
                              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            )}
                            {isSeasonPartiallySelected(season.seasonNumber, season.episodes?.length || season.episodeCount || 0) && (
                              <div className="w-2 h-0.5 bg-current" />
                            )}
                          </div>

                          {/* Season Poster */}
                          {season.posterPath ? (
                            <img
                              src={buildImageUrl(season.posterPath, "w92") ?? ""}
                              alt={season.name ?? ""}
                              className="w-12 h-18 object-cover rounded flex-shrink-0"
                            />
                          ) : (
                            <div className="w-12 h-18 bg-white/10 rounded flex-shrink-0 flex items-center justify-center">
                              <span className="text-white/30 text-xs">S{season.seasonNumber}</span>
                            </div>
                          )}

                          {/* Season Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-white font-medium truncate">
                                {season.name || `Season ${season.seasonNumber}`}
                              </h3>
                              {season.airDate && (
                                <span className="text-white/40 text-sm">
                                  ({new Date(season.airDate).getFullYear()})
                                </span>
                              )}
                              {/* Server availability badges */}
                              {getSeasonAvailability(
                                season.seasonNumber,
                                season.episodes?.length || season.episodeCount || 0
                              ).map((avail) => (
                                <span
                                  key={avail.serverName}
                                  className={`text-xs px-1.5 py-0.5 rounded flex items-center gap-1 ${
                                    avail.isComplete
                                      ? "bg-green-500/20 text-green-400 border border-green-500/30"
                                      : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                                  }`}
                                >
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path
                                      fillRule="evenodd"
                                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                  {avail.serverName}
                                  {!avail.isComplete && (
                                    <span className="opacity-70">
                                      ({avail.availableCount}/{avail.totalCount})
                                    </span>
                                  )}
                                </span>
                              ))}
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
                            {season.episodes.map((episode: Episode) => {
                              const episodeAvail = getEpisodeAvailability(
                                season.seasonNumber,
                                episode.episodeNumber
                              );
                              const isAvailable = episodeAvail.length > 0;

                              return (
                                <div
                                  key={episode.episodeNumber}
                                  className={`flex gap-4 p-4 border-b border-white/5 last:border-b-0 hover:bg-white/[0.02] transition-colors ${
                                    isAvailable ? "bg-green-500/[0.02]" : ""
                                  }`}
                                >
                                  {/* Episode checkbox */}
                                  <div
                                    onClick={() => toggleEpisodeSelection(
                                      season.seasonNumber,
                                      episode.episodeNumber,
                                      season.episodes?.length || 0
                                    )}
                                    className={`
                                      w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 mt-1
                                      transition-colors cursor-pointer
                                      ${
                                        selectedSeasons.has(season.seasonNumber) || selectedEpisodes.has(`${season.seasonNumber}-${episode.episodeNumber}`)
                                          ? "bg-annex-500 border-annex-500 text-white"
                                          : "border-white/20 bg-white/5 hover:border-white/40"
                                      }
                                    `}
                                  >
                                    {(selectedSeasons.has(season.seasonNumber) || selectedEpisodes.has(`${season.seasonNumber}-${episode.episodeNumber}`)) && (
                                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                      </svg>
                                    )}
                                  </div>

                                  {/* Episode Still */}
                                  <div className="relative flex-shrink-0">
                                    {episode.stillPath ? (
                                      <img
                                        src={buildImageUrl(episode.stillPath, "w185") ?? ""}
                                        alt={episode.name ?? ""}
                                        className="w-32 h-18 object-cover rounded"
                                      />
                                    ) : (
                                      <div className="w-32 h-18 bg-white/5 rounded flex items-center justify-center">
                                        <span className="text-white/20 text-sm">
                                          E{episode.episodeNumber}
                                        </span>
                                      </div>
                                    )}
                                    {/* Availability indicator overlay */}
                                    {isAvailable && (
                                      <div className="absolute top-1 right-1 bg-green-500 rounded-full p-0.5">
                                        <svg
                                          className="w-3 h-3 text-white"
                                          fill="currentColor"
                                          viewBox="0 0 20 20"
                                        >
                                          <path
                                            fillRule="evenodd"
                                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                                            clipRule="evenodd"
                                          />
                                        </svg>
                                      </div>
                                    )}
                                  </div>

                                  {/* Episode Info */}
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <h4 className="text-white/90 font-medium">
                                            <span className="text-white/40 mr-2">
                                              {episode.episodeNumber}.
                                            </span>
                                            {episode.name}
                                          </h4>
                                          {/* Server badges for this episode */}
                                          {episodeAvail.map((avail) => (
                                            <span
                                              key={avail.serverName}
                                              className="text-xs px-1.5 py-0.5 bg-green-500/20 text-green-400 rounded border border-green-500/30"
                                            >
                                              {avail.serverName}
                                              {avail.quality && (
                                                <span className="opacity-70 ml-1">
                                                  {avail.quality}
                                                </span>
                                              )}
                                            </span>
                                          ))}
                                        </div>
                                        <div className="flex items-center gap-3 mt-1 text-sm text-white/40">
                                          {episode.airDate && (
                                            <span>{formatAirDate(episode.airDate)}</span>
                                          )}
                                          {episode.runtime && <span>{episode.runtime}m</span>}
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
                              );
                            })}
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

                {/* Selection Summary & Request Button */}
                {isTvShow && tvData?.seasons && tvData.seasons.length > 0 && (
                  <div className="sticky bottom-0 mt-6 p-4 bg-black/90 backdrop-blur-xl border border-white/10 rounded">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1">
                        {(() => {
                          const { seasons, episodes } = getSelectedCount();
                          if (episodes === 0) {
                            return (
                              <p className="text-sm text-white/50">
                                Select seasons or episodes to request
                              </p>
                            );
                          }
                          return (
                            <p className="text-sm text-white/90">
                              <span className="font-medium text-annex-400">{episodes}</span> episode{episodes !== 1 ? 's' : ''} selected
                              {seasons > 0 && (
                                <span className="text-white/50">
                                  {' '}({seasons} full season{seasons !== 1 ? 's' : ''})
                                </span>
                              )}
                            </p>
                          );
                        })()}
                      </div>

                      <div className="flex gap-3">
                        {getSelectedCount().episodes > 0 && (
                          <Button
                            variant="ghost"
                            size="md"
                            onClick={() => {
                              setSelectedSeasons(new Set());
                              setSelectedEpisodes(new Set());
                            }}
                          >
                            Clear Selection
                          </Button>
                        )}

                        <Button
                          variant="primary"
                          size="md"
                          onClick={() => setShowRequestWithSelections(true)}
                          disabled={getSelectedCount().episodes === 0}
                        >
                          Request Selected Episodes
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
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
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">
                    Created By
                  </div>
                  <div className="text-white/90">{tvData.createdBy.join(", ")}</div>
                </div>
              )}

              {tvData?.networks && (tvData.networks as Array<{ name: string }>).length > 0 && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Network</div>
                  <div className="text-white/90">
                    {(tvData.networks as Array<{ name: string }>).map((n) => n.name).join(", ")}
                  </div>
                </div>
              )}

              {data.language && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Language</div>
                  <div className="text-white/90">{data.language}</div>
                </div>
              )}

              {data.country && (
                <div>
                  <div className="text-xs text-white/40 uppercase tracking-wide mb-1">Country</div>
                  <div className="text-white/90">{data.country}</div>
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
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                    />
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
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
              </a>
            </div>
          </div>
        </div>

        {/* Cast Section */}
        {cast.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-6">Cast</h2>
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 2xl:grid-cols-12 gap-4">
              {displayCast.map((person) => (
                <div key={person.id} className="text-center group">
                  {person.profilePath ? (
                    <img
                      src={buildImageUrl(person.profilePath, "w185") ?? ""}
                      alt={person.name}
                      className="w-full aspect-[2/3] object-cover rounded border border-white/10 group-hover:border-white/30 transition-colors"
                    />
                  ) : (
                    <div className="w-full aspect-[2/3] bg-white/5 rounded border border-white/10 flex items-center justify-center">
                      <svg
                        className="w-8 h-8 text-white/20"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
                      </svg>
                    </div>
                  )}
                  <p className="text-sm text-white/90 mt-2 truncate">{person.name}</p>
                  <p className="text-xs text-white/50 truncate">{person.character}</p>
                </div>
              ))}
            </div>
            {cast.length > 12 && (
              <button
                onClick={() => setShowAllCast(!showAllCast)}
                className="mt-6 text-sm text-annex-400 hover:text-annex-300 transition-colors"
              >
                {showAllCast ? "Show less" : `Show all ${cast.length} cast members`}
              </button>
            )}
          </div>
        )}

        {/* Crew Section */}
        {crew.length > 0 && (
          <div>
            <h2 className="text-xl font-semibold text-white mb-6">Crew</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {crew.map((person, index) => (
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
        isOpen={showRequestDialog || showRequestWithSelections}
        onClose={() => {
          setShowRequestDialog(false);
          setShowRequestWithSelections(false);
        }}
        tmdbId={tmdbId}
        type={type}
        title={data.title}
        year={data.year ?? 0}
        posterPath={data.posterPath}
        {...(showRequestWithSelections && type === 'tv' ? buildRequestPayload() : {})}
      />
    </div>
  );
}
