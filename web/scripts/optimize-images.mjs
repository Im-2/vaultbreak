// Builds responsive AVIF + WebP versions of the site photos (web/public/assets/<name>.jpg -> assets/img/<name>-<w>.avif|webp) and
// web/src/lib/img-meta.json (intrinsic sizes for width/height attributes). Usage: node web/scripts/optimize-images.mjs
import sharp from "sharp";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
const src = new URL("../public/assets/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = `${src}img/`; mkdirSync(out, { recursive: true });
const WIDTHS = [480, 960, 1600];
const meta = {}; let before = 0, after = 0; const rows = [];
for (const f of readdirSync(src).filter((x) => x.endsWith(".jpg"))) {
  const name = f.replace(/\.jpg$/, ""); const orig = statSync(`${src}${f}`).size; before += orig;
  const m = await sharp(`${src}${f}`).metadata(); meta[name] = { w: m.width, h: m.height };
  let sizes = {};
  for (const w of WIDTHS) {
    const ww = Math.min(w, m.width);
    const a = await sharp(`${src}${f}`).resize({ width: ww }).avif({ quality: 48, effort: 5 }).toFile(`${out}${name}-${w}.avif`);
    const b = await sharp(`${src}${f}`).resize({ width: ww }).webp({ quality: 74 }).toFile(`${out}${name}-${w}.webp`);
    sizes[w] = { avif: a.size, webp: b.size };
  }
  after += sizes[1600].avif; rows.push(`${name.padEnd(8)} jpg ${(orig / 1024).toFixed(0).padStart(4)} KB -> avif@1600 ${(sizes[1600].avif / 1024).toFixed(0).padStart(3)} KB, webp@1600 ${(sizes[1600].webp / 1024).toFixed(0).padStart(3)} KB | avif@960 ${(sizes[960].avif / 1024).toFixed(0)} KB, @480 ${(sizes[480].avif / 1024).toFixed(0)} KB`);
}
writeFileSync(new URL("../src/lib/img-meta.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), JSON.stringify(meta, null, 1));
console.log(rows.join("\n")); console.log(`total jpg ${(before / 1024).toFixed(0)} KB -> avif@1600 ${(after / 1024).toFixed(0)} KB`);
