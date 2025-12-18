// Email notification provider (SMTP)

import type { BaseNotificationProvider } from "../NotificationDispatcher.js";
import type { NotificationPayload, NotificationResult } from "../types.js";
import { NotificationProvider } from "@prisma/client";

interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure?: boolean; // TLS
  smtpUser: string;
  smtpPassword: string;
  fromAddress: string;
  fromName?: string;
  toAddress: string;
}

export class EmailProvider implements BaseNotificationProvider {
  async send(payload: NotificationPayload, config: Record<string, unknown>): Promise<NotificationResult> {
    const cfg = config as unknown as EmailConfig;

    // Validate config
    if (!cfg.smtpHost || !cfg.smtpPort || !cfg.smtpUser || !cfg.smtpPassword || !cfg.fromAddress || !cfg.toAddress) {
      return {
        success: false,
        provider: NotificationProvider.EMAIL,
        configId: "",
        error: "Missing required SMTP config fields",
      };
    }

    // For now, return a placeholder since we need an SMTP library
    // TODO: Implement actual email sending using nodemailer or similar
    return {
      success: false,
      provider: NotificationProvider.EMAIL,
      configId: "",
      error: "Email provider not yet implemented - requires SMTP library",
    };

    /*
    // Example implementation with nodemailer (requires: bun add nodemailer)
    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpSecure !== false,
        auth: {
          user: cfg.smtpUser,
          pass: cfg.smtpPassword,
        },
      });

      const subject = this.buildSubject(payload);
      const html = this.buildHtml(payload);

      const info = await transporter.sendMail({
        from: cfg.fromName ? `"${cfg.fromName}" <${cfg.fromAddress}>` : cfg.fromAddress,
        to: cfg.toAddress,
        subject,
        html,
      });

      return {
        success: true,
        provider: NotificationProvider.EMAIL,
        configId: "",
        deliveryId: info.messageId,
      };
    } catch (error) {
      return {
        success: false,
        provider: NotificationProvider.EMAIL,
        configId: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    */
  }

  private buildSubject(payload: NotificationPayload): string {
    const { event, data } = payload;
    const title = data.title ? `${data.title} (${data.year})` : "Notification";

    switch (event) {
      case "request.started":
        return `Annex: New Request - ${title}`;
      case "request.completed":
        return `Annex: Request Completed - ${title}`;
      case "request.failed":
        return `Annex: Request Failed - ${title}`;
      case "approval.required":
        return `Annex: Approval Required - ${title}`;
      default:
        return `Annex: ${event}`;
    }
  }

  private buildHtml(payload: NotificationPayload): string {
    const { event, data } = payload;

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: system-ui, sans-serif; line-height: 1.6; color: #333; }
          .header { background: #ef4444; color: white; padding: 20px; }
          .content { padding: 20px; }
          .footer { padding: 20px; background: #f5f5f5; color: #666; font-size: 0.9em; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Annex Notification</h1>
        </div>
        <div class="content">
          <h2>${event}</h2>
          <p><strong>${data.title || "Unknown"} (${data.year || ""})</strong></p>
          ${data.message ? `<p>${data.message}</p>` : ""}
        </div>
        <div class="footer">
          <p>Annex Media Server - ${new Date(payload.timestamp).toLocaleString()}</p>
        </div>
      </body>
      </html>
    `;
  }
}
