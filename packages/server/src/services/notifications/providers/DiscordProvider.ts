// Discord notification provider with rich embeds and poster thumbnails

import type { BaseNotificationProvider } from "../NotificationDispatcher.js";
import type { NotificationPayload, NotificationResult } from "../types.js";
import { NotificationProvider } from "@prisma/client";

interface DiscordConfig {
  webhookUrl: string;
  username?: string;
  avatarUrl?: string;
  mentionRoleId?: string; // Optional role to mention
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
  timestamp?: string;
  footer?: { text: string };
}

interface DiscordPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

export class DiscordProvider implements BaseNotificationProvider {
  async send(payload: NotificationPayload, config: Record<string, unknown>): Promise<NotificationResult> {
    const cfg = config as unknown as DiscordConfig;

    if (!cfg.webhookUrl) {
      return {
        success: false,
        provider: NotificationProvider.DISCORD,
        configId: "",
        error: "Missing webhookUrl in config",
      };
    }

    const embed = this.buildEmbed(payload);
    const discordPayload: DiscordPayload = {
      username: cfg.username || "Annex",
      avatar_url: cfg.avatarUrl,
      content: cfg.mentionRoleId ? `<@&${cfg.mentionRoleId}>` : undefined,
      embeds: [embed],
    };

    try {
      const response = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(discordPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          provider: NotificationProvider.DISCORD,
          configId: "",
          error: `Discord API error (${response.status}): ${errorText}`,
        };
      }

      return {
        success: true,
        provider: NotificationProvider.DISCORD,
        configId: "",
      };
    } catch (error) {
      return {
        success: false,
        provider: NotificationProvider.DISCORD,
        configId: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildEmbed(payload: NotificationPayload): DiscordEmbed {
    const { event, data } = payload;

    // Base embed
    const embed: DiscordEmbed = {
      timestamp: payload.timestamp,
      footer: { text: "Annex Media Server" },
    };

    // Add poster thumbnail if available
    const posterPath = data.posterPath as string | undefined;
    if (posterPath) {
      embed.thumbnail = {
        url: `https://image.tmdb.org/t/p/w500${posterPath}`,
      };
    }

    // Customize embed based on event
    switch (event) {
      case "request.started":
        embed.title = `New Request: ${data.title} (${data.year})`;
        embed.description = `Request started for ${payload.mediaType === "MOVIE" ? "movie" : "TV show"}`;
        embed.color = 0xef4444; // annex-500 red
        break;

      case "request.completed":
        embed.title = `Request Completed: ${data.title} (${data.year})`;
        embed.description = "Successfully downloaded and delivered";
        embed.color = 0x22c55e; // green
        if (data.deliver && typeof data.deliver === "object") {
          const deliver = data.deliver as { deliveredServers?: string[] };
          if (deliver.deliveredServers && Array.isArray(deliver.deliveredServers)) {
            embed.fields = [
              {
                name: "Delivered to",
                value: deliver.deliveredServers.join(", ") || "None",
                inline: false,
              },
            ];
          }
        }
        break;

      case "request.failed":
        embed.title = `Request Failed: ${data.title} (${data.year})`;
        embed.description = data.error ? String(data.error) : "Request failed";
        embed.color = 0xdc2626; // annex-600 dark red
        break;

      case "step.completed":
        embed.title = `Step Completed: ${data.stepName || "Unknown"}`;
        embed.description = `${data.title} (${data.year})`;
        embed.color = 0xeab308; // gold-500
        embed.fields = [
          {
            name: "Step",
            value: String(data.stepName || "Unknown"),
            inline: true,
          },
        ];
        break;

      case "approval.required":
        embed.title = `Approval Required: ${data.title} (${data.year})`;
        embed.description = data.reason ? String(data.reason) : "Manual approval needed";
        embed.color = 0xf59e0b; // amber
        if (data.approvalId) {
          embed.fields = [
            {
              name: "Approval ID",
              value: String(data.approvalId),
              inline: true,
            },
            {
              name: "Required Role",
              value: String(data.requiredRole || "any"),
              inline: true,
            },
          ];
        }
        break;

      case "approval.processed": {
        const action = data.action as string;
        embed.title = `Approval ${action === "approve" ? "Approved" : "Rejected"}: ${data.title} (${data.year})`;
        embed.description = data.comment ? String(data.comment) : undefined;
        embed.color = action === "approve" ? 0x22c55e : 0xdc2626;
        if (data.processedBy) {
          embed.fields = [
            {
              name: "Processed by",
              value: String(data.processedBy),
              inline: true,
            },
          ];
        }
        break;
      }

      case "search.quality_unavailable":
        embed.title = `Quality Unavailable: ${data.title} (${data.year})`;
        embed.description = `Requested quality not available. Best available: ${data.bestAvailable}`;
        embed.color = 0xf59e0b; // amber
        break;

      case "test":
        embed.title = "Test Notification";
        embed.description = String(data.message || "This is a test notification from Annex");
        embed.color = 0xef4444; // annex-500 red
        break;

      default:
        embed.title = event.split(".").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
        embed.description = data.message ? String(data.message) : undefined;
        embed.color = 0xef4444; // annex-500 red
    }

    return embed;
  }
}
