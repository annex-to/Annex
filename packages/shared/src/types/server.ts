/**
 * Storage server and media server configuration
 */

export type TransferProtocol = "sftp" | "rsync" | "smb";
export type MediaServerType = "plex" | "emby" | "none";
export type Resolution = "4K" | "2K" | "1080p" | "720p" | "480p";
export type VideoCodec = "av1" | "hevc" | "h264";

export interface MediaServerConfig {
  type: MediaServerType;
  url: string;
  apiKey: string;
  libraryIds: {
    movies: string[];
    tv: string[];
  };
}

export interface StorageServerRestrictions {
  maxResolution: Resolution;
  maxFileSize: number | null; // bytes, null = unlimited
  preferredCodec: VideoCodec;
  maxBitrate: number | null; // kbps, null = unlimited
}

export interface StorageServer {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: TransferProtocol;
  username: string;
  // Password/key stored separately, not exposed to client
  paths: {
    movies: string;
    tv: string;
  };
  restrictions: StorageServerRestrictions;
  mediaServer: MediaServerConfig | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface StorageServerInput {
  name: string;
  host: string;
  port: number;
  protocol: TransferProtocol;
  username: string;
  password?: string;
  privateKey?: string;
  paths: {
    movies: string;
    tv: string;
  };
  restrictions: StorageServerRestrictions;
  mediaServer: MediaServerConfig | null;
  enabled: boolean;
}

export interface ServerTestResult {
  success: boolean;
  message: string;
  latencyMs?: number;
}
