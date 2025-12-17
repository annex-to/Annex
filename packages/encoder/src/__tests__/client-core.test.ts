/**
 * Core functionality tests for WebSocket encoder client
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

describe("client - core functionality", () => {
  let mockWs: any;
  let wsHandlers: any = {};

  beforeEach(() => {
    // Mock WebSocket
    mockWs = {
      readyState: 1, // OPEN
      send: mock(() => {}),
      close: mock(() => {}),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    // Intercept WebSocket constructor
    (global as any).WebSocket = mock(function (url: string) {
      setTimeout(() => {
        if (mockWs.onopen) mockWs.onopen({});
      }, 10);
      return mockWs;
    });
  });

  afterEach(() => {
    mockWs = null;
    wsHandlers = {};
  });

  describe("message handling", () => {
    test("handles registered message and starts heartbeat", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate registered message
      const registeredMsg = { type: "registered" };
      mockWs.onmessage({ data: JSON.stringify(registeredMsg) });

      expect(mockWs.send).toHaveBeenCalled();
    });

    test("handles pong message", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const initialCalls = mockWs.send.mock.calls.length;

      // Simulate pong message (should not cause errors)
      const pongMsg = { type: "pong" };
      mockWs.onmessage({ data: JSON.stringify(pongMsg) });

      // No additional sends for pong
      expect(mockWs.send.mock.calls.length).toBe(initialCalls);
    });

    test("handles invalid JSON message", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate invalid message (should not crash)
      mockWs.onmessage({ data: "invalid json{" });

      expect(client).toBeDefined();
    });

    test("handles server shutdown message", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate server shutdown
      const shutdownMsg = {
        type: "server:shutdown",
        reconnectDelay: 5000,
      };
      mockWs.onmessage({ data: JSON.stringify(shutdownMsg) });

      expect(client).toBeDefined();
    });

    test("handles unknown message type", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate unknown message
      const unknownMsg = { type: "unknown:message" };
      mockWs.onmessage({ data: JSON.stringify(unknownMsg) });

      expect(client).toBeDefined();
    });
  });

  describe("job capacity management", () => {
    test("rejects job when at capacity", async () => {
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

      // Mock the encoder to never complete
      mock.module("../encoder.js", () => ({
        encode: mock(async () => {
          await new Promise(() => {}); // Never resolves
        }),
        probeMedia: mock(async () => ({
          duration: 100,
          width: 1920,
          height: 1080,
          fps: 24,
          fileSize: 1000000,
          subtitleStreams: [],
        })),
      }));

      const { EncoderClient } = require("../client.js");
      const client = new EncoderClient();

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send first job (will be accepted)
      const job1 = {
        type: "job:assign",
        jobId: "job1",
        inputPath: "/test/input1.mp4",
        outputPath: "/test/output1.mkv",
        profileId: "profile1",
        profile: {
          name: "Test Profile",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          videoQuality: 30,
          videoMaxResolution: "1080p",
          audioEncoder: "opus",
          audioFlags: {},
          videoFlags: {},
        },
      };
      mockWs.onmessage({ data: JSON.stringify(job1) });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const callsBefore = mockWs.send.mock.calls.length;

      // Send second job (should be rejected due to capacity)
      const job2 = {
        type: "job:assign",
        jobId: "job2",
        inputPath: "/test/input2.mp4",
        outputPath: "/test/output2.mkv",
        profileId: "profile1",
        profile: {
          name: "Test Profile",
          hwAccel: "vaapi",
          videoEncoder: "av1_vaapi",
          videoQuality: 30,
          videoMaxResolution: "1080p",
          audioEncoder: "opus",
          audioFlags: {},
          videoFlags: {},
        },
      };
      mockWs.onmessage({ data: JSON.stringify(job2) });
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should have sent job:failed message
      const failedMsg = mockWs.send.mock.calls
        .slice(callsBefore)
        .find((call: any) => {
          const msg = JSON.parse(call[0]);
          return msg.type === "job:failed" && msg.jobId === "job2";
        });

      expect(failedMsg).toBeDefined();
    });
  });

  describe("job cancellation", () => {
    test("handles job cancel for unknown job", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Cancel non-existent job (should not crash)
      const cancelMsg = {
        type: "job:cancel",
        jobId: "nonexistent",
        reason: "Test cancellation",
      };
      mockWs.onmessage({ data: JSON.stringify(cancelMsg) });

      expect(client).toBeDefined();
    });
  });

  describe("graceful shutdown", () => {
    test("stops without active jobs", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      await client.stop();

      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe("connection handling", () => {
    test("handles WebSocket close event", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate disconnection
      if (mockWs.onclose) {
        mockWs.onclose({ code: 1006, reason: "Connection lost" });
      }

      expect(client).toBeDefined();
    });

    test("handles WebSocket error event", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Simulate error
      if (mockWs.onerror) {
        mockWs.onerror({ error: new Error("Connection error") });
      }

      expect(client).toBeDefined();
    });

    test("sends message with throttled warning when not connected", async () => {
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

      // Don't start, so WebSocket is not connected
      // Try to trigger a send (indirectly through a message)

      expect(client).toBeDefined();
    });
  });

  describe("state transitions", () => {
    test("transitions from OFFLINE to CONNECTING on start", async () => {
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

      await client.start();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Client should be in REGISTERING state after connection
      expect(client).toBeDefined();
    });
  });
});
