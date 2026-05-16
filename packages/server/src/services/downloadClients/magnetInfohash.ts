const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/=+$/, "");
  if (cleaned.length !== 32) return null;
  let bits = "";
  for (const ch of cleaned) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) return null;
    bits += index.toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    hex += Number.parseInt(bits.slice(i, i + 8), 2)
      .toString(16)
      .padStart(2, "0");
  }
  return hex.length === 40 ? hex : null;
}

export function extractInfohashFromMagnet(magnet: string): string | null {
  if (!magnet.startsWith("magnet:?")) return null;
  const params = new URLSearchParams(magnet.slice("magnet:?".length));
  const xts = params.getAll("xt");
  for (const xt of xts) {
    if (!xt.startsWith("urn:btih:")) continue;
    const raw = xt.slice("urn:btih:".length);
    if (/^[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();
    const decoded = decodeBase32(raw);
    if (decoded) return decoded;
  }
  return null;
}
