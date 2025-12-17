/**
 * Tests for WebSocket encoder client
 */

import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";

describe("client", () => {
  describe("EncoderClient", () => {
    describe("initialization", () => {
      test("class exists and is constructable", () => {
        mock.module("../config.js", () => ({
          getConfig: mock(() => ({
            encoderId: "test-encoder",
            serverUrl: "ws://localhost:3000/encoder",
            gpuDevice: "/dev/dri/renderD128",
            maxConcurrent: 1,
            heartbeatInterval: 30000,
            reconnectInterval: 5000,
            maxReconnectInterval: 60000,
          })),
        }));

        const { EncoderClient } = require("../client.js");
        expect(typeof EncoderClient).toBe("function");

        const client = new EncoderClient();
        expect(client).toBeDefined();
      });

      test("initializes with config from getConfig", () => {
        const mockConfig = {
          encoderId: "test-encoder-123",
          serverUrl: "ws://test-server:3000/encoder",
          gpuDevice: "/dev/dri/renderD129",
          maxConcurrent: 2,
          heartbeatInterval: 30000,
          reconnectInterval: 5000,
          maxReconnectInterval: 60000,
        };

        mock.module("../config.js", () => ({
          getConfig: mock(() => mockConfig),
        }));

        const { EncoderClient } = require("../client.js");
        const client = new EncoderClient();

        expect(client).toBeDefined();
      });
    });

    describe("start", () => {
      test("function exists and is callable", () => {
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

        expect(typeof client.start).toBe("function");
      });

      test("start method exists", () => {
        mock.module("../config.js", () => ({
          getConfig: mock(() => ({
            encoderId: "test-encoder",
            serverUrl: "ws://localhost:3000/encoder",
            gpuDevice: "/dev/dri/renderD128",
            maxConcurrent: 1,
            heartbeatInterval: 30000,
            reconnectInterval: 5000,
            maxReconnectInterval: 60000,
          })),
        }));

        const { EncoderClient } = require("../client.js");
        const client = new EncoderClient();

        expect(typeof client.start).toBe("function");
      });

      test("start returns promise", () => {
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
        expect(result instanceof Promise).toBe(true);
      });
    });

    describe("stop", () => {
      test("function exists and is callable", () => {
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

        expect(typeof client.stop).toBe("function");
      });

      test("stop returns promise", () => {
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
        expect(result instanceof Promise).toBe(true);
      });

      test("stop method exists", () => {
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

        expect(typeof client.stop).toBe("function");
      });
    });

    describe("class structure", () => {
      test("EncoderClient has expected methods", () => {
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

        // Verify key methods exist
        expect(typeof client.start).toBe("function");
        expect(typeof client.stop).toBe("function");
      });
    });
  });
});
