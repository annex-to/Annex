import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockPrisma } from "../../../__tests__/setup.js";

const mockPrisma = createMockPrisma();

const circuitBreakerStore = new Map<string, any>();

mockPrisma.circuitBreaker = {
  findUnique: mock(async ({ where }: { where: { service: string } }) => {
    return circuitBreakerStore.get(where.service) || null;
  }),
  create: mock(async ({ data }: { data: any }) => {
    const record = { ...data, createdAt: new Date(), updatedAt: new Date() };
    circuitBreakerStore.set(data.service, record);
    return record;
  }),
  update: mock(async ({ where, data }: { where: { service: string }; data: any }) => {
    const record = circuitBreakerStore.get(where.service);
    if (!record) throw new Error(`CircuitBreaker ${where.service} not found`);
    const updated = { ...record, ...data, updatedAt: new Date() };
    circuitBreakerStore.set(where.service, updated);
    return updated;
  }),
  findMany: mock(async (_opts: { orderBy?: any } = {}) => {
    return Array.from(circuitBreakerStore.values());
  }),
};

mock.module("../../../db/client.js", () => ({
  prisma: mockPrisma,
  db: mockPrisma,
}));

const { CircuitBreakerService, CircuitState } = await import("../CircuitBreakerService.js");

describe("CircuitBreakerService", () => {
  let service: InstanceType<typeof CircuitBreakerService>;

  beforeEach(() => {
    service = new CircuitBreakerService({
      failureThreshold: 3,
      halfOpenAfterMs: 5 * 60 * 1000,
      successThreshold: 2,
    });
    circuitBreakerStore.clear();
  });

  afterEach(() => {
    circuitBreakerStore.clear();
  });

  describe("isAvailable", () => {
    test("returns true for new service (creates CLOSED breaker)", async () => {
      const available = await service.isAvailable("new-service");
      expect(available).toBe(true);
      expect(circuitBreakerStore.get("new-service")?.state).toBe(CircuitState.CLOSED);
    });

    test("returns true for CLOSED circuit", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.CLOSED,
        failures: 0,
        lastFailure: null,
        opensAt: null,
      });
      expect(await service.isAvailable("test")).toBe(true);
    });

    test("returns false for OPEN circuit within cooldown", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: new Date(Date.now() + 300000),
      });
      expect(await service.isAvailable("test")).toBe(false);
    });

    test("transitions OPEN to HALF_OPEN when cooldown expired", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.OPEN,
        failures: 3,
        lastFailure: new Date(Date.now() - 600000),
        opensAt: new Date(Date.now() - 1000),
      });
      const available = await service.isAvailable("test");
      expect(available).toBe(true);
      expect(circuitBreakerStore.get("test").state).toBe(CircuitState.HALF_OPEN);
    });

    test("returns true for HALF_OPEN circuit", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.HALF_OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: null,
      });
      expect(await service.isAvailable("test")).toBe(true);
    });
  });

  describe("recordSuccess", () => {
    test("resets failure count in CLOSED state", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.CLOSED,
        failures: 2,
        lastFailure: new Date(),
        opensAt: null,
      });
      await service.recordSuccess("test");
      const breaker = circuitBreakerStore.get("test");
      expect(breaker.failures).toBe(0);
      expect(breaker.lastFailure).toBeNull();
    });

    test("increments success count in HALF_OPEN state", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.HALF_OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: null,
      });

      await service.recordSuccess("test");
      // After 1 success, still HALF_OPEN (threshold is 2)
      expect(circuitBreakerStore.get("test").state).toBe(CircuitState.HALF_OPEN);
    });

    test("transitions HALF_OPEN to CLOSED after successThreshold", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.HALF_OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: null,
      });

      await service.recordSuccess("test");
      await service.recordSuccess("test");

      const breaker = circuitBreakerStore.get("test");
      expect(breaker.state).toBe(CircuitState.CLOSED);
      expect(breaker.failures).toBe(0);
    });
  });

  describe("recordFailure", () => {
    test("creates breaker and increments failure on new service", async () => {
      await service.recordFailure("new-svc", "connection refused");
      const breaker = circuitBreakerStore.get("new-svc");
      expect(breaker).toBeDefined();
      expect(breaker.failures).toBe(1);
      expect(breaker.state).toBe(CircuitState.CLOSED);
    });

    test("increments failure count", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.CLOSED,
        failures: 1,
        lastFailure: null,
        opensAt: null,
      });
      await service.recordFailure("test", "error");
      expect(circuitBreakerStore.get("test").failures).toBe(2);
    });

    test("transitions to OPEN at failure threshold", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.CLOSED,
        failures: 2,
        lastFailure: null,
        opensAt: null,
      });
      await service.recordFailure("test", "error 3");
      const breaker = circuitBreakerStore.get("test");
      expect(breaker.state).toBe(CircuitState.OPEN);
      expect(breaker.opensAt).toBeDefined();
    });

    test("HALF_OPEN failure immediately reopens circuit", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.HALF_OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: null,
      });
      await service.recordFailure("test", "failed during recovery");
      expect(circuitBreakerStore.get("test").state).toBe(CircuitState.OPEN);
    });
  });

  describe("reset", () => {
    test("resets circuit to CLOSED with zero failures", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.OPEN,
        failures: 5,
        lastFailure: new Date(),
        opensAt: new Date(Date.now() + 300000),
      });
      await service.reset("test");
      const breaker = circuitBreakerStore.get("test");
      expect(breaker.state).toBe(CircuitState.CLOSED);
      expect(breaker.failures).toBe(0);
      expect(breaker.opensAt).toBeNull();
    });
  });

  describe("getState", () => {
    test("returns current state", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: new Date(),
      });
      expect(await service.getState("test")).toBe(CircuitState.OPEN);
    });

    test("returns CLOSED for new service", async () => {
      expect(await service.getState("new-service")).toBe(CircuitState.CLOSED);
    });
  });

  describe("getBreakerInfo", () => {
    test("returns info for existing breaker", async () => {
      const now = new Date();
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.OPEN,
        failures: 3,
        lastFailure: now,
        opensAt: new Date(now.getTime() + 300000),
      });
      const info = await service.getBreakerInfo("test");
      expect(info).toBeDefined();
      expect(info?.service).toBe("test");
      expect(info?.state).toBe(CircuitState.OPEN);
      expect(info?.failures).toBe(3);
    });

    test("returns null for non-existent breaker", async () => {
      const info = await service.getBreakerInfo("nonexistent");
      expect(info).toBeNull();
    });
  });

  describe("getAllBreakers", () => {
    test("returns all breakers", async () => {
      circuitBreakerStore.set("svc-1", {
        service: "svc-1",
        state: CircuitState.CLOSED,
        failures: 0,
        lastFailure: null,
        opensAt: null,
        updatedAt: new Date(),
      });
      circuitBreakerStore.set("svc-2", {
        service: "svc-2",
        state: CircuitState.OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: new Date(),
        updatedAt: new Date(),
      });

      const breakers = await service.getAllBreakers();
      expect(breakers).toHaveLength(2);
    });
  });

  describe("state transition lifecycle", () => {
    test("full lifecycle: CLOSED -> OPEN -> HALF_OPEN -> CLOSED", async () => {
      // Start CLOSED
      circuitBreakerStore.set("lifecycle", {
        service: "lifecycle",
        state: CircuitState.CLOSED,
        failures: 0,
        lastFailure: null,
        opensAt: null,
      });

      // Record failures to open
      await service.recordFailure("lifecycle", "fail 1");
      await service.recordFailure("lifecycle", "fail 2");
      await service.recordFailure("lifecycle", "fail 3");
      expect(circuitBreakerStore.get("lifecycle").state).toBe(CircuitState.OPEN);

      // Simulate cooldown expiry by setting opensAt to past
      circuitBreakerStore.get("lifecycle").opensAt = new Date(Date.now() - 1000);
      const available = await service.isAvailable("lifecycle");
      expect(available).toBe(true);
      expect(circuitBreakerStore.get("lifecycle").state).toBe(CircuitState.HALF_OPEN);

      // Record successes to close
      await service.recordSuccess("lifecycle");
      await service.recordSuccess("lifecycle");
      expect(circuitBreakerStore.get("lifecycle").state).toBe(CircuitState.CLOSED);
      expect(circuitBreakerStore.get("lifecycle").failures).toBe(0);
    });

    test("HALF_OPEN -> OPEN on failure", async () => {
      circuitBreakerStore.set("test", {
        service: "test",
        state: CircuitState.HALF_OPEN,
        failures: 3,
        lastFailure: new Date(),
        opensAt: null,
      });

      // One success then a failure
      await service.recordSuccess("test");
      await service.recordFailure("test", "still broken");
      expect(circuitBreakerStore.get("test").state).toBe(CircuitState.OPEN);
    });
  });
});
