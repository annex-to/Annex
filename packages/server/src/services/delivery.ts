/**
 * Delivery Service
 *
 * Handles file transfer to storage servers via SFTP, rsync, or SMB.
 * Also triggers library scans on Plex/Emby after delivery.
 */

import { spawn, ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { dirname } from "path";
import SftpClient from "ssh2-sftp-client";
import { prisma } from "../db/client.js";
import { triggerPlexLibraryScan } from "./plex.js";
import type { StorageServer } from "@prisma/client";

export interface DeliveryProgress {
  bytesTransferred: number;
  totalBytes: number;
  progress: number; // 0-100
  speed: number; // bytes/sec
  eta: number; // seconds
}

export interface DeliveryResult {
  success: boolean;
  serverId: string;
  serverName: string;
  localPath: string;
  remotePath: string;
  bytesTransferred: number;
  duration: number; // seconds
  error?: string;
  libraryScanTriggered: boolean;
}

class DeliveryService {
  private activeTransfers: Map<string, { cancel: () => void }> = new Map();

  /**
   * Calculate SHA256 checksum of a file
   */
  async calculateChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);

      stream.on("data", (data) => hash.update(data));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  /**
   * Get storage server by ID
   */
  async getServer(serverId: string): Promise<StorageServer | null> {
    return prisma.storageServer.findUnique({
      where: { id: serverId },
    });
  }

  /**
   * Deliver a file to a storage server
   */
  async deliver(
    serverId: string,
    localPath: string,
    remotePath: string,
    options: {
      jobId?: string;
      onProgress?: (progress: DeliveryProgress) => void;
      checkCancelled?: () => boolean;
    } = {}
  ): Promise<DeliveryResult> {
    const { jobId, onProgress, checkCancelled } = options;
    const startTime = Date.now();

    // Get server details
    const server = await this.getServer(serverId);
    if (!server) {
      return {
        success: false,
        serverId,
        serverName: "Unknown",
        localPath,
        remotePath,
        bytesTransferred: 0,
        duration: 0,
        error: "Storage server not found",
        libraryScanTriggered: false,
      };
    }

    // Check if file exists
    let fileSize: number;
    try {
      const stats = await fs.stat(localPath);
      fileSize = stats.size;
    } catch (error) {
      return {
        success: false,
        serverId,
        serverName: server.name,
        localPath,
        remotePath,
        bytesTransferred: 0,
        duration: 0,
        error: `Local file not found: ${localPath}`,
        libraryScanTriggered: false,
      };
    }

    console.log(`[Delivery] Transferring to ${server.name} via ${server.protocol}: ${localPath} -> ${remotePath}`);

    let result: DeliveryResult;

    try {
      switch (server.protocol) {
        case "LOCAL":
          result = await this.deliverViaLocal(server, localPath, remotePath, fileSize, {
            jobId,
            onProgress,
            checkCancelled,
          });
          break;

        case "SFTP":
          result = await this.deliverViaSftp(server, localPath, remotePath, fileSize, {
            jobId,
            onProgress,
            checkCancelled,
          });
          break;

        case "RSYNC":
          result = await this.deliverViaRsync(server, localPath, remotePath, fileSize, {
            jobId,
            onProgress,
            checkCancelled,
          });
          break;

        case "SMB":
          result = await this.deliverViaSmb(server, localPath, remotePath, fileSize, {
            jobId,
            onProgress,
            checkCancelled,
          });
          break;

        default:
          result = {
            success: false,
            serverId,
            serverName: server.name,
            localPath,
            remotePath,
            bytesTransferred: 0,
            duration: (Date.now() - startTime) / 1000,
            error: `Unsupported protocol: ${server.protocol}`,
            libraryScanTriggered: false,
          };
      }
    } catch (error) {
      console.error(`[Delivery] Transfer failed:`, error);
      result = {
        success: false,
        serverId,
        serverName: server.name,
        localPath,
        remotePath,
        bytesTransferred: 0,
        duration: (Date.now() - startTime) / 1000,
        error: error instanceof Error ? error.message : String(error),
        libraryScanTriggered: false,
      };
    }

    if (result.success) {
      console.log(`[Delivery] Transfer successful to ${server.name}: ${remotePath}`);
    } else {
      console.error(`[Delivery] Transfer failed to ${server.name}: ${result.error}`);
    }

    // Trigger library scan if delivery was successful
    if (result.success && server.mediaServerType !== "NONE") {
      try {
        await this.triggerLibraryScan(server, remotePath);
        result.libraryScanTriggered = true;
        console.log(`[Delivery] Library scan triggered for ${server.name}`);
      } catch (error) {
        console.error(`[Delivery] Failed to trigger library scan:`, error);
        // Don't fail the delivery just because scan failed
      }
    }

    return result;
  }

  /**
   * Deliver file via local filesystem copy
   */
  private async deliverViaLocal(
    server: StorageServer,
    localPath: string,
    remotePath: string,
    fileSize: number,
    options: {
      jobId?: string;
      onProgress?: (progress: DeliveryProgress) => void;
      checkCancelled?: () => boolean;
    }
  ): Promise<DeliveryResult> {
    const { onProgress, checkCancelled } = options;
    const startTime = Date.now();

    try {
      // Ensure remote directory exists
      const remoteDir = dirname(remotePath);
      await fs.mkdir(remoteDir, { recursive: true });

      // Copy file with progress tracking
      const readStream = createReadStream(localPath);
      const { createWriteStream } = await import("fs");
      const writeStream = createWriteStream(remotePath);

      let bytesTransferred = 0;
      let cancelled = false;

      // Set up progress tracking
      const progressInterval = setInterval(() => {
        if (checkCancelled?.()) {
          cancelled = true;
          readStream.destroy();
          writeStream.destroy();
        }

        if (onProgress && bytesTransferred > 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = bytesTransferred / elapsed;
          const remaining = fileSize - bytesTransferred;
          const eta = speed > 0 ? remaining / speed : 0;

          onProgress({
            bytesTransferred,
            totalBytes: fileSize,
            progress: (bytesTransferred / fileSize) * 100,
            speed,
            eta,
          });
        }
      }, 500);

      readStream.on("data", (chunk: Buffer | string) => {
        bytesTransferred += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      });

      await new Promise<void>((resolve, reject) => {
        readStream.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        readStream.on("error", reject);
      });

      clearInterval(progressInterval);

      if (cancelled) {
        // Clean up partial file
        try {
          await fs.unlink(remotePath);
        } catch {
          // Ignore
        }

        return {
          success: false,
          serverId: server.id,
          serverName: server.name,
          localPath,
          remotePath,
          bytesTransferred,
          duration: (Date.now() - startTime) / 1000,
          error: "Transfer cancelled",
          libraryScanTriggered: false,
        };
      }

      console.log(`[Delivery] Local copy complete: ${remotePath}`);

      return {
        success: true,
        serverId: server.id,
        serverName: server.name,
        localPath,
        remotePath,
        bytesTransferred: fileSize,
        duration: (Date.now() - startTime) / 1000,
        libraryScanTriggered: false,
      };
    } catch (error) {
      console.error(`[Delivery] Local copy failed:`, error);
      return {
        success: false,
        serverId: server.id,
        serverName: server.name,
        localPath,
        remotePath,
        bytesTransferred: 0,
        duration: (Date.now() - startTime) / 1000,
        error: error instanceof Error ? error.message : String(error),
        libraryScanTriggered: false,
      };
    }
  }

  /**
   * Deliver file via SFTP
   */
  private async deliverViaSftp(
    server: StorageServer,
    localPath: string,
    remotePath: string,
    fileSize: number,
    options: {
      jobId?: string;
      onProgress?: (progress: DeliveryProgress) => void;
      checkCancelled?: () => boolean;
    }
  ): Promise<DeliveryResult> {
    const { jobId, onProgress, checkCancelled } = options;
    const startTime = Date.now();

    const sftp = new SftpClient();
    let cancelled = false;

    // Set up cancellation
    if (jobId) {
      this.activeTransfers.set(jobId, {
        cancel: () => {
          cancelled = true;
          sftp.end();
        },
      });
    }

    try {
      // Connect
      await sftp.connect({
        host: server.host,
        port: server.port,
        username: server.username,
        password: server.encryptedPassword || undefined,
        privateKey: server.encryptedPrivateKey || undefined,
        readyTimeout: 30000,
      });

      // Ensure remote directory exists
      const remoteDir = dirname(remotePath);
      await sftp.mkdir(remoteDir, true);

      // Track progress
      let bytesTransferred = 0;
      const progressInterval = setInterval(() => {
        if (onProgress && bytesTransferred > 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = bytesTransferred / elapsed;
          const remaining = fileSize - bytesTransferred;
          const eta = speed > 0 ? remaining / speed : 0;

          onProgress({
            bytesTransferred,
            totalBytes: fileSize,
            progress: (bytesTransferred / fileSize) * 100,
            speed,
            eta,
          });
        }

        // Check for cancellation
        if (checkCancelled?.()) {
          cancelled = true;
          sftp.end();
        }
      }, 1000);

      // Upload file
      await sftp.fastPut(localPath, remotePath, {
        step: (transferred: number) => {
          bytesTransferred = transferred;
        },
      });

      clearInterval(progressInterval);

      if (cancelled) {
        // Clean up partial file
        try {
          await sftp.delete(remotePath);
        } catch {
          // Ignore
        }

        return {
          success: false,
          serverId: server.id,
          serverName: server.name,
          localPath,
          remotePath,
          bytesTransferred,
          duration: (Date.now() - startTime) / 1000,
          error: "Transfer cancelled",
          libraryScanTriggered: false,
        };
      }

      return {
        success: true,
        serverId: server.id,
        serverName: server.name,
        localPath,
        remotePath,
        bytesTransferred: fileSize,
        duration: (Date.now() - startTime) / 1000,
        libraryScanTriggered: false,
      };
    } finally {
      if (jobId) {
        this.activeTransfers.delete(jobId);
      }
      await sftp.end();
    }
  }

  /**
   * Deliver file via rsync over SSH
   */
  private async deliverViaRsync(
    server: StorageServer,
    localPath: string,
    remotePath: string,
    fileSize: number,
    options: {
      jobId?: string;
      onProgress?: (progress: DeliveryProgress) => void;
      checkCancelled?: () => boolean;
    }
  ): Promise<DeliveryResult> {
    const { jobId, onProgress, checkCancelled } = options;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const sshTarget = `${server.username}@${server.host}:${remotePath}`;

      const args = [
        "-rltDvz",       // Like -a but without -pog (no perms, owner, group)
        "--progress",
        "--partial",
        "--mkpath",      // Create parent directories on destination
        "-e", `ssh -p ${server.port} -o StrictHostKeyChecking=no`,
        localPath,
        sshTarget,
      ];

      console.log(`[Delivery] Running rsync: rsync ${args.join(" ")}`);
      const process = spawn("rsync", args);

      if (jobId) {
        this.activeTransfers.set(jobId, {
          cancel: () => process.kill("SIGTERM"),
        });
      }

      let bytesTransferred = 0;
      const lastProgressTime = Date.now();

      // Parse rsync progress output
      process.stdout?.on("data", (data) => {
        const output = data.toString();

        // Look for progress lines like: "1,234,567  50%  1.23MB/s  0:01:23"
        const match = output.match(/(\d[\d,]*)\s+(\d+)%\s+([\d.]+[KMGT]B\/s)/);
        if (match) {
          bytesTransferred = parseInt(match[1].replace(/,/g, ""), 10);
          const speed = this.parseSpeed(match[3]);

          if (onProgress) {
            const remaining = fileSize - bytesTransferred;
            const eta = speed > 0 ? remaining / speed : 0;

            onProgress({
              bytesTransferred,
              totalBytes: fileSize,
              progress: (bytesTransferred / fileSize) * 100,
              speed,
              eta,
            });
          }
        }

        // Check for cancellation
        if (checkCancelled?.()) {
          process.kill("SIGTERM");
        }
      });

      let stderr = "";
      process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", (code) => {
        if (jobId) {
          this.activeTransfers.delete(jobId);
        }

        if (code === 0) {
          resolve({
            success: true,
            serverId: server.id,
            serverName: server.name,
            localPath,
            remotePath,
            bytesTransferred: fileSize,
            duration: (Date.now() - startTime) / 1000,
            libraryScanTriggered: false,
          });
        } else {
          resolve({
            success: false,
            serverId: server.id,
            serverName: server.name,
            localPath,
            remotePath,
            bytesTransferred,
            duration: (Date.now() - startTime) / 1000,
            error: stderr || `rsync exited with code ${code}`,
            libraryScanTriggered: false,
          });
        }
      });

      process.on("error", (error) => {
        if (jobId) {
          this.activeTransfers.delete(jobId);
        }

        resolve({
          success: false,
          serverId: server.id,
          serverName: server.name,
          localPath,
          remotePath,
          bytesTransferred: 0,
          duration: (Date.now() - startTime) / 1000,
          error: error.message,
          libraryScanTriggered: false,
        });
      });
    });
  }

  /**
   * Deliver file via SMB (smbclient)
   */
  private async deliverViaSmb(
    server: StorageServer,
    localPath: string,
    remotePath: string,
    fileSize: number,
    options: {
      jobId?: string;
      onProgress?: (progress: DeliveryProgress) => void;
      checkCancelled?: () => boolean;
    }
  ): Promise<DeliveryResult> {
    const { jobId, onProgress, checkCancelled } = options;
    const startTime = Date.now();

    return new Promise((resolve) => {
      // SMB path format: //server/share/path
      const remoteDir = dirname(remotePath);
      const remoteFile = remotePath.split("/").pop();

      // Build smbclient command
      // Format: smbclient //server/share -U username%password -c "mkdir path; put localfile remotefile"
      const sharePath = `//${server.host}/${remotePath.split("/")[1]}`;
      const relativePath = "/" + remotePath.split("/").slice(2).join("/");

      const mkdirCmd = `mkdir "${dirname(relativePath)}"`;
      const putCmd = `put "${localPath}" "${relativePath}"`;

      const args = [
        sharePath,
        "-U", `${server.username}%${server.encryptedPassword || ""}`,
        "-p", server.port.toString(),
        "-c", `${mkdirCmd}; ${putCmd}`,
      ];

      const process = spawn("smbclient", args);

      if (jobId) {
        this.activeTransfers.set(jobId, {
          cancel: () => process.kill("SIGTERM"),
        });
      }

      // SMB client doesn't provide great progress output
      // We'll just update periodically
      const progressInterval = setInterval(() => {
        if (checkCancelled?.()) {
          process.kill("SIGTERM");
        }
      }, 1000);

      let stderr = "";
      process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      process.on("close", (code) => {
        clearInterval(progressInterval);

        if (jobId) {
          this.activeTransfers.delete(jobId);
        }

        if (code === 0) {
          // Final progress update
          if (onProgress) {
            onProgress({
              bytesTransferred: fileSize,
              totalBytes: fileSize,
              progress: 100,
              speed: 0,
              eta: 0,
            });
          }

          resolve({
            success: true,
            serverId: server.id,
            serverName: server.name,
            localPath,
            remotePath,
            bytesTransferred: fileSize,
            duration: (Date.now() - startTime) / 1000,
            libraryScanTriggered: false,
          });
        } else {
          resolve({
            success: false,
            serverId: server.id,
            serverName: server.name,
            localPath,
            remotePath,
            bytesTransferred: 0,
            duration: (Date.now() - startTime) / 1000,
            error: stderr || `smbclient exited with code ${code}`,
            libraryScanTriggered: false,
          });
        }
      });

      process.on("error", (error) => {
        clearInterval(progressInterval);

        if (jobId) {
          this.activeTransfers.delete(jobId);
        }

        resolve({
          success: false,
          serverId: server.id,
          serverName: server.name,
          localPath,
          remotePath,
          bytesTransferred: 0,
          duration: (Date.now() - startTime) / 1000,
          error: error.message,
          libraryScanTriggered: false,
        });
      });
    });
  }

  /**
   * Parse speed string (e.g., "1.23MB/s") to bytes/sec
   */
  private parseSpeed(speedStr: string): number {
    const match = speedStr.match(/([\d.]+)([KMGT]?)B\/s/i);
    if (!match) return 0;

    let speed = parseFloat(match[1]);
    const unit = match[2].toUpperCase();

    switch (unit) {
      case "K":
        speed *= 1024;
        break;
      case "M":
        speed *= 1024 * 1024;
        break;
      case "G":
        speed *= 1024 * 1024 * 1024;
        break;
      case "T":
        speed *= 1024 * 1024 * 1024 * 1024;
        break;
    }

    return speed;
  }

  /**
   * Trigger library scan on media server after delivery
   */
  private async triggerLibraryScan(server: StorageServer, deliveredPath: string): Promise<void> {
    if (!server.mediaServerUrl || !server.mediaServerApiKey) {
      console.log(`[Delivery] No media server configured for ${server.name}`);
      return;
    }

    switch (server.mediaServerType) {
      case "PLEX":
        await this.triggerPlexScan(server, deliveredPath);
        break;

      case "EMBY":
        await this.triggerEmbyScan(server, deliveredPath);
        break;
    }
  }

  /**
   * Trigger Plex library scan
   */
  private async triggerPlexScan(server: StorageServer, deliveredPath: string): Promise<void> {
    // Determine which library to scan based on path
    const isMovie = deliveredPath.includes(server.pathMovies);
    const libraryIds = isMovie ? server.mediaServerLibraryMovies : server.mediaServerLibraryTv;

    if (libraryIds.length === 0) {
      console.log(`[Delivery] No Plex library configured for ${isMovie ? "movies" : "TV"}`);
      return;
    }

    // Trigger scan for each configured library
    for (const libraryId of libraryIds) {
      try {
        await triggerPlexLibraryScan(
          server.mediaServerUrl!,
          server.mediaServerApiKey!,
          libraryId
        );
        console.log(`[Delivery] Triggered Plex scan for library ${libraryId}`);
      } catch (error) {
        console.error(`[Delivery] Failed to trigger Plex scan for library ${libraryId}:`, error);
      }
    }
  }

  /**
   * Trigger Emby library scan
   */
  private async triggerEmbyScan(server: StorageServer, deliveredPath: string): Promise<void> {
    // Determine which library to scan based on path
    const isMovie = deliveredPath.includes(server.pathMovies);
    const libraryIds = isMovie ? server.mediaServerLibraryMovies : server.mediaServerLibraryTv;

    if (libraryIds.length === 0) {
      console.log(`[Delivery] No Emby library configured for ${isMovie ? "movies" : "TV"}`);
      return;
    }

    // Trigger scan using Emby's library refresh endpoint
    for (const libraryId of libraryIds) {
      try {
        const baseUrl = server.mediaServerUrl!.replace(/\/$/, "");
        const response = await fetch(`${baseUrl}/Library/Refresh`, {
          method: "POST",
          headers: {
            "X-Emby-Token": server.mediaServerApiKey!,
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        console.log(`[Delivery] Triggered Emby library refresh`);
      } catch (error) {
        console.error(`[Delivery] Failed to trigger Emby scan for library ${libraryId}:`, error);
      }
    }
  }

  /**
   * Cancel an active transfer
   */
  cancelTransfer(jobId: string): boolean {
    const transfer = this.activeTransfers.get(jobId);
    if (transfer) {
      transfer.cancel();
      this.activeTransfers.delete(jobId);
      return true;
    }
    return false;
  }

  /**
   * Deliver to multiple servers in parallel
   */
  async deliverToServers(
    serverIds: string[],
    localPath: string,
    getRemotePath: (server: StorageServer) => string,
    options: {
      jobId?: string;
      onProgress?: (serverId: string, progress: DeliveryProgress) => void;
      checkCancelled?: () => boolean;
    } = {}
  ): Promise<DeliveryResult[]> {
    const results = await Promise.all(
      serverIds.map(async (serverId) => {
        const server = await this.getServer(serverId);
        if (!server) {
          return {
            success: false,
            serverId,
            serverName: "Unknown",
            localPath,
            remotePath: "",
            bytesTransferred: 0,
            duration: 0,
            error: "Server not found",
            libraryScanTriggered: false,
          };
        }

        const remotePath = getRemotePath(server);
        return this.deliver(serverId, localPath, remotePath, {
          ...options,
          onProgress: options.onProgress
            ? (progress) => options.onProgress!(serverId, progress)
            : undefined,
        });
      })
    );

    return results;
  }
}

// Singleton instance
let deliveryService: DeliveryService | null = null;

export function getDeliveryService(): DeliveryService {
  if (!deliveryService) {
    deliveryService = new DeliveryService();
  }
  return deliveryService;
}

export { DeliveryService };
