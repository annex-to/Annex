/**
 * Migration script for download clients
 *
 * - Creates default qBittorrent client from environment variables
 * - Optionally creates SABnzbd and NZBGet clients from environment variables
 * - Backfills existing downloads with downloadClientId
 * - Registers clients with DownloadClientManager
 */

import { DownloadClientType } from "@prisma/client";
import { getConfig } from "../../config/index.js";
import { prisma } from "../../db/client.js";
import { getSecretsService } from "../secrets.js";
import { getDownloadClientManager } from "./DownloadClientManager.js";
import type { IDownloadClient } from "./IDownloadClient.js";
import { NZBGetClient } from "./NZBGetClient.js";
import { QBittorrentClient } from "./QBittorrentClient.js";
import { SABnzbdClient } from "./SABnzbdClient.js";

/**
 * Initialize download clients from environment variables
 * Runs on server startup if no clients exist
 */
export async function initializeDownloadClients(): Promise<void> {
  console.log("[DownloadClients] Checking for existing clients...");

  const existingClients = await prisma.downloadClient.findMany();

  if (existingClients.length > 0) {
    console.log(`[DownloadClients] Found ${existingClients.length} existing clients`);
    await registerExistingClients(existingClients);
    return;
  }

  console.log("[DownloadClients] No clients found, initializing from environment...");

  const config = getConfig();
  const secrets = getSecretsService();
  const clientsCreated: string[] = [];

  // Create default qBittorrent client
  if (config.qbittorrent.url) {
    console.log("[DownloadClients] Creating default qBittorrent client...");

    const qbClient = await prisma.downloadClient.create({
      data: {
        name: "qBittorrent",
        type: DownloadClientType.QBITTORRENT,
        url: config.qbittorrent.url,
        username: config.qbittorrent.username || undefined,
        priority: 50,
        enabled: true,
        supportedTypes: ["torrent"],
        baseDir: config.qbittorrent.baseDir || undefined,
      },
    });

    // Store password in secrets
    if (config.qbittorrent.password) {
      await secrets.setSecret(
        `downloadClient.${qbClient.id}.password`,
        config.qbittorrent.password
      );
    }

    clientsCreated.push(`qBittorrent (${qbClient.id})`);

    // Backfill existing downloads
    await backfillDownloads(qbClient.id);
  }

  // Create SABnzbd client if configured
  const sabnzbdUrl = process.env.SABNZBD_URL;
  const sabnzbdApiKey = process.env.SABNZBD_API_KEY;

  if (sabnzbdUrl && sabnzbdApiKey) {
    console.log("[DownloadClients] Creating SABnzbd client...");

    const sabClient = await prisma.downloadClient.create({
      data: {
        name: "SABnzbd",
        type: DownloadClientType.SABNZBD,
        url: sabnzbdUrl,
        priority: 50,
        enabled: true,
        supportedTypes: ["nzb"],
      },
    });

    // Store API key in secrets
    await secrets.setSecret(`downloadClient.${sabClient.id}.apiKey`, sabnzbdApiKey);

    clientsCreated.push(`SABnzbd (${sabClient.id})`);
  }

  // Create NZBGet client if configured
  const nzbgetUrl = process.env.NZBGET_URL;
  const nzbgetUsername = process.env.NZBGET_USERNAME;
  const nzbgetPassword = process.env.NZBGET_PASSWORD;

  if (nzbgetUrl && nzbgetUsername && nzbgetPassword) {
    console.log("[DownloadClients] Creating NZBGet client...");

    const nzbgetClient = await prisma.downloadClient.create({
      data: {
        name: "NZBGet",
        type: DownloadClientType.NZBGET,
        url: nzbgetUrl,
        username: nzbgetUsername,
        priority: 50,
        enabled: true,
        supportedTypes: ["nzb"],
      },
    });

    // Store password in secrets
    await secrets.setSecret(`downloadClient.${nzbgetClient.id}.password`, nzbgetPassword);

    clientsCreated.push(`NZBGet (${nzbgetClient.id})`);
  }

  if (clientsCreated.length > 0) {
    console.log(
      `[DownloadClients] Initialized ${clientsCreated.length} clients: ${clientsCreated.join(", ")}`
    );

    // Reload and register clients
    const allClients = await prisma.downloadClient.findMany({
      where: { enabled: true },
    });
    await registerExistingClients(allClients);
  } else {
    console.warn(
      "[DownloadClients] No download clients configured. Set QBITTORRENT_URL or SABNZBD_URL/NZBGET_URL in environment."
    );
  }
}

/**
 * Register existing clients with the DownloadClientManager
 */
async function registerExistingClients(
  clients: Array<{
    id: string;
    name: string;
    type: DownloadClientType;
    url: string;
    username: string | null;
    baseDir: string | null;
  }>
): Promise<void> {
  const clientManager = getDownloadClientManager();
  const secrets = getSecretsService();

  for (const dbClient of clients) {
    try {
      let client: IDownloadClient;

      switch (dbClient.type) {
        case DownloadClientType.QBITTORRENT: {
          const password = await secrets.getSecret(`downloadClient.${dbClient.id}.password`);
          client = new QBittorrentClient({
            name: dbClient.name,
            url: dbClient.url,
            username: dbClient.username || "",
            password: password || "",
            baseDir: dbClient.baseDir || undefined,
          });
          break;
        }

        case DownloadClientType.SABNZBD: {
          const apiKey = await secrets.getSecret(`downloadClient.${dbClient.id}.apiKey`);
          client = new SABnzbdClient({
            name: dbClient.name,
            url: dbClient.url,
            apiKey: apiKey || "",
            baseDir: dbClient.baseDir || undefined,
          });
          break;
        }

        case DownloadClientType.NZBGET: {
          const password = await secrets.getSecret(`downloadClient.${dbClient.id}.password`);
          client = new NZBGetClient({
            name: dbClient.name,
            url: dbClient.url,
            username: dbClient.username || "",
            password: password || "",
            baseDir: dbClient.baseDir || undefined,
          });
          break;
        }

        default:
          console.warn(`[DownloadClients] Unknown client type: ${dbClient.type}`);
          continue;
      }

      clientManager.registerClient(dbClient.id, client);
    } catch (error) {
      console.error(`[DownloadClients] Failed to register client ${dbClient.name}:`, error);
    }
  }
}

/**
 * Backfill existing downloads with the default client ID
 */
async function backfillDownloads(defaultClientId: string): Promise<void> {
  const downloadsToBackfill = await prisma.download.findMany({
    where: {
      downloadClientId: null,
    },
    select: { id: true },
  });

  if (downloadsToBackfill.length === 0) {
    console.log("[DownloadClients] No downloads to backfill");
    return;
  }

  console.log(
    `[DownloadClients] Backfilling ${downloadsToBackfill.length} downloads with default client...`
  );

  await prisma.download.updateMany({
    where: {
      downloadClientId: null,
    },
    data: {
      downloadClientId: defaultClientId,
      clientHash: { set: undefined }, // Will use torrentHash if clientHash is null
    },
  });

  console.log("[DownloadClients] Backfill complete");
}
