// Converts the fonts used by the NFT card (Inter 500/600/700 and DejaVu Sans Mono) into glyph outlines, so the card SVG carries
// its text as PATHS: it renders identically on every device and marketplace, with no font installed or embedded.
// Output: server/src/art-glyphs.json  { fontKey: { upm, glyphs: { "<char>": { a: advance, d: "svg path in font units, y down" } } } }
// Usage: node scripts/gen-art-glyphs.mjs   (needs the devDependencies opentype.js, @fontsource/inter, @fontsource/dejavu-mono)
import { readFileSync, writeFileSync } from "node:fs";
import opentype from "opentype.js";

const FONTS = {
  "inter-500": "node_modules/@fontsource/inter/files/inter-latin-500-normal.woff",
  "inter-600": "node_modules/@fontsource/inter/files/inter-latin-600-normal.woff",
  "inter-700": "node_modules/@fontsource/inter/files/inter-latin-700-normal.woff",
  "mono-400": "node_modules/@fontsource/dejavu-mono/files/dejavu-mono-latin-400-normal.woff",
};
let chars = ""; for (let c = 32; c <= 126; c++) chars += String.fromCharCode(c);
chars += "·…–—’‘“”éèêëàâäáíìîïóòôöúùûüñçßÉÈÀÖÜÑÇ€£°";
const out = {};
for (const [key, file] of Object.entries(FONTS)) {
  const buf = readFileSync(file);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const upm = font.unitsPerEm; const glyphs = {};
  for (const ch of chars) {
    const g = font.charToGlyph(ch); if (g.index === 0 && ch !== " ") continue;
    const d = g.getPath(0, 0, upm).toPathData(1);
    glyphs[ch] = { a: g.advanceWidth, d };
  }
  out[key] = { upm, glyphs };
  console.log(key, upm, Object.keys(glyphs).length, "glyphs");
}
writeFileSync("server/src/art-glyphs.json", JSON.stringify(out));
console.log("wrote server/src/art-glyphs.json", (JSON.stringify(out).length / 1024).toFixed(0) + " KB");
