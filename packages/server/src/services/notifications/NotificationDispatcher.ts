// NotificationDispatcher - Routes notifications to configured providers
// Handles notification delivery, retries, and provider management

import { prisma } from "../../db/client.js";
import { NotificationProvider, ActivityType, MediaType } from "@prisma/client";
import type { NotificationPayload, NotificationResult } from "./types.js";
import { DiscordProvider } from "./providers/DiscordProvider.js";
import { WebhookProvider } from "./providers/WebhookProvider.js";
import { EmailProvider } from "./providers/EmailProvider.js";

export interface NotificationOptions {
  event: string;
  requestId: string;
  mediaType: MediaType;
  data: Record<string, unknown>;
  userId?: string;
}

export class NotificationDispatcher {
  private providers: Map<NotificationProvider, BaseNotificationProvider>;

  constructor() {
    this.providers = new Map();
    this.providers.set(NotificationProvider.DISCORD, new DiscordProvider());
    this.providers.set(NotificationProvider.WEBHOOK, new WebhookProvider());
    this.providers.set(NotificationProvider.EMAIL, new EmailProvider());
  }

  async dispatch(options: NotificationOptions): Promise<NotificationResult[]> {
    const { event, requestId, mediaType, data, userId } = options;

    // Find matching notification configs
    const configs = await prisma.notificationConfig.findMany({
      where: {
        enabled: true,
        events: { has: event },
        OR: [
          { mediaType: null }, // No media type filter
          { mediaType }, // Matches media type
        ],
        ...(userId ? { userId } : {}),
      },
    });

    if (configs.length === 0) {
      return [];
    }

    // Prepare notification payload
    const payload: NotificationPayload = {
      event,
      requestId,
      mediaType,
      data,
      timestamp: new Date().toISOString(),
    };

    // Send to all matching configs
    const results: NotificationResult[] = [];
    for (const config of configs) {
      const provider = this.providers.get(config.provider);
      if (!provider) {
        results.push({
          success: false,
          provider: config.provider,
          configId: config.id,
          error: `Provider ${config.provider} not found`,
        });
        continue;
      }

      try {
        const result = await provider.send(payload, config.config as Record<string, unknown>);
        results.push({
          ...result,
          configId: config.id,
        });

        if (!result.success) {
          await this.logActivity(
            requestId,
            ActivityType.ERROR,
            `Notification failed (${config.provider}): ${result.error}`,
            { provider: config.provider, configId: config.id }
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          success: false,
          provider: config.provider,
          configId: config.id,
          error: errorMessage,
        });

        await this.logActivity(
          requestId,
          ActivityType.ERROR,
          `Notification error (${config.provider}): ${errorMessage}`,
          { provider: config.provider, configId: config.id }
        );
      }
    }

    return results;
  }

  async testNotification(configId: string): Promise<NotificationResult> {
    const config = await prisma.notificationConfig.findUnique({
      where: { id: configId },
    });

    if (!config) {
      return {
        success: false,
        provider: NotificationProvider.WEBHOOK,
        configId,
        error: "Config not found",
      };
    }

    const provider = this.providers.get(config.provider);
    if (!provider) {
      return {
        success: false,
        provider: config.provider,
        configId,
        error: `Provider ${config.provider} not found`,
      };
    }

    const testPayload: NotificationPayload = {
      event: "test",
      requestId: "test-request",
      mediaType: MediaType.MOVIE,
      data: {
        title: "Test Movie",
        year: 2024,
        message: "This is a test notification from Annex",
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const result = await provider.send(testPayload, config.config as Record<string, unknown>);
      return {
        ...result,
        configId,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        provider: config.provider,
        configId,
        error: errorMessage,
      };
    }
  }

  private async logActivity(requestId: string, type: ActivityType, message: string, details?: object): Promise<void> {
    await prisma.activityLog.create({
      data: {
        requestId,
        type,
        message,
        details: details || undefined,
      },
    });
  }
}

// Base interface for notification providers
export interface BaseNotificationProvider {
  send(payload: NotificationPayload, config: Record<string, unknown>): Promise<NotificationResult>;
}

// Singleton instance
let notificationDispatcherInstance: NotificationDispatcher | null = null;

export function getNotificationDispatcher(): NotificationDispatcher {
  if (!notificationDispatcherInstance) {
    notificationDispatcherInstance = new NotificationDispatcher();
  }
  return notificationDispatcherInstance;
}
