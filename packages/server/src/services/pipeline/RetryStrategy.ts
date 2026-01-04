import type { ProcessingStatus } from "@prisma/client";

export interface RetryConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  jitterFactor: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelayMs: 1000, // 1 second
  maxDelayMs: 300000, // 5 minutes
  maxAttempts: 5,
  jitterFactor: 0.1, // 10% jitter
};

/**
 * Error classification for retry decisions
 */
export enum ErrorType {
  TRANSIENT = "TRANSIENT", // Temporary failures that can be retried
  PERMANENT = "PERMANENT", // Permanent failures that should not be retried
  RATE_LIMIT = "RATE_LIMIT", // Rate limiting errors
  NETWORK = "NETWORK", // Network connectivity issues
  TIMEOUT = "TIMEOUT", // Timeout errors
}

export class RetryStrategy {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Calculate next retry time using exponential backoff with jitter
   */
  calculateNextRetryTime(attempts: number): Date {
    const exponentialDelay = Math.min(
      this.config.baseDelayMs * 2 ** attempts,
      this.config.maxDelayMs
    );

    // Add jitter to prevent thundering herd
    const jitter = exponentialDelay * this.config.jitterFactor * (Math.random() - 0.5);
    const delayMs = exponentialDelay + jitter;

    return new Date(Date.now() + delayMs);
  }

  /**
   * Check if retry is allowed based on attempts
   */
  canRetry(attempts: number, maxAttempts?: number): boolean {
    const limit = maxAttempts ?? this.config.maxAttempts;
    return attempts < limit;
  }

  /**
   * Classify error to determine if it should be retried
   */
  classifyError(error: Error | string): ErrorType {
    const message = typeof error === "string" ? error : error.message.toLowerCase();

    // Network errors
    if (
      message.includes("econnrefused") ||
      message.includes("enotfound") ||
      message.includes("enetunreach") ||
      message.includes("etimedout") ||
      message.includes("connection lost") ||
      message.includes("connection refused") ||
      message.includes("connection reset") ||
      message.includes("getconnection")
    ) {
      return ErrorType.NETWORK;
    }

    // Timeout errors
    if (message.includes("timeout") || message.includes("timed out")) {
      return ErrorType.TIMEOUT;
    }

    // Rate limiting
    if (
      message.includes("rate limit") ||
      message.includes("too many requests") ||
      message.includes("429")
    ) {
      return ErrorType.RATE_LIMIT;
    }

    // Transient errors
    if (
      message.includes("503") ||
      message.includes("502") ||
      message.includes("504") ||
      message.includes("service unavailable") ||
      message.includes("temporarily unavailable")
    ) {
      return ErrorType.TRANSIENT;
    }

    // Permanent errors
    if (
      message.includes("404") ||
      message.includes("not found") ||
      message.includes("invalid") ||
      message.includes("forbidden") ||
      message.includes("unauthorized") ||
      message.includes("no results") ||
      message.includes("no releases found")
    ) {
      return ErrorType.PERMANENT;
    }

    // Default to transient for unknown errors
    return ErrorType.TRANSIENT;
  }

  /**
   * Determine if error should trigger retry
   */
  shouldRetry(error: Error | string, attempts: number, maxAttempts?: number): boolean {
    if (!this.canRetry(attempts, maxAttempts)) {
      return false;
    }

    const errorType = this.classifyError(error);
    return errorType !== ErrorType.PERMANENT;
  }

  /**
   * Get retry delay for specific error types
   */
  getRetryDelay(errorType: ErrorType, attempts: number): Date {
    switch (errorType) {
      case ErrorType.RATE_LIMIT: {
        // Longer delay for rate limits
        const rateLimitDelay = Math.min(
          this.config.baseDelayMs * 3 ** attempts,
          this.config.maxDelayMs
        );
        return new Date(Date.now() + rateLimitDelay);
      }

      case ErrorType.NETWORK:
      case ErrorType.TIMEOUT:
        // Standard exponential backoff
        return this.calculateNextRetryTime(attempts);

      case ErrorType.TRANSIENT:
        // Standard exponential backoff
        return this.calculateNextRetryTime(attempts);

      case ErrorType.PERMANENT:
        // No retry
        return new Date(Date.now());

      default:
        return this.calculateNextRetryTime(attempts);
    }
  }

  /**
   * Calculate retry time based on error and attempts
   */
  calculateRetryTime(error: Error | string, attempts: number): Date | null {
    const errorType = this.classifyError(error);

    if (errorType === ErrorType.PERMANENT) {
      return null; // No retry for permanent errors
    }

    return this.getRetryDelay(errorType, attempts);
  }

  /**
   * Check if a status allows retry
   */
  isRetryableStatus(status: ProcessingStatus): boolean {
    // These statuses represent in-progress work that can fail and be retried
    return (
      status === "SEARCHING" ||
      status === "DOWNLOADING" ||
      status === "ENCODING" ||
      status === "DELIVERING"
    );
  }

  /**
   * Get the retry status for a given current status
   * Returns the same status to retry the operation
   */
  getRetryStatus(currentStatus: ProcessingStatus): ProcessingStatus {
    // When retrying, we return to the same status to retry the operation
    if (this.isRetryableStatus(currentStatus)) {
      return currentStatus;
    }

    // For FAILED status, reset to PENDING to restart the pipeline
    if (currentStatus === "FAILED") {
      return "PENDING";
    }

    // Other statuses don't support retry
    return currentStatus;
  }

  /**
   * Format error for storage
   */
  formatError(error: Error | string): string {
    if (typeof error === "string") {
      return error;
    }

    return `${error.name}: ${error.message}`;
  }
}

export const retryStrategy = new RetryStrategy();
