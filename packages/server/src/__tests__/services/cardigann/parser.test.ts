import { describe, expect, it } from "bun:test";
import { CardigannParser } from "../../../services/cardigann/parser";

describe("CardigannParser", () => {
  const parser = new CardigannParser();

  describe("parseDefinition", () => {
    it("parses valid YML definition", () => {
      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://example.com
search:
  paths:
    - path: /search
`;

      const result = parser.parseDefinition(yml);

      expect(result.definition.id).toBe("test-indexer");
      expect(result.definition.name).toBe("Test Indexer");
      expect(result.definition.links).toEqual(["https://example.com"]);
    });

    it("extracts version from YML comment", () => {
      const yml = `
# version: 2.5.1
id: test-indexer
name: Test Indexer
links:
  - https://example.com
search:
  paths:
    - path: /search
`;

      const result = parser.parseDefinition(yml);
      expect(result.version).toBe("2.5.1");
    });

    it("defaults to version 1.0 if not specified", () => {
      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://example.com
search:
  paths:
    - path: /search
`;

      const result = parser.parseDefinition(yml);
      expect(result.version).toBe("1.0");
    });

    it("throws error if id is missing", () => {
      const yml = `
name: Test Indexer
links:
  - https://example.com
`;

      expect(() => parser.parseDefinition(yml)).toThrow("Definition must have an id");
    });

    it("throws error if name is missing", () => {
      const yml = `
id: test-indexer
links:
  - https://example.com
`;

      expect(() => parser.parseDefinition(yml)).toThrow("Definition must have a name");
    });

    it("throws error if links are missing", () => {
      const yml = `
id: test-indexer
name: Test Indexer
`;

      expect(() => parser.parseDefinition(yml)).toThrow("Definition must have at least one link");
    });

    it("throws error if search configuration is missing", () => {
      const yml = `
id: test-indexer
name: Test Indexer
links:
  - https://example.com
`;

      expect(() => parser.parseDefinition(yml)).toThrow(
        "Definition must have search configuration"
      );
    });
  });

  describe("normalizeUrl", () => {
    it("returns absolute URLs unchanged", () => {
      const result = parser.normalizeUrl("https://base.com", "https://other.com/path");
      expect(result).toBe("https://other.com/path");
    });

    it("appends relative path to base URL", () => {
      const result = parser.normalizeUrl("https://base.com", "/search");
      expect(result).toBe("https://base.com/search");
    });

    it("handles base URL with trailing slash", () => {
      const result = parser.normalizeUrl("https://base.com/", "/search");
      expect(result).toBe("https://base.com/search");
    });

    it("adds leading slash if missing", () => {
      const result = parser.normalizeUrl("https://base.com", "search");
      expect(result).toBe("https://base.com/search");
    });
  });

  describe("replaceVariables", () => {
    it("replaces .Config variables", () => {
      const template = "{{.Config.username}}:{{.Config.password}}";
      const vars = { username: "user", password: "pass" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("user:pass");
    });

    it("replaces .Keywords variable", () => {
      const template = "q={{.Keywords}}";
      const vars = { query: "test search" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("q=test search");
    });

    it("replaces .Categories variable", () => {
      const template = "cat={{.Categories}}";
      const vars = { categories: "1,2,3" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("cat=1,2,3");
    });

    it("replaces .Query.IMDBId variable", () => {
      const template = "imdb={{.Query.IMDBId}}";
      const vars = { imdbId: "tt1234567" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("imdb=tt1234567");
    });

    it("replaces multiple variables", () => {
      const template = "q={{.Keywords}}&cat={{.Categories}}&imdb={{.Query.IMDBId}}";
      const vars = { query: "test", categories: "1,2", imdbId: "tt1234567" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("q=test&cat=1,2&imdb=tt1234567");
    });

    it("handles missing variables gracefully", () => {
      const template = "q={{.Keywords}}&missing={{.NotDefined}}";
      const vars = { query: "test" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("q=test&missing={{.NotDefined}}");
    });
  });

  describe("replaceFilters", () => {
    it("applies append filter", () => {
      const value = "hello";
      const filters = [{ name: "append", args: [" world"] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello world");
    });

    it("applies prepend filter", () => {
      const value = "world";
      const filters = [{ name: "prepend", args: ["hello "] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello world");
    });

    it("applies replace filter", () => {
      const value = "hello world";
      const filters = [{ name: "replace", args: ["world", "universe"] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello universe");
    });

    it("applies split filter", () => {
      const value = "a,b,c,d";
      const filters = [{ name: "split", args: [",", 2] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("c");
    });

    it("applies trim filter", () => {
      const value = "  hello  ";
      const filters = [{ name: "trim" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello");
    });

    it("applies urlencode filter", () => {
      const value = "hello world & test";
      const filters = [{ name: "urlencode" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello%20world%20%26%20test");
    });

    it("applies urldecode filter", () => {
      const value = "hello%20world%20%26%20test";
      const filters = [{ name: "urldecode" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello world & test");
    });

    it("applies toupper filter", () => {
      const value = "hello";
      const filters = [{ name: "toupper" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("HELLO");
    });

    it("applies tolower filter", () => {
      const value = "HELLO";
      const filters = [{ name: "tolower" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("hello");
    });

    it("applies multiple filters in sequence", () => {
      const value = "  hello world  ";
      const filters = [
        { name: "trim" },
        { name: "replace", args: ["world", "universe"] },
        { name: "toupper" },
      ];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("HELLO UNIVERSE");
    });

    it("applies regexp filter", () => {
      const value = "Size: 1.5 GB";
      const filters = [{ name: "regexp", args: ["\\d+\\.\\d+"] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("1.5");
    });

    it("applies re_replace filter", () => {
      const value = "Size: 1.5 GB";
      const filters = [{ name: "re_replace", args: ["\\d+\\.\\d+", "2.0"] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("Size: 2.0 GB");
    });

    it("applies querystring filter", () => {
      const value = "?foo=bar&baz=qux";
      const filters = [{ name: "querystring", args: ["foo"] }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("bar");
    });

    it("applies diacritics filter", () => {
      const value = "café résumé";
      const filters = [{ name: "diacritics" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("cafe resume");
    });
  });

  describe("date parsing filters", () => {
    it("parses timeago filter", () => {
      const value = "2 hours ago";
      const filters = [{ name: "timeago" }];

      const result = parser.replaceFilters(value, filters);
      const parsed = new Date(result);

      expect(parsed).toBeInstanceOf(Date);
      expect(!Number.isNaN(parsed.getTime())).toBe(true);
    });

    it("parses fuzzytime filter with 'today'", () => {
      const value = "Today at 15:30";
      const filters = [{ name: "fuzzytime" }];

      const result = parser.replaceFilters(value, filters);
      const parsed = new Date(result);

      expect(parsed).toBeInstanceOf(Date);
      expect(!Number.isNaN(parsed.getTime())).toBe(true);
    });

    it("handles unknown filter gracefully", () => {
      const value = "test";
      const filters = [{ name: "nonexistent" }];

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("test");
    });
  });
});
