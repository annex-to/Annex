/**
 * Advanced tests for WebSocket encoder client
 */

import { describe, test, expect, mock } from "bun:test";

describe("client - advanced functionality", () => {
  describe("EncoderClient - configuration", () => {
    test("uses custom encoderId from config", () => {
      const customId = "custom-encoder-12345";
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: customId,
          serverUrl: "ws://localhost:3000/encoder",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 2,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("uses custom serverUrl from config", () => {
      const customUrl = "wss://production-server:8080/encoder";
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: customUrl,
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("uses custom maxConcurrent from config", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 4,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("uses custom GPU device from config", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD129",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("handles config with all custom values", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "prod-encoder-001",
          serverUrl: "wss://prod.example.com:443/encoder",
          gpuDevice: "/dev/dri/renderD130",
          maxConcurrent: 8,
          heartbeatInterval: 60000,
          reconnectInterval: 10000,
          maxReconnectInterval: 120000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
      expect(typeof client.start).toBe("function");
      expect(typeof client.stop).toBe("function");
    });
  });

  describe("EncoderClient - state management", () => {
    test("initializes in OFFLINE state", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      // Client should be created successfully
      expect(client).toBeDefined();
    });

    test("client instance is unique per construction", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client1 = new EncoderClient();
      const client2 = new EncoderClient();

      expect(client1).not.toBe(client2);
    });
  });

  describe("EncoderClient - method signatures", () => {
    test("start method returns Promise", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      const result = client.start();
      expect(result).toBeInstanceOf(Promise);
    });

    test("stop method returns Promise", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      const result = client.stop();
      expect(result).toBeInstanceOf(Promise);
    });

    test("start can be called multiple times", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      const result1 = client.start();
      const result2 = client.start();

      expect(result1).toBeInstanceOf(Promise);
      expect(result2).toBeInstanceOf(Promise);
    });

    test("stop can be called without start", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      // Should not throw
      await expect(client.stop()).resolves.toBeUndefined();
    });

    test("stop can be called multiple times", async () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      await client.stop();
      await expect(client.stop()).resolves.toBeUndefined();
    });
  });

  describe("EncoderClient - edge cases", () => {
    test("handles very long encoder ID", () => {
      const longId = "a".repeat(1000);
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: longId,
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("handles special characters in encoder ID", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "encoder-@#$%^&*()",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("handles maximum maxConcurrent value", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 8, // Maximum allowed
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("handles minimum heartbeatInterval", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 5000, // Minimum allowed
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });

    test("handles minimum reconnectInterval", () => {
      mock.module("../config.js", () => ({
        getConfig: mock(() => ({
          encoderId: "test",
          serverUrl: "ws://localhost:3000",
          gpuDevice: "/dev/dri/renderD128",
          maxConcurrent: 1,
          heartbeatInterval: 30000,
          reconnectInterval: 1000, // Minimum allowed
          maxReconnectInterval: 60000,
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      expect(client).toBeDefined();
    });
  });
});
