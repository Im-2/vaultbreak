// Recompresses docs/screens/*.png (palette quantisation) to keep the repo light.
import sharp from "sharp";
import { readdirSync, renameSync, statSync } from "node:fs";
const dir = new URL("../../docs/screens/", import.meta.url).pathname;
let before = 0, after = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".png"))) {
  const p = dir + f; before += statSync(p).size;
  await sharp(p).png({ compressionLevel: 9, palette: true, quality: 88, effort: 8 }).toFile(p + ".tmp");
  renameSync(p + ".tmp", p); after += statSync(p).size;
}
console.log(`screens: ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`);
