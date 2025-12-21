/**
 * Download Service
 *
 * Manages torrent downloads via qBittorrent Web API.
 * Handles adding, monitoring, and cleaning up torrents.
 */

import { getConfig } from "../config/index.js";
import { isSampleFile } from "./archive.js";
import { getSecretsService } from "./secrets.js";

interface TorrentInfo {
  hash: string;
  name: string;
  size: number;
  progress: number; // 0-1
  dlspeed: number; // bytes/sec
  upspeed: number; // bytes/sec
  num_seeds: number;
  num_leechs: number;
  ratio: number;
  eta: number; // seconds, 8640000 = infinity
  state: string;
  content_path: string;
  save_path: string;
  added_on: number; // Unix timestamp
  completion_on: number; // Unix timestamp, -1 if not complete
}

interface TorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number; // 0-1
  priority: number;
  is_seed: boolean;
  piece_range: number[];
  availability: number;
}

export interface DownloadProgress {
  hash: string;
  name: string;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number; // bytes/sec
  uploadSpeed: number; // bytes/sec
  progress: number; // 0-100
  eta: number; // seconds, -1 if infinite
  seeds: number;
  peers: number;
  ratio: number;
  state: DownloadState;
  contentPath: string;
  savePath: string; // Parent directory where torrent is saved
  isComplete: boolean;
}

export type DownloadState =
  | "queued"
  | "downloading"
  | "stalled"
  | "checking"
  | "complete"
  | "seeding"
  | "paused"
  | "error"
  | "unknown";

// Map qBittorrent state strings to our internal DownloadState
const STATE_MAP: Record<string, DownloadState> = {
  allocating: "queued",
  checkingDL: "checking",
  checkingResumeData: "checking",
  checkingUP: "checking",
  downloading: "downloading",
  error: "error",
  forcedDL: "downloading",
  forcedMetaDL: "downloading",
  forcedUP: "seeding",
  metaDL: "downloading",
  missingFiles: "error",
  moving: "queued",
  pausedDL: "paused",
  pausedUP: "paused",
  queuedDL: "queued",
  queuedUP: "queued",
  stalledDL: "stalled",
  stalledUP: "seeding",
  uploading: "seeding",
  unknown: "unknown",
};

class DownloadService {
  private baseUrl: string;
  private username: string;
  private password: string;
  private qbBaseDir: string | undefined;
  private cookie: string | null = null;
  private cookieExpiry: number = 0;
  private credentialsPromise: Promise<void> | null = null;
  private credentialsLoaded: boolean = false;

  constructor() {
    const config = getConfig();
    // Load from config initially as fallback
    this.baseUrl = config.qbittorrent.url.replace(/\/+$/, "");
    this.username = config.qbittorrent.username || "";
    this.password = config.qbittorrent.password || "";
    this.qbBaseDir = config.qbittorrent.baseDir?.replace(/\/+$/, "");

    // Listen for secret changes to refresh credentials
    const secrets = getSecretsService();
    secrets.on("change", (key: string) => {
      if (key.startsWith("qbittorrent.")) {
        this.credentialsLoaded = false;
        this.credentialsPromise = null;
        this.cookie = null;
        this.cookieExpiry = 0;
      }
    });
  }

  /**
   * Load credentials from secrets store (preferred) or config (fallback)
   */
  private async loadCredentials(): Promise<void> {
    if (this.credentialsLoaded) {
      return;
    }

    // Prevent duplicate fetches
    if (this.credentialsPromise) {
      return this.credentialsPromise;
    }

    this.credentialsPromise = (async () => {
      try {
        const secrets = getSecretsService();
        const [url, username, password] = await Promise.all([
          secrets.getSecret("qbittorrent.url"),
          secrets.getSecret("qbittorrent.username"),
          secrets.getSecret("qbittorrent.password"),
        ]);

        if (url) {
          this.baseUrl = url.replace(/\/+$/, "");
        }
        if (username !== null) {
          this.username = username;
        }
        if (password !== null) {
          this.password = password;
        }
      } catch {
        // Keep config values on error
      }

      this.credentialsLoaded = true;
    })();

    return this.credentialsPromise;
  }

  /**
   * Map a qBittorrent content path to the local filesystem path.
   * If ANNEX_QBITTORRENT_BASE_DIR is set, extracts the relative path from
   * qBittorrent's content_path and prepends the configured base directory.
   */
  private mapContentPath(qbPath: string): string {
    if (!this.qbBaseDir || !qbPath) {
      return qbPath;
    }

    // qBittorrent returns paths like /downloads/TorrentName or C:\Downloads\TorrentName
    // We need to extract just the torrent folder/file name and prepend our base dir
    // The content_path is the full path to the content (folder or single file)

    // Get the last component (torrent name/folder)
    const pathParts = qbPath.replace(/\\/g, "/").split("/");
    const torrentName = pathParts[pathParts.length - 1];

    // If the path has a parent that looks like a download directory, use everything after it
    // Common patterns: /downloads/, /torrents/, etc.
    // For simplicity, just use the torrent name (last path component)
    return `${this.qbBaseDir}/${torrentName}`;
  }

  /**
   * Map a qBittorrent save_path to the local filesystem path.
   * If ANNEX_QBITTORRENT_BASE_DIR is set, returns the configured base directory.
   * The save_path is the parent directory, and file.name contains the relative path.
   */
  private mapSavePath(qbPath: string): string {
    if (!this.qbBaseDir) {
      return qbPath?.replace(/\/+$/, "") || "";
    }
    return this.qbBaseDir;
  }

  /**
   * Authenticate with qBittorrent
   */
  private async authenticate(): Promise<void> {
    // Load credentials from secrets first
    await this.loadCredentials();

    // Reuse valid cookie
    if (this.cookie && Date.now() < this.cookieExpiry) {
      return;
    }

    const response = await fetch(`${this.baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `username=${encodeURIComponent(this.username)}&password=${encodeURIComponent(this.password)}`,
    });

    if (!response.ok) {
      throw new Error(`qBittorrent login failed: ${response.status}`);
    }

    const text = await response.text();
    if (text === "Fails.") {
      throw new Error("qBittorrent login failed: Invalid credentials");
    }

    // Extract cookie
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/SID=([^;]+)/);
      if (match) {
        this.cookie = `SID=${match[1]}`;
        // Cookie expires in 1 hour by default, refresh after 50 minutes
        this.cookieExpiry = Date.now() + 50 * 60 * 1000;
      }
    }
  }

  /**
   * Make authenticated API request
   */
  private async request(
    endpoint: string,
    options: {
      method?: string;
      body?: URLSearchParams | FormData | string;
      headers?: Record<string, string>;
    } = {}
  ): Promise<Response> {
    await this.authenticate();

    const { method = "GET", body, headers = {} } = options;

    const response = await fetch(`${this.baseUrl}/api/v2${endpoint}`, {
      method,
      headers: {
        Cookie: this.cookie || "",
        ...headers,
      },
      body,
    });

    if (response.status === 403) {
      // Cookie expired, re-authenticate
      this.cookie = null;
      this.cookieExpiry = 0;
      await this.authenticate();

      // Retry request
      return fetch(`${this.baseUrl}/api/v2${endpoint}`, {
        method,
        headers: {
          Cookie: this.cookie || "",
          ...headers,
        },
        body,
      });
    }

    return response;
  }

  /**
   * Test connection to qBittorrent
   */
  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    try {
      await this.authenticate();
      const response = await this.request("/app/version");

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const version = await response.text();
      return { success: true, version };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Add a torrent from magnet link
   */
  async addMagnet(
    magnetUri: string,
    options: {
      savePath?: string;
      category?: string;
      paused?: boolean;
      tags?: string[];
    } = {}
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const formData = new URLSearchParams();
      formData.set("urls", magnetUri);

      if (options.savePath) {
        formData.set("savepath", options.savePath);
      }
      if (options.category) {
        formData.set("category", options.category);
      }
      if (options.paused) {
        formData.set("paused", "true");
      }
      if (options.tags && options.tags.length > 0) {
        formData.set("tags", options.tags.join(","));
      }

      const response = await this.request("/torrents/add", {
        method: "POST",
        body: formData,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: text || `HTTP ${response.status}` };
      }

      // Extract hash from magnet URI
      const hashMatch = magnetUri.match(/xt=urn:btih:([a-fA-F0-9]+)/i);
      const hash = hashMatch ? hashMatch[1].toLowerCase() : undefined;

      return { success: true, hash };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Add a torrent from .torrent URL
   * Note: qBittorrent doesn't return the hash when adding from URL,
   * so the caller may need to look up torrents by tag to find it.
   */
  async addTorrentUrl(
    torrentUrl: string,
    options: {
      savePath?: string;
      category?: string;
      paused?: boolean;
      tags?: string[];
    } = {}
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const formData = new URLSearchParams();
      formData.set("urls", torrentUrl);

      if (options.savePath) {
        formData.set("savepath", options.savePath);
      }
      if (options.category) {
        formData.set("category", options.category);
      }
      if (options.paused) {
        formData.set("paused", "true");
      }
      if (options.tags && options.tags.length > 0) {
        formData.set("tags", options.tags.join(","));
      }

      const response = await this.request("/torrents/add", {
        method: "POST",
        body: formData,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: text || `HTTP ${response.status}` };
      }

      // Try to extract hash from magnet URI if it's a magnet
      if (torrentUrl.startsWith("magnet:")) {
        const hashMatch = torrentUrl.match(/xt=urn:btih:([a-fA-F0-9]+)/i);
        const hash = hashMatch ? hashMatch[1].toLowerCase() : undefined;
        return { success: true, hash };
      }

      // For .torrent URLs, we can't easily get the hash without parsing
      // Caller can use findTorrentByTag to locate it
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Add a torrent from raw .torrent file data
   * This is used when we need to fetch the torrent file ourselves
   * (e.g., from UNIT3D trackers that require authentication)
   */
  async addTorrentFile(
    torrentData: ArrayBuffer,
    filename: string,
    options: {
      savePath?: string;
      category?: string;
      paused?: boolean;
      tags?: string[];
    } = {}
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      // Use FormData for multipart upload
      const formData = new FormData();

      // Create a Blob from the torrent data
      const blob = new Blob([torrentData], { type: "application/x-bittorrent" });
      formData.append("torrents", blob, filename);

      if (options.savePath) {
        formData.append("savepath", options.savePath);
      }
      if (options.category) {
        formData.append("category", options.category);
      }
      if (options.paused) {
        formData.append("paused", "true");
      }
      if (options.tags && options.tags.length > 0) {
        formData.append("tags", options.tags.join(","));
      }

      const response = await this.request("/torrents/add", {
        method: "POST",
        body: formData,
        // Don't set Content-Type header - fetch will set it with boundary for multipart
      });

      const responseText = await response.text();
      console.log(
        `[QBittorrent] addTorrentFile response: status=${response.status}, body="${responseText}"`
      );

      if (!response.ok) {
        return { success: false, error: responseText || `HTTP ${response.status}` };
      }

      // qBittorrent doesn't return the hash when adding files
      // Caller can use findTorrentByTag to locate it
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fetch a torrent file from a URL
   * Used for trackers that require authenticated downloads (e.g., UNIT3D)
   */
  async fetchTorrentFile(
    url: string,
    headers?: Record<string, string>
  ): Promise<{ success: boolean; data?: ArrayBuffer; error?: string }> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Annex/1.0",
          ...headers,
        },
      });

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get("content-type") || "";
      const contentLength = response.headers.get("content-length") || "unknown";
      console.log(
        `[QBittorrent] fetchTorrentFile response: status=${response.status}, content-type="${contentType}", size=${contentLength}`
      );

      // Check if we got a torrent file (not an error page)
      if (
        !contentType.includes("application/x-bittorrent") &&
        !contentType.includes("application/octet-stream")
      ) {
        const text = await response.text();
        console.log(
          `[QBittorrent] Non-torrent response received (${contentType}):`,
          text.substring(0, 500)
        );
        return {
          success: false,
          error: `Unexpected content type: ${contentType}. Response: ${text.slice(0, 200)}`,
        };
      }

      const data = await response.arrayBuffer();
      console.log(`[QBittorrent] Successfully fetched torrent file: ${data.byteLength} bytes`);
      if (data.byteLength === 0) {
        return { success: false, error: "Received empty torrent file" };
      }
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get torrent progress by hash
   */
  async getProgress(hash: string): Promise<DownloadProgress | null> {
    try {
      const response = await this.request(`/torrents/info?hashes=${hash.toLowerCase()}`);

      if (!response.ok) {
        return null;
      }

      const torrents = (await response.json()) as TorrentInfo[];
      if (torrents.length === 0) {
        return null;
      }

      const torrent = torrents[0];
      return this.mapTorrentProgress(torrent);
    } catch {
      return null;
    }
  }

  /**
   * Get all torrents
   */
  async getAllTorrents(): Promise<DownloadProgress[]> {
    try {
      const response = await this.request("/torrents/info");

      if (!response.ok) {
        return [];
      }

      const torrents = (await response.json()) as TorrentInfo[];
      return torrents.map((t) => this.mapTorrentProgress(t));
    } catch {
      return [];
    }
  }

  /**
   * Find a torrent by tag
   * Useful for finding torrents added via .torrent URL where we don't know the hash
   */
  async findTorrentByTag(tag: string, timeoutMs: number = 30000): Promise<DownloadProgress | null> {
    const startTime = Date.now();
    const pollInterval = 1000; // Check every second

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await this.request(`/torrents/info?tag=${encodeURIComponent(tag)}`);

        if (response.ok) {
          const torrents = (await response.json()) as TorrentInfo[];
          if (torrents.length > 0) {
            return this.mapTorrentProgress(torrents[0]);
          }
        }
      } catch {
        // Ignore errors, keep polling
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return null;
  }

  /**
   * Get torrent files
   */
  async getTorrentFiles(hash: string): Promise<TorrentFile[]> {
    try {
      const response = await this.request(`/torrents/files?hash=${hash.toLowerCase()}`);

      if (!response.ok) {
        return [];
      }

      return (await response.json()) as TorrentFile[];
    } catch {
      return [];
    }
  }

  /**
   * Get the main video file path from a torrent
   */
  async getMainVideoFile(hash: string): Promise<{ path: string; size: number } | null> {
    const progress = await this.getProgress(hash);
    if (!progress) return null;

    const files = await this.getTorrentFiles(hash);
    if (files.length === 0) return null;

    console.log(`[Download] Torrent ${hash.substring(0, 8)}...`);
    console.log(`[Download]   savePath: ${progress.savePath}`);
    console.log(`[Download]   contentPath: ${progress.contentPath}`);
    console.log(`[Download]   files[0].name: ${files[0]?.name}`);

    // Find the largest video file, excluding samples
    const videoExtensions = [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
    const minSizeBytes = 100 * 1024 * 1024; // 100MB minimum to exclude samples

    let videoFiles = files.filter((f) =>
      videoExtensions.some((ext) => f.name.toLowerCase().endsWith(ext))
    );

    // Filter out sample files and small files
    const originalCount = videoFiles.length;
    videoFiles = videoFiles.filter((f) => !isSampleFile(f.name) && f.size >= minSizeBytes);

    if (originalCount > videoFiles.length) {
      console.log(
        `[Download] Filtered out ${originalCount - videoFiles.length} sample/small files`
      );
    }

    if (videoFiles.length === 0) return null;

    // Sort by size, largest first
    videoFiles.sort((a, b) => b.size - a.size);

    // Note: qBittorrent file.name includes the relative path from save_path
    // e.g., "TorrentFolder/video.mkv" or just "video.mkv" for single-file torrents
    const mainFile = videoFiles[0];
    const fullPath = `${progress.savePath}/${mainFile.name}`;

    console.log(`[Download]   mainFile.name: ${mainFile.name}`);
    console.log(`[Download]   fullPath: ${fullPath}`);

    return { path: fullPath, size: mainFile.size };
  }

  /**
   * Map qBittorrent torrent info to our progress format
   */
  private mapTorrentProgress(torrent: TorrentInfo): DownloadProgress {
    const state = STATE_MAP[torrent.state] || "unknown";
    const isComplete = torrent.progress >= 1 || state === "seeding" || state === "complete";

    return {
      hash: torrent.hash,
      name: torrent.name,
      downloadedBytes: Math.floor(torrent.size * torrent.progress),
      totalBytes: torrent.size,
      downloadSpeed: torrent.dlspeed,
      uploadSpeed: torrent.upspeed,
      progress: torrent.progress * 100,
      eta: torrent.eta === 8640000 ? -1 : torrent.eta,
      seeds: torrent.num_seeds,
      peers: torrent.num_leechs,
      ratio: torrent.ratio,
      state,
      contentPath: this.mapContentPath(torrent.content_path),
      savePath: this.mapSavePath(torrent.save_path),
      isComplete,
    };
  }

  /**
   * Pause a torrent
   */
  async pauseTorrent(hash: string): Promise<boolean> {
    try {
      const response = await this.request("/torrents/pause", {
        method: "POST",
        body: new URLSearchParams({ hashes: hash.toLowerCase() }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Resume a torrent
   */
  async resumeTorrent(hash: string): Promise<boolean> {
    try {
      const response = await this.request("/torrents/resume", {
        method: "POST",
        body: new URLSearchParams({ hashes: hash.toLowerCase() }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Delete a torrent (optionally with files)
   */
  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<boolean> {
    try {
      const response = await this.request("/torrents/delete", {
        method: "POST",
        body: new URLSearchParams({
          hashes: hash.toLowerCase(),
          deleteFiles: deleteFiles.toString(),
        }),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for a torrent to complete downloading
   */
  async waitForCompletion(
    hash: string,
    options: {
      pollInterval?: number; // ms
      timeout?: number; // ms
      onProgress?: (progress: DownloadProgress) => void;
      checkCancelled?: () => boolean;
    } = {}
  ): Promise<{ success: boolean; progress?: DownloadProgress; error?: string }> {
    const {
      pollInterval = 5000,
      timeout = 24 * 60 * 60 * 1000,
      onProgress,
      checkCancelled,
    } = options;

    const startTime = Date.now();

    while (true) {
      // Check for cancellation
      if (checkCancelled?.()) {
        return { success: false, error: "Cancelled" };
      }

      // Check timeout
      if (Date.now() - startTime > timeout) {
        return { success: false, error: "Download timed out" };
      }

      const progress = await this.getProgress(hash);

      if (!progress) {
        return { success: false, error: "Torrent not found" };
      }

      // Report progress
      if (onProgress) {
        onProgress(progress);
      }

      // Check for errors
      if (progress.state === "error") {
        return { success: false, progress, error: "Torrent error" };
      }

      // Check for completion
      if (progress.isComplete) {
        return { success: true, progress };
      }

      // Wait before next poll
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
}

// Singleton instance
let downloadService: DownloadService | null = null;

export function getDownloadService(): DownloadService {
  if (!downloadService) {
    downloadService = new DownloadService();
  }
  return downloadService;
}

export { DownloadService };
