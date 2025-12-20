export interface CardigannDefinition {
  id: string;
  name: string;
  description?: string;
  language?: string;
  type?: string;
  encoding?: string;
  followredirect?: boolean;
  testlinktorrent?: boolean;
  requestDelay?: number;
  links?: string[];
  legacylinks?: string[];
  certificates?: string[];
  caps?: CardigannCaps;
  settings?: CardigannSetting[];
  login?: CardigannLogin;
  ratio?: CardigannRatio;
  search?: CardigannSearch;
  download?: CardigannDownload;
}

export interface CardigannCaps {
  categorymappings?: CardigannCategoryMapping[];
  modes?: {
    search?: string[];
    "tv-search"?: string[];
    "movie-search"?: string[];
    "music-search"?: string[];
    "book-search"?: string[];
  };
}

export interface CardigannCategoryMapping {
  id: string;
  cat: string;
  desc: string;
  default?: boolean;
}

export interface CardigannSetting {
  name: string;
  type: "text" | "password" | "checkbox" | "select" | "info";
  label: string;
  default?: string | boolean;
  options?: { [key: string]: string };
}

export interface CardigannLogin {
  method?: "post" | "form" | "cookie" | "get" | "oneurl";
  path?: string;
  form?: string;
  submitpath?: string;
  inputs?: { [key: string]: string };
  selectorinputs?: { [key: string]: CardigannSelector };
  getselectorinputs?: { [key: string]: CardigannSelector };
  selectors?: boolean;
  cookies?: string[];
  headers?: { [key: string]: string };
  error?: CardigannSelector[];
  test?: CardigannLoginTest;
  captcha?: CardigannCaptcha;
}

export interface CardigannLoginTest {
  path?: string;
  selector?: string;
}

export interface CardigannCaptcha {
  type: "image" | "recaptcha" | "recaptchav2" | "hcaptcha" | "text";
  selector?: string;
  input?: string;
}

export interface CardigannSearch {
  paths?: CardigannSearchPath[];
  inputs?: { [key: string]: string };
  headers?: { [key: string]: string };
  keywordsfilters?: CardigannFilter[];
  rows?: CardigannRowsSelector;
  fields?: { [key: string]: CardigannSelector };
}

export interface CardigannSearchPath {
  path: string;
  method?: "get" | "post";
  inheritinputs?: boolean;
  followredirect?: boolean;
  inputs?: { [key: string]: string };
  headers?: { [key: string]: string };
  response?: {
    type?: "json" | "xml";
    noResultsMessage?: string;
  };
  rows?: CardigannRowsSelector;
  fields?: { [key: string]: CardigannSelector };
}

export interface CardigannRowsSelector {
  selector?: string;
  attribute?: string;
  after?: number;
  remove?: string;
  filters?: CardigannFilter[];
  dateheaders?: CardigannDateHeaders;
  count?: CardigannSelector;
}

export interface CardigannDateHeaders {
  selector: string;
  filters?: CardigannFilter[];
}

export interface CardigannSelector {
  selector?: string;
  attribute?: string;
  text?: string;
  case?: { [key: string]: string };
  remove?: string;
  filters?: CardigannFilter[];
  optional?: boolean;
}

export interface CardigannFilter {
  name: string;
  args?: (string | number)[];
}

export interface CardigannRatio {
  text?: string;
  path?: string;
  selector?: string;
  attribute?: string;
  filters?: CardigannFilter[];
}

export interface CardigannDownload {
  selector?: string;
  attribute?: string;
  method?: "get" | "post";
  before?: string;
  filters?: CardigannFilter[];
  infohash?: CardigannSelector;
}

export interface ParsedIndexerDefinition {
  definition: CardigannDefinition;
  version: string;
}

export interface CardigannSearchParams {
  query?: string;
  categories?: string[];
  imdbId?: string;
  tmdbId?: string;
  tvdbId?: string;
  season?: number;
  episode?: number;
  limit?: number;
  offset?: number;
}

export interface CardigannSearchResult {
  title: string;
  downloadUrl: string;
  infoUrl?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  publishDate?: Date;
  category?: string[];
  imdbId?: string;
  tmdbId?: string;
  tvdbId?: string;
  downloadVolumeFactor?: number;
  uploadVolumeFactor?: number;
  minimumRatio?: number;
  minimumSeedTime?: number;
  infohash?: string;
}

export interface CardigannContext {
  definition: CardigannDefinition;
  settings: { [key: string]: string | boolean };
  cookies: { [key: string]: string };
  baseUrl: string;
}

export interface CardigannLoginResult {
  success: boolean;
  cookies: { [key: string]: string };
  error?: string;
}
