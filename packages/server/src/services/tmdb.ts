/**
 * TMDB API Service
 *
 * Handles all interactions with The Movie Database API including:
 * - Trending movies and TV shows
 * - Search functionality
 * - Detailed movie/TV/season information
 * - Rate limiting and caching
 */

import { getConfig } from "../config/index.js";
import { prisma } from "../db/client.js";
import type {
  Movie,
  MovieDetails,
  TvShow,
  TvShowDetails,
  Season,
  Episode,
  TrendingResult,
  SearchResult,
  Video,
  CastMember,
  CrewMember,
  SpokenLanguage,
  ProductionCompany,
  Network,
} from "@annex/shared";

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

// Rate limiting
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 25; // ~40 requests/second max

interface TMDBResponse<T> {
  results: T[];
  page: number;
  total_pages: number;
  total_results: number;
}

interface TMDBVideo {
  id: string;
  key: string;
  name: string;
  site: string;
  size: number;
  type: string;
  official: boolean;
  published_at: string;
}

interface TMDBCastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
  order: number;
}

interface TMDBCrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profile_path: string | null;
}

interface TMDBSpokenLanguage {
  english_name: string;
  iso_639_1: string;
  name: string;
}

interface TMDBProductionCompany {
  id: number;
  name: string;
  logo_path: string | null;
  origin_country: string;
}

interface TMDBProductionCountry {
  iso_3166_1: string;
  name: string;
}

interface TMDBMovie {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date: string;
  runtime: number | null;
  genres: { id: number; name: string }[];
  vote_average: number;
  vote_count: number;
  imdb_id?: string;
  status?: string;
  tagline?: string;
  budget?: number;
  revenue?: number;
  original_language?: string;
  spoken_languages?: TMDBSpokenLanguage[];
  production_companies?: TMDBProductionCompany[];
  production_countries?: TMDBProductionCountry[];
  videos?: { results: TMDBVideo[] };
  credits?: {
    cast: TMDBCastMember[];
    crew: TMDBCrewMember[];
  };
}

interface TMDBNetwork {
  id: number;
  name: string;
  logo_path: string | null;
  origin_country: string;
}

interface TMDBCreatedBy {
  id: number;
  name: string;
  profile_path: string | null;
}

interface TMDBTvShow {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  first_air_date: string;
  last_air_date: string | null;
  status: string;
  genres: { id: number; name: string }[];
  vote_average: number;
  vote_count: number;
  number_of_seasons: number;
  number_of_episodes: number;
  external_ids?: { imdb_id?: string };
  seasons?: TMDBSeason[];
  tagline?: string;
  original_language?: string;
  spoken_languages?: TMDBSpokenLanguage[];
  production_companies?: TMDBProductionCompany[];
  production_countries?: TMDBProductionCountry[];
  networks?: TMDBNetwork[];
  created_by?: TMDBCreatedBy[];
  videos?: { results: TMDBVideo[] };
  credits?: {
    cast: TMDBCastMember[];
    crew: TMDBCrewMember[];
  };
}

interface TMDBSeason {
  season_number: number;
  name: string;
  overview: string;
  poster_path: string | null;
  air_date: string | null;
  episode_count: number;
  episodes?: TMDBEpisode[];
}

interface TMDBEpisode {
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  air_date: string | null;
  runtime: number | null;
}

interface TMDBTrendingItem {
  id: number;
  media_type?: "movie" | "tv";
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  overview: string;
}

interface TMDBSearchItem {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  poster_path: string | null;
  backdrop_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  overview: string;
}

class TMDBService {
  private apiKey: string | undefined;

  constructor() {
    this.apiKey = getConfig().tmdb.apiKey;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - lastRequestTime;
    if (elapsed < MIN_REQUEST_INTERVAL) {
      await new Promise((resolve) =>
        setTimeout(resolve, MIN_REQUEST_INTERVAL - elapsed)
      );
    }
    lastRequestTime = Date.now();
  }

  private async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    if (!this.apiKey) {
      throw new Error("TMDB API key not configured. Set TMDB_API_KEY in your environment.");
    }

    await this.rateLimit();

    const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
    url.searchParams.set("api_key", this.apiKey);
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });

    const response = await fetch(url.toString());

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TMDB API error ${response.status}: ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get trending movies or TV shows
   */
  async getTrending(
    type: "movie" | "tv",
    timeWindow: "day" | "week" = "week",
    page = 1
  ): Promise<{ results: TrendingResult[]; page: number; totalPages: number; totalResults: number }> {
    const data = await this.fetch<TMDBResponse<TMDBTrendingItem>>(
      `/trending/${type}/${timeWindow}`,
      { page: page.toString() }
    );

    const results: TrendingResult[] = data.results.map((item) => ({
      type,
      tmdbId: item.id,
      title: type === "movie" ? item.title! : item.name!,
      posterPath: item.poster_path,
      backdropPath: item.backdrop_path,
      year: this.extractYear(type === "movie" ? item.release_date : item.first_air_date),
      voteAverage: item.vote_average,
      overview: item.overview,
    }));

    return {
      results,
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
    };
  }

  /**
   * Search for movies, TV shows, or both
   */
  async search(
    query: string,
    type: "movie" | "tv" | "multi" = "multi",
    page = 1
  ): Promise<{ results: SearchResult[]; page: number; totalPages: number; totalResults: number }> {
    const endpoint = type === "multi" ? "/search/multi" : `/search/${type}`;
    const data = await this.fetch<TMDBResponse<TMDBSearchItem>>(endpoint, {
      query,
      page: page.toString(),
      include_adult: "false",
    });

    const results: SearchResult[] = data.results
      .filter((item) => item.media_type !== "person")
      .map((item) => {
        const mediaType = type === "multi" ? item.media_type : type;
        const isMovie = mediaType === "movie";
        return {
          type: mediaType as "movie" | "tv",
          tmdbId: item.id,
          title: isMovie ? item.title! : item.name!,
          posterPath: item.poster_path,
          backdropPath: item.backdrop_path,
          year: this.extractYear(isMovie ? item.release_date : item.first_air_date),
          voteAverage: item.vote_average,
          overview: item.overview,
        };
      });

    return {
      results,
      page: data.page,
      totalPages: data.total_pages,
      totalResults: data.total_results,
    };
  }

  /**
   * Get detailed movie information
   */
  async getMovie(tmdbId: number): Promise<Movie> {
    const data = await this.fetch<TMDBMovie>(`/movie/${tmdbId}`, {
      append_to_response: "external_ids",
    });

    const movie: Movie = {
      tmdbId: data.id,
      title: data.title,
      originalTitle: data.original_title,
      year: this.extractYear(data.release_date),
      overview: data.overview,
      posterPath: data.poster_path,
      backdropPath: data.backdrop_path,
      releaseDate: data.release_date,
      runtime: data.runtime,
      genres: data.genres.map((g) => g.name),
      voteAverage: data.vote_average,
      voteCount: data.vote_count,
    };

    // Cache to database
    await this.cacheMediaItem(movie, "movie", data.imdb_id);

    return movie;
  }

  /**
   * Get extended movie details including videos, credits, spoken languages
   */
  async getMovieDetails(tmdbId: number): Promise<MovieDetails> {
    const data = await this.fetch<TMDBMovie>(`/movie/${tmdbId}`, {
      append_to_response: "external_ids,videos,credits",
    });

    // Find director from crew
    const director = data.credits?.crew.find((c) => c.job === "Director")?.name || null;

    // Filter videos to get trailers (prefer official YouTube trailers)
    const videos: Video[] = (data.videos?.results || [])
      .filter((v) => v.site === "YouTube")
      .sort((a, b) => {
        // Prioritize: official trailers > official teasers > other official > non-official
        const getScore = (v: TMDBVideo) => {
          let score = 0;
          if (v.official) score += 10;
          if (v.type === "Trailer") score += 5;
          if (v.type === "Teaser") score += 3;
          return score;
        };
        return getScore(b) - getScore(a);
      })
      .map((v) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        site: v.site,
        type: v.type,
        official: v.official,
      }));

    // Map cast (limit to top 20)
    const cast: CastMember[] = (data.credits?.cast || [])
      .slice(0, 20)
      .map((c) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
        order: c.order,
      }));

    // Map crew (key roles only)
    const keyRoles = ["Director", "Writer", "Screenplay", "Producer", "Executive Producer", "Director of Photography", "Composer"];
    const crew: CrewMember[] = (data.credits?.crew || [])
      .filter((c) => keyRoles.includes(c.job))
      .map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
        profilePath: c.profile_path,
      }));

    // Map spoken languages
    const spokenLanguages: SpokenLanguage[] = (data.spoken_languages || []).map((l) => ({
      englishName: l.english_name,
      iso: l.iso_639_1,
      name: l.name,
    }));

    // Map production companies
    const productionCompanies: ProductionCompany[] = (data.production_companies || []).map((c) => ({
      id: c.id,
      name: c.name,
      logoPath: c.logo_path,
      originCountry: c.origin_country,
    }));

    // Map production countries
    const productionCountries = (data.production_countries || []).map((c) => c.name);

    const movieDetails: MovieDetails = {
      tmdbId: data.id,
      title: data.title,
      originalTitle: data.original_title,
      year: this.extractYear(data.release_date),
      overview: data.overview,
      posterPath: data.poster_path,
      backdropPath: data.backdrop_path,
      releaseDate: data.release_date,
      runtime: data.runtime,
      genres: data.genres.map((g) => g.name),
      voteAverage: data.vote_average,
      voteCount: data.vote_count,
      tagline: data.tagline || null,
      budget: data.budget || null,
      revenue: data.revenue || null,
      originalLanguage: data.original_language || null,
      spokenLanguages,
      productionCompanies,
      productionCountries,
      videos,
      cast,
      crew,
      director,
      imdbId: data.imdb_id || null,
    };

    // Cache basic info to database
    await this.cacheMediaItem(movieDetails, "movie", data.imdb_id);

    return movieDetails;
  }

  /**
   * Get detailed TV show information
   */
  async getTvShow(tmdbId: number): Promise<TvShow> {
    const data = await this.fetch<TMDBTvShow>(`/tv/${tmdbId}`, {
      append_to_response: "external_ids",
    });

    const tvShow: TvShow = {
      tmdbId: data.id,
      title: data.name,
      originalTitle: data.original_name,
      year: this.extractYear(data.first_air_date),
      overview: data.overview,
      posterPath: data.poster_path,
      backdropPath: data.backdrop_path,
      firstAirDate: data.first_air_date,
      lastAirDate: data.last_air_date,
      status: this.mapTvStatus(data.status),
      genres: data.genres.map((g) => g.name),
      voteAverage: data.vote_average,
      voteCount: data.vote_count,
      numberOfSeasons: data.number_of_seasons,
      numberOfEpisodes: data.number_of_episodes,
    };

    // Cache to database
    await this.cacheMediaItem(tvShow, "tv", data.external_ids?.imdb_id);

    return tvShow;
  }

  /**
   * Get extended TV show details including videos, credits, spoken languages
   */
  async getTvShowDetails(tmdbId: number): Promise<TvShowDetails> {
    const data = await this.fetch<TMDBTvShow>(`/tv/${tmdbId}`, {
      append_to_response: "external_ids,videos,credits",
    });

    // Filter videos to get trailers (prefer official YouTube trailers)
    const videos: Video[] = (data.videos?.results || [])
      .filter((v) => v.site === "YouTube")
      .sort((a, b) => {
        const getScore = (v: TMDBVideo) => {
          let score = 0;
          if (v.official) score += 10;
          if (v.type === "Trailer") score += 5;
          if (v.type === "Teaser") score += 3;
          return score;
        };
        return getScore(b) - getScore(a);
      })
      .map((v) => ({
        id: v.id,
        key: v.key,
        name: v.name,
        site: v.site,
        type: v.type,
        official: v.official,
      }));

    // Map cast (limit to top 20)
    const cast: CastMember[] = (data.credits?.cast || [])
      .slice(0, 20)
      .map((c) => ({
        id: c.id,
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
        order: c.order,
      }));

    // Map crew (key roles only)
    const keyRoles = ["Creator", "Executive Producer", "Showrunner", "Director of Photography", "Composer"];
    const crew: CrewMember[] = (data.credits?.crew || [])
      .filter((c) => keyRoles.includes(c.job))
      .map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
        profilePath: c.profile_path,
      }));

    // Map spoken languages
    const spokenLanguages: SpokenLanguage[] = (data.spoken_languages || []).map((l) => ({
      englishName: l.english_name,
      iso: l.iso_639_1,
      name: l.name,
    }));

    // Map production companies
    const productionCompanies: ProductionCompany[] = (data.production_companies || []).map((c) => ({
      id: c.id,
      name: c.name,
      logoPath: c.logo_path,
      originCountry: c.origin_country,
    }));

    // Map production countries
    const productionCountries = (data.production_countries || []).map((c) => c.name);

    // Map networks
    const networks: Network[] = (data.networks || []).map((n) => ({
      id: n.id,
      name: n.name,
      logoPath: n.logo_path,
      originCountry: n.origin_country,
    }));

    // Map creators
    const createdBy = (data.created_by || []).map((c) => c.name);

    const tvShowDetails: TvShowDetails = {
      tmdbId: data.id,
      title: data.name,
      originalTitle: data.original_name,
      year: this.extractYear(data.first_air_date),
      overview: data.overview,
      posterPath: data.poster_path,
      backdropPath: data.backdrop_path,
      firstAirDate: data.first_air_date,
      lastAirDate: data.last_air_date,
      status: this.mapTvStatus(data.status),
      genres: data.genres.map((g) => g.name),
      voteAverage: data.vote_average,
      voteCount: data.vote_count,
      numberOfSeasons: data.number_of_seasons,
      numberOfEpisodes: data.number_of_episodes,
      tagline: data.tagline || null,
      originalLanguage: data.original_language || null,
      spokenLanguages,
      productionCompanies,
      productionCountries,
      networks,
      createdBy,
      videos,
      cast,
      crew,
      imdbId: data.external_ids?.imdb_id || null,
    };

    // Cache basic info to database
    await this.cacheMediaItem(tvShowDetails, "tv", data.external_ids?.imdb_id);

    return tvShowDetails;
  }

  /**
   * Get TV season with episodes
   */
  async getSeason(tmdbId: number, seasonNumber: number): Promise<Season & { episodes: Episode[] }> {
    const data = await this.fetch<TMDBSeason>(`/tv/${tmdbId}/season/${seasonNumber}`);

    const season: Season & { episodes: Episode[] } = {
      seasonNumber: data.season_number,
      name: data.name,
      overview: data.overview,
      posterPath: data.poster_path,
      airDate: data.air_date,
      episodeCount: data.episode_count,
      episodes: (data.episodes || []).map((ep) => ({
        episodeNumber: ep.episode_number,
        seasonNumber: ep.season_number,
        name: ep.name,
        overview: ep.overview,
        stillPath: ep.still_path,
        airDate: ep.air_date,
        runtime: ep.runtime,
      })),
    };

    return season;
  }

  /**
   * Get popular movies (for initial database population)
   */
  async getPopularMovies(page = 1): Promise<{ results: TrendingResult[]; page: number; totalPages: number }> {
    const data = await this.fetch<TMDBResponse<TMDBTrendingItem>>("/movie/popular", {
      page: page.toString(),
    });

    const results: TrendingResult[] = data.results.map((item) => ({
      type: "movie" as const,
      tmdbId: item.id,
      title: item.title!,
      posterPath: item.poster_path,
      backdropPath: item.backdrop_path,
      year: this.extractYear(item.release_date),
      voteAverage: item.vote_average,
      overview: item.overview,
    }));

    return { results, page: data.page, totalPages: data.total_pages };
  }

  /**
   * Get popular TV shows (for initial database population)
   */
  async getPopularTvShows(page = 1): Promise<{ results: TrendingResult[]; page: number; totalPages: number }> {
    const data = await this.fetch<TMDBResponse<TMDBTrendingItem>>("/tv/popular", {
      page: page.toString(),
    });

    const results: TrendingResult[] = data.results.map((item) => ({
      type: "tv" as const,
      tmdbId: item.id,
      title: item.name!,
      posterPath: item.poster_path,
      backdropPath: item.backdrop_path,
      year: this.extractYear(item.first_air_date),
      voteAverage: item.vote_average,
      overview: item.overview,
    }));

    return { results, page: data.page, totalPages: data.total_pages };
  }

  /**
   * Discover movies with filters
   */
  async discoverMovies(options: {
    page?: number;
    sortBy?: string;
    year?: number;
    withGenres?: string;
    voteAverageGte?: number;
  } = {}): Promise<{ results: TrendingResult[]; page: number; totalPages: number }> {
    const params: Record<string, string> = {
      page: (options.page || 1).toString(),
      sort_by: options.sortBy || "popularity.desc",
      include_adult: "false",
    };

    if (options.year) params.primary_release_year = options.year.toString();
    if (options.withGenres) params.with_genres = options.withGenres;
    if (options.voteAverageGte) params["vote_average.gte"] = options.voteAverageGte.toString();

    const data = await this.fetch<TMDBResponse<TMDBTrendingItem>>("/discover/movie", params);

    const results: TrendingResult[] = data.results.map((item) => ({
      type: "movie" as const,
      tmdbId: item.id,
      title: item.title!,
      posterPath: item.poster_path,
      backdropPath: item.backdrop_path,
      year: this.extractYear(item.release_date),
      voteAverage: item.vote_average,
      overview: item.overview,
    }));

    return { results, page: data.page, totalPages: data.total_pages };
  }

  /**
   * Discover TV shows with filters
   */
  async discoverTvShows(options: {
    page?: number;
    sortBy?: string;
    year?: number;
    withGenres?: string;
    voteAverageGte?: number;
  } = {}): Promise<{ results: TrendingResult[]; page: number; totalPages: number }> {
    const params: Record<string, string> = {
      page: (options.page || 1).toString(),
      sort_by: options.sortBy || "popularity.desc",
      include_adult: "false",
    };

    if (options.year) params.first_air_date_year = options.year.toString();
    if (options.withGenres) params.with_genres = options.withGenres;
    if (options.voteAverageGte) params["vote_average.gte"] = options.voteAverageGte.toString();

    const data = await this.fetch<TMDBResponse<TMDBTrendingItem>>("/discover/tv", params);

    const results: TrendingResult[] = data.results.map((item) => ({
      type: "tv" as const,
      tmdbId: item.id,
      title: item.name!,
      posterPath: item.poster_path,
      backdropPath: item.backdrop_path,
      year: this.extractYear(item.first_air_date),
      voteAverage: item.vote_average,
      overview: item.overview,
    }));

    return { results, page: data.page, totalPages: data.total_pages };
  }

  /**
   * Cache a media item to the database (basic info only - used during browsing)
   */
  private async cacheMediaItem(
    media: Movie | TvShow,
    type: "movie" | "tv",
    imdbId?: string
  ): Promise<void> {
    const id = `tmdb-${type}-${media.tmdbId}`;

    const releaseDate = "releaseDate" in media ? media.releaseDate : media.firstAirDate;
    const year = this.extractYear(releaseDate) || null;

    try {
      await prisma.mediaItem.upsert({
        where: { id },
        create: {
          id,
          tmdbId: media.tmdbId,
          imdbId: imdbId || null,
          type: type === "movie" ? "MOVIE" : "TV",
          title: media.title,
          originalTitle: media.originalTitle,
          year,
          releaseDate,
          overview: media.overview,
          posterPath: media.posterPath,
          backdropPath: media.backdropPath,
          genres: media.genres,
          runtime: "runtime" in media ? media.runtime : null,
          status: "status" in media ? media.status : null,
          ratings: {
            create: {
              tmdbScore: media.voteAverage,
              tmdbVotes: media.voteCount,
            },
          },
        },
        update: {
          title: media.title,
          originalTitle: media.originalTitle,
          year,
          releaseDate,
          overview: media.overview,
          posterPath: media.posterPath,
          backdropPath: media.backdropPath,
          genres: media.genres,
          runtime: "runtime" in media ? media.runtime : null,
          status: "status" in media ? media.status : null,
          imdbId: imdbId || undefined,
          ratings: {
            upsert: {
              create: {
                tmdbScore: media.voteAverage,
                tmdbVotes: media.voteCount,
              },
              update: {
                tmdbScore: media.voteAverage,
                tmdbVotes: media.voteCount,
              },
            },
          },
        },
      });
    } catch (error) {
      // Log but don't fail the request if caching fails
      console.error("Failed to cache media item:", error);
    }
  }

  /**
   * Fully hydrate a movie with all TMDB details into the database
   * This stores everything locally so we never need to call TMDB again for this movie
   */
  async hydrateMovie(tmdbId: number): Promise<boolean> {
    try {
      const data = await this.fetch<TMDBMovie>(`/movie/${tmdbId}`, {
        append_to_response: "external_ids,videos,credits",
      });

      const id = `tmdb-movie-${tmdbId}`;
      const year = this.extractYear(data.release_date) || null;

      // Find director from crew
      const director = data.credits?.crew.find((c) => c.job === "Director")?.name || null;

      // Process videos (filter and sort by priority)
      const videos = (data.videos?.results || [])
        .filter((v) => v.site === "YouTube")
        .sort((a, b) => {
          const getScore = (v: TMDBVideo) => {
            let score = 0;
            if (v.official) score += 10;
            if (v.type === "Trailer") score += 5;
            if (v.type === "Teaser") score += 3;
            return score;
          };
          return getScore(b) - getScore(a);
        })
        .map((v) => ({
          id: v.id,
          key: v.key,
          name: v.name,
          site: v.site,
          type: v.type,
          official: v.official,
        }));

      // Process cast (limit to top 20)
      const cast = (data.credits?.cast || [])
        .slice(0, 20)
        .map((c) => ({
          id: c.id,
          name: c.name,
          character: c.character,
          profilePath: c.profile_path,
          order: c.order,
        }));

      // Process crew (key roles only)
      const keyRoles = ["Director", "Writer", "Screenplay", "Producer", "Executive Producer", "Director of Photography", "Composer"];
      const crew = (data.credits?.crew || [])
        .filter((c) => keyRoles.includes(c.job))
        .map((c) => ({
          id: c.id,
          name: c.name,
          job: c.job,
          department: c.department,
          profilePath: c.profile_path,
        }));

      // Process production companies
      const productionCompanies = (data.production_companies || []).map((c) => ({
        id: c.id,
        name: c.name,
        logoPath: c.logo_path,
        originCountry: c.origin_country,
      }));

      // Process spoken languages
      const spokenLanguages = (data.spoken_languages || []).map((l) => l.iso_639_1);

      // Process production countries
      const productionCountries = (data.production_countries || []).map((c) => c.iso_3166_1);

      await prisma.mediaItem.upsert({
        where: { id },
        create: {
          id,
          tmdbId: data.id,
          imdbId: data.imdb_id || null,
          type: "MOVIE",
          title: data.title,
          originalTitle: data.original_title,
          year,
          releaseDate: data.release_date,
          overview: data.overview,
          tagline: data.tagline || null,
          posterPath: data.poster_path,
          backdropPath: data.backdrop_path,
          genres: data.genres.map((g) => g.name),
          runtime: data.runtime,
          status: data.status || null,
          language: data.original_language || null,
          spokenLanguages,
          productionCountries,
          director,
          budget: data.budget ? BigInt(data.budget) : null,
          revenue: data.revenue ? BigInt(data.revenue) : null,
          cast,
          crew,
          videos,
          productionCompanies,
          tmdbUpdatedAt: new Date(),
          ratings: {
            create: {
              tmdbScore: data.vote_average,
              tmdbVotes: data.vote_count,
            },
          },
        },
        update: {
          imdbId: data.imdb_id || null,
          title: data.title,
          originalTitle: data.original_title,
          year,
          releaseDate: data.release_date,
          overview: data.overview,
          tagline: data.tagline || null,
          posterPath: data.poster_path,
          backdropPath: data.backdrop_path,
          genres: data.genres.map((g) => g.name),
          runtime: data.runtime,
          status: data.status || null,
          language: data.original_language || null,
          spokenLanguages,
          productionCountries,
          director,
          budget: data.budget ? BigInt(data.budget) : null,
          revenue: data.revenue ? BigInt(data.revenue) : null,
          cast,
          crew,
          videos,
          productionCompanies,
          tmdbUpdatedAt: new Date(),
          ratings: {
            upsert: {
              create: {
                tmdbScore: data.vote_average,
                tmdbVotes: data.vote_count,
              },
              update: {
                tmdbScore: data.vote_average,
                tmdbVotes: data.vote_count,
              },
            },
          },
        },
      });

      return true;
    } catch (error) {
      console.error(`Failed to hydrate movie ${tmdbId}:`, error);
      return false;
    }
  }

  /**
   * Fully hydrate a TV show with all TMDB details into the database
   * This stores everything locally including season/episode info
   */
  async hydrateTvShow(tmdbId: number, includeSeasons = true): Promise<boolean> {
    try {
      const data = await this.fetch<TMDBTvShow>(`/tv/${tmdbId}`, {
        append_to_response: "external_ids,videos,credits",
      });

      const id = `tmdb-tv-${tmdbId}`;
      const year = this.extractYear(data.first_air_date) || null;

      // Process videos
      const videos = (data.videos?.results || [])
        .filter((v) => v.site === "YouTube")
        .sort((a, b) => {
          const getScore = (v: TMDBVideo) => {
            let score = 0;
            if (v.official) score += 10;
            if (v.type === "Trailer") score += 5;
            if (v.type === "Teaser") score += 3;
            return score;
          };
          return getScore(b) - getScore(a);
        })
        .map((v) => ({
          id: v.id,
          key: v.key,
          name: v.name,
          site: v.site,
          type: v.type,
          official: v.official,
        }));

      // Process cast
      const cast = (data.credits?.cast || [])
        .slice(0, 20)
        .map((c) => ({
          id: c.id,
          name: c.name,
          character: c.character,
          profilePath: c.profile_path,
          order: c.order,
        }));

      // Process crew
      const keyRoles = ["Creator", "Executive Producer", "Showrunner", "Director of Photography", "Composer"];
      const crew = (data.credits?.crew || [])
        .filter((c) => keyRoles.includes(c.job))
        .map((c) => ({
          id: c.id,
          name: c.name,
          job: c.job,
          department: c.department,
          profilePath: c.profile_path,
        }));

      // Process networks
      const networks = (data.networks || []).map((n) => ({
        id: n.id,
        name: n.name,
        logoPath: n.logo_path,
        originCountry: n.origin_country,
      }));

      // Process production companies
      const productionCompanies = (data.production_companies || []).map((c) => ({
        id: c.id,
        name: c.name,
        logoPath: c.logo_path,
        originCountry: c.origin_country,
      }));

      // Process creators
      const createdBy = (data.created_by || []).map((c) => c.name);

      // Process spoken languages
      const spokenLanguages = (data.spoken_languages || []).map((l) => l.iso_639_1);

      // Process production countries
      const productionCountries = (data.production_countries || []).map((c) => c.iso_3166_1);

      // Upsert the main TV show record
      await prisma.mediaItem.upsert({
        where: { id },
        create: {
          id,
          tmdbId: data.id,
          imdbId: data.external_ids?.imdb_id || null,
          type: "TV",
          title: data.name,
          originalTitle: data.original_name,
          year,
          releaseDate: data.first_air_date,
          overview: data.overview,
          tagline: data.tagline || null,
          posterPath: data.poster_path,
          backdropPath: data.backdrop_path,
          genres: data.genres.map((g) => g.name),
          status: this.mapTvStatus(data.status),
          language: data.original_language || null,
          spokenLanguages,
          productionCountries,
          numberOfSeasons: data.number_of_seasons,
          numberOfEpisodes: data.number_of_episodes,
          networks,
          createdBy,
          cast,
          crew,
          videos,
          productionCompanies,
          tmdbUpdatedAt: new Date(),
          ratings: {
            create: {
              tmdbScore: data.vote_average,
              tmdbVotes: data.vote_count,
            },
          },
        },
        update: {
          imdbId: data.external_ids?.imdb_id || null,
          title: data.name,
          originalTitle: data.original_name,
          year,
          releaseDate: data.first_air_date,
          overview: data.overview,
          tagline: data.tagline || null,
          posterPath: data.poster_path,
          backdropPath: data.backdrop_path,
          genres: data.genres.map((g) => g.name),
          status: this.mapTvStatus(data.status),
          language: data.original_language || null,
          spokenLanguages,
          productionCountries,
          numberOfSeasons: data.number_of_seasons,
          numberOfEpisodes: data.number_of_episodes,
          networks,
          createdBy,
          cast,
          crew,
          videos,
          productionCompanies,
          tmdbUpdatedAt: new Date(),
          ratings: {
            upsert: {
              create: {
                tmdbScore: data.vote_average,
                tmdbVotes: data.vote_count,
              },
              update: {
                tmdbScore: data.vote_average,
                tmdbVotes: data.vote_count,
              },
            },
          },
        },
      });

      // Optionally fetch and store all seasons with episodes
      if (includeSeasons && data.seasons) {
        for (const seasonInfo of data.seasons) {
          // Skip specials (season 0) unless they have episodes
          if (seasonInfo.season_number === 0 && (!seasonInfo.episode_count || seasonInfo.episode_count === 0)) {
            continue;
          }

          try {
            await this.hydrateSeason(tmdbId, seasonInfo.season_number, id);
          } catch (error) {
            console.error(`Failed to hydrate season ${seasonInfo.season_number} for TV ${tmdbId}:`, error);
            // Continue with other seasons
          }
        }
      }

      return true;
    } catch (error) {
      console.error(`Failed to hydrate TV show ${tmdbId}:`, error);
      return false;
    }
  }

  /**
   * Hydrate a single season with episodes into the database
   */
  async hydrateSeason(tmdbId: number, seasonNumber: number, mediaItemId: string): Promise<boolean> {
    try {
      const data = await this.fetch<TMDBSeason>(`/tv/${tmdbId}/season/${seasonNumber}`);

      // Upsert the season
      const season = await prisma.season.upsert({
        where: {
          mediaItemId_seasonNumber: {
            mediaItemId,
            seasonNumber: data.season_number,
          },
        },
        create: {
          mediaItemId,
          seasonNumber: data.season_number,
          name: data.name,
          overview: data.overview || null,
          posterPath: data.poster_path,
          airDate: data.air_date,
          episodeCount: data.episode_count,
        },
        update: {
          name: data.name,
          overview: data.overview || null,
          posterPath: data.poster_path,
          airDate: data.air_date,
          episodeCount: data.episode_count,
        },
      });

      // Upsert episodes
      if (data.episodes && data.episodes.length > 0) {
        for (const ep of data.episodes) {
          await prisma.episode.upsert({
            where: {
              seasonId_episodeNumber: {
                seasonId: season.id,
                episodeNumber: ep.episode_number,
              },
            },
            create: {
              seasonId: season.id,
              episodeNumber: ep.episode_number,
              seasonNumber: ep.season_number,
              name: ep.name,
              overview: ep.overview || null,
              stillPath: ep.still_path,
              airDate: ep.air_date,
              runtime: ep.runtime,
            },
            update: {
              name: ep.name,
              overview: ep.overview || null,
              stillPath: ep.still_path,
              airDate: ep.air_date,
              runtime: ep.runtime,
            },
          });
        }
      }

      return true;
    } catch (error) {
      console.error(`Failed to hydrate season ${seasonNumber} for TV ${tmdbId}:`, error);
      return false;
    }
  }

  /**
   * Batch hydrate multiple media items
   * Processes items sequentially to respect rate limits
   */
  async batchHydrate(
    items: Array<{ tmdbId: number; type: "movie" | "tv" }>,
    options: { includeSeasons?: boolean } = {}
  ): Promise<{ success: number; failed: number }> {
    const { includeSeasons = false } = options;
    let success = 0;
    let failed = 0;

    for (const item of items) {
      const result = item.type === "movie"
        ? await this.hydrateMovie(item.tmdbId)
        : await this.hydrateTvShow(item.tmdbId, includeSeasons);

      if (result) {
        success++;
      } else {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * Bulk sync trending/popular media to database
   */
  async syncPopularMedia(options: {
    movies?: boolean;
    tvShows?: boolean;
    pages?: number;
  } = { movies: true, tvShows: true, pages: 5 }): Promise<{ movies: number; tvShows: number }> {
    let movieCount = 0;
    let tvCount = 0;

    if (options.movies) {
      for (let page = 1; page <= (options.pages || 5); page++) {
        const { results } = await this.getPopularMovies(page);
        for (const item of results) {
          try {
            await this.getMovie(item.tmdbId); // This caches to DB
            movieCount++;
          } catch (error) {
            console.error(`Failed to sync movie ${item.tmdbId}:`, error);
          }
        }
      }
    }

    if (options.tvShows) {
      for (let page = 1; page <= (options.pages || 5); page++) {
        const { results } = await this.getPopularTvShows(page);
        for (const item of results) {
          try {
            await this.getTvShow(item.tmdbId); // This caches to DB
            tvCount++;
          } catch (error) {
            console.error(`Failed to sync TV show ${item.tmdbId}:`, error);
          }
        }
      }
    }

    return { movies: movieCount, tvShows: tvCount };
  }

  /**
   * Get recently changed movie/TV IDs (last 24 hours)
   */
  async getChanges(type: "movie" | "tv", page = 1): Promise<number[]> {
    const endpoint = type === "movie" ? "/movie/changes" : "/tv/changes";

    interface ChangesResponse {
      results: Array<{ id: number; adult?: boolean }>;
      page: number;
      total_pages: number;
      total_results: number;
    }

    try {
      const data = await this.fetch<ChangesResponse>(endpoint, {
        page: page.toString(),
      });

      // Filter out adult content and return just the IDs
      const ids = data.results
        .filter((item) => !item.adult)
        .map((item) => item.id);

      // If there are more pages, recursively fetch them (up to 5 pages to avoid rate limits)
      if (data.page < data.total_pages && page < 5) {
        const moreIds = await this.getChanges(type, page + 1);
        return [...ids, ...moreIds];
      }

      return ids;
    } catch (error) {
      console.error(`Failed to get ${type} changes:`, error);
      return [];
    }
  }

  // Helper methods

  private extractYear(dateStr: string | undefined): number {
    if (!dateStr) return 0;
    const year = parseInt(dateStr.split("-")[0], 10);
    return isNaN(year) ? 0 : year;
  }

  private mapTvStatus(status: string): TvShow["status"] {
    const statusMap: Record<string, TvShow["status"]> = {
      "Returning Series": "Returning Series",
      Ended: "Ended",
      Canceled: "Canceled",
      "In Production": "In Production",
    };
    return statusMap[status] || "Returning Series";
  }

  /**
   * Batch get basic info for multiple items (used for TMDB fallback)
   * Processes in parallel with rate limiting (20 requests per second)
   */
  async batchGetBasicInfo(
    items: Array<{ tmdbId: number; type: "movie" | "tv" }>
  ): Promise<Array<{ tmdbId: number; type: "movie" | "tv"; data: Movie | TvShow | null }>> {
    const CONCURRENCY = 20; // Process up to 20 at a time (respects TMDB rate limit)
    const results: Array<{ tmdbId: number; type: "movie" | "tv"; data: Movie | TvShow | null }> = [];

    // Process in chunks of CONCURRENCY
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const chunk = items.slice(i, i + CONCURRENCY);

      const chunkResults = await Promise.allSettled(
        chunk.map(async (item) => {
          try {
            if (item.type === "movie") {
              const data = await this.getMovie(item.tmdbId);
              return { tmdbId: item.tmdbId, type: item.type, data };
            } else {
              const data = await this.getTvShow(item.tmdbId);
              return { tmdbId: item.tmdbId, type: item.type, data };
            }
          } catch {
            return { tmdbId: item.tmdbId, type: item.type, data: null };
          }
        })
      );

      for (const result of chunkResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          // This shouldn't happen since we catch errors above
          results.push({ tmdbId: 0, type: "movie", data: null });
        }
      }

      // Wait 1 second between batches if we have more to process
      if (i + CONCURRENCY < items.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  /**
   * Get full image URL from TMDB path
   */
  static getImageUrl(path: string | null, size: "w92" | "w154" | "w185" | "w342" | "w500" | "w780" | "original" = "w500"): string | null {
    if (!path) return null;
    return `${TMDB_IMAGE_BASE}/${size}${path}`;
  }
}

// Singleton instance
let tmdbService: TMDBService | null = null;

export function getTMDBService(): TMDBService {
  if (!tmdbService) {
    tmdbService = new TMDBService();
  }
  return tmdbService;
}

export { TMDBService };
