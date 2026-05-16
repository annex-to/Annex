import { afterEach, describe, expect, test } from "bun:test";

const original = process.env.ANNEX_FILE_MAPPING_V2;

afterEach(() => {
  if (original === undefined) {
    process.env.ANNEX_FILE_MAPPING_V2 = undefined;
    delete process.env.ANNEX_FILE_MAPPING_V2;
  } else {
    process.env.ANNEX_FILE_MAPPING_V2 = original;
  }
});

describe("fileMappingV2Enabled", () => {
  test("returns false by default", async () => {
    process.env.ANNEX_FILE_MAPPING_V2 = undefined;
    delete process.env.ANNEX_FILE_MAPPING_V2;
    const { fileMappingV2Enabled } = await import(
      `../../../services/fileMapping/featureFlag?cb=${Date.now()}-a`
    );
    expect(fileMappingV2Enabled()).toBe(false);
  });

  test("returns true when ANNEX_FILE_MAPPING_V2=true", async () => {
    process.env.ANNEX_FILE_MAPPING_V2 = "true";
    const { fileMappingV2Enabled } = await import(
      `../../../services/fileMapping/featureFlag?cb=${Date.now()}-b`
    );
    expect(fileMappingV2Enabled()).toBe(true);
  });

  test("returns true when ANNEX_FILE_MAPPING_V2=1", async () => {
    process.env.ANNEX_FILE_MAPPING_V2 = "1";
    const { fileMappingV2Enabled } = await import(
      `../../../services/fileMapping/featureFlag?cb=${Date.now()}-c`
    );
    expect(fileMappingV2Enabled()).toBe(true);
  });
});
