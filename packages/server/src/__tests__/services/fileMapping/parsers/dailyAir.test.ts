import { describe, expect, it } from "bun:test";
import { dailyAirParser } from "../../../../services/fileMapping/parsers/dailyAir";

describe("dailyAirParser", () => {
  it("parses 2024.05.15", () => {
    const r = dailyAirParser.parse("DailyShow.2024.05.15.mkv");
    expect(r?.airDate?.toISOString().slice(0, 10)).toBe("2024-05-15");
  });

  it("parses 2024-05-15", () => {
    const r = dailyAirParser.parse("DailyShow.2024-05-15.mkv");
    expect(r?.airDate?.toISOString().slice(0, 10)).toBe("2024-05-15");
  });

  it("rejects clearly-not-air-dates like 1080p", () => {
    expect(dailyAirParser.parse("Show.1080p.mkv")).toBeNull();
  });

  it("rejects 4-digit numbers that aren't years", () => {
    expect(dailyAirParser.parse("Show.0001.01.01.mkv")).toBeNull();
  });
});
