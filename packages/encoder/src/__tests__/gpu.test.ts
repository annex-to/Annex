/**
 * Tests for GPU detection and testing
 */

import { describe, test, expect, mock, spyOn } from "bun:test";
import * as fs from "fs";

describe("gpu", () => {
  describe("isGpuAvailable", () => {
    describe("happy path", () => {
      test("function exists and is callable", () => {
        const { isGpuAvailable } = require("../gpu.js");
        expect(typeof isGpuAvailable).toBe("function");
      });

      test("returns true for accessible device", () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {});

        const { isGpuAvailable } = require("../gpu.js");
        const result = isGpuAvailable("/dev/dri/renderD128");

        expect(result).toBe(true);
        expect(accessSyncSpy).toHaveBeenCalledWith(
          "/dev/dri/renderD128",
          fs.constants.R_OK | fs.constants.W_OK
        );

        accessSyncSpy.mockRestore();
      });
    });

    describe("non-happy path", () => {
      test("returns false for inaccessible device", () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {
          throw new Error("EACCES: permission denied");
        });

        const { isGpuAvailable } = require("../gpu.js");
        const result = isGpuAvailable("/dev/dri/renderD999");

        expect(result).toBe(false);

        accessSyncSpy.mockRestore();
      });

      test("returns false for nonexistent device", () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {
          throw new Error("ENOENT: no such file or directory");
        });

        const { isGpuAvailable } = require("../gpu.js");
        const result = isGpuAvailable("/dev/nonexistent");

        expect(result).toBe(false);

        accessSyncSpy.mockRestore();
      });

      test("returns false for null path", () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {
          throw new Error("Invalid path");
        });

        const { isGpuAvailable } = require("../gpu.js");
        const result = isGpuAvailable(null as any);

        expect(result).toBe(false);

        accessSyncSpy.mockRestore();
      });

      test("returns false for empty path", () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {
          throw new Error("Invalid path");
        });

        const { isGpuAvailable } = require("../gpu.js");
        const result = isGpuAvailable("");

        expect(result).toBe(false);

        accessSyncSpy.mockRestore();
      });
    });
  });

  describe("listRenderDevices", () => {
    describe("happy path", () => {
      test("function exists and is callable", () => {
        const { listRenderDevices } = require("../gpu.js");
        expect(typeof listRenderDevices).toBe("function");
      });

      test("returns array of accessible render devices", () => {
        const readdirSyncSpy = spyOn(fs, "readdirSync").mockReturnValue([
          "card0",
          "renderD128",
          "renderD129",
          "by-path",
        ] as any);

        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {});

        const { listRenderDevices } = require("../gpu.js");
        const result = listRenderDevices();

        expect(Array.isArray(result)).toBe(true);
        expect(result).toContain("/dev/dri/renderD128");
        expect(result).toContain("/dev/dri/renderD129");
        expect(result).not.toContain("/dev/dri/card0");

        readdirSyncSpy.mockRestore();
        accessSyncSpy.mockRestore();
      });

      test("filters out inaccessible devices", () => {
        const readdirSyncSpy = spyOn(fs, "readdirSync").mockReturnValue([
          "renderD128",
          "renderD129",
        ] as any);

        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation((path: any) => {
          if (path === "/dev/dri/renderD129") {
            throw new Error("EACCES");
          }
        });

        const { listRenderDevices } = require("../gpu.js");
        const result = listRenderDevices();

        expect(result).toContain("/dev/dri/renderD128");
        expect(result).not.toContain("/dev/dri/renderD129");

        readdirSyncSpy.mockRestore();
        accessSyncSpy.mockRestore();
      });

      test("returns empty array when no render devices found", () => {
        const readdirSyncSpy = spyOn(fs, "readdirSync").mockReturnValue([
          "card0",
          "card1",
        ] as any);

        const { listRenderDevices } = require("../gpu.js");
        const result = listRenderDevices();

        expect(result).toEqual([]);

        readdirSyncSpy.mockRestore();
      });
    });

    describe("non-happy path", () => {
      test("returns empty array when /dev/dri does not exist", () => {
        const readdirSyncSpy = spyOn(fs, "readdirSync").mockImplementation(() => {
          throw new Error("ENOENT: no such file or directory");
        });

        const { listRenderDevices } = require("../gpu.js");
        const result = listRenderDevices();

        expect(result).toEqual([]);

        readdirSyncSpy.mockRestore();
      });

      test("returns empty array on permission error", () => {
        const readdirSyncSpy = spyOn(fs, "readdirSync").mockImplementation(() => {
          throw new Error("EACCES: permission denied");
        });

        const { listRenderDevices } = require("../gpu.js");
        const result = listRenderDevices();

        expect(result).toEqual([]);

        readdirSyncSpy.mockRestore();
      });
    });
  });

  describe("testGpuEncoding", () => {
    describe("happy path", () => {
      test("function exists and is callable", () => {
        const { testGpuEncoding } = require("../gpu.js");
        expect(typeof testGpuEncoding).toBe("function");
      });

      test("returns promise", () => {
        mock.module("child_process", () => ({
          spawn: mock(() => ({
            stderr: { on: mock(() => {}) },
            on: mock((event: string, callback: Function) => {
              if (event === "close") {
                setTimeout(() => callback(0), 10);
              }
            }),
            kill: mock(() => {}),
          })),
        }));

        const { testGpuEncoding } = require("../gpu.js");
        const result = testGpuEncoding("/dev/dri/renderD128");

        expect(result instanceof Promise).toBe(true);
      });

      test("resolves true when ffmpeg succeeds", async () => {
        mock.module("child_process", () => ({
          spawn: mock(() => ({
            stderr: { on: mock(() => {}) },
            on: mock((event: string, callback: Function) => {
              if (event === "close") {
                setTimeout(() => callback(0), 10);
              }
            }),
            kill: mock(() => {}),
          })),
        }));

        const { testGpuEncoding } = require("../gpu.js");
        const result = await testGpuEncoding("/dev/dri/renderD128");

        expect(result).toBe(true);
      });
    });

    describe("non-happy path", () => {
      test("resolves false when ffmpeg fails", async () => {
        const consoleWarnSpy = spyOn(console, "warn");

        mock.module("child_process", () => ({
          spawn: mock(() => ({
            stderr: { on: mock((event: string, callback: Function) => {
              if (event === "data") {
                callback(Buffer.from("Error: Cannot find encoder"));
              }
            }) },
            on: mock((event: string, callback: Function) => {
              if (event === "close") {
                setTimeout(() => callback(1), 10);
              }
            }),
            kill: mock(() => {}),
          })),
        }));

        const { testGpuEncoding } = require("../gpu.js");
        const result = await testGpuEncoding("/dev/dri/renderD128");

        expect(result).toBe(false);
        expect(consoleWarnSpy).toHaveBeenCalled();

        consoleWarnSpy.mockRestore();
      });

      test("resolves false on spawn error", async () => {
        mock.module("child_process", () => ({
          spawn: mock(() => ({
            stderr: { on: mock(() => {}) },
            on: mock((event: string, callback: Function) => {
              if (event === "error") {
                setTimeout(() => callback(new Error("spawn failed")), 10);
              }
            }),
            kill: mock(() => {}),
          })),
        }));

        const { testGpuEncoding } = require("../gpu.js");
        const result = await testGpuEncoding("/dev/dri/renderD999");

        expect(result).toBe(false);
      });

      test("resolves false on timeout", async () => {
        const killMock = mock(() => {});

        mock.module("child_process", () => ({
          spawn: mock(() => ({
            stderr: { on: mock(() => {}) },
            on: mock(() => {}), // Never calls close
            kill: killMock,
          })),
        }));

        const { testGpuEncoding } = require("../gpu.js");
        const result = await testGpuEncoding("/dev/dri/renderD128");

        expect(result).toBe(false);
        expect(killMock).toHaveBeenCalledWith("SIGKILL");
      }, 15000); // Increase timeout for this test
    });
  });

  describe("getGpuInfo", () => {
    describe("happy path", () => {
      test("function exists and is callable", () => {
        const { getGpuInfo } = require("../gpu.js");
        expect(typeof getGpuInfo).toBe("function");
      });

      test("returns null for unavailable device", async () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {
          throw new Error("ENOENT");
        });

        const { getGpuInfo } = require("../gpu.js");
        const result = await getGpuInfo("/dev/dri/renderD999");

        expect(result).toBeNull();

        accessSyncSpy.mockRestore();
      });

      test("returns GpuInfo object for available device", async () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {});

        mock.module("child_process", () => ({
          spawn: mock((command: string) => {
            if (command === "vainfo") {
              return {
                stdout: { on: mock((event: string, callback: Function) => {
                  if (event === "data") {
                    callback(Buffer.from("vainfo: Driver version: Intel\nvainfo: VA-API version: 1.0"));
                  }
                }) },
                on: mock((event: string, callback: Function) => {
                  if (event === "close") {
                    setTimeout(() => callback(0), 10);
                  }
                }),
                kill: mock(() => {}),
              };
            } else {
              // ffmpeg
              return {
                stderr: { on: mock(() => {}) },
                on: mock((event: string, callback: Function) => {
                  if (event === "close") {
                    setTimeout(() => callback(0), 10);
                  }
                }),
                kill: mock(() => {}),
              };
            }
          }),
        }));

        const { getGpuInfo } = require("../gpu.js");
        const result = await getGpuInfo("/dev/dri/renderD128");

        expect(result).not.toBeNull();
        expect(result?.devicePath).toBe("/dev/dri/renderD128");
        expect(typeof result?.vendor).toBe("string");
        expect(typeof result?.model).toBe("string");
        expect(typeof result?.supported).toBe("boolean");

        accessSyncSpy.mockRestore();
      });
    });

    describe("non-happy path", () => {
      test("sets Unknown vendor/model when vainfo fails", async () => {
        const accessSyncSpy = spyOn(fs, "accessSync").mockImplementation(() => {});

        mock.module("child_process", () => ({
          spawn: mock((command: string) => {
            if (command === "vainfo") {
              return {
                stdout: { on: mock(() => {}) },
                on: mock((event: string, callback: Function) => {
                  if (event === "close") {
                    setTimeout(() => callback(1), 10); // Fail
                  }
                }),
                kill: mock(() => {}),
              };
            } else {
              // ffmpeg
              return {
                stderr: { on: mock(() => {}) },
                on: mock((event: string, callback: Function) => {
                  if (event === "close") {
                    setTimeout(() => callback(0), 10);
                  }
                }),
                kill: mock(() => {}),
              };
            }
          }),
        }));

        const { getGpuInfo } = require("../gpu.js");
        const result = await getGpuInfo("/dev/dri/renderD128");

        expect(result?.vendor).toBe("Unknown");
        expect(result?.model).toBe("Unknown");

        accessSyncSpy.mockRestore();
      });
    });
  });
});
