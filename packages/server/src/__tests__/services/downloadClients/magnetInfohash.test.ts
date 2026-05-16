import { describe, expect, it } from "bun:test";
import { extractInfohashFromMagnet } from "../../../services/downloadClients/magnetInfohash.js";

describe("extractInfohashFromMagnet", () => {
  it("extracts a v1 40-char hex infohash", () => {
    const magnet = "magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Foo";
    expect(extractInfohashFromMagnet(magnet)).toBe("0123456789abcdef0123456789abcdef01234567");
  });

  it("extracts and decodes a base32 32-char infohash", () => {
    const magnet = "magnet:?xt=urn:btih:AERBCYJ4HMTU3IVTPL2BLO7VBYJVZIA7&dn=Foo";
    const result = extractInfohashFromMagnet(magnet);
    expect(result).not.toBeNull();
    expect(result).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for non-magnet input", () => {
    expect(extractInfohashFromMagnet("https://example.com/file.torrent")).toBeNull();
  });

  it("returns null when xt parameter is missing", () => {
    expect(extractInfohashFromMagnet("magnet:?dn=Foo")).toBeNull();
  });

  it("returns null for malformed infohash", () => {
    expect(extractInfohashFromMagnet("magnet:?xt=urn:btih:notahash")).toBeNull();
  });

  it("ignores BTMH (v2) topics for now", () => {
    expect(
      extractInfohashFromMagnet(
        "magnet:?xt=urn:btmh:1220AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      )
    ).toBeNull();
  });
});
