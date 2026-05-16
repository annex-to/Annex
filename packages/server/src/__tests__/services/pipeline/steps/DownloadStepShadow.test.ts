import { describe, expect, mock, test } from "bun:test";

let mapCalls = 0;
let nextFails = false;

mock.module("../../../../services/fileMapping", () => ({
  mapDownloadFiles: async (_id: string) => {
    mapCalls += 1;
    if (nextFails) {
      nextFails = false;
      throw new Error("boom");
    }
    return { fileMapStatus: "MAPPED" as const, orphans: [], misses: [] };
  },
}));

mock.module("../../../../services/fileMapping/featureFlag", () => ({
  fileMappingV2Enabled: () => false,
}));

const { runShadowMapping } = await import("../../../../services/pipeline/steps/DownloadStep");

describe("runShadowMapping", () => {
  test("invokes mapDownloadFiles", async () => {
    mapCalls = 0;
    await runShadowMapping("dl-id");
    expect(mapCalls).toBe(1);
  });

  test("swallows errors from mapDownloadFiles", async () => {
    nextFails = true;
    await expect(runShadowMapping("dl-id")).resolves.toBeUndefined();
  });
});
