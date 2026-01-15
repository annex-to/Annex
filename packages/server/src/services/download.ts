/**
 * Download Service (Legacy)
 *
 * This file now re-exports from QBittorrentClient for backward compatibility.
 * All new code should use the downloadClients module directly.
 */

export type {
  DownloadProgress,
  DownloadState,
} from "./downloadClients/IDownloadClient.js";
export {
  getDownloadService,
  QBittorrentClient as DownloadService,
} from "./downloadClients/QBittorrentClient.js";
