// Live test of the transfer guard UI: a live attempt shows "Available in M:SS" and a disabled Transfer button; when the attempt ends the
// button re-enables by itself (no reload); with no active attempt there is no warning. Usage: node web/scripts/live-guard-e2e.mjs <url>
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const base = (process.argv[2] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.floor(Math.random() * 1e6).toString(36);
let bad = 0; const check = (n, ok, x = "") => { if (!ok) bad++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${x ? "  " + x : ""}`); };
const api = async (path, { token, body, method = "POST" } = {}) => { const r = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 100) }; } };
const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
const aliceName = `guardA${rid()}`, carolName = `guardC${rid()}`;
try {
  await page.goto(`${base}/create?noloader`, { waitUntil: "load" }); await sleep(3500);
  await page.getByRole("button", { name: /Sign in/ }).first().click(); await sleep(700);
  await page.getByLabel("Name").fill(aliceName); await page.getByLabel("Passphrase", { exact: true }).fill("demo-passphrase");
  await page.getByRole("button", { name: /Continue/ }).click(); await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60000 }); await sleep(2000);
  await page.getByLabel("Name", { exact: true }).first().fill(`Guard Test ${rid()}`);
  await page.getByText("Use a strong template").click(); await page.getByLabel("Starting pot (NEAR)").fill("0.5"); await sleep(1500);
  await page.getByRole("button", { name: /Mint Guardian/ }).click();
  if (await page.getByText(/Not enough credits/).waitFor({ timeout: 8000 }).then(() => true).catch(() => false)) { await page.getByRole("button", { name: /Add play credits/ }).first().click(); await sleep(10000); await page.getByRole("button", { name: /Mint Guardian/ }).click(); }
  await page.waitForURL(/\/guardian\//, { timeout: 120000 });
  const gid = new URL(page.url()).pathname.split("/").pop();
  const carol = (await api("/custodial/signin", { body: { name: carolName, secret: "demo-passphrase" } })).body;

  // no active attempt: no warning
  await page.goto(`${base}/me?noloader`, { waitUntil: "load" }); await sleep(3500);
  await page.getByRole("button", { name: "Transfer" }).first().click(); await page.getByLabel("Recipient").fill(carolName); await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByText(/Confirm transfer/).waitFor({ timeout: 20000 });
  const noWarn = (await page.getByText(/Available in/).count()) === 0 && await page.locator(".modal__card").getByRole("button", { name: /^Transfer/ }).isEnabled();
  await page.screenshot({ path: `${out}guard-1-no-active-session.png` });
  check("no active session: no warning, Transfer enabled", noWarn);
  await page.keyboard.press("Escape");

  // a live attempt: countdown shown, button disabled
  const play = await api(`/guardians/${gid}/play`, { token: carol.token });
  await page.getByRole("button", { name: "Transfer" }).first().click(); await page.getByLabel("Recipient").fill(carolName); await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByText(/Confirm transfer/).waitFor({ timeout: 20000 });
  const countdown = page.getByText(/Available in \d+:\d\d/); await countdown.first().waitFor({ timeout: 20000 }).catch(() => {});
  const text1 = await countdown.first().innerText().catch(() => ""); await sleep(3000); const text2 = await countdown.first().innerText().catch(() => "");
  const disabled = await page.locator(".modal__card").getByRole("button", { name: /^Transfer/ }).isDisabled();
  await page.screenshot({ path: `${out}guard-2-countdown.png` });
  const m = (t) => { const x = /(\d+):(\d\d)/.exec(t); return x ? Number(x[1]) * 60 + Number(x[2]) : null; };
  check("live attempt: shows the expiry countdown (counting down) and disables Transfer", !!play.body?.session_id && disabled && m(text1) !== null && m(text2) !== null && m(text2) < m(text1) && m(text1) <= 600, `"${text1.slice(-30).trim()}" -> "${text2.slice(-30).trim()}"`);

  // the attempt ends: the dialog unlocks by itself
  await api(`/sessions/${play.body.session_id}/close`, { token: carol.token });
  await page.getByText(/Available in/).waitFor({ state: "detached", timeout: 40000 }).catch(() => {});
  const unlocked = (await page.getByText(/Available in/).count()) === 0 && await page.locator(".modal__card").getByRole("button", { name: /^Transfer/ }).isEnabled();
  await page.screenshot({ path: `${out}guard-3-auto-unlocked.png` });
  check("attempt ends: warning disappears and Transfer re-enables by itself (no reload)", unlocked);
  await page.locator(".modal__card").getByRole("button", { name: /^Transfer/ }).click();
  const done = await page.getByText(/Transferred\./).waitFor({ timeout: 90000 }).then(() => true).catch(() => false);
  check("transfer succeeds after the attempt closed", done);
} catch (e) { bad++; console.log("FAIL  error:", String(e.message).split("\n")[0]); await page.screenshot({ path: `${out}guard-FAIL.png`, fullPage: true }).catch(() => {}); }
await b.close(); process.exit(bad ? 1 : 0);
