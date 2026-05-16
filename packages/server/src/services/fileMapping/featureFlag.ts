export function fileMappingV2Enabled(): boolean {
  const value = process.env.ANNEX_FILE_MAPPING_V2;
  return value === "true" || value === "1";
}
