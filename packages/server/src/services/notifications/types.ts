// Notification types and interfaces

import type { NotificationProvider, MediaType } from "@prisma/client";

export interface NotificationPayload {
  event: string;
  requestId: string;
  mediaType: MediaType;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface NotificationResult {
  success: boolean;
  provider: NotificationProvider;
  configId: string;
  error?: string;
  deliveryId?: string; // Provider-specific delivery ID
}
