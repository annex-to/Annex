import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CardigannExecutor } from "../../../services/cardigann/executor";
import type { CardigannContext, CardigannSearchParams } from "../../../services/cardigann/types";

describe("CardigannExecutor", () => {
  const executor = new CardigannExecutor();
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("search", () => {
    it("executes HTML search and parses results", async () => {
      const mockHtml = `
        <table>
          <tr class="result">
            <td class="title">Test Movie</td>
            <td class="size">1.5 GB</td>
            <td class="seeders">10</td>
            <td class="leechers">5</td>
            <td><a class="download" href="/download/123">Download</a></td>
          </tr>
          <tr class="result">
            <td class="title">Another Movie</td>
            <td class="size">2.0 GB</td>
            <td class="seeders">20</td>
            <td class="leechers">3</td>
            <td><a class="download" href="/download/456">Download</a></td>
          </tr>
        </table>
      `;

      global.fetch = mock(async () => ({
        text: async () => mockHtml,
        headers: new Headers(),
      })) as any;

      const context: CardigannContext = {
        definition: {
          id: "test",
          name: "Test",
          links: ["https://test.com"],
          search: {
            paths: [
              {
                path: "/search",
                method: "get",
                rows: { selector: "tr.result" },
                fields: {
                  title: { selector: ".title" },
                  size: { selector: ".size" },
                  seeders: { selector: ".seeders" },
                  leechers: { selector: ".leechers" },
                  download: { selector: ".download", attribute: "href" },
                },
              },
            ],
          },
        },
        settings: {},
        cookies: {},
        baseUrl: "https://test.com",
      };

      const params: CardigannSearchParams = {
        query: "test",
      };

      const results = await executor.search(context, params);

      expect(results.length).toBe(2);
      expect(results[0].title).toBe("Test Movie");
      expect(results[0].seeders).toBe(10);
      expect(results[0].leechers).toBe(5);
      expect(results[0].downloadUrl).toBe("https://test.com/download/123");
      expect(results[1].title).toBe("Another Movie");
    });

    it("executes JSON search and parses results", async () => {
      const mockJson = JSON.stringify([
        {
          title: "Test Movie",
          size: "1.5 GB",
          seeders: 10,
          download: "/download/123",
        },
        {
          title: "Another Movie",
          size: "2.0 GB",
          seeders: 20,
          download: "/download/456",
        },
      ]);

      global.fetch = mock(async () => ({
        text: async () => mockJson,
        headers: new Headers(),
      })) as any;

      const context: CardigannContext = {
        definition: {
          id: "test",
          name: "Test",
          links: ["https://test.com"],
          search: {
            paths: [
              {
                path: "/api/search",
                method: "get",
                response: { type: "json" },
                fields: {
                  title: { selector: "title" },
                  size: { selector: "size" },
                  seeders: { selector: "seeders" },
                  download: { selector: "download" },
                },
              },
            ],
          },
        },
        settings: {},
        cookies: {},
        baseUrl: "https://test.com",
      };

      const params: CardigannSearchParams = {
        query: "test",
      };

      const results = await executor.search(context, params);

      expect(results.length).toBe(2);
      expect(results[0].title).toBe("Test Movie");
    });

    it("deduplicates results by infohash", async () => {
      const mockHtml = `
        <table>
          <tr class="result">
            <td class="title">Test Movie</td>
            <td class="download"><a href="magnet:?xt=urn:btih:ABC123">Download</a></td>
            <td class="infohash">ABC123</td>
          </tr>
          <tr class="result">
            <td class="title">Test Movie (Duplicate)</td>
            <td class="download"><a href="magnet:?xt=urn:btih:ABC123">Download</a></td>
            <td class="infohash">ABC123</td>
          </tr>
        </table>
      `;

      global.fetch = mock(async () => ({
        text: async () => mockHtml,
        headers: new Headers(),
      })) as any;

      const context: CardigannContext = {
        definition: {
          id: "test",
          name: "Test",
          links: ["https://test.com"],
          search: {
            paths: [
              {
                path: "/search",
                rows: { selector: "tr.result" },
                fields: {
                  title: { selector: ".title" },
                  download: { selector: ".download a", attribute: "href" },
                  infohash: { selector: ".infohash" },
                },
              },
            ],
          },
        },
        settings: {},
        cookies: {},
        baseUrl: "https://test.com",
      };

      const params: CardigannSearchParams = {
        query: "test",
      };

      const results = await executor.search(context, params);

      expect(results.length).toBe(1);
    });

    it("handles search with no results gracefully", async () => {
      global.fetch = mock(async () => ({
        text: async () => "<table></table>",
        headers: new Headers(),
      })) as any;

      const context: CardigannContext = {
        definition: {
          id: "test",
          name: "Test",
          links: ["https://test.com"],
          search: {
            paths: [
              {
                path: "/search",
                rows: { selector: "tr.result" },
                fields: { title: { selector: ".title" } },
              },
            ],
          },
        },
        settings: {},
        cookies: {},
        baseUrl: "https://test.com",
      };

      const params: CardigannSearchParams = {
        query: "nonexistent",
      };

      const results = await executor.search(context, params);

      expect(results.length).toBe(0);
    });

    it("throws error if search configuration is missing", async () => {
      const context: CardigannContext = {
        definition: {
          id: "test",
          name: "Test",
          links: ["https://test.com"],
        },
        settings: {},
        cookies: {},
        baseUrl: "https://test.com",
      };

      const params: CardigannSearchParams = {
        query: "test",
      };

      await expect(executor.search(context, params)).rejects.toThrow(
        "No search configuration found in definition"
      );
    });
  });
});
