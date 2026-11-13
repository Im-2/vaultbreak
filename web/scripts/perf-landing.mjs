// Measures the landing page on the LIVE site: when real numbers show in "Pot in play / Attempts so far / Guardians alive", the API calls,
// and the hero image. Scenarios: warm (normal), fresh visitor (empty browser storage), and "backend unreachable" (every /api call stalls).
// Usage: node web/scripts/perf-landing.mjs [url]   Screenshots: docs/screens/deployed/perf-landing-{1440,390}.png
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const base = (process.argv[2] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(out, { recursive: true });
const b = await chromium.launch();
async function run(label, { width = 1440, stall = false, reuse = null } = {}) {
  const ctx = reuse ?? await b.newContext({ viewport: { width, height: width > 800 ? 900 : 844 } }); const page = await ctx.newPage();
  const api = []; const t0 = Date.now();
  page.on("response", async (r) => { const u = r.url(); if (/\/api\/(stats|guardians)$/.test(u) || /snapshot\.json/.test(u) || /assets\/img\/vault/.test(u)) { let size = 0; try { size = (await r.body()).length; } catch { /* streamed */ } api.push({ u: u.replace(base, ""), s: r.status(), t: Date.now() - t0, kb: Math.round(size / 1024), src: r.headers()["x-vaultbreak-source"] ?? "" }); } });
  if (stall) await page.route("**/api/**", async (route) => { await new Promise((r) => setTimeout(r, 30000)); route.abort().catch(() => {}); });
  await page.goto(`${base}/?noloader`, { waitUntil: "commit" });
  const numbers = async () => page.evaluate(() => { const dds = [...document.querySelectorAll(".hero__meta dd")].map((e) => e.textContent ?? ""); return dds.length === 3 && dds.every((t) => /\d/.test(t)) ? dds : null; });
  let shown = null, ms = null;
  while (Date.now() - t0 < 40000) { shown = await numbers().catch(() => null); if (shown) { ms = Date.now() - t0; break; } await new Promise((r) => setTimeout(r, 50)); }
  await new Promise((r) => setTimeout(r, 2500));
  const note = await page.locator(".hero__meta").innerText().catch(() => "");
  if (!stall) await page.screenshot({ path: `${out}perf-landing-${width}.png` }).catch(() => {});
  const img = await page.evaluate(() => { const e = performance.getEntriesByType("resource").filter((x) => /assets\/img\/vault/.test(x.name)); return e.map((x) => `${x.name.split("/").pop()} ${Math.round((x.encodedBodySize || x.transferSize) / 1024)} KB, done at ${Math.round(x.responseEnd)} ms`); });
  console.log(`${label.padEnd(34)} numbers visible after ${ms === null ? "NEVER (>40 s)" : ms + " ms"} -> ${shown ? shown.map((x) => x.replace(/\s+/g, " ")).join(" | ") : "-"}`);
  console.log(`   calls: ${api.map((a) => `${a.u} ${a.s} @${a.t}ms ${a.kb}KB ${a.src}`).join("; ") || "(none seen)"}`);
  console.log(`   hero image: ${img.join("; ") || "(not requested yet)"}${stall ? `\n   page text: ${note.replace(/\s+/g, " ").slice(0, 170)}` : ""}`);
  await page.close(); return ctx;
}
const first = await run("fresh visitor, desktop (cold cache)");
await run("same browser, 2nd visit (warm)", { reuse: first });
await first.close();
await run("fresh visitor, phone 390", { width: 390 });
await run("backend unreachable (fresh visitor)", { stall: true });
await b.close();
