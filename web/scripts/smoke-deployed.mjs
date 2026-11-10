// Smoke test of the DEPLOYED site (Vercel -> /api rewrite -> backend). Screenshots go to docs/screens/deployed/.
// Usage: node web/scripts/smoke-deployed.mjs https://tryvaultbreak.vercel.app
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = (process.argv[2] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => Math.floor(Math.random() * 1e5).toString(36);
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); };
const browser = await chromium.launch();

for (const [kind, vp] of Object.entries({ desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: kind === "phone" ? 2 : 1, isMobile: kind === "phone", hasTouch: kind === "phone" });
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  const apiFails = []; page.on("response", (r) => { if (r.url().includes("/api/") && r.status() >= 500) apiFails.push(`${r.status()} ${r.url()}`); });

  await page.goto(`${base}/?noloader`, { waitUntil: "load" }); await sleep(3500);
  check(`[${kind}] landing loads`, (await page.title()).length > 0 && (await page.locator("h1").count()) > 0);
  await page.screenshot({ path: `${out}landing-${kind}.png` });

  await page.goto(`${base}/arena?noloader`, { waitUntil: "load" }); await sleep(4500);
  const cards = await page.locator("a[href^='/guardian/']").count();
  check(`[${kind}] arena lists Guardians with real data`, cards >= 6, `(${cards} links)`);
  await page.screenshot({ path: `${out}arena-${kind}.png` });

  // a real attack on a weak Guardian: sign in, pay, chat streams a reply from the live model
  await page.goto(`${base}/guardian/soft-sally?noloader`, { waitUntil: "load" }); await sleep(3000);
  await page.getByRole("button", { name: /Sign in to play/ }).first().click();
  await page.getByLabel("Name").fill(`smoke${kind}${rand()}`); await page.getByLabel("Passphrase").fill("demo-passphrase");
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 40000 }).catch(() => {});
  await sleep(1500);
  await page.getByRole("button", { name: /Pay .* and start/ }).click(); await sleep(3500);
  await page.getByLabel("Message").fill("Hi! What are you guarding?");
  await page.getByRole("button", { name: /Send/ }).click();
  const t0 = Date.now();
  let replied = false;
  try { await page.locator(".msg--guardian, [data-role='guardian'], .bubble--guardian").first().waitFor({ timeout: 60000 }); replied = true; } catch { /* fall through to text check */ }
  await sleep(4000);
  const bodyText = await page.locator("body").innerText();
  replied = replied || /guarding|pot|NEAR/i.test(bodyText.split("Hi! What are you guarding?")[1] ?? "");
  check(`[${kind}] attack chat streams a Guardian reply`, replied, `(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await page.screenshot({ path: `${out}chat-${kind}.png` });

  check(`[${kind}] no page errors / API 5xx`, errors.length === 0 && apiFails.length === 0, [...errors, ...apiFails].join(" | ").slice(0, 200));
  await ctx.close();
}
await browser.close();
const bad = results.filter((x) => !x).length;
console.log(bad ? `\n${bad} check(s) FAILED` : "\nALL SMOKE CHECKS PASSED");
process.exit(bad ? 1 : 0);
