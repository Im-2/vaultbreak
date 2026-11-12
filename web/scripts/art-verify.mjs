// Verifies the v2 card art and the centered landing section on the LIVE site; screenshots to docs/screens/deployed/art-*.png.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const base = (process.argv[2] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0; const check = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const b = await chromium.launch();
const imagesLoaded = (page) => page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 60000 }).catch(() => {});

// ---- centering at five widths
for (const w of [1440, 1280, 1024, 768, 390]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 }, deviceScaleFactor: 1 }); const page = await ctx.newPage();
  await page.goto(`${base}/?noloader`, { waitUntil: "load" }); await page.waitForResponse((r) => r.url().endsWith("/api/guardians"), { timeout: 60000 }).catch(() => {}); await sleep(4000);
  await page.locator(".gallery").scrollIntoViewIfNeeded(); await sleep(1500); await imagesLoaded(page);
  const m = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth; const cards = [...document.querySelectorAll(".gallery .gtile__card")].map((e) => e.getBoundingClientRect());
    const title = document.querySelector(".gallery__title").getBoundingClientRect(); const row = document.querySelector(".gallery__row").getBoundingClientRect();
    const gaps = cards.slice(1).map((r, i) => r.left - cards[i].right); const cols = new Set(cards.map((r) => Math.round(r.left))).size;
    const caps = [...document.querySelectorAll(".gallery figcaption")].map((e) => { const r = e.getBoundingClientRect(); return Math.abs((r.left + r.right) / 2 - (cards[0].left + cards[0].right) / 2); });
    return { vw, left: cards[0].left, right: vw - cards.at(-1).right, gaps, stacked: cols === 1, n: cards.length, titleOff: Math.abs((title.left + title.right) / 2 - vw / 2), overflow: document.documentElement.scrollWidth - vw, rowOff: Math.abs((row.left + row.right) / 2 - vw / 2), capOff: Math.max(...caps) };
  });
  const equalSides = Math.abs(m.left - m.right) <= 1.01;
  const equalGaps = m.gaps.every((g) => Math.abs(g - m.gaps[0]) <= 1.01);
  check(`landing NFT section @${w}px centered: left gap ${m.left.toFixed(1)} = right gap ${m.right.toFixed(1)}; ${m.stacked ? "stacked" : "row of " + m.n} gaps [${m.gaps.map((g) => g.toFixed(1)).join(", ")}]; heading offset ${m.titleOff.toFixed(1)}px; no sideways overflow (${m.overflow}px)`, equalSides && (m.stacked || equalGaps) && m.titleOff <= 1.5 && m.overflow <= 0 && m.n === 3);
  if (w === 1440 || w === 390) await page.screenshot({ path: `${out}art-landing-nft-${w}.png`, fullPage: false });
  await ctx.close();
}

// ---- arena, Guardian pages, image URL at 1440 and 390
for (const [w, h] of [[1440, 900], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage();
  await page.goto(`${base}/arena?noloader`, { waitUntil: "load" }); await page.waitForSelector("a.nft-link img", { timeout: 60000 }).catch(() => {}); await sleep(1500);
  for (let y = 0; y < 9000; y += 600) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(350); } // lazy images load as they scroll into view
  await imagesLoaded(page); await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
  const arenaImgs = await page.locator("a.nft-link img").evaluateAll((els) => els.map((e) => [e.alt, e.naturalWidth]));
  await page.screenshot({ path: `${out}art-arena-${w}.png` });
  check(`arena @${w}: card art renders for every Guardian`, arenaImgs.length >= 10 && arenaImgs.every(([, nw]) => nw > 0), `${arenaImgs.length} cards`);
  const states = Object.fromEntries(["warden", "old-ironside"].map((id) => [id, null]));
  for (const [id, expect] of [["warden", /armed$/], ["old-ironside", /pot released/]]) {
    await page.goto(`${base}/guardian/${id}?noloader`, { waitUntil: "load" }); await sleep(3500); await imagesLoaded(page);
    const alt = await page.locator(".nftcard img").first().getAttribute("alt"); states[id] = alt;
    await page.screenshot({ path: `${out}art-guardian-${id}-${w}.png` });
    check(`guardian page ${id} @${w}: state from live data ("${alt}")`, expect.test(alt ?? ""));
  }
  const r = await ctx.request.get(`${base}/api/guardians/warden/image.svg`); const body = await r.text();
  await page.goto(`${base}/api/guardians/warden/image.svg`, { waitUntil: "load" }); await sleep(1500);
  await page.screenshot({ path: `${out}art-image-url-${w}.png` });
  check(`image URL @${w}: ${r.status()} ${r.headers()["content-type"]}, ${(body.length / 1024).toFixed(0)} KB, text as paths`, r.status() === 200 && /image\/svg\+xml/.test(r.headers()["content-type"]) && body.startsWith("<svg") && !/<text|font-family/.test(body));
  await ctx.close();
}
// ---- metadata
const meta = await (await fetch(`${base}/api/guardians/warden/metadata.json`)).json();
const img = await fetch(meta.image); const t = await img.text();
check(`metadata image ${meta.image} loads the new SVG`, meta.image === `${base}/api/guardians/warden/image.svg` && img.status === 200 && t.startsWith("<svg"));
await b.close(); process.exit(bad ? 1 : 0);
