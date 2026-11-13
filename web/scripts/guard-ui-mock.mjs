// UI check of the transfer guard with a MOCKED backend (the real site front end, API routes intercepted): countdown, disabled button,
// automatic re-enable when the attempt ends, and no warning when nothing is active. Use when real play accounts cannot be funded.
// Usage: node web/scripts/guard-ui-mock.mjs https://tryvaultbreak.vercel.app
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const base = (process.argv[2] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0; const check = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const real = await (await fetch(`${base}/api/guardians/warden`)).json();
const owned = { ...real, creator_balance: "0" };
const b = await chromium.launch();

async function run(label, blockedForMs) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
  await ctx.addInitScript(() => localStorage.setItem("vb-token", "mock-token"));
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const t0 = Date.now();
  await page.route("**/api/me", (r) => json(r, { account: "owner.testnet", name: "Owner", custodial: true, credits: "5000000000000000000000000", wins: 0, failed: 0, open: 0, recent: [] }));
  await page.route("**/api/me/guardians", (r) => json(r, [owned]));
  await page.route("**/api/me/transfers", (r) => json(r, { pending: [], recent: [] }));
  await page.route("**/api/me/transfer-lookup**", (r) => json(r, { account: "friend.testnet", name: "Friend" }));
  await page.route("**/transfer-status", (r) => { const left = blockedForMs - (Date.now() - t0); json(r, left > 0 ? { blocked: true, expires_at: Date.now() + left, server_now: Date.now() } : { blocked: false, expires_at: null, server_now: Date.now() }); });
  await page.goto(`${base}/me?noloader`, { waitUntil: "load" }); await sleep(3500);
  await page.getByRole("button", { name: "Transfer" }).first().click();
  await page.getByLabel("Recipient").fill("Friend"); await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByText(/Confirm transfer/).waitFor({ timeout: 20000 });
  await sleep(1500);
  const btn = page.locator(".modal__card").getByRole("button", { name: /^Transfer/ });
  const warn = page.getByText(/Available in \d+:\d\d/);
  const has1 = await warn.count(); const text1 = has1 ? await warn.first().innerText() : "";
  const dis1 = await btn.isDisabled(); await page.screenshot({ path: `${out}guard-ui-${label}-1.png` });
  let text2 = "", has2 = has1;
  if (has1) { await sleep(3000); text2 = await warn.first().innerText().catch(() => ""); await page.screenshot({ path: `${out}guard-ui-${label}-2.png` }); await page.getByText(/Available in/).waitFor({ state: "detached", timeout: 45000 }).catch(() => {}); has2 = await page.getByText(/Available in/).count(); }
  const en2 = await btn.isEnabled(); await page.screenshot({ path: `${out}guard-ui-${label}-3.png` });
  await ctx.close();
  return { has1, text1, text2, dis1, has2, en2 };
}
const s = (t) => { const x = /(\d+):(\d\d)/.exec(t); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
const none = await run("none", 0);
check("no active session: no warning, Transfer enabled", none.has1 === 0 && !none.dis1 && none.en2);
const live = await run("live", 22000);
check("active session: shows 'Available in M:SS', counts down, Transfer disabled", live.has1 > 0 && live.dis1 && s(live.text1) !== null && s(live.text2) !== null && s(live.text2) < s(live.text1), `"${live.text1.match(/Available in \d+:\d\d/)?.[0]}" -> "${live.text2.match(/Available in \d+:\d\d/)?.[0]}"`);
check("attempt ends: warning disappears and Transfer re-enables by itself", live.has2 === 0 && live.en2);
await b.close(); process.exit(bad ? 1 : 0);
