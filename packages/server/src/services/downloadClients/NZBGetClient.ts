import { DownloadClientType } from "@prisma/client";
import type {
  AddDownloadOptions,
  AddDownloadResult,
  DownloadProgress,
  DownloadState,
  IDownloadClient,
  TestConnectionResult,
} from "./IDownloadClient";

interface NZBGetRPCRequest {
  version: string;
  method: string;
  params: unknown[];
  id: number;
}

interface NZBGetRPCResponse<T> {
  version: string;
  result: T;
  error?: {
    code: number;
    message: string;
  };
}

interface NZBGetGroup {
  NZBID: number;
  NZBName: string;
  Category: string;
  Status: string;
  FileSizeMB: number;
  RemainingSizeMB: number;
  DownloadedSizeMB: number;
  DownloadRate: number;
  UploadRate: number;
  PostTotalTimeSec: number;
  DownloadTimeSec: number;
  DestDir: string;
}

interface NZBGetHistoryItem {
  NZBID: number;
  Name: string;
  Category: string;
  Status: string;
  FileSizeMB: number;
  DownloadedSizeMB: number;
  DestDir: string;
  FinalDir: string;
  DownloadTimeSec: number;
}

const STATE_MAP: Record<string, DownloadState> = {
  DOWNLOADING: "downloading",
  PAUSED: "paused",
  QUEUED: "queued",
  POST_PROCESSING: "extracting",
  SUCCESS: "complete",
  FAILURE: "error",
  WARNING: "complete",
  DELETED: "error",
};

export class NZBGetClient implements IDownloadClient {
  readonly type = DownloadClientType.NZBGET;
  readonly name: string;

  private baseUrl: string;
  private username: string;
  private password: string;
  private nzbGetBaseDir: string | undefined;
  private requestId = 1;
  private cachedVersion: string | null = null;

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
    this.nzbGetBaseDir = config.baseDir?.replace(/\/+$/, "");
  }

  supportsType(type: "torrent" | "nzb"): boolean {
    return type === "nzb";
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const response = await this.rpcCall<string>("version");

      if (!response.result) {
        return { success: false, error: response.error?.message || "Unknown error" };
      }

      return { success: true, version: response.result };
    } catch (error) {
      console.error(`[NZBGetClient] Exception:`, error);
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
      if (data) {
        return await this.addNzbFile(data, options);
      }

      return await this.addNzbUrl(url, options);
    } catch (error) {
      console.error(`[NZBGetClient] Exception:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async addNzbFile(
    fileData: ArrayBuffer,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult> {
    try {
      // Convert ArrayBuffer to base64 using chunked approach to avoid stack overflow
      const uint8Array = new Uint8Array(fileData);
      const base64 = this.arrayBufferToBase64(uint8Array);

      // Use provided filename or default, ensure .nzb extension
      let filename = options?.filename || "download";
      if (!filename.endsWith(".nzb")) {
        filename += ".nzb";
      }
      const category = options?.category || "";
      const priority = options?.priority || 0;
      const addPaused = options?.paused || false;

      // NZBGet 21.1 API signature (10 params):
      // Filename, Content, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore, DupeMode, PPParameters
      // Note: AutoCategory was added in v25.3, not present in 21.1
      const params: unknown[] = [
        filename, // Filename (string)
        base64, // Content (string) - base64 encoded NZB
        category, // Category (string)
        priority, // Priority (int)
        false, // AddToTop (bool)
        addPaused, // AddPaused (bool)
        "", // DupeKey (string)
        0, // DupeScore (int)
        "SCORE", // DupeMode (string)
        [], // PPParameters (struct[])
      ];

      console.log(`[NZBGetClient] Calling append with ${params.length} parameters (v21.1 signature)`);
      const response = await this.rpcCall<number>("append", params);

      if (response.error) {
        console.error(`[NZBGetClient] append failed:`, response.error);
        return { success: false, error: response.error.message };
      }

      if (!response.result) {
        return { success: false, error: "No NZBID returned" };
      }

      return { success: true, clientHash: String(response.result) };
    } catch (error) {
      console.error(`[NZBGetClient] Exception:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Convert Uint8Array to base64 string using chunked approach to avoid stack overflow
   */
  private arrayBufferToBase64(uint8Array: Uint8Array): string {
    const chunkSize = 8192; // Process 8KB at a time
    let binary = "";

    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, Math.min(i + chunkSize, uint8Array.length));
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }

  private async addNzbUrl(
    nzbUrl: string,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult> {
    try {
      // Use provided filename or default, ensure .nzb extension
      let filename = options?.filename || "download";
      if (!filename.endsWith(".nzb")) {
        filename += ".nzb";
      }
      const category = options?.category || "";
      const priority = options?.priority || 0;
      const addPaused = options?.paused || false;

      // NZBGet 21.1: Use append method with URL in Content parameter (no separate appendurl)
      // Filename, Content, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore, DupeMode, PPParameters
      const params: unknown[] = [
        filename, // Filename (string)
        nzbUrl, // Content (string) - URL to fetch NZB from
        category, // Category (string)
        priority, // Priority (int)
        false, // AddToTop (bool)
        addPaused, // AddPaused (bool)
        "", // DupeKey (string)
        0, // DupeScore (int)
        "SCORE", // DupeMode (string)
        [], // PPParameters (struct[])
      ];

      console.log(`[NZBGetClient] Calling append with URL (10 params)`);
      const response = await this.rpcCall<number>("append", params);

      if (response.error) {
        console.error(`[NZBGetClient] append (URL) failed:`, response.error);
        return { success: false, error: response.error.message };
      }

      if (!response.result) {
        return { success: false, error: "No NZBID returned" };
      }

      return { success: true, clientHash: String(response.result) };
    } catch (error) {
      console.error(`[NZBGetClient] Exception:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getProgress(clientHash: string): Promise<DownloadProgress | null> {
    try {
      const nzbId = Number.parseInt(clientHash, 10);

      // Check queue first
      const queueResponse = await this.rpcCall<NZBGetGroup[]>("listgroups");
      if (queueResponse.result) {
        const group = queueResponse.result.find((g) => g.NZBID === nzbId);
        if (group) {
          return this.mapGroupToProgress(group);
        }
      }

      // Check history
      const historyResponse = await this.rpcCall<NZBGetHistoryItem[]>("history");
      if (historyResponse.result) {
        const item = historyResponse.result.find((h) => h.NZBID === nzbId);
        if (item) {
          return this.mapHistoryItemToProgress(item);
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async getAllDownloads(): Promise<DownloadProgress[]> {
    try {
      const results: DownloadProgress[] = [];

      // Get queue
      const queueResponse = await this.rpcCall<NZBGetGroup[]>("listgroups");
      if (queueResponse.result) {
        results.push(...queueResponse.result.map((g) => this.mapGroupToProgress(g)));
      }

      // Get recent history
      const historyResponse = await this.rpcCall<NZBGetHistoryItem[]>("history");
      if (historyResponse.result) {
        results.push(...historyResponse.result.map((h) => this.mapHistoryItemToProgress(h)));
      }

      return results;
    } catch {
      return [];
    }
  }

  async pauseDownload(clientHash: string): Promise<boolean> {
    try {
      const nzbId = Number.parseInt(clientHash, 10);
      const response = await this.rpcCall<boolean>("editqueue", ["GroupPause", "", nzbId]);
      return response.result || false;
    } catch {
      return false;
    }
  }

  async resumeDownload(clientHash: string): Promise<boolean> {
    try {
      const nzbId = Number.parseInt(clientHash, 10);
      const response = await this.rpcCall<boolean>("editqueue", ["GroupResume", "", nzbId]);
      return response.result || false;
    } catch {
      return false;
    }
  }

  async deleteDownload(clientHash: string, deleteFiles: boolean): Promise<boolean> {
    try {
      const nzbId = Number.parseInt(clientHash, 10);
      const action = deleteFiles ? "GroupFinalDelete" : "GroupDelete";
      const response = await this.rpcCall<boolean>("editqueue", [action, "", nzbId]);
      return response.result || false;
    } catch {
      return false;
    }
  }

  async getMainVideoFile(clientHash: string): Promise<{ path: string; size: number } | null> {
    try {
      const progress = await this.getProgress(clientHash);
      if (!progress || !progress.isComplete) return null;

      // NZBGet stores files in DestDir/FinalDir
      // For now, return the content path and let the caller scan it
      return {
        path: progress.contentPath,
        size: progress.totalBytes,
      };
    } catch {
      return null;
    }
  }

  private async rpcCall<T>(method: string, params: unknown[] = []): Promise<NZBGetRPCResponse<T>> {
    const request: NZBGetRPCRequest = {
      version: "1.1",
      method,
      params,
      id: this.requestId++,
    };

    const auth = btoa(`${this.username}:${this.password}`);

    const response = await fetch(`${this.baseUrl}/jsonrpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return (await response.json()) as NZBGetRPCResponse<T>;
  }

  private mapGroupToProgress(group: NZBGetGroup): DownloadProgress {
    const totalBytes = group.FileSizeMB * 1024 * 1024;
    const downloadedBytes = group.DownloadedSizeMB * 1024 * 1024;
    const progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
    const remainingBytes = group.RemainingSizeMB * 1024 * 1024;
    const eta = group.DownloadRate > 0 ? remainingBytes / group.DownloadRate : 0;
    const state = this.mapState(group.Status);

    return {
      clientHash: String(group.NZBID),
      hash: String(group.NZBID),
      name: group.NZBName,
      downloadedBytes,
      totalBytes,
      downloadSpeed: group.DownloadRate,
      uploadSpeed: 0,
      progress,
      eta: Math.floor(eta),
      state,
      contentPath: this.mapPath(group.DestDir),
      savePath: this.mapPath(group.DestDir),
      isComplete: false,
      seeds: 0,
      peers: 0,
      ratio: 0,
    };
  }

  private mapHistoryItemToProgress(item: NZBGetHistoryItem): DownloadProgress {
    const totalBytes = item.FileSizeMB * 1024 * 1024;
    const state = this.mapState(item.Status);
    const isComplete = state === "complete";
    const path = item.FinalDir || item.DestDir;

    console.log(`[NZBGetClient] History item ${item.NZBID}:`, {
      status: item.Status,
      state,
      isComplete,
      finalDir: item.FinalDir,
      destDir: item.DestDir,
      path,
    });

    return {
      clientHash: String(item.NZBID),
      hash: String(item.NZBID),
      name: item.Name,
      downloadedBytes: totalBytes,
      totalBytes,
      downloadSpeed: 0,
      uploadSpeed: 0,
      progress: isComplete ? 100 : 0,
      eta: 0,
      state,
      contentPath: this.mapPath(path),
      savePath: this.mapPath(path),
      isComplete,
      seeds: 0,
      peers: 0,
      ratio: 0,
    };
  }

  private mapState(nzbGetStatus: string): DownloadState {
    return STATE_MAP[nzbGetStatus] || "unknown";
  }

  private mapPath(nzbGetPath: string): string {
    if (!this.nzbGetBaseDir || !nzbGetPath) {
      return nzbGetPath;
    }

    // If path starts with NZBGet's configured directory, replace with our base dir
    // For now, just return the path as-is since we don't know NZBGet's config
    return nzbGetPath;
  }
}
