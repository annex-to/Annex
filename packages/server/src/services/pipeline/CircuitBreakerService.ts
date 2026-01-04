import { prisma } from "../../db/client.js";

export interface CircuitBreakerConfig {
  failureThreshold: number; // Open circuit after N failures
  halfOpenAfterMs: number; // Try half-open after this delay
  successThreshold: number; // Close circuit after N successes in half-open
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  halfOpenAfterMs: 5 * 60 * 1000, // 5 minutes
  successThreshold: 2,
};

export enum CircuitState {
  CLOSED = "CLOSED", // Normal operation
  OPEN = "OPEN", // Service is down, don't attempt
  HALF_OPEN = "HALF_OPEN", // Testing if service recovered
}

export class CircuitBreakerService {
  private config: CircuitBreakerConfig;
  private halfOpenSuccesses: Map<string, number> = new Map();

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if service is available (circuit allows requests)
   */
  async isAvailable(service: string): Promise<boolean> {
    const breaker = await this.getOrCreateBreaker(service);

    // CLOSED: Service is healthy
    if (breaker.state === CircuitState.CLOSED) {
      return true;
    }

    // OPEN: Check if cooldown period has passed
    if (breaker.state === CircuitState.OPEN) {
      if (breaker.opensAt && new Date() >= breaker.opensAt) {
        // Transition to HALF_OPEN
        await this.transitionToHalfOpen(service);
        return true;
      }
      return false;
    }

    // HALF_OPEN: Allow limited requests to test recovery
    if (breaker.state === CircuitState.HALF_OPEN) {
      return true;
    }

    return false;
  }

  /**
   * Record successful operation
   */
  async recordSuccess(service: string): Promise<void> {
    const breaker = await this.getOrCreateBreaker(service);

    if (breaker.state === CircuitState.HALF_OPEN) {
      // Count successes in half-open state
      const successes = (this.halfOpenSuccesses.get(service) || 0) + 1;
      this.halfOpenSuccesses.set(service, successes);

      if (successes >= this.config.successThreshold) {
        // Enough successes, close circuit
        await this.transitionToClosed(service);
        this.halfOpenSuccesses.delete(service);
      }
    } else if (breaker.state === CircuitState.CLOSED) {
      // Reset failure count on success
      await prisma.circuitBreaker.update({
        where: { service },
        data: {
          failures: 0,
          lastFailure: null,
        },
      });
    }
  }

  /**
   * Record failed operation
   */
  async recordFailure(service: string, error: Error | string): Promise<void> {
    const breaker = await this.getOrCreateBreaker(service);
    const errorMessage = typeof error === "string" ? error : error.message;

    console.log(
      `[CircuitBreaker] Recording failure for ${service}: ${errorMessage} (failures: ${breaker.failures + 1}/${this.config.failureThreshold})`
    );

    if (breaker.state === CircuitState.HALF_OPEN) {
      // Failure in half-open immediately reopens circuit
      await this.transitionToOpen(service);
      this.halfOpenSuccesses.delete(service);
      return;
    }

    // Increment failure count
    const failures = breaker.failures + 1;
    await prisma.circuitBreaker.update({
      where: { service },
      data: {
        failures,
        lastFailure: new Date(),
      },
    });

    // Open circuit if threshold exceeded
    if (failures >= this.config.failureThreshold) {
      await this.transitionToOpen(service);
    }
  }

  /**
   * Manually reset circuit to closed (for admin intervention)
   */
  async reset(service: string): Promise<void> {
    await this.transitionToClosed(service);
    this.halfOpenSuccesses.delete(service);
  }

  /**
   * Get current circuit state
   */
  async getState(service: string): Promise<CircuitState> {
    const breaker = await this.getOrCreateBreaker(service);
    return breaker.state as CircuitState;
  }

  /**
   * Get circuit breaker info for a specific service
   */
  async getBreakerInfo(service: string): Promise<{
    service: string;
    state: CircuitState;
    failures: number;
    lastFailure: Date | null;
    opensAt: Date | null;
  } | null> {
    const breaker = await prisma.circuitBreaker.findUnique({
      where: { service },
    });

    if (!breaker) {
      return null;
    }

    return {
      service: breaker.service,
      state: breaker.state as CircuitState,
      failures: breaker.failures,
      lastFailure: breaker.lastFailure,
      opensAt: breaker.opensAt,
    };
  }

  /**
   * Get all circuit breakers with their states
   */
  async getAllBreakers(): Promise<
    Array<{
      service: string;
      state: CircuitState;
      failures: number;
      lastFailure: Date | null;
      opensAt: Date | null;
    }>
  > {
    const breakers = await prisma.circuitBreaker.findMany({
      orderBy: { updatedAt: "desc" },
    });

    return breakers.map(
      (b: {
        service: string;
        state: string;
        failures: number;
        lastFailure: Date | null;
        opensAt: Date | null;
      }) => ({
        service: b.service,
        state: b.state as CircuitState,
        failures: b.failures,
        lastFailure: b.lastFailure,
        opensAt: b.opensAt,
      })
    );
  }

  /**
   * Get or create circuit breaker for service
   */
  private async getOrCreateBreaker(service: string) {
    let breaker = await prisma.circuitBreaker.findUnique({
      where: { service },
    });

    if (!breaker) {
      breaker = await prisma.circuitBreaker.create({
        data: {
          service,
          state: CircuitState.CLOSED,
          failures: 0,
        },
      });
    }

    return breaker;
  }

  /**
   * Transition circuit to OPEN state
   */
  private async transitionToOpen(service: string): Promise<void> {
    const opensAt = new Date(Date.now() + this.config.halfOpenAfterMs);

    await prisma.circuitBreaker.update({
      where: { service },
      data: {
        state: CircuitState.OPEN,
        opensAt,
      },
    });

    console.log(
      `[CircuitBreaker] Circuit OPEN for ${service}. Will attempt half-open at ${opensAt.toISOString()}`
    );
  }

  /**
   * Transition circuit to HALF_OPEN state
   */
  private async transitionToHalfOpen(service: string): Promise<void> {
    await prisma.circuitBreaker.update({
      where: { service },
      data: {
        state: CircuitState.HALF_OPEN,
        opensAt: null,
      },
    });

    this.halfOpenSuccesses.set(service, 0);
    console.log(`[CircuitBreaker] Circuit HALF_OPEN for ${service}, testing recovery`);
  }

  /**
   * Transition circuit to CLOSED state
   */
  private async transitionToClosed(service: string): Promise<void> {
    await prisma.circuitBreaker.update({
      where: { service },
      data: {
        state: CircuitState.CLOSED,
        failures: 0,
        lastFailure: null,
        opensAt: null,
      },
    });

    console.log(`[CircuitBreaker] Circuit CLOSED for ${service}, service recovered`);
  }
}

export const circuitBreakerService = new CircuitBreakerService();
