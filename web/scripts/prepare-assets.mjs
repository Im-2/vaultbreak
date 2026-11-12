// Prepares the supplied images for the web app: resizes photos, crops the vault emblem out of each NFT card
// (the cards have demo numbers baked in; the UI shows live numbers, so only the emblem art is used).
import sharp from "sharp";
import { mkdirSync } from "node:fs";
const src = new URL("../../ui/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const out = new URL("../public/assets/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(out, { recursive: true });
const photos = { "vault.jpg": "vault", "landing-photo.jpg": "aisle", "more.jpg": "tunnel", "moore.jpg": "shadows", "another.jpg": "metal", "other-refernnce.jpg": "rack", "ppa.jpg": "hall" };
for (const [file, name] of Object.entries(photos)) {
  const info = await sharp(`${src}${file}`).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toFile(`${out}${name}.jpg`);
  console.log(name, info.width + "x" + info.height, Math.round(info.size / 1024) + "KB");
}
// (The NFT card art now comes from the API: server/src/art.ts renders it as SVG; the old emblem crops are gone.)
