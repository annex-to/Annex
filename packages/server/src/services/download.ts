/**
 * Download Service
 *
 * Manages torrent downloads via WebTorrent.
 * Handles adding, monitoring, and cleaning up torrents.
 */

import WebTorrent from "webtorrent";
import type { Torrent } from "webtorrent";
import { getConfig } from "../config/index.js";
import { isSampleFile } from "./archive.js";

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

interface TorrentFileInfo {
  index: number;
  name: string;
  size: number;
  progress: number; // 0-1
  priority: number;
  is_seed: boolean;
  piece_range: number[];
  availability: number;
}

class DownloadService {
  private client: WebTorrent.Instance | null = null;
  private downloadPath: string;
  private pausedTorrents: Set<string> = new Set();

  constructor() {
    const config = getConfig();
    this.downloadPath = config.downloads.directory;
  }

  /**
   * Get or create the WebTorrent client
   */
  private getClient(): WebTorrent.Instance {
    if (!this.client) {
      this.client = new WebTorrent({
        maxConns: 55,
        dht: true,
        lsd: true,
        webSeeds: true,
      });

      this.client.on("error", (err: Error | string) => {
        const message = typeof err === "string" ? err : err.message;
        console.error("[WebTorrent] Client error:", message);
      });
    }
    return this.client;
  }

  /**
   * Map WebTorrent torrent state to our internal DownloadState
   */
  private mapState(torrent: Torrent): DownloadState {
    if (this.pausedTorrents.has(torrent.infoHash)) {
      return "paused";
    }
    if (torrent.done) {
      return torrent.uploadSpeed > 0 ? "seeding" : "complete";
    }
    if (torrent.numPeers === 0) {
      return "stalled";
    }
    return "downloading";
  }

  /**
   * Test connection - WebTorrent is always "connected" as it runs locally
   */
  async testConnection(): Promise<{ success: boolean; version?: string; error?: string }> {
    try {
      this.getClient();
      return {
        success: true,
        version: `WebTorrent ${(WebTorrent as unknown as { VERSION?: string }).VERSION || "2.x"}`,
      };
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
      const client = this.getClient();
      const savePath = options.savePath || this.downloadPath;

      return new Promise((resolve) => {
        const torrent = client.add(magnetUri, { path: savePath });

        torrent.on("ready", () => {
          if (options.paused) {
            torrent.pause();
            this.pausedTorrents.add(torrent.infoHash);
          }
          resolve({ success: true, hash: torrent.infoHash });
        });

        torrent.on("error", (err: Error | string) => {
          const message = typeof err === "string" ? err : err.message;
          resolve({ success: false, error: message });
        });

        // Timeout for metadata fetch
        setTimeout(() => {
          if (!torrent.ready) {
            resolve({ success: false, error: "Timeout waiting for torrent metadata" });
          }
        }, 60000);
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Add a torrent from .torrent URL
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
    // For magnet URIs, delegate to addMagnet
    if (torrentUrl.startsWith("magnet:")) {
      return this.addMagnet(torrentUrl, options);
    }

    try {
      const client = this.getClient();
      const savePath = options.savePath || this.downloadPath;

      return new Promise((resolve) => {
        const torrent = client.add(torrentUrl, { path: savePath });

        torrent.on("ready", () => {
          if (options.paused) {
            torrent.pause();
            this.pausedTorrents.add(torrent.infoHash);
          }
          resolve({ success: true, hash: torrent.infoHash });
        });

        torrent.on("error", (err: Error | string) => {
          const message = typeof err === "string" ? err : err.message;
          resolve({ success: false, error: message });
        });

        setTimeout(() => {
          if (!torrent.ready) {
            resolve({ success: false, error: "Timeout waiting for torrent metadata" });
          }
        }, 60000);
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Add a torrent from raw .torrent file data
   */
  async addTorrentFile(
    torrentData: ArrayBuffer,
    _filename: string,
    options: {
      savePath?: string;
      category?: string;
      paused?: boolean;
      tags?: string[];
    } = {}
  ): Promise<{ success: boolean; hash?: string; error?: string }> {
    try {
      const client = this.getClient();
      const savePath = options.savePath || this.downloadPath;

      return new Promise((resolve) => {
        const torrent = client.add(Buffer.from(torrentData), { path: savePath });

        torrent.on("ready", () => {
          if (options.paused) {
            torrent.pause();
            this.pausedTorrents.add(torrent.infoHash);
          }
          resolve({ success: true, hash: torrent.infoHash });
        });

        torrent.on("error", (err: Error | string) => {
          const message = typeof err === "string" ? err : err.message;
          resolve({ success: false, error: message });
        });

        setTimeout(() => {
          if (!torrent.ready) {
            resolve({ success: false, error: "Timeout waiting for torrent metadata" });
          }
        }, 60000);
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fetch a torrent file from a URL
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
      if (
        !contentType.includes("application/x-bittorrent") &&
        !contentType.includes("application/octet-stream")
      ) {
        const text = await response.text();
        console.log(
          `[Download] Non-torrent response received (${contentType}):`,
          text.substring(0, 500)
        );
        return {
          success: false,
          error: `Unexpected content type: ${contentType}. Response: ${text.slice(0, 200)}`,
        };
      }

      const data = await response.arrayBuffer();
      console.log(`[Download] Successfully fetched torrent file: ${data.byteLength} bytes`);
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
      const client = this.getClient();
      const torrent = await client.get(hash);

      if (!torrent) {
        return null;
      }

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
      const client = this.getClient();
      return client.torrents.map((t) => this.mapTorrentProgress(t));
    } catch {
      return [];
    }
  }

  /**
   * Find a torrent by tag - WebTorrent doesn't support tags natively,
   * so this polls until the torrent is added
   */
  async findTorrentByTag(_tag: string, timeoutMs: number = 30000): Promise<DownloadProgress | null> {
    // Since WebTorrent returns the hash immediately, this is mainly for compatibility
    // Just return the most recently added torrent within the timeout
    const startTime = Date.now();
    const pollInterval = 1000;

    while (Date.now() - startTime < timeoutMs) {
      const torrents = await this.getAllTorrents();
      if (torrents.length > 0) {
        // Return the most recently added (last in array)
        return torrents[torrents.length - 1];
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    return null;
  }

  /**
   * Get torrent files
   */
  async getTorrentFiles(hash: string): Promise<TorrentFileInfo[]> {
    try {
      const client = this.getClient();
      const torrent = await client.get(hash);

      if (!torrent) {
        return [];
      }

      return torrent.files.map((file, index) => ({
        index,
        name: file.path,
        size: file.length,
        progress: file.progress,
        priority: 1, // WebTorrent doesn't have priority concept
        is_seed: torrent.done,
        piece_range: [],
        availability: 1,
      }));
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

    const mainFile = videoFiles[0];
    // WebTorrent file.path is relative to the torrent's save path
    const fullPath = `${progress.savePath}/${mainFile.name}`;

    console.log(`[Download]   mainFile.name: ${mainFile.name}`);
    console.log(`[Download]   fullPath: ${fullPath}`);

    return { path: fullPath, size: mainFile.size };
  }

  /**
   * Map WebTorrent torrent to our progress format
   */
  private mapTorrentProgress(torrent: Torrent): DownloadProgress {
    const state = this.mapState(torrent);
    const isComplete = torrent.done;

    // Calculate ETA
    let eta = -1;
    if (torrent.downloadSpeed > 0 && !torrent.done) {
      const remaining = torrent.length - torrent.downloaded;
      eta = Math.ceil(remaining / torrent.downloadSpeed);
    }

    // Get the content path - for single file it's the file path, for multi-file it's the folder
    const savePath = torrent.path || this.downloadPath;
    const contentPath =
      torrent.files.length === 1
        ? `${savePath}/${torrent.files[0].path}`
        : `${savePath}/${torrent.name}`;

    return {
      hash: torrent.infoHash,
      name: torrent.name,
      downloadedBytes: torrent.downloaded,
      totalBytes: torrent.length,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      progress: torrent.progress * 100,
      eta,
      seeds: torrent.numPeers, // WebTorrent doesn't distinguish seeds from peers
      peers: torrent.numPeers,
      ratio: torrent.uploaded / Math.max(torrent.downloaded, 1),
      state,
      contentPath,
      savePath,
      isComplete,
    };
  }

  /**
   * Pause a torrent
   */
  async pauseTorrent(hash: string): Promise<boolean> {
    try {
      const client = this.getClient();
      const torrent = await client.get(hash);
      if (torrent) {
        torrent.pause();
        this.pausedTorrents.add(hash);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Resume a torrent
   */
  async resumeTorrent(hash: string): Promise<boolean> {
    try {
      const client = this.getClient();
      const torrent = await client.get(hash);
      if (torrent) {
        torrent.resume();
        this.pausedTorrents.delete(hash);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Delete a torrent (optionally with files)
   */
  async deleteTorrent(hash: string, deleteFiles: boolean = false): Promise<boolean> {
    try {
      const client = this.getClient();
      const torrent = await client.get(hash);
      if (torrent) {
        await client.remove(hash, { destroyStore: deleteFiles });
        this.pausedTorrents.delete(hash);
        return true;
      }
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Download] Error removing torrent: ${message}`);
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
    const { pollInterval = 5000, timeout = 24 * 60 * 60 * 1000, onProgress, checkCancelled } =
      options;

    const startTime = Date.now();
    const client = this.getClient();
    const torrent = await client.get(hash);

    if (!torrent) {
      return { success: false, error: "Torrent not found" };
    }

    return new Promise((resolve) => {
      const progressInterval = setInterval(() => {
        // Check for cancellation
        if (checkCancelled?.()) {
          clearInterval(progressInterval);
          resolve({ success: false, error: "Cancelled" });
          return;
        }

        // Check timeout
        if (Date.now() - startTime > timeout) {
          clearInterval(progressInterval);
          resolve({ success: false, error: "Download timed out" });
          return;
        }

        const progress = this.mapTorrentProgress(torrent);

        // Report progress
        if (onProgress) {
          onProgress(progress);
        }

        // Check for errors
        if (progress.state === "error") {
          clearInterval(progressInterval);
          resolve({ success: false, progress, error: "Torrent error" });
          return;
        }

        // Check for completion
        if (progress.isComplete) {
          clearInterval(progressInterval);
          resolve({ success: true, progress });
          return;
        }
      }, pollInterval);

      // Also listen for the done event for immediate completion
      torrent.on("done", () => {
        clearInterval(progressInterval);
        const progress = this.mapTorrentProgress(torrent);
        resolve({ success: true, progress });
      });

      torrent.on("error", (err: Error | string) => {
        clearInterval(progressInterval);
        const message = typeof err === "string" ? err : err.message;
        resolve({ success: false, error: message });
      });
    });
  }

  /**
   * Destroy the WebTorrent client (cleanup)
   */
  async destroy(): Promise<void> {
    if (this.client) {
      return new Promise((resolve) => {
        this.client?.destroy((err) => {
          if (err) {
            const message = typeof err === "string" ? err : err.message;
            console.error("[WebTorrent] Error destroying client:", message);
          }
          this.client = null;
          this.pausedTorrents.clear();
          resolve();
        });
      });
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
