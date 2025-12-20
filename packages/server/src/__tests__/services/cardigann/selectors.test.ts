import { describe, expect, it } from "bun:test";
import { CardigannSelectorEngine } from "../../../services/cardigann/selectors";

describe("CardigannSelectorEngine", () => {
  const engine = new CardigannSelectorEngine();

  describe("extractRows", () => {
    it("extracts rows using CSS selector", () => {
      const html = `
        <table>
          <tr class="result"><td>Row 1</td></tr>
          <tr class="result"><td>Row 2</td></tr>
          <tr class="result"><td>Row 3</td></tr>
        </table>
      `;

      const rows = engine.extractRows(html, { selector: "tr.result" });
      expect(rows.length).toBe(3);
    });

    it("returns body element if no selector specified", () => {
      const html = "<body><div>Content</div></body>";

      const rows = engine.extractRows(html, {});
      expect(rows.length).toBe(1);
    });

    it("removes elements matching remove selector", () => {
      const html = `
        <table>
          <tr class="result"><td>Row 1</td></tr>
          <tr class="header"><td>Header</td></tr>
          <tr class="result"><td>Row 2</td></tr>
        </table>
      `;

      const rows = engine.extractRows(html, {
        selector: "tr.result",
        remove: "tr.header",
      });
      expect(rows.length).toBe(2);
    });

    it("skips first N rows with after parameter", () => {
      const html = `
        <table>
          <tr class="result"><td>Row 1</td></tr>
          <tr class="result"><td>Row 2</td></tr>
          <tr class="result"><td>Row 3</td></tr>
        </table>
      `;

      const rows = engine.extractRows(html, {
        selector: "tr.result",
        after: 1,
      });
      expect(rows.length).toBe(2);
    });
  });

  describe("extractField", () => {
    it("returns text content by default", () => {
      const html = '<div class="title">Test Title</div>';
      const $ = require("cheerio").load(html);
      const element = $(".title");

      const result = engine.extractField(element, { selector: "text()" }, $);
      expect(result).toBe("Test Title");
    });

    it("extracts attribute value", () => {
      const html = '<div><a class="link" href="/download/123">Download</a></div>';
      const $ = require("cheerio").load(html);
      const element = $("div");

      const result = engine.extractField(element, { selector: ".link", attribute: "href" }, $);
      expect(result).toBe("/download/123");
    });

    it("returns text from selector", () => {
      const html = '<div class="item"><span class="title">Title</span></div>';
      const $ = require("cheerio").load(html);
      const element = $(".item");

      const result = engine.extractField(element, { selector: ".title" }, $);
      expect(result).toBe("Title");
    });

    it("uses static text if provided", () => {
      const html = "<div>Content</div>";
      const $ = require("cheerio").load(html);
      const element = $("div");

      const result = engine.extractField(element, { text: "Static Value" }, $);
      expect(result).toBe("Static Value");
    });

    it("applies filters to extracted value", () => {
      const html = '<div><span class="title">  test  </span></div>';
      const $ = require("cheerio").load(html);
      const element = $("div");

      const result = engine.extractField(
        element,
        {
          selector: ".title",
          filters: [{ name: "trim" }, { name: "toupper" }],
        },
        $
      );
      expect(result).toBe("TEST");
    });

    it("returns empty string for optional missing field", () => {
      const html = '<div class="item">Content</div>';
      const $ = require("cheerio").load(html);
      const element = $(".item");

      const result = engine.extractField(element, { selector: ".nonexistent", optional: true }, $);
      expect(result).toBe("");
    });
  });

  describe("extractMultipleFields", () => {
    it("extracts multiple fields from element", () => {
      const html = `
        <div class="result">
          <span class="title">Test Title</span>
          <span class="size">1.5 GB</span>
          <a class="download" href="/download/123">Download</a>
        </div>
      `;
      const $ = require("cheerio").load(html);
      const element = $(".result");

      const fields = {
        title: { selector: ".title" },
        size: { selector: ".size" },
        download: { selector: ".download", attribute: "href" },
      };

      const result = engine.extractMultipleFields(element, fields, $);

      expect(result.title).toBe("Test Title");
      expect(result.size).toBe("1.5 GB");
      expect(result.download).toBe("/download/123");
    });
  });

  describe("parseSize", () => {
    it("parses bytes", () => {
      expect(engine.parseSize("512 B")).toBe(512);
    });

    it("parses kilobytes", () => {
      expect(engine.parseSize("1.5 KB")).toBe(1536);
    });

    it("parses megabytes", () => {
      expect(engine.parseSize("2 MB")).toBe(2097152);
    });

    it("parses gigabytes", () => {
      expect(engine.parseSize("1.5 GB")).toBe(1610612736);
    });

    it("parses terabytes", () => {
      expect(engine.parseSize("1 TB")).toBe(1099511627776);
    });

    it("handles different formats", () => {
      expect(engine.parseSize("1,024 KB")).toBe(1048576);
      expect(engine.parseSize("1.5gb")).toBe(1610612736);
    });

    it("returns 0 for invalid format", () => {
      expect(engine.parseSize("invalid")).toBe(0);
    });
  });

  describe("parseNumber", () => {
    it("parses simple numbers", () => {
      expect(engine.parseNumber("123")).toBe(123);
    });

    it("parses numbers with commas", () => {
      expect(engine.parseNumber("1,234,567")).toBe(1234567);
    });

    it("parses decimal numbers", () => {
      expect(engine.parseNumber("123.45")).toBe(123.45);
    });

    it("returns 0 for invalid numbers", () => {
      expect(engine.parseNumber("invalid")).toBe(0);
    });
  });

  describe("parseDate", () => {
    it("parses valid date string", () => {
      const result = engine.parseDate("2024-01-15T10:30:00Z");
      expect(result).toBeInstanceOf(Date);
      expect(result?.getFullYear()).toBe(2024);
    });

    it("returns null for invalid date", () => {
      const result = engine.parseDate("invalid date");
      expect(result).toBeNull();
    });
  });

  describe("extractJsonValue", () => {
    it("extracts nested JSON values", () => {
      const json = {
        data: {
          items: {
            title: "Test Title",
          },
        },
      };

      const result = engine.extractJsonValue(json, "data.items.title");
      expect(result).toBe("Test Title");
    });

    it("returns empty string for missing path", () => {
      const json = { data: { items: {} } };

      const result = engine.extractJsonValue(json, "data.items.missing");
      expect(result).toBe("");
    });
  });

  describe("extractXmlValue", () => {
    it("extracts XML values using selector", () => {
      const xml = `
        <rss>
          <channel>
            <item>
              <title>Test Title</title>
            </item>
          </channel>
        </rss>
      `;

      const result = engine.extractXmlValue(xml, "item title");
      expect(result).toBe("Test Title");
    });
  });
});
