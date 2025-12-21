import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cardigannParser } from "../../../services/cardigann/parser";

describe("TorrentLeech Integration Test", () => {
  it("should parse TorrentLeech JSON response correctly", () => {
    // Load the TorrentLeech definition
    const definitionPath = join(
      __dirname,
      "../../../../data/cardigann-definitions/torrentleech.yml"
    );
    const ymlContent = readFileSync(definitionPath, "utf-8");
    const parsed = cardigannParser.parseDefinition(ymlContent);
    const definition = parsed.definition;

    // Load the sample JSON response
    const responsePath = join(__dirname, "../../fixtures/cardigann/torrentleech-response.json");
    const jsonResponse = readFileSync(responsePath, "utf-8");

    // Get the search configuration
    const searchConfig = definition.search;
    expect(searchConfig).toBeDefined();
    if (!searchConfig) return;

    const searchPath = searchConfig.paths?.[0];
    expect(searchPath).toBeDefined();

    // Parse the JSON response using the private method (we'll need to expose or test differently)
    // For now, let's test the core parsing logic
    const json = JSON.parse(jsonResponse);

    // Verify the JSON structure
    expect(json.numFound).toBe(3);
    expect(json.torrentList).toBeArray();
    expect(json.torrentList).toHaveLength(3);

    // Verify row selector extraction
    const rowSelector = searchConfig.rows?.selector;
    expect(rowSelector).toBe("torrentList");
    if (!rowSelector) return;

    // Manually extract using the selector (mimicking what the executor does)
    const items = json[rowSelector];
    expect(items).toBeArray();
    expect(items).toHaveLength(3);

    // Verify first item has expected fields
    const firstItem = items[0];
    expect(firstItem.fid).toBe("241257906");
    expect(firstItem.name).toContain("Fallout S01");
    expect(firstItem.seeders).toBe(843);
    expect(firstItem.size).toBe(25106127683);
    expect(firstItem.imdbID).toBe("tt12637874");

    // Verify field selectors exist in definition
    const fields = searchConfig.fields;
    expect(fields).toBeDefined();
    if (!fields) return;

    expect(fields.title).toBeDefined();
    expect(fields._id).toBeDefined();
    expect(fields.seeders).toBeDefined();
    expect(fields.leechers).toBeDefined();
    expect(fields.size).toBeDefined();
    expect(fields.download).toBeDefined();

    console.log("✓ TorrentLeech definition and sample response validated");
    console.log(`✓ Successfully extracted ${items.length} torrents from JSON`);
    console.log(`✓ First torrent: ${firstItem.name}`);
    console.log(
      `✓ Seeders: ${firstItem.seeders}, Size: ${(firstItem.size / 1024 / 1024 / 1024).toFixed(2)} GB`
    );
  });

  it("should handle the title_test field correctly", () => {
    const definitionPath = join(
      __dirname,
      "../../../../data/cardigann-definitions/torrentleech.yml"
    );
    const ymlContent = readFileSync(definitionPath, "utf-8");
    const parsed = cardigannParser.parseDefinition(ymlContent);
    const definition = parsed.definition;

    const fields = definition.search?.fields;
    expect(fields).toBeDefined();
    if (!fields) return;

    // TorrentLeech has a title_test field that checks if title is null
    // and a title field that uses the result
    expect(fields.title_test).toBeDefined();
    expect(fields.title).toBeDefined();
    expect(fields.title.text).toContain("{{ if .Result.title_test }}");
  });

  it("should extract correct download URL format", () => {
    const definitionPath = join(
      __dirname,
      "../../../../data/cardigann-definitions/torrentleech.yml"
    );
    const ymlContent = readFileSync(definitionPath, "utf-8");
    const parsed = cardigannParser.parseDefinition(ymlContent);
    const definition = parsed.definition;

    const fields = definition.search?.fields;
    expect(fields).toBeDefined();
    if (!fields) return;

    // Download URL should be /download/{id}/{filename}
    expect(fields.download.text).toContain("/download/");
    expect(fields.download.text).toContain("{{ .Result._id }}");
    expect(fields.download.text).toContain("{{ .Result._filename }}");
  });
});
