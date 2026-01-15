import { DownloadClientType } from "@prisma/client";
import { getConfig } from "../../config/index.js";
import { isSampleFile } from "../archive.js";
import { getSecretsService } from "../secrets.js";
import type {
  AddDownloadOptions,
  AddDownloadResult,
  DownloadProgress,
  DownloadState,
  IDownloadClient,
  TestConnectionResult,
} from "./IDownloadClient";

interface TorrentInfo {
  hash: string;
  name: string;
  size: number;
  progress: number;
  dlspeed: number;
  upspeed: number;
  num_seeds: number;
  num_leechs: number;
  ratio: number;
  eta: number;
  state: string;
  content_path: string;
  save_path: string;
  added_on: number;
  completion_on: number;
}

interface TorrentFile {
  index: number;
  name: string;
  size: number;
  progress: number;
  priority: number;
  is_seed: boolean;
  piece_range: number[];
  availability: number;
}

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

export class QBittorrentClient implements IDownloadClient {
  readonly type = DownloadClientType.QBITTORRENT;
  readonly name: string;

  private baseUrl: string;
  private username: string;
  private password: string;
  private qbBaseDir: string | undefined;
  private cookie: string | null = null;
  private cookieExpiry: number = 0;

  constructor(config: {
    name: string;
    url: string;
    username: string;
    password: string;
    baseDir?: string;
  }) {
    this.name = config.name;
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.qbBaseDir = config.baseDir?.replace(/\/+$/, "");
  }

  supportsType(type: "torrent" | "nzb"): boolean {
    return type === "torrent";
  }

  async testConnection(): Promise<TestConnectionResult> {
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
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async addDownload(
    url: string,
    data?: ArrayBuffer,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult> {
    try {
      if (url.startsWith("magnet:")) {
        return await this.addMagnet(url, options);
      }

      if (data) {
        return await this.addTorrentFile(data, undefined, options);
      }

      return await this.addTorrentUrl(url, options);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getProgress(clientHash: string): Promise<DownloadProgress | null> {
    try {
      const response = await this.request("/torrents/info");
      if (!response.ok) return null;

      const torrents = (await response.json()) as TorrentInfo[];
      const torrent = torrents.find((t) => t.hash.toLowerCase() === clientHash.toLowerCase());

      if (!torrent) return null;

      const state = STATE_MAP[torrent.state] || "unknown";
      const isComplete = state === "complete" || state === "seeding" || torrent.progress >= 1;

      return {
        clientHash: torrent.hash,
        hash: torrent.hash, // Backward compatibility
        name: torrent.name,
        downloadedBytes: Math.floor(torrent.size * torrent.progress),
        totalBytes: torrent.size,
        downloadSpeed: torrent.dlspeed,
        uploadSpeed: torrent.upspeed,
        progress: torrent.progress * 100,
        eta: torrent.eta === 8640000 ? -1 : torrent.eta,
        state,
        contentPath: this.mapContentPath(torrent.content_path),
        savePath: this.mapSavePath(torrent.save_path),
        isComplete,
        seeds: torrent.num_seeds || 0,
        peers: torrent.num_leechs || 0,
        ratio: torrent.ratio || 0,
      };
    } catch {
      return null;
    }
  }

  async getAllDownloads(): Promise<DownloadProgress[]> {
    try {
      const response = await this.request("/torrents/info");
      if (!response.ok) return [];

      const torrents = (await response.json()) as TorrentInfo[];

      return torrents.map((torrent) => {
        const state = STATE_MAP[torrent.state] || "unknown";
        const isComplete = state === "complete" || state === "seeding" || torrent.progress >= 1;

        return {
          clientHash: torrent.hash,
          hash: torrent.hash, // Backward compatibility
          name: torrent.name,
          downloadedBytes: Math.floor(torrent.size * torrent.progress),
          totalBytes: torrent.size,
          downloadSpeed: torrent.dlspeed,
          uploadSpeed: torrent.upspeed,
          progress: torrent.progress * 100,
          eta: torrent.eta === 8640000 ? -1 : torrent.eta,
          state,
          contentPath: this.mapContentPath(torrent.content_path),
          savePath: this.mapSavePath(torrent.save_path),
          isComplete,
          seeds: torrent.num_seeds || 0,
          peers: torrent.num_leechs || 0,
          ratio: torrent.ratio || 0,
        };
      });
    } catch {
      return [];
    }
  }

  async pauseDownload(clientHash: string): Promise<boolean> {
    try {
      const params = new URLSearchParams({ hashes: clientHash });
      const response = await this.request("/torrents/pause", {
        method: "POST",
        body: params,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async resumeDownload(clientHash: string): Promise<boolean> {
    try {
      const params = new URLSearchParams({ hashes: clientHash });
      const response = await this.request("/torrents/resume", {
        method: "POST",
        body: params,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async deleteDownload(clientHash: string, deleteFiles: boolean): Promise<boolean> {
    try {
      const params = new URLSearchParams({
        hashes: clientHash,
        deleteFiles: deleteFiles.toString(),
      });
      const response = await this.request("/torrents/delete", {
        method: "POST",
        body: params,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async getMainVideoFile(clientHash: string): Promise<{ path: string; size: number } | null> {
    try {
      const response = await this.request(`/torrents/files?hash=${clientHash}`);
      if (!response.ok) return null;

      const files = (await response.json()) as TorrentFile[];

      const videoFiles = files.filter((file) => {
        const ext = file.name.toLowerCase().split(".").pop();
        return (
          ext &&
          ["mkv", "mp4", "avi", "m4v", "mov", "wmv", "flv", "webm", "ts", "m2ts"].includes(ext) &&
          file.size > 50 * 1024 * 1024 &&
          !isSampleFile(file.name)
        );
      });

      if (videoFiles.length === 0) return null;

      const largestVideo = videoFiles.reduce((largest, current) =>
        current.size > largest.size ? current : largest
      );

      const progress = await this.getProgress(clientHash);
      if (!progress) return null;

      return {
        path: `${progress.contentPath}/${largestVideo.name}`,
        size: largestVideo.size,
      };
    } catch {
      return null;
    }
  }

  async addMagnet(magnetUri: string, options?: AddDownloadOptions): Promise<AddDownloadResult> {
    const params = new URLSearchParams({ urls: magnetUri });

    if (options?.savePath) params.append("savepath", options.savePath);
    if (options?.category) params.append("category", options.category);
    if (options?.paused) params.append("paused", "true");
    if (options?.tags && options.tags.length > 0) params.append("tags", options.tags.join(","));

    const response = await this.request("/torrents/add", {
      method: "POST",
      body: params,
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    if (text === "Fails.") {
      return { success: false, error: "Failed to add magnet" };
    }

    return { success: true };
  }

  async addTorrentUrl(
    torrentUrl: string,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult> {
    const params = new URLSearchParams({ urls: torrentUrl });

    if (options?.savePath) params.append("savepath", options.savePath);
    if (options?.category) params.append("category", options.category);
    if (options?.paused) params.append("paused", "true");
    if (options?.tags && options.tags.length > 0) params.append("tags", options.tags.join(","));

    const response = await this.request("/torrents/add", {
      method: "POST",
      body: params,
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    if (text === "Fails.") {
      return { success: false, error: "Failed to add torrent" };
    }

    return { success: true };
  }

  async addTorrentFile(
    fileData: ArrayBuffer,
    filename?: string,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult> {
    const formData = new FormData();
    const blob = new Blob([fileData], { type: "application/x-bittorrent" });
    formData.append("torrents", blob, filename || "torrent.torrent");

    if (options?.savePath) formData.append("savepath", options.savePath);
    if (options?.category) formData.append("category", options.category);
    if (options?.paused) formData.append("paused", "true");
    if (options?.tags && options.tags.length > 0) formData.append("tags", options.tags.join(","));

    const response = await this.request("/torrents/add", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    if (text === "Fails.") {
      return { success: false, error: "Failed to add torrent file" };
    }

    return { success: true };
  }

  private async authenticate(): Promise<void> {
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

    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/SID=([^;]+)/);
      if (match) {
        this.cookie = `SID=${match[1]}`;
        this.cookieExpiry = Date.now() + 50 * 60 * 1000;
      }
    }
  }

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
      this.cookie = null;
      this.cookieExpiry = 0;
      await this.authenticate();

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

  private mapContentPath(qbPath: string): string {
    if (!this.qbBaseDir || !qbPath) {
      return qbPath;
    }

    const pathParts = qbPath.replace(/\\/g, "/").split("/");
    const torrentName = pathParts[pathParts.length - 1];
    return `${this.qbBaseDir}/${torrentName}`;
  }

  private mapSavePath(qbPath: string): string {
    if (!this.qbBaseDir) {
      return qbPath?.replace(/\/+$/, "") || "";
    }
    return this.qbBaseDir;
  }

  // qBittorrent-specific methods (for backward compatibility)

  async getAllTorrents(): Promise<DownloadProgress[]> {
    return this.getAllDownloads();
  }

  async addTags(hash: string, tags: string[]): Promise<boolean> {
    try {
      const params = new URLSearchParams({
        hashes: hash,
        tags: tags.join(","),
      });
      const response = await this.request("/torrents/addTags", {
        method: "POST",
        body: params,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async findTorrentByTag(tag: string, timeoutMs: number = 30000): Promise<DownloadProgress | null> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const torrents = await this.getAllTorrents();
      const found = torrents.find((t) => t.name.toLowerCase().includes(tag.toLowerCase()));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  }

  async getTorrentFiles(hash: string): Promise<TorrentFile[]> {
    try {
      const response = await this.request(`/torrents/files?hash=${hash}`);
      if (!response.ok) return [];
      return (await response.json()) as TorrentFile[];
    } catch {
      return [];
    }
  }

  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<boolean> {
    return this.deleteDownload(hash, deleteFiles);
  }

  async pauseTorrent(hash: string): Promise<boolean> {
    return this.pauseDownload(hash);
  }

  async resumeTorrent(hash: string): Promise<boolean> {
    return this.resumeDownload(hash);
  }

  async fetchTorrentFile(
    downloadUrl: string,
    headers?: Record<string, string>
  ): Promise<{ success: boolean; data?: ArrayBuffer; error?: string }> {
    try {
      const response = await fetch(downloadUrl, { headers });
      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }
      const data = await response.arrayBuffer();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  async waitForCompletion(
    hash: string,
    options: {
      pollInterval?: number;
      timeout?: number;
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
      if (checkCancelled?.()) {
        return { success: false, error: "Cancelled" };
      }

      if (Date.now() - startTime > timeout) {
        return { success: false, error: "Download timed out" };
      }

      const progress = await this.getProgress(hash);

      if (!progress) {
        return { success: false, error: "Torrent not found" };
      }

      if (onProgress) {
        onProgress(progress);
      }

      if (progress.state === "error") {
        return { success: false, progress, error: "Torrent error" };
      }

      if (progress.isComplete) {
        return { success: true, progress };
      }

      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
  }
}

// Legacy singleton for backward compatibility
let legacyInstance: QBittorrentClient | null = null;

export function getDownloadService(): QBittorrentClient {
  if (!legacyInstance) {
    const config = getConfig();
    const secrets = getSecretsService();

    // Create initial instance with config values
    legacyInstance = new QBittorrentClient({
      name: "qBittorrent (Legacy)",
      url: config.qbittorrent.url,
      username: config.qbittorrent.username || "",
      password: config.qbittorrent.password || "",
      baseDir: config.qbittorrent.baseDir,
    });

    // Listen for secret changes to recreate instance
    secrets.on("change", (key: string) => {
      if (key.startsWith("qbittorrent.")) {
        legacyInstance = null;
      }
    });
  }

  return legacyInstance;
}
