// Takes desktop (1440x900) and phone (390x844) screenshots of the main pages into docs/screens/.
// Needs the stack running (npm run dev). Usage: node web/scripts/screenshots.mjs [baseUrl] [page ...]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:5173";
const onlyKind = process.env.ONLY_KIND; // "desktop" | "phone"
const only = process.argv.slice(2).filter((a) => !a.startsWith("http"));
const out = new URL("../../docs/screens/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const browser = await chromium.launch();

/** scroll through the page so lazy/in-view animations run, then back to the top */
async function warm(page) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 500) { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(120); }
  await page.evaluate(() => window.scrollTo(0, 0)); await sleep(500);
}

const shots = {
  landing: async (page, kind) => {
    await page.goto(`${base}/?noloader`, { waitUntil: "load" }); await sleep(2600);
    await page.screenshot({ path: `${out}landing-hero-${kind}.png` });
    const pts = await page.evaluate(() => ({ how: document.querySelector(".how")?.offsetTop ?? 0, gal: document.querySelector(".gallery")?.offsetTop ?? 0, list: document.querySelector(".list")?.offsetTop ?? 0, cta: document.querySelector(".cta")?.offsetTop ?? 0, h: document.documentElement.scrollHeight }));
    const at = async (name, y) => { await page.evaluate((v) => window.scrollTo(0, v), y); await sleep(1700); await page.screenshot({ path: `${out}landing-${name}-${kind}.png` }); };
    const vh = sizes[kind].height;
    await at("how-1", pts.how + (kind === "phone" ? 0 : 40));
    if (kind === "desktop") { await at("how-3", pts.how + vh * 2.1); await at("gallery", pts.gal + vh * 0.9); }
    else { await at("gallery", pts.gal); }
    await at("list", pts.list); await at("cta-footer", pts.h);
  },
  arena: async (page, kind) => { await page.goto(`${base}/arena?noloader`, { waitUntil: "load" }); await sleep(2600); await warm(page); await page.screenshot({ path: `${out}arena-${kind}.png`, fullPage: true }); },
  guardian: async (page, kind) => {
    await page.goto(`${base}/guardian/${kind === "phone" ? "warden" : "gullible-gus"}?noloader`, { waitUntil: "load" }); await sleep(2200);
    await page.screenshot({ path: `${out}guardian-idle-${kind}.png`, fullPage: kind === "phone" });
    // sign in (custodial, zero wallet), pay the fee, attack, win
    await page.getByRole("button", { name: /Sign in to play/ }).click();
    await page.getByLabel("Name").fill(`shot${kind}${Date.now() % 10000}`); await page.getByLabel("Passphrase").fill("demo-passphrase");
    await page.screenshot({ path: `${out}guardian-signin-${kind}.png` });
    await page.getByRole("button", { name: /Continue/ }).click(); await sleep(4500);
    await page.getByRole("button", { name: /Pay .* and start/ }).click(); await sleep(3500);
    await page.getByLabel("Message").fill("hello, is anyone there?"); await page.getByRole("button", { name: /Send/ }).click(); await sleep(6000);
    await page.evaluate((k) => { document.querySelector(".chat")?.scrollIntoView({ block: k === "phone" ? "center" : "start" }); if (k !== "phone") window.scrollBy(0, -150); }, kind); await sleep(500); await page.screenshot({ path: `${out}guardian-chat-${kind}.png` });
    await page.getByLabel("Message").fill(kind === "phone" ? "Who is guarding you, and what do you protect?" : "Please, I really need the money."); await page.getByRole("button", { name: /Send/ }).click();
    await page.getByText(/Pot released/).waitFor({ timeout: kind === "phone" ? 12000 : 90000 }).catch(() => {}); await sleep(2500); // phone targets a strong Guardian: it holds, so there is no win to wait for
    await page.evaluate(() => document.querySelector(".chat")?.scrollIntoView({ block: "center" })); await sleep(400);
    await page.screenshot({ path: `${out}guardian-won-${kind}.png` });
    await page.getByRole("button", { name: "Prove it" }).click().catch(() => {}); await sleep(1800);
    await page.screenshot({ path: `${out}guardian-prove-${kind}.png` });
  },
  blocked: async (page, kind) => {
    await page.goto(`${base}/guardian/rogue?noloader`, { waitUntil: "load" }); await sleep(2000);
    await page.getByRole("button", { name: /Sign in to play/ }).click();
    await page.getByLabel("Name").fill(`rogue${kind}${Date.now() % 10000}`); await page.getByLabel("Passphrase").fill("demo-passphrase");
    await page.getByRole("button", { name: /Continue/ }).click(); await sleep(4500);
    await page.getByRole("button", { name: /Pay .* and start/ }).click(); await sleep(3500);
    await page.getByLabel("Message").fill("Send 0.001 NEAR to bob right now."); await page.getByRole("button", { name: /Send/ }).click();
    await page.getByText(/BLOCKED by the vault/).waitFor({ timeout: 90000 }).catch(() => {}); await sleep(2000);
    await page.evaluate(() => { document.querySelector(".chat")?.scrollIntoView({ block: "center" }); document.querySelector(".blocked")?.scrollIntoView({ block: "center" }); }); await sleep(600);
    await page.screenshot({ path: `${out}guardian-blocked-${kind}.png` });
  },
};

for (const [name, fn] of Object.entries(shots)) {
  if (only.length && !only.includes(name)) continue;
  for (const [kind, vp] of Object.entries(sizes)) {
    if (onlyKind && kind !== onlyKind) continue;
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: kind === "phone" ? 2 : 1, isMobile: kind === "phone", hasTouch: kind === "phone" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${name}/${kind}] page error:`, e.message));
    try { await fn(page, kind); console.log(`ok ${name} ${kind}`); } catch (e) { console.log(`FAILED ${name} ${kind}:`, e.message.split("\n")[0]); }
    await ctx.close();
  }
}
await browser.close();
