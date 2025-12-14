/**
 * TorrentLeech Provider Service
 *
 * Handles authentication and search for TorrentLeech private tracker.
 * Uses cookie-based authentication and JSON API.
 */

import type { Release } from "./indexer.js";

// TorrentLeech category IDs
export const TORRENTLEECH_CATEGORIES = {
  // Movies
  MOVIES_CAM: 8,
  MOVIES_TS_TC: 9,
  MOVIES_DVDRIP_DVDSCR: 11,
  MOVIES_WEBDL: 37,
  MOVIES_WEBRIP: 43,
  MOVIES_HDRIP: 14,
  MOVIES_BLURAY: 12,
  MOVIES_BDREMUX: 13,
  MOVIES_4K: 47,
  MOVIES_BOXSETS: 15,
  MOVIES_DOCUMENTARIES: 29,

  // TV
  TV_EPISODES_HD: 26,
  TV_EPISODES_SD: 27,
  TV_EPISODES_4K: 32,
  TV_BOXSETS: 7,
  TV_BOXSETS_HD: 34,
  TV_BOXSETS_4K: 35,

  // Anime
  ANIME: 34,

  // Foreign
  FOREIGN_MOVIES: 36,
  FOREIGN_TV: 44,
} as const;

// Category groups for easy selection
export const TORRENTLEECH_CATEGORY_GROUPS = {
  movies: [
    TORRENTLEECH_CATEGORIES.MOVIES_CAM,
    TORRENTLEECH_CATEGORIES.MOVIES_TS_TC,
    TORRENTLEECH_CATEGORIES.MOVIES_DVDRIP_DVDSCR,
    TORRENTLEECH_CATEGORIES.MOVIES_WEBDL,
    TORRENTLEECH_CATEGORIES.MOVIES_WEBRIP,
    TORRENTLEECH_CATEGORIES.MOVIES_HDRIP,
    TORRENTLEECH_CATEGORIES.MOVIES_BLURAY,
    TORRENTLEECH_CATEGORIES.MOVIES_BDREMUX,
    TORRENTLEECH_CATEGORIES.MOVIES_4K,
    TORRENTLEECH_CATEGORIES.MOVIES_BOXSETS,
    TORRENTLEECH_CATEGORIES.MOVIES_DOCUMENTARIES,
  ],
  tv: [
    TORRENTLEECH_CATEGORIES.TV_EPISODES_HD,
    TORRENTLEECH_CATEGORIES.TV_EPISODES_SD,
    TORRENTLEECH_CATEGORIES.TV_EPISODES_4K,
    TORRENTLEECH_CATEGORIES.TV_BOXSETS,
    TORRENTLEECH_CATEGORIES.TV_BOXSETS_HD,
    TORRENTLEECH_CATEGORIES.TV_BOXSETS_4K,
  ],
  all: Object.values(TORRENTLEECH_CATEGORIES),
};

// TorrentLeech API response types
interface TorrentLeechTorrent {
  fid: string;
  filename: string;
  name: string;
  addedTimestamp: string;
  categoryID: number;
  size: number;
  completed: number;
  seeders: number;
  leechers: number;
  uploaderName: string;
  imdbID?: string;
  igdbID?: string;
  tvmazeID?: string;
  tags?: string;
  rating?: number;
  numComments: number;
  new: number;
}

interface TorrentLeechResponse {
  torrentList: TorrentLeechTorrent[];
  numFound: number;
  facets: unknown;
}

export interface TorrentLeechConfig {
  baseUrl: string;
  username: string;
  password: string;
  alt2FAToken?: string; // Optional 2FA bypass token from TorrentLeech profile
  rssKey?: string; // Optional RSS key for direct downloads
}

export interface TorrentLeechSearchOptions {
  query: string;
  categories?: number[];
  imdbId?: string;
  page?: number;
}

// Quality scoring weights (same as main indexer service)
const QUALITY_SCORES = {
  // Resolution
  "2160p": 100,
  "1080p": 80,
  "720p": 60,
  "480p": 40,
  SD: 20,

  // Source type
  REMUX: 50,
  BLURAY: 40,
  "WEB-DL": 35,
  WEBDL: 35,
  WEBRIP: 30,
  HDTV: 25,
  DVDRIP: 15,
  CAM: 5,

  // Codec
  AV1: 15,
  HEVC: 12,
  H265: 12,
  X265: 12,
  H264: 10,
  X264: 10,

  // Audio
  ATMOS: 8,
  TRUEHD: 7,
  "DTS-HD": 6,
  DTS: 4,
  AAC: 3,
};

class TorrentLeechProvider {
  private baseUrl: string;
  private cookies: string | null = null;
  private cookieExpiry: Date | null = null;
  private username: string;
  private password: string;
  private alt2FAToken?: string;
  private rssKey?: string;

  constructor(config: TorrentLeechConfig) {
    // Normalize the base URL - ensure https and www
    let baseUrl = config.baseUrl.replace(/\/+$/, "");
    if (!baseUrl.startsWith("http")) {
      baseUrl = `https://${baseUrl}`;
    }
    // Ensure https
    baseUrl = baseUrl.replace(/^http:/, "https:");
    // Ensure www subdomain for torrentleech domains (both .org and .me)
    if ((baseUrl.includes("torrentleech.org") || baseUrl.includes("torrentleech.me")) && !baseUrl.includes("www.")) {
      baseUrl = baseUrl.replace("://", "://www.");
    }
    this.baseUrl = baseUrl;
    this.username = config.username;
    this.password = config.password;
    this.alt2FAToken = config.alt2FAToken;
    this.rssKey = config.rssKey;
  }

  /**
   * Authenticate with TorrentLeech and get session cookies
   */
  async authenticate(): Promise<boolean> {
    // Check if we have valid cookies
    if (this.cookies && this.cookieExpiry && new Date() < this.cookieExpiry) {
      return true;
    }

    console.log("[TorrentLeech] Authenticating...");

    try {
      // Build form data with optional 2FA token
      const formData: Record<string, string> = {
        username: this.username,
        password: this.password,
      };

      // Add 2FA token if provided (required if user has 2FA enabled)
      if (this.alt2FAToken) {
        formData.alt2FAToken = this.alt2FAToken;
      }

      // First, get any initial cookies from the login page
      const loginPageUrl = `${this.baseUrl}/user/account/login/`;

      const loginPageResponse = await fetch(loginPageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        redirect: "follow",
      });


      // Collect any initial cookies
      let initialCookies: string[] = [];
      if (typeof loginPageResponse.headers.getSetCookie === "function") {
        initialCookies = loginPageResponse.headers.getSetCookie().map(c => c.split(";")[0]);
      }

      const response = await fetch(loginPageUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Origin": this.baseUrl,
          "Referer": loginPageUrl,
          ...(initialCookies.length > 0 && { "Cookie": initialCookies.join("; ") }),
        },
        body: new URLSearchParams(formData).toString(),
        redirect: "manual", // Don't follow redirects to capture cookies
      });


      // Check redirect and verify login status
      let confirmedLoggedIn = false;

      if (response.status === 302) {
        const redirectUrl = response.headers.get("location");
        if (redirectUrl) {

          // Get cookies from the 302 response first
          let responseCookies: string[] = [];
          if (typeof response.headers.getSetCookie === "function") {
            responseCookies = response.headers.getSetCookie().map(c => c.split(";")[0]);
          }
          const allCookiesForCheck = [...initialCookies, ...responseCookies].join("; ");

          // Follow the redirect to check if we're actually logged in
          const checkResponse = await fetch(redirectUrl.startsWith("http") ? redirectUrl : `${this.baseUrl}${redirectUrl}`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Cookie": allCookiesForCheck,
            },
          });
          const pageBody = await checkResponse.text();

          // Check if we're actually logged in despite the redirect
          // TorrentLeech shows "loggedin" class in navbar when authenticated
          if (pageBody.includes("loggedin") || pageBody.includes("logged-in") || pageBody.includes(">Logout<") || pageBody.includes(">logout<")) {
            confirmedLoggedIn = true;
          } else {
            // Look for common error patterns
            if (pageBody.includes("Invalid username") || pageBody.includes("Invalid password")) {
              console.error("[TorrentLeech] Invalid username or password");
              return false;
            }
            if (pageBody.includes("Captcha") || pageBody.includes("captcha") || pageBody.includes("CAPTCHA")) {
              console.error("[TorrentLeech] CAPTCHA required - too many failed attempts?");
              return false;
            }
            if (pageBody.includes("banned") || pageBody.includes("Banned") || pageBody.includes("disabled") || pageBody.includes("Disabled")) {
              console.error("[TorrentLeech] Account may be banned or disabled");
              return false;
            }

            // Check if this is actually the login form page (not logged in)
            if (pageBody.includes('name="username"') && pageBody.includes('name="password"')) {
              console.error("[TorrentLeech] Still on login form - authentication failed");
              return false;
            }
          }
        }
      }

      // Get cookies from response - try multiple methods
      // Even if we get a redirect, the cookies might still be valid
      let setCookieHeaders: string[] = [];

      // Method 1: getSetCookie (modern)
      if (typeof response.headers.getSetCookie === "function") {
        setCookieHeaders = response.headers.getSetCookie();
      }

      // Method 2: Iterate headers
      if (setCookieHeaders.length === 0) {
        response.headers.forEach((value, key) => {
          if (key.toLowerCase() === "set-cookie") {
            setCookieHeaders.push(value);
          }
        });
      }

      // Method 3: Get raw header
      if (setCookieHeaders.length === 0) {
        const cookieHeader = response.headers.get("set-cookie");
        if (cookieHeader) {
          // Split carefully - cookies are separated by ", " but cookie values can contain ", "
          // Look for patterns like "name=value; ..., name2=value2"
          setCookieHeaders = cookieHeader.split(/,(?=\s*\w+=)/);
        }
      }


      // Parse cookies from login response
      const loginCookies: string[] = [];
      for (const header of setCookieHeaders) {
        const cookie = header.split(";")[0].trim();
        if (cookie && cookie.includes("=")) {
          loginCookies.push(cookie);
        }
      }

      // Combine initial cookies with login response cookies
      // Use a Map to dedupe by cookie name, preferring newer cookies
      const cookieMap = new Map<string, string>();

      // Add initial cookies first
      for (const cookie of initialCookies) {
        const [name] = cookie.split("=");
        if (name) {
          cookieMap.set(name, cookie);
        }
      }

      // Add login response cookies (these override initial ones)
      for (const cookie of loginCookies) {
        const [name] = cookie.split("=");
        if (name) {
          cookieMap.set(name, cookie);
        }
      }

      const allCookies = Array.from(cookieMap.values());
      const cookieNames = Array.from(cookieMap.keys());

      if (allCookies.length === 0) {
        console.error("[TorrentLeech] No cookies available");
        return false;
      }

      // Check for session-related cookies that indicate successful login
      // TorrentLeech typically sets PHPSESSID and/or member cookies on login
      const hasSessionCookie = cookieNames.some(name =>
        name.toLowerCase().includes("sess") ||
        name.toLowerCase().includes("member") ||
        name.toLowerCase().includes("auth") ||
        name.toLowerCase().includes("tl")
      );


      this.cookies = allCookies.join("; ");

      // Verify login by making a test request (unless already confirmed via redirect page)
      // This catches cases where we got cookies but they're not valid session cookies
      if (!confirmedLoggedIn && !hasSessionCookie) {
        try {
          const verifyResponse = await fetch(`${this.baseUrl}/torrents/browse/list/page/1`, {
            headers: {
              Cookie: this.cookies,
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "application/json, text/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
            },
            signal: AbortSignal.timeout(15000),
          });

          const verifyContentType = verifyResponse.headers.get("content-type") || "";
          if (!verifyContentType.includes("application/json")) {
            console.error("[TorrentLeech] Session verification failed - not getting JSON response");
            this.cookies = null;
            return false;
          }
        } catch (verifyError) {
          console.error("[TorrentLeech] Session verification request failed:", verifyError);
          this.cookies = null;
          return false;
        }
      }

      // Set cookie expiry to 1 hour from now (conservative estimate)
      this.cookieExpiry = new Date(Date.now() + 60 * 60 * 1000);

      console.log("[TorrentLeech] Authentication successful");
      return true;
    } catch (error) {
      console.error("[TorrentLeech] Authentication failed:", error);
      return false;
    }
  }

  /**
   * Make an authenticated request to TorrentLeech
   */
  private async request<T>(path: string): Promise<T> {
    const authenticated = await this.authenticate();
    if (!authenticated) {
      throw new Error("Failed to authenticate with TorrentLeech");
    }

    const url = `${this.baseUrl}${path}`;
    console.log(`[TorrentLeech] Request: ${url}`);

    const response = await fetch(url, {
      headers: {
        Cookie: this.cookies!,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(30000),
    });

    console.log(`[TorrentLeech] Response status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      console.error(`[TorrentLeech] Error response: ${text.substring(0, 500)}`);

      // If 403, try re-authenticating
      if (response.status === 403) {
        this.cookies = null;
        this.cookieExpiry = null;
        const reauth = await this.authenticate();
        if (reauth) {
          const retryResponse = await fetch(url, {
            headers: {
              Cookie: this.cookies!,
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "application/json, text/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
            },
            signal: AbortSignal.timeout(30000),
          });
          if (retryResponse.ok) {
            return retryResponse.json() as Promise<T>;
          }
        }
      }
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check content type - if not JSON, we might have been redirected to login page
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      const text = await response.text();
      console.error(`[TorrentLeech] Unexpected content type: ${contentType}`);
      console.error(`[TorrentLeech] Response body: ${text.substring(0, 500)}`);

      // Check if it's a login page - session expired server-side
      if (text.includes("login") || text.includes("Login") || text.includes("Sign In")) {
        console.log("[TorrentLeech] Session expired server-side, re-authenticating...");

        // Clear cached session and force re-authentication
        this.cookies = null;
        this.cookieExpiry = null;

        const reauth = await this.authenticate();
        if (reauth) {
          // Retry the request with fresh cookies
          const retryResponse = await fetch(url, {
            headers: {
              Cookie: this.cookies!,
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "application/json, text/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
            },
            signal: AbortSignal.timeout(30000),
          });

          const retryContentType = retryResponse.headers.get("content-type") || "";
          if (retryResponse.ok && retryContentType.includes("application/json")) {
            console.log("[TorrentLeech] Re-authentication successful, retry succeeded");
            return retryResponse.json() as Promise<T>;
          }

          // Still not JSON after re-auth - credentials may be wrong
          const retryText = await retryResponse.text();
          console.error(`[TorrentLeech] Retry failed - status: ${retryResponse.status}, content-type: ${retryContentType}`);
          console.error(`[TorrentLeech] Retry body: ${retryText.substring(0, 500)}`);
          throw new Error("Re-authentication failed - check credentials or 2FA token");
        }
        throw new Error("Session expired and re-authentication failed");
      }
      throw new Error(`Expected JSON but got ${contentType}`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Search TorrentLeech for torrents
   */
  async search(options: TorrentLeechSearchOptions): Promise<Release[]> {
    const { query, categories, imdbId, page = 1 } = options;

    // Build search URL
    let path = "/torrents/browse/list";

    // Only use exact match for IMDB ID searches (movie searches)
    // For text queries, exact match is too strict and misses releases with different formatting
    if (imdbId) {
      path += "/exact/1";
    }

    // Add query - prefer IMDB ID for precise matching, otherwise use text query
    const searchQuery = imdbId || query;
    if (searchQuery) {
      path += `/query/${encodeURIComponent(searchQuery)}`;
    }

    // Add categories
    if (categories && categories.length > 0) {
      path += `/categories/${categories.join(",")}`;
    }

    // Order by seeders descending
    path += "/orderby/seeders/order/desc";

    // Add pagination (TL uses 1-based pages, page/0 doesn't work)
    path += `/page/${Math.max(1, page)}`;

    console.log(`[TorrentLeech] Searching: ${path}`);

    const response = await this.request<TorrentLeechResponse>(path);

    if (!response.torrentList || !Array.isArray(response.torrentList)) {
      return [];
    }

    return response.torrentList.map((torrent) =>
      this.mapToRelease(torrent)
    );
  }

  /**
   * Test connection to TorrentLeech
   */
  async testConnection(): Promise<{
    success: boolean;
    message: string;
    username?: string;
  }> {
    try {
      const authenticated = await this.authenticate();
      if (!authenticated) {
        return {
          success: false,
          message: "Failed to authenticate - check username/password or 2FA token",
        };
      }

      console.log("[TorrentLeech] Testing connection with browse request...");

      // Try to access a simple endpoint to verify session
      // Note: page/0 doesn't work on TL, must use page/1 or omit page
      const response = await this.request<TorrentLeechResponse>(
        "/torrents/browse/list/page/1"
      );

      console.log(`[TorrentLeech] Browse response: ${JSON.stringify(response).substring(0, 200)}`);

      if (response.torrentList !== undefined) {
        return {
          success: true,
          message: `Connected successfully (found ${response.numFound || 0} torrents)`,
          username: this.username,
        };
      }

      return {
        success: false,
        message: "Unexpected response from TorrentLeech",
      };
    } catch (error) {
      console.error("[TorrentLeech] Test connection error:", error);
      return {
        success: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get download URL for a torrent
   */
  getDownloadUrl(fid: string, filename: string): string {
    // TorrentLeech download URL format: /download/{fid}/{filename}
    // Requires RSS key or session cookie
    if (this.rssKey) {
      return `${this.baseUrl}/rss/download/${fid}/${this.rssKey}/${encodeURIComponent(filename)}`;
    }
    return `${this.baseUrl}/download/${fid}/${encodeURIComponent(filename)}`;
  }

  /**
   * Map TorrentLeech torrent to Release interface
   */
  private mapToRelease(torrent: TorrentLeechTorrent): Release {
    const title = torrent.name;
    const resolution = this.extractResolution(title);
    const source = this.extractSource(title);
    const codec = this.extractCodec(title);
    const score = this.calculateScore(title, resolution, source, codec, torrent.seeders);

    return {
      id: `torrentleech-${torrent.fid}`,
      title,
      indexerId: "torrentleech",
      indexerName: "TorrentLeech",
      resolution,
      source,
      codec,
      size: torrent.size,
      seeders: torrent.seeders,
      leechers: torrent.leechers,
      downloadUrl: this.getDownloadUrl(torrent.fid, torrent.filename),
      infoUrl: `${this.baseUrl}/torrent/${torrent.fid}`,
      publishDate: new Date(parseInt(torrent.addedTimestamp) * 1000),
      score,
      categories: [torrent.categoryID],
    };
  }

  /**
   * Extract resolution from title
   */
  private extractResolution(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("2160P") || upper.includes("4K") || upper.includes("UHD")) return "2160p";
    if (upper.includes("1080P") || upper.includes("1080I")) return "1080p";
    if (upper.includes("720P")) return "720p";
    if (upper.includes("480P") || upper.includes("576P")) return "480p";
    return "SD";
  }

  /**
   * Extract source type from title
   */
  private extractSource(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("REMUX")) return "REMUX";
    if (upper.includes("BLURAY") || upper.includes("BLU-RAY") || upper.includes("BDRIP")) return "BLURAY";
    if (upper.includes("WEB-DL") || upper.includes("WEBDL")) return "WEB-DL";
    if (upper.includes("WEBRIP") || upper.includes("WEB-RIP")) return "WEBRIP";
    if (upper.includes("HDTV")) return "HDTV";
    if (upper.includes("DVDRIP") || upper.includes("DVD-RIP")) return "DVDRIP";
    if (upper.includes("CAM") || upper.includes("HDCAM")) return "CAM";
    return "UNKNOWN";
  }

  /**
   * Extract codec from title
   */
  private extractCodec(title: string): string {
    const upper = title.toUpperCase();
    if (upper.includes("AV1")) return "AV1";
    if (upper.includes("HEVC") || upper.includes("H.265") || upper.includes("H265") || upper.includes("X265")) return "HEVC";
    if (upper.includes("H.264") || upper.includes("H264") || upper.includes("X264") || upper.includes("AVC")) return "H264";
    return "UNKNOWN";
  }

  /**
   * Calculate quality score for a release
   */
  private calculateScore(
    title: string,
    resolution: string,
    source: string,
    codec: string,
    seeders: number
  ): number {
    let score = 0;

    // Resolution score
    score += QUALITY_SCORES[resolution as keyof typeof QUALITY_SCORES] || 0;

    // Source score
    score += QUALITY_SCORES[source as keyof typeof QUALITY_SCORES] || 0;

    // Codec score
    score += QUALITY_SCORES[codec as keyof typeof QUALITY_SCORES] || 0;

    // Audio bonus
    const upper = title.toUpperCase();
    if (upper.includes("ATMOS")) score += QUALITY_SCORES.ATMOS;
    if (upper.includes("TRUEHD")) score += QUALITY_SCORES.TRUEHD;
    if (upper.includes("DTS-HD") || upper.includes("DTSHD")) score += QUALITY_SCORES["DTS-HD"];
    if (upper.includes("DTS") && !upper.includes("DTS-HD")) score += QUALITY_SCORES.DTS;

    // Seeder bonus (logarithmic, capped at 20 points)
    if (seeders > 0) {
      score += Math.min(20, Math.floor(Math.log10(seeders) * 5));
    }

    // Penalty for samples, hardcoded subs, etc.
    if (upper.includes("SAMPLE")) score -= 100;
    if (upper.includes("HARDCODED") || upper.includes("HC ")) score -= 30;
    if (upper.includes("KOREAN") && !upper.includes("KOREAN.ENG")) score -= 20;

    return score;
  }

  /**
   * Clear cached cookies (force re-authentication)
   */
  clearSession(): void {
    this.cookies = null;
    this.cookieExpiry = null;
  }
}

// Provider instance cache
const providerCache = new Map<string, TorrentLeechProvider>();

/**
 * Get or create a TorrentLeech provider instance
 */
export function getTorrentLeechProvider(config: TorrentLeechConfig): TorrentLeechProvider {
  const key = `${config.baseUrl}:${config.username}`;

  let provider = providerCache.get(key);
  if (!provider) {
    provider = new TorrentLeechProvider(config);
    providerCache.set(key, provider);
  }

  return provider;
}

/**
 * Clear a cached provider (e.g., when credentials change)
 */
export function clearTorrentLeechProvider(baseUrl: string, username: string): void {
  const key = `${baseUrl}:${username}`;
  const provider = providerCache.get(key);
  if (provider) {
    provider.clearSession();
    providerCache.delete(key);
  }
}

export { TorrentLeechProvider };
