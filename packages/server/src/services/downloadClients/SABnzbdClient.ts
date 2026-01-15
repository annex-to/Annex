import { DownloadClientType } from "@prisma/client";
import type {
  AddDownloadOptions,
  AddDownloadResult,
  DownloadProgress,
  DownloadState,
  IDownloadClient,
  TestConnectionResult,
} from "./IDownloadClient";

interface SABQueueSlot {
  nzo_id: string;
  filename: string;
  mb: string;
  mbleft: string;
  mbmissing: string;
  percentage: string;
  status: string;
  timeleft: string;
  eta: string;
  cat: string;
  priority: string;
  script: string;
  avg_age: string;
}

interface SABHistorySlot {
  nzo_id: string;
  name: string;
  size: string;
  category: string;
  status: string;
  fail_message: string;
  storage: string;
  path: string;
  completed: number;
  download_time: number;
}

interface SABQueueResponse {
  queue: {
    slots: SABQueueSlot[];
    speed: string;
    size: string;
    sizeleft: string;
    mb: string;
    mbleft: string;
    noofslots: number;
    status: string;
    timeleft: string;
    eta: string;
  };
}

interface SABHistoryResponse {
  history: {
    slots: SABHistorySlot[];
    noofslots: number;
  };
}

interface SABVersionResponse {
  version: string;
}

interface SABAddFileResponse {
  nzo_ids: string[];
}

const STATE_MAP: Record<string, DownloadState> = {
  Downloading: "downloading",
  Paused: "paused",
  Extracting: "extracting",
  Queued: "queued",
  Completed: "complete",
  Failed: "error",
  Verifying: "checking",
  Moving: "queued",
  Repairing: "checking",
};

export class SABnzbdClient implements IDownloadClient {
  readonly type = DownloadClientType.SABNZBD;
  readonly name: string;

  private baseUrl: string;
  private apiKey: string;
  private sabBaseDir: string | undefined;

  constructor(config: { name: string; url: string; apiKey: string; baseDir?: string }) {
    this.name = config.name;
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.sabBaseDir = config.baseDir?.replace(/\/+$/, "");
  }

  supportsType(type: "torrent" | "nzb"): boolean {
    return type === "nzb";
  }

  async testConnection(): Promise<TestConnectionResult> {
    try {
      const url = `${this.baseUrl}/api?mode=version&apikey=${this.apiKey}&output=json`;
      const response = await fetch(url);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = (await response.json()) as SABVersionResponse;
      return { success: true, version: data.version };
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
      if (data) {
        return await this.addNzbFile(data, options);
      }

      return await this.addNzbUrl(url, options);
    } catch (error) {
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
      const formData = new FormData();
      const blob = new Blob([fileData], { type: "application/x-nzb" });
      formData.append("name", blob, "file.nzb");

      if (options?.category) formData.append("cat", options.category);
      if (options?.priority !== undefined) formData.append("priority", String(options.priority));
      if (options?.paused) formData.append("pause", "1");

      const url = `${this.baseUrl}/api?mode=addfile&apikey=${this.apiKey}&output=json`;
      const response = await fetch(url, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const result = (await response.json()) as SABAddFileResponse;

      if (!result.nzo_ids || result.nzo_ids.length === 0) {
        return { success: false, error: "No NZO ID returned" };
      }

      return { success: true, clientHash: result.nzo_ids[0] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async addNzbUrl(
    nzbUrl: string,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult> {
    try {
      const params = new URLSearchParams({
        mode: "addurl",
        name: nzbUrl,
        apikey: this.apiKey,
        output: "json",
      });

      if (options?.category) params.append("cat", options.category);
      if (options?.priority !== undefined) params.append("priority", String(options.priority));
      if (options?.paused) params.append("pause", "1");

      const url = `${this.baseUrl}/api?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        return { success: false, error: `HTTP ${response.status}` };
      }

      const result = (await response.json()) as SABAddFileResponse;

      if (!result.nzo_ids || result.nzo_ids.length === 0) {
        return { success: false, error: "No NZO ID returned" };
      }

      return { success: true, clientHash: result.nzo_ids[0] };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  async getProgress(clientHash: string): Promise<DownloadProgress | null> {
    try {
      // Check queue first
      const queueUrl = `${this.baseUrl}/api?mode=queue&apikey=${this.apiKey}&output=json`;
      const queueResponse = await fetch(queueUrl);

      if (queueResponse.ok) {
        const queueData = (await queueResponse.json()) as SABQueueResponse;
        const slot = queueData.queue.slots.find((s) => s.nzo_id === clientHash);

        if (slot) {
          return this.mapQueueSlotToProgress(slot);
        }
      }

      // Check history
      const historyUrl = `${this.baseUrl}/api?mode=history&apikey=${this.apiKey}&output=json`;
      const historyResponse = await fetch(historyUrl);

      if (historyResponse.ok) {
        const historyData = (await historyResponse.json()) as SABHistoryResponse;
        const slot = historyData.history.slots.find((s) => s.nzo_id === clientHash);

        if (slot) {
          return this.mapHistorySlotToProgress(slot);
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
      const queueUrl = `${this.baseUrl}/api?mode=queue&apikey=${this.apiKey}&output=json`;
      const queueResponse = await fetch(queueUrl);

      if (queueResponse.ok) {
        const queueData = (await queueResponse.json()) as SABQueueResponse;
        results.push(...queueData.queue.slots.map((s) => this.mapQueueSlotToProgress(s)));
      }

      // Get recent history
      const historyUrl = `${this.baseUrl}/api?mode=history&apikey=${this.apiKey}&output=json&limit=50`;
      const historyResponse = await fetch(historyUrl);

      if (historyResponse.ok) {
        const historyData = (await historyResponse.json()) as SABHistoryResponse;
        results.push(...historyData.history.slots.map((s) => this.mapHistorySlotToProgress(s)));
      }

      return results;
    } catch {
      return [];
    }
  }

  async pauseDownload(clientHash: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api?mode=queue&name=pause&value=${clientHash}&apikey=${this.apiKey}`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  async resumeDownload(clientHash: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api?mode=queue&name=resume&value=${clientHash}&apikey=${this.apiKey}`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  async deleteDownload(clientHash: string, deleteFiles: boolean): Promise<boolean> {
    try {
      const mode = deleteFiles ? "delete" : "delete";
      const url = `${this.baseUrl}/api?mode=queue&name=${mode}&value=${clientHash}&apikey=${this.apiKey}`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  async getMainVideoFile(clientHash: string): Promise<{ path: string; size: number } | null> {
    try {
      const progress = await this.getProgress(clientHash);
      if (!progress || !progress.isComplete) return null;

      // SABnzbd stores files in contentPath
      // For now, we'll need to scan the directory to find the largest video file
      // This would require file system access which we don't have here
      // Return the content path and let the caller scan it
      return {
        path: progress.contentPath,
        size: progress.totalBytes,
      };
    } catch {
      return null;
    }
  }

  private mapQueueSlotToProgress(slot: SABQueueSlot): DownloadProgress {
    const totalBytes = Number.parseFloat(slot.mb) * 1024 * 1024;
    const leftBytes = Number.parseFloat(slot.mbleft) * 1024 * 1024;
    const downloadedBytes = totalBytes - leftBytes;
    const progress = Number.parseFloat(slot.percentage);
    const state = this.mapState(slot.status);
    const eta = this.parseEta(slot.timeleft);

    return {
      clientHash: slot.nzo_id,
      hash: slot.nzo_id,
      name: slot.filename,
      downloadedBytes,
      totalBytes,
      downloadSpeed: 0, // SABnzbd doesn't provide per-item speed in queue
      uploadSpeed: 0,
      progress,
      eta,
      state,
      contentPath: "",
      savePath: "",
      isComplete: false,
      seeds: 0,
      peers: 0,
      ratio: 0,
    };
  }

  private mapHistorySlotToProgress(slot: SABHistorySlot): DownloadProgress {
    const totalBytes = this.parseSize(slot.size);
    const state = this.mapState(slot.status);
    const isComplete = state === "complete";

    return {
      clientHash: slot.nzo_id,
      hash: slot.nzo_id,
      name: slot.name,
      downloadedBytes: totalBytes,
      totalBytes,
      downloadSpeed: 0,
      uploadSpeed: 0,
      progress: isComplete ? 100 : 0,
      eta: 0,
      state,
      contentPath: this.mapPath(slot.path || slot.storage),
      savePath: this.mapPath(slot.path || slot.storage),
      isComplete,
      seeds: 0,
      peers: 0,
      ratio: 0,
    };
  }

  private mapState(sabStatus: string): DownloadState {
    return STATE_MAP[sabStatus] || "unknown";
  }

  private parseEta(timeLeft: string): number {
    // SABnzbd returns time in format like "1:23:45" (H:MM:SS)
    if (!timeLeft || timeLeft === "0:00:00") return 0;

    const parts = timeLeft.split(":");
    if (parts.length !== 3) return 0;

    const hours = Number.parseInt(parts[0], 10) || 0;
    const minutes = Number.parseInt(parts[1], 10) || 0;
    const seconds = Number.parseInt(parts[2], 10) || 0;

    return hours * 3600 + minutes * 60 + seconds;
  }

  private parseSize(sizeStr: string): number {
    // SABnzbd returns size like "1.23 GB", "456.78 MB", etc.
    const match = sizeStr.match(/^([\d.]+)\s*([KMGT]?B)$/i);
    if (!match) return 0;

    const value = Number.parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    const multipliers: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024,
      TB: 1024 * 1024 * 1024 * 1024,
    };

    return value * (multipliers[unit] || 1);
  }

  private mapPath(sabPath: string): string {
    if (!this.sabBaseDir || !sabPath) {
      return sabPath;
    }

    // If path starts with SABnzbd's configured directory, replace with our base dir
    // For now, just return the path as-is since we don't know SABnzbd's config
    return sabPath;
  }
}
