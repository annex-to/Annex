// Generic webhook notification provider

import type { BaseNotificationProvider } from "../NotificationDispatcher.js";
import type { NotificationPayload, NotificationResult } from "../types.js";
import { NotificationProvider } from "@prisma/client";

interface WebhookConfig {
  url: string;
  method?: "POST" | "PUT";
  headers?: Record<string, string>;
  includeAuth?: boolean;
  authHeader?: string; // e.g., "Authorization"
  authValue?: string; // e.g., "Bearer token123"
}

export class WebhookProvider implements BaseNotificationProvider {
  async send(payload: NotificationPayload, config: Record<string, unknown>): Promise<NotificationResult> {
    const cfg = config as unknown as WebhookConfig;

    if (!cfg.url) {
      return {
        success: false,
        provider: NotificationProvider.WEBHOOK,
        configId: "",
        error: "Missing url in config",
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "Annex/1.0",
      ...cfg.headers,
    };

    // Add auth header if configured
    if (cfg.includeAuth && cfg.authHeader && cfg.authValue) {
      headers[cfg.authHeader] = cfg.authValue;
    }

    const method = cfg.method || "POST";

    try {
      const response = await fetch(cfg.url, {
        method,
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          provider: NotificationProvider.WEBHOOK,
          configId: "",
          error: `Webhook error (${response.status}): ${errorText}`,
        };
      }

      // Try to get delivery ID from response headers or body
      let deliveryId: string | undefined;
      const contentType = response.headers.get("content-type");
      if (contentType?.includes("application/json")) {
        try {
          const body = await response.json() as Record<string, unknown>;
          deliveryId = (body.id || body.messageId || body.deliveryId) as string | undefined;
        } catch {
          // Ignore JSON parse errors
        }
      }

      return {
        success: true,
        provider: NotificationProvider.WEBHOOK,
        configId: "",
        deliveryId,
      };
    } catch (error) {
      return {
        success: false,
        provider: NotificationProvider.WEBHOOK,
        configId: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
