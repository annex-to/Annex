import type { ProcessingItem } from "@prisma/client";
import { circuitBreakerService } from "./CircuitBreakerService.js";
import { ErrorType, type RetryConfig } from "./RetryStrategy.js";

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  baseDelayMs: 1000, // 1 second
  maxDelayMs: 300000, // 5 minutes
  maxAttempts: 5,
  jitterFactor: 0.1, // 10% jitter
};

export interface RetryDecision {
  shouldRetry: boolean;
  useSkipUntil: boolean; // If true, use skipUntil (service down), else nextRetryAt (transient)
  retryAt: Date | null;
  reason: string;
}

export interface ErrorHistoryEntry {
  timestamp: string;
  error: string;
  errorType: ErrorType;
  attempts: number;
}

/**
 * Smart retry strategy that integrates with circuit breakers
 * Distinguishes between service outages (skipUntil) and transient errors (nextRetryAt)
 */
export class SmartRetryStrategy {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Decide if and how to retry based on error type and circuit breaker state
   */
  async decide(
    item: ProcessingItem,
    error: Error | string,
    service?: string
  ): Promise<RetryDecision> {
    const errorType = this.classifyError(error);
    const errorMessage = this.formatError(error);

    // Check attempts limit
    if (!this.canRetry(item.attempts, item.maxAttempts)) {
      return {
        shouldRetry: false,
        useSkipUntil: false,
        retryAt: null,
        reason: `Max attempts (${item.maxAttempts}) reached`,
      };
    }

    // Permanent errors: Don't retry
    if (errorType === ErrorType.PERMANENT) {
      return {
        shouldRetry: false,
        useSkipUntil: false,
        retryAt: null,
        reason: `Permanent error: ${errorMessage}`,
      };
    }

    // Check circuit breaker for service-specific errors
    if (service && (errorType === ErrorType.NETWORK || errorType === ErrorType.TIMEOUT)) {
      const isAvailable = await circuitBreakerService.isAvailable(service);

      if (!isAvailable) {
        // Service is down (circuit open), use skipUntil
        const breaker = await circuitBreakerService.getState(service);
        const breakerInfo = await circuitBreakerService.getBreakerInfo(service);
        const skipUntil = breakerInfo?.opensAt || new Date(Date.now() + this.config.maxDelayMs);

        return {
          shouldRetry: true,
          useSkipUntil: true,
          retryAt: skipUntil,
          reason: `Service ${service} unavailable (circuit ${breaker}), skipping until ${skipUntil.toISOString()}`,
        };
      }

      // Record failure in circuit breaker
      await circuitBreakerService.recordFailure(service, error);
    }

    // Transient errors: Retry with backoff
    const retryAt = this.calculateRetryTime(errorType, item.attempts);

    return {
      shouldRetry: true,
      useSkipUntil: false,
      retryAt,
      reason: `Transient ${errorType} error, retry at ${retryAt.toISOString()}`,
    };
  }

  /**
   * Record error in item's error history
   */
  buildErrorHistory(
    item: ProcessingItem,
    error: Error | string,
    errorType: ErrorType
  ): ErrorHistoryEntry[] {
    const existingHistory = (item.errorHistory as ErrorHistoryEntry[] | null) || [];

    const newEntry: ErrorHistoryEntry = {
      timestamp: new Date().toISOString(),
      error: this.formatError(error),
      errorType,
      attempts: item.attempts + 1,
    };

    // Keep last 10 errors
    const updatedHistory = [...existingHistory, newEntry].slice(-10);

    return updatedHistory;
  }

  /**
   * Calculate next retry time using exponential backoff with jitter
   */
  private calculateRetryTime(errorType: ErrorType, attempts: number): Date {
    let baseDelay: number;

    switch (errorType) {
      case ErrorType.RATE_LIMIT:
        // Longer delay for rate limits
        baseDelay = Math.min(this.config.baseDelayMs * 3 ** attempts, this.config.maxDelayMs);
        break;

      case ErrorType.NETWORK:
      case ErrorType.TIMEOUT:
      case ErrorType.TRANSIENT:
        // Standard exponential backoff
        baseDelay = Math.min(this.config.baseDelayMs * 2 ** attempts, this.config.maxDelayMs);
        break;

      default:
        baseDelay = this.config.baseDelayMs;
    }

    // Add jitter to prevent thundering herd
    const jitter = baseDelay * this.config.jitterFactor * (Math.random() - 0.5);
    const delayMs = baseDelay + jitter;

    return new Date(Date.now() + delayMs);
  }

  /**
   * Check if retry is allowed based on attempts
   */
  private canRetry(attempts: number, maxAttempts: number): boolean {
    return attempts < maxAttempts;
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
      message.includes("getconnection") ||
      message.includes("socket hang up") ||
      message.includes("network error")
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
      message.includes("temporarily unavailable") ||
      message.includes("try again")
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
   * Format error for storage
   */
  formatError(error: Error | string): string {
    if (typeof error === "string") {
      return error;
    }

    return `${error.name}: ${error.message}`;
  }

  /**
   * Record successful operation in circuit breaker
   */
  async recordSuccess(service?: string): Promise<void> {
    if (service) {
      await circuitBreakerService.recordSuccess(service);
    }
  }
}

export const smartRetryStrategy = new SmartRetryStrategy();
