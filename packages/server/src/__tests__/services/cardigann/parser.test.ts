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

    it("handles invalid regexp pattern gracefully", () => {
      const value = "test";
      const filters = [{ name: "regexp", args: ["(?i)"] }]; // Invalid JS regex

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("test"); // Should return original value
    });

    it("handles invalid re_replace pattern gracefully", () => {
      const value = "test";
      const filters = [{ name: "re_replace", args: ["(?i)", "x"] }]; // Invalid JS regex

      const result = parser.replaceFilters(value, filters);
      expect(result).toBe("test"); // Should return original value
    });
  });

  describe(".Result variable replacement (inter-field references)", () => {
    it("replaces .Result.fieldname", () => {
      const template = "{{ .Result.title }}";
      const vars = { title: "Test Movie" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("Test Movie");
    });

    it("replaces multiple .Result variables", () => {
      const template = "/download/{{ .Result._id }}/{{ .Result._filename }}";
      const vars = { _id: "12345", _filename: "movie.torrent" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("/download/12345/movie.torrent");
    });

    it("handles TorrentLeech-style download URL", () => {
      const template = "/download/{{ .Result._id }}/{{ .Result._filename }}";
      const vars = {
        _id: "241257906",
        _filename: "Fallout.S01.1080p.AMZN.WEB-DL.torrent",
      };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("/download/241257906/Fallout.S01.1080p.AMZN.WEB-DL.torrent");
    });
  });

  describe("join function", () => {
    it("joins .Categories with separator", () => {
      const template = '{{ join .Categories "," }}';
      const vars = { categories: "1,2,3" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("1,2,3");
    });

    it("joins .Keywords with separator", () => {
      const template = '{{ join .Keywords " " }}';
      const vars = { query: "test query" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("test query");
    });
  });

  describe("conditional expressions", () => {
    describe("simple if statements", () => {
      it("evaluates truthy condition", () => {
        const template = "{{ if .Config.username }}yes{{ else }}no{{ end }}";
        const vars = { username: "john" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("yes");
      });

      it("evaluates falsy condition (empty string)", () => {
        const template = "{{ if .Config.username }}yes{{ else }}no{{ end }}";
        const vars = { username: "" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("no");
      });

      it("evaluates falsy condition (false)", () => {
        const template = "{{ if .Config.enabled }}yes{{ else }}no{{ end }}";
        const vars = { enabled: false };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("no");
      });

      it("handles if without else", () => {
        const template = "{{ if .Config.username }}User: {{ .Config.username }}{{ end }}";
        const vars = { username: "john" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("User: john");
      });

      it("handles if without else - falsy condition", () => {
        const template = "{{ if .Config.username }}User: {{ .Config.username }}{{ end }}";
        const vars = { username: "" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("");
      });

      it("handles variable replacement inside if block", () => {
        const template =
          "{{ if .Result.title_test }}{{ .Result.title_test }}{{ else }}No title{{ end }}";
        const vars = { title_test: "Test Movie" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("Test Movie");
      });
    });

    describe("boolean operators", () => {
      it("handles 'and' operator - both true", () => {
        const template = "{{ if and .Config.user .Config.pass }}yes{{ else }}no{{ end }}";
        const vars = { user: "john", pass: "secret" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("yes");
      });

      it("handles 'and' operator - one false", () => {
        const template = "{{ if and .Config.user .Config.pass }}yes{{ else }}no{{ end }}";
        const vars = { user: "john", pass: "" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("no");
      });

      it("handles 'or' operator - one true", () => {
        const template = "{{ if or .Config.user .Config.pass }}yes{{ else }}no{{ end }}";
        const vars = { user: "", pass: "secret" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("yes");
      });

      it("handles 'or' operator - both false", () => {
        const template = "{{ if or .Config.user .Config.pass }}yes{{ else }}no{{ end }}";
        const vars = { user: "", pass: "" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("no");
      });

      it("handles 'eq' operator - equal", () => {
        const template = "{{ if eq .Config.type .Config.expected }}yes{{ else }}no{{ end }}";
        const vars = { type: "movie", expected: "movie" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("yes");
      });

      it("handles 'eq' operator - not equal", () => {
        const template = "{{ if eq .Config.type .Config.expected }}yes{{ else }}no{{ end }}";
        const vars = { type: "movie", expected: "tv" };

        const result = parser.replaceVariables(template, vars);
        expect(result).toBe("no");
      });
    });
  });

  describe("complex real-world scenarios", () => {
    it("handles TorrentLeech title field pattern", () => {
      const template =
        "{{ if .Result.title_test }}{{ .Result.title_test }}{{ else }}TorrentLeech did not provide a title{{ end }}";

      // With title
      const resultWithTitle = parser.replaceVariables(template, {
        title_test: "Fallout S01 1080p AMZN WEB-DL DDP5 1 Atmos H 264-FLUX",
      });
      expect(resultWithTitle).toBe("Fallout S01 1080p AMZN WEB-DL DDP5 1 Atmos H 264-FLUX");

      // Without title (empty string)
      const resultWithoutTitle = parser.replaceVariables(template, { title_test: "" });
      expect(resultWithoutTitle).toBe("TorrentLeech did not provide a title");

      // Without title (undefined)
      const resultUndefined = parser.replaceVariables(template, {});
      expect(resultUndefined).toBe("TorrentLeech did not provide a title");
    });

    it("handles TorrentLeech details URL pattern", () => {
      const template = "/torrent/{{ .Result._id }}";
      const vars = { _id: "241257906" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("/torrent/241257906");
    });

    it("handles conditional with nested variable replacements", () => {
      const template = "{{ if .Keywords }}q={{ .Keywords }}{{ end }}";
      const vars = { query: "test movie" };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("q=test movie");
    });

    it("handles login with username and password check", () => {
      const template =
        "{{ if and .Config.username .Config.password }}login=true&user={{ .Config.username }}{{ else }}anonymous=true{{ end }}";

      const withCredentials = parser.replaceVariables(template, {
        username: "john",
        password: "secret",
      });
      expect(withCredentials).toBe("login=true&user=john");

      const withoutCredentials = parser.replaceVariables(template, {
        username: "",
        password: "",
      });
      expect(withoutCredentials).toBe("anonymous=true");
    });

    it("handles multiple variable types in one template", () => {
      const template =
        "/search?q={{ .Keywords }}&cat={{ .Categories }}&imdb={{ .Query.IMDBId }}&user={{ .Config.username }}";
      const vars = {
        query: "inception",
        categories: "1,2",
        imdbId: "tt1375666",
        username: "john",
      };

      const result = parser.replaceVariables(template, vars);
      expect(result).toBe("/search?q=inception&cat=1,2&imdb=tt1375666&user=john");
    });
  });
});
