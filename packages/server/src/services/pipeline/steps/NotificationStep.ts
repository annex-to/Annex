import { BaseStep, type StepOutput } from "./BaseStep.js";
import type { PipelineContext } from "../PipelineContext.js";
import { StepType, ActivityType } from "@prisma/client";
import { prisma } from "../../../db/client.js";
import { getNotificationDispatcher } from "../../notifications/NotificationDispatcher.js";

interface NotificationStepConfig {
  event: string; // Event name (e.g., "request.started", "step.completed")
  includeContext?: boolean; // Include full pipeline context in notification
  continueOnError?: boolean; // Don't fail pipeline if notification fails
}

/**
 * Notification Step - Send notifications to configured providers
 *
 * Inputs:
 * - requestId, mediaType, title, year (from context)
 * - Config: event, includeContext, continueOnError
 *
 * Outputs:
 * - notification.sent: Whether any notifications were sent
 * - notification.providers: List of providers that received notification
 * - notification.errors: List of failed providers and errors
 *
 * Behavior:
 * - Finds matching notification configs for the event
 * - Dispatches notification to all matching providers
 * - Can optionally continue on error
 */
export class NotificationStep extends BaseStep {
  readonly type = StepType.NOTIFICATION;

  validateConfig(config: unknown): void {
    if (!config || typeof config !== "object") {
      throw new Error("NotificationStep config must be an object");
    }

    const cfg = config as NotificationStepConfig;
    if (!cfg.event || typeof cfg.event !== "string") {
      throw new Error("NotificationStep config must have an 'event' string");
    }
  }

  async execute(context: PipelineContext, config: unknown): Promise<StepOutput> {
    this.validateConfig(config);
    const cfg = config as NotificationStepConfig;

    const dispatcher = getNotificationDispatcher();

    // Prepare notification data
    const data = cfg.includeContext
      ? {
          title: context.title,
          year: context.year,
          tmdbId: context.tmdbId,
          search: context.search,
          download: context.download,
          encode: context.encode,
          deliver: context.deliver,
        }
      : {
          title: context.title,
          year: context.year,
          tmdbId: context.tmdbId,
        };

    this.reportProgress(0, "Sending notifications");

    try {
      const results = await dispatcher.dispatch({
        event: cfg.event,
        requestId: context.requestId,
        mediaType: context.mediaType,
        data,
      });

      const successfulProviders = results.filter((r) => r.success).map((r) => r.provider);
      const failedProviders = results.filter((r) => !r.success).map((r) => ({
        provider: r.provider,
        error: r.error || "Unknown error",
      }));

      this.reportProgress(100, `Notifications sent: ${successfulProviders.length} succeeded, ${failedProviders.length} failed`);

      // Log notification results
      if (successfulProviders.length > 0) {
        await this.logActivity(
          context.requestId,
          ActivityType.SUCCESS,
          `Notifications sent to: ${successfulProviders.join(", ")}`,
          { event: cfg.event, providers: successfulProviders }
        );
      }

      if (failedProviders.length > 0) {
        await this.logActivity(
          context.requestId,
          ActivityType.WARNING,
          `Some notifications failed: ${failedProviders.map((f) => `${f.provider} (${f.error})`).join(", ")}`,
          { event: cfg.event, failures: failedProviders }
        );
      }

      // Determine success
      const success = successfulProviders.length > 0 || cfg.continueOnError !== false;

      return {
        success,
        data: {
          sent: successfulProviders.length > 0,
          providers: successfulProviders,
          errors: failedProviders.length > 0 ? failedProviders : undefined,
        },
        error: !success && failedProviders.length > 0
          ? `All notifications failed: ${failedProviders.map((f) => f.error).join(", ")}`
          : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      await this.logActivity(
        context.requestId,
        ActivityType.ERROR,
        `Notification dispatch error: ${errorMessage}`,
        { event: cfg.event }
      );

      if (cfg.continueOnError !== false) {
        return {
          success: true,
          data: {
            sent: false,
            error: errorMessage,
          },
        };
      }

      return {
        success: false,
        error: errorMessage,
        data: {
          sent: false,
          error: errorMessage,
        },
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
