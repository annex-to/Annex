import { describe, expect, test } from "bun:test";
import { normalizedTitlesMatch } from "../../services/downloadManager";

describe("normalizedTitlesMatch", () => {
  test("matches identical titles", () => {
    expect(normalizedTitlesMatch("The Office", "the office")).toBe(true);
  });

  test("treats punctuation and spacing differences as matching", () => {
    expect(normalizedTitlesMatch("The Office: US", "the.office.us")).toBe(true);
  });

  test("rejects different shows that share a word", () => {
    expect(normalizedTitlesMatch("The Office", "The Office UK")).toBe(false);
  });

  test("rejects empty vs non-empty", () => {
    expect(normalizedTitlesMatch("", "Show")).toBe(false);
  });
});
