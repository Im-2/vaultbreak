// Usage: node web/scripts/offline-test.mjs <offline|online> [url]. Run once with the backend stopped and once after restarting it.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const phase = process.argv[2] ?? "offline"; const base = (process.argv[3] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch(); let bad = 0;
const check = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
await page.goto(`${base}/?noloader`, { waitUntil: "load" });
for (const id of ["warden", "soft-sally", "rogue"]) {
  const r = await ctx.request.get(`${base}/api/guardians/${id}/metadata.json`);
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  const h = r.headers();
  check(`[${phase}] metadata ${id}: ${r.status()} ${h["content-type"]} source=${h["x-vaultbreak-source"]} cors=${h["access-control-allow-origin"]}`, r.status() === 200 && /application\/json/.test(h["content-type"]) && h["access-control-allow-origin"] === "*" && !!j?.title,
    j ? `title="${j.title}" status=${j.attributes?.find((a) => a.trait_type === "status")?.value} attempts=${j.attributes?.find((a) => a.trait_type === "attempts")?.value} stale=${!!j.extra?.stale}` : "");
}
const unk = await ctx.request.get(`${base}/api/guardians/does-not-exist/metadata.json`); check(`[${phase}] unknown id returns JSON error, not an error page: ${unk.status()} ${unk.headers()["content-type"]}`, /json/.test(unk.headers()["content-type"] ?? "") && unk.status() === 404);
const api = await ctx.request.get(`${base}/api/stats`); console.log(`info  /api/stats -> ${api.status()} ${(await api.text()).slice(0, 80).replace(/\n/g, " ")}`);
await sleep(4000);
await page.goto(`${base}/arena?noloader`, { waitUntil: "load" }); await sleep(7000);
const banner = await page.locator(".offline").count(); const body = (await page.locator("body").innerText()).trim();
await page.screenshot({ path: `${out}backend-${phase}-arena.png` });
if (phase === "offline") check("site shows a clear 'backend offline' message", banner > 0 && /offline/i.test(body) && body.length > 200, `(banner=${banner}, page text ${body.length} chars)`);
else { const cards = await page.locator("a[href^='/guardian/']").count(); check("banner gone and the arena shows live Guardians", banner === 0 && cards >= 6, `(${cards} links)`); }
await page.goto(`${base}/guardian/warden?noloader`, { waitUntil: "load" }); await sleep(5000);
await page.screenshot({ path: `${out}backend-${phase}-guardian.png` });
await b.close(); process.exit(bad ? 1 : 0);
