import type { DownloadClientType } from "@prisma/client";

export type DownloadState =
  | "queued"
  | "downloading"
  | "stalled"
  | "paused"
  | "checking"
  | "extracting"
  | "complete"
  | "seeding"
  | "error"
  | "unknown";

export interface DownloadProgress {
  clientHash: string;
  hash?: string; // Alias for backward compatibility
  name: string;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  uploadSpeed: number;
  progress: number;
  eta: number;
  state: DownloadState;
  contentPath: string;
  savePath: string;
  isComplete: boolean;
  seeds: number;
  peers: number;
  ratio: number;
}

export interface AddDownloadOptions {
  savePath?: string;
  category?: string;
  paused?: boolean;
  tags?: string[];
  priority?: number;
}

export interface AddDownloadResult {
  success: boolean;
  clientHash?: string;
  error?: string;
}

export interface TestConnectionResult {
  success: boolean;
  version?: string;
  error?: string;
}

export interface IDownloadClient {
  readonly type: DownloadClientType;
  readonly name: string;

  testConnection(): Promise<TestConnectionResult>;

  addDownload(
    url: string,
    data?: ArrayBuffer,
    options?: AddDownloadOptions
  ): Promise<AddDownloadResult>;

  getProgress(clientHash: string): Promise<DownloadProgress | null>;
  getAllDownloads(): Promise<DownloadProgress[]>;

  pauseDownload(clientHash: string): Promise<boolean>;
  resumeDownload(clientHash: string): Promise<boolean>;
  deleteDownload(clientHash: string, deleteFiles: boolean): Promise<boolean>;

  getMainVideoFile(clientHash: string): Promise<{ path: string; size: number } | null>;

  supportsType(type: "torrent" | "nzb"): boolean;
}
