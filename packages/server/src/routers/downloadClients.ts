import { DownloadClientType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db/client.js";
import { getDownloadClientManager } from "../services/downloadClients/DownloadClientManager.js";
import type { IDownloadClient } from "../services/downloadClients/IDownloadClient.js";
import { NZBGetClient } from "../services/downloadClients/NZBGetClient.js";
import { QBittorrentClient } from "../services/downloadClients/QBittorrentClient.js";
import { SABnzbdClient } from "../services/downloadClients/SABnzbdClient.js";
import { getSecretsService } from "../services/secrets.js";
import { publicProcedure, router } from "../trpc.js";

const downloadClientInputSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["qbittorrent", "sabnzbd", "nzbget"]),
  url: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
  apiKey: z.string().optional(),
  priority: z.number().min(1).max(100).default(50),
  enabled: z.boolean().default(true),
  baseDir: z.string().optional(),
});

// Map string values to Prisma enums
function toDownloadClientType(value: string): DownloadClientType {
  const map: Record<string, DownloadClientType> = {
    qbittorrent: DownloadClientType.QBITTORRENT,
    sabnzbd: DownloadClientType.SABNZBD,
    nzbget: DownloadClientType.NZBGET,
  };
  return map[value] ?? DownloadClientType.QBITTORRENT;
}

function fromDownloadClientType(value: DownloadClientType): string {
  return value.toLowerCase();
}

// Helper to instantiate client from DB record
async function instantiateClient(dbClient: {
  id: string;
  name: string;
  type: DownloadClientType;
  url: string;
  username: string | null;
  baseDir: string | null;
}): Promise<IDownloadClient | null> {
  const secrets = getSecretsService();

  try {
    switch (dbClient.type) {
      case DownloadClientType.QBITTORRENT: {
        const password = await secrets.getSecret(`downloadClient.${dbClient.id}.password`);
        return new QBittorrentClient({
          name: dbClient.name,
          url: dbClient.url,
          username: dbClient.username || "",
          password: password || "",
          baseDir: dbClient.baseDir || undefined,
        });
      }

      case DownloadClientType.SABNZBD: {
        const apiKey = await secrets.getSecret(`downloadClient.${dbClient.id}.apiKey`);
        return new SABnzbdClient({
          name: dbClient.name,
          url: dbClient.url,
          apiKey: apiKey || "",
          baseDir: dbClient.baseDir || undefined,
        });
      }

      case DownloadClientType.NZBGET: {
        const password = await secrets.getSecret(`downloadClient.${dbClient.id}.password`);
        return new NZBGetClient({
          name: dbClient.name,
          url: dbClient.url,
          username: dbClient.username || "",
          password: password || "",
          baseDir: dbClient.baseDir || undefined,
        });
      }

      default:
        return null;
    }
  } catch (error) {
    console.error(`[DownloadClients] Failed to instantiate client ${dbClient.name}:`, error);
    return null;
  }
}

export const downloadClientsRouter = router({
  /**
   * List all download clients
   */
  list: publicProcedure.query(async () => {
    const clients = await prisma.downloadClient.findMany({
      orderBy: { priority: "desc" }, // Higher priority first
    });

    return clients.map(
      (c: {
        id: string;
        name: string;
        type: DownloadClientType;
        url: string;
        username: string | null;
        priority: number;
        enabled: boolean;
        supportedTypes: string[];
        baseDir: string | null;
        isHealthy: boolean;
        lastHealthCheck: Date | null;
        lastError: string | null;
        totalDownloads: number;
        activeDownloads: number;
        createdAt: Date;
        updatedAt: Date;
      }) => ({
        id: c.id,
        name: c.name,
        type: fromDownloadClientType(c.type),
        url: c.url,
        username: c.username,
        priority: c.priority,
        enabled: c.enabled,
        supportedTypes: c.supportedTypes,
        baseDir: c.baseDir,
        isHealthy: c.isHealthy,
        lastHealthCheck: c.lastHealthCheck,
        lastError: c.lastError,
        totalDownloads: c.totalDownloads,
        activeDownloads: c.activeDownloads,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })
    );
  }),

  /**
   * Get a single download client by ID
   */
  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const client = await prisma.downloadClient.findUnique({
      where: { id: input.id },
    });

    if (!client) {
      return null;
    }

    return {
      id: client.id,
      name: client.name,
      type: fromDownloadClientType(client.type),
      url: client.url,
      username: client.username,
      priority: client.priority,
      enabled: client.enabled,
      supportedTypes: client.supportedTypes,
      baseDir: client.baseDir,
      isHealthy: client.isHealthy,
      lastHealthCheck: client.lastHealthCheck,
      lastError: client.lastError,
      totalDownloads: client.totalDownloads,
      activeDownloads: client.activeDownloads,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    };
  }),

  /**
   * Create a new download client
   */
  create: publicProcedure.input(downloadClientInputSchema).mutation(async ({ input }) => {
    const clientType = toDownloadClientType(input.type);
    const secrets = getSecretsService();

    // Determine supported types based on client type
    const supportedTypes = clientType === DownloadClientType.QBITTORRENT ? ["torrent"] : ["nzb"];

    // Create the client record
    const client = await prisma.downloadClient.create({
      data: {
        name: input.name,
        type: clientType,
        url: input.url,
        username: input.username || null,
        priority: input.priority,
        enabled: input.enabled,
        supportedTypes,
        baseDir: input.baseDir || null,
      },
    });

    // Store credentials in secrets
    if (clientType === DownloadClientType.QBITTORRENT && input.password) {
      await secrets.setSecret(`downloadClient.${client.id}.password`, input.password);
    } else if (clientType === DownloadClientType.SABNZBD && input.apiKey) {
      await secrets.setSecret(`downloadClient.${client.id}.apiKey`, input.apiKey);
    } else if (clientType === DownloadClientType.NZBGET && input.password) {
      await secrets.setSecret(`downloadClient.${client.id}.password`, input.password);
    }

    // Instantiate and register with manager if enabled
    if (input.enabled) {
      const clientInstance = await instantiateClient(client);
      if (clientInstance) {
        const manager = getDownloadClientManager();
        manager.registerClient(client.id, clientInstance);
      }
    }

    return { id: client.id };
  }),

  /**
   * Update a download client
   */
  update: publicProcedure
    .input(z.object({ id: z.string() }).merge(downloadClientInputSchema.partial()))
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;
      const secrets = getSecretsService();

      const data: Record<string, unknown> = {};

      if (updates.name !== undefined) data.name = updates.name;
      if (updates.type !== undefined) {
        const clientType = toDownloadClientType(updates.type);
        data.type = clientType;
        // Update supported types based on new type
        data.supportedTypes = clientType === DownloadClientType.QBITTORRENT ? ["torrent"] : ["nzb"];
      }
      if (updates.url !== undefined) data.url = updates.url;
      if (updates.username !== undefined) data.username = updates.username || null;
      if (updates.priority !== undefined) data.priority = updates.priority;
      if (updates.enabled !== undefined) data.enabled = updates.enabled;
      if (updates.baseDir !== undefined) data.baseDir = updates.baseDir || null;

      // Update the client record
      const client = await prisma.downloadClient.update({
        where: { id },
        data,
      });

      // Update credentials in secrets if provided
      if (updates.password) {
        if (
          client.type === DownloadClientType.QBITTORRENT ||
          client.type === DownloadClientType.NZBGET
        ) {
          await secrets.setSecret(`downloadClient.${id}.password`, updates.password);
        }
      }
      if (updates.apiKey && client.type === DownloadClientType.SABNZBD) {
        await secrets.setSecret(`downloadClient.${id}.apiKey`, updates.apiKey);
      }

      // Re-register with manager if enabled
      const manager = getDownloadClientManager();
      if (client.enabled) {
        const clientInstance = await instantiateClient(client);
        if (clientInstance) {
          manager.registerClient(id, clientInstance);
        }
      }

      return { success: true };
    }),

  /**
   * Delete a download client
   */
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const secrets = getSecretsService();

    // Delete credentials from secrets
    const client = await prisma.downloadClient.findUnique({
      where: { id: input.id },
    });

    if (client) {
      if (
        client.type === DownloadClientType.QBITTORRENT ||
        client.type === DownloadClientType.NZBGET
      ) {
        await secrets.deleteSecret(`downloadClient.${input.id}.password`);
      } else if (client.type === DownloadClientType.SABNZBD) {
        await secrets.deleteSecret(`downloadClient.${input.id}.apiKey`);
      }
    }

    // Delete the client record
    await prisma.downloadClient.delete({
      where: { id: input.id },
    });

    return { success: true };
  }),

  /**
   * Test a download client connection
   */
  test: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const client = await prisma.downloadClient.findUnique({
      where: { id: input.id },
    });

    if (!client) {
      return {
        success: false,
        error: "Download client not found",
        version: null,
      };
    }

    // Instantiate the client
    const clientInstance = await instantiateClient(client);

    if (!clientInstance) {
      return {
        success: false,
        error: "Failed to instantiate client",
        version: null,
      };
    }

    // Test the connection
    const result = await clientInstance.testConnection();

    // Update health status in database
    await prisma.downloadClient.update({
      where: { id: input.id },
      data: {
        isHealthy: result.success,
        lastHealthCheck: new Date(),
        lastError: result.success ? null : result.error || null,
      },
    });

    return {
      success: result.success,
      error: result.error || null,
      version: result.version || null,
    };
  }),
});
