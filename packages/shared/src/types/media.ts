/**
 * Media types and metadata
 */

export type MediaType = "movie" | "tv";

export interface Video {
  id: string;
  key: string;
  name: string;
  site: string;
  type: string;
  official: boolean;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
  order: number;
}

export interface CrewMember {
  id: number;
  name: string;
  job: string;
  department: string;
  profilePath: string | null;
}

export interface SpokenLanguage {
  englishName: string;
  iso: string;
  name: string;
}

export interface ProductionCompany {
  id: number;
  name: string;
  logoPath: string | null;
  originCountry: string;
}

export interface Network {
  id: number;
  name: string;
  logoPath: string | null;
  originCountry: string;
}

export interface Movie {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string;
  runtime: number | null;
  genres: string[];
  voteAverage: number;
  voteCount: number;
}

export interface MovieDetails extends Movie {
  tagline: string | null;
  budget: number | null;
  revenue: number | null;
  originalLanguage: string | null;
  spokenLanguages: SpokenLanguage[];
  productionCompanies: ProductionCompany[];
  productionCountries: string[];
  videos: Video[];
  cast: CastMember[];
  crew: CrewMember[];
  director: string | null;
  imdbId: string | null;
}

export interface TvShow {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  firstAirDate: string;
  lastAirDate: string | null;
  status: "Returning Series" | "Ended" | "Canceled" | "In Production";
  genres: string[];
  voteAverage: number;
  voteCount: number;
  numberOfSeasons: number;
  numberOfEpisodes: number;
}

export interface TvShowDetails extends TvShow {
  tagline: string | null;
  originalLanguage: string | null;
  spokenLanguages: SpokenLanguage[];
  productionCompanies: ProductionCompany[];
  productionCountries: string[];
  networks: Network[];
  createdBy: string[];
  videos: Video[];
  cast: CastMember[];
  crew: CrewMember[];
  imdbId: string | null;
}

export interface Season {
  seasonNumber: number;
  name: string;
  overview: string;
  posterPath: string | null;
  airDate: string | null;
  episodeCount: number;
}

export interface Episode {
  episodeNumber: number;
  seasonNumber: number;
  name: string;
  overview: string;
  stillPath: string | null;
  airDate: string | null;
  runtime: number | null;
}

export interface MediaRatings {
  tmdbScore: number | null;
  imdbScore: number | null;
  rtCriticScore: number | null;
  rtAudienceScore: number | null;
  metacriticScore: number | null;
  traktScore: number | null;
  letterboxdScore: number | null;
  mdblistScore: number | null;
  aggregateScore: number | null;
}

export interface TrendingResult {
  type: MediaType;
  tmdbId: number;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  year: number;
  voteAverage: number;
  overview: string;
  // Enhanced ratings from local database
  ratings?: MediaRatings;
  // YouTube trailer key (if available)
  trailerKey?: string | null;
}

export interface SearchResult extends TrendingResult {
  // Same structure, just semantically different
}
