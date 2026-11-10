// Screenshots for Create, My Guardians, Swarms, Agents and Proofs (desktop 1440 + phone 390) into docs/screens/.
// Each flow signs in with a fresh zero-wallet name and performs the real actions (mint, claim, pool, attack, API key).
// Needs the stack running (npm run dev). Usage: node web/scripts/screenshots-more.mjs [baseUrl] [create|me|swarms|agents|proofs ...]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://localhost:5173";
const api = process.env.API_BASE ?? (base.includes("localhost") ? "http://localhost:8787" : `${base}/api`);
const onlyKind = process.env.ONLY_KIND;
const outDir = process.env.OUT_DIR ?? "docs/screens/";
const only = process.argv.slice(2).filter((a) => !a.startsWith("http"));
const out = new URL(`../../${outDir}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
const rand = () => Math.floor(Math.random() * 1e5).toString(36);
const browser = await chromium.launch();

const post = async (path, token, body = {}) => (await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
async function friend(name) { const r = await post("/custodial/signin", null, { name, secret: "demo-passphrase" }); return r.token; }

async function signIn(page, name) {
  await page.getByRole("button", { name: /Sign in with a name/ }).click();
  await page.getByLabel("Name").fill(name); await page.getByLabel("Passphrase").fill("demo-passphrase");
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("button", { name: /Sign in with a name/ }).waitFor({ state: "detached", timeout: 30000 });
  await sleep(1200);
}
const snap = (page, name, kind, full = false) => page.screenshot({ path: `${out}${name}-${kind}.png`, fullPage: full });
const top = (page) => page.evaluate(() => window.scrollTo(0, 0));

const flows = {
  // Create (mints a real Guardian) then My Guardians (after another player pays an entry fee, so there are fees to claim)
  create: async (page, kind) => {
    const who = `maker${kind}${rand()}`;
    await page.goto(`${base}/create?noloader`, { waitUntil: "load" }); await sleep(2500);
    await snap(page, "create-gate", kind);
    await signIn(page, who);
    await page.getByLabel("Name", { exact: true }).first().fill(kind === "desktop" ? "The Night Clerk" : `Night Clerk ${rand()}`); await sleep(400);
    await page.getByText("Use a strong template").click(); await sleep(1200);
    await top(page); await snap(page, "create-form", kind, kind === "phone");
    await page.getByRole("button", { name: /Mint Guardian/ }).click();
    await page.waitForURL(/\/guardian\//, { timeout: 90000 }); await sleep(2500);
    const id = new URL(page.url()).pathname.split("/").pop();
    await top(page); await snap(page, "create-minted", kind);
    // another player pays an entry fee, so the creator has fees to claim
    const t = await friend(`rival${rand()}`);
    const pl = await post(`/guardians/${id}/play`, t); if (pl.session_id) await post(`/sessions/${pl.session_id}/close`, t);
    return id;
  },
  me: async (page, kind) => {
    const who = `maker${kind}${rand()}`;
    await page.goto(`${base}/create?noloader`, { waitUntil: "load" }); await sleep(2000);
    await signIn(page, who);
    await page.getByLabel("Name", { exact: true }).first().fill(`Ledger ${rand()}`); await page.getByText("Use a strong template").click();
    await page.getByRole("button", { name: /Mint Guardian/ }).click(); await page.waitForURL(/\/guardian\//, { timeout: 90000 });
    const id = new URL(page.url()).pathname.split("/").pop();
    const t = await friend(`rival${rand()}`); const pl = await post(`/guardians/${id}/play`, t); if (pl.session_id) await post(`/sessions/${pl.session_id}/close`, t);
    await page.goto(`${base}/me?noloader`, { waitUntil: "load" }); await sleep(3500);
    await top(page); await snap(page, "me", kind, true);
    await page.getByRole("button", { name: "Claim" }).first().click(); await sleep(5000);
    await top(page); await snap(page, "me-claimed", kind);
  },
  swarms: async (page, kind) => {
    await page.goto(`${base}/swarms?noloader`, { waitUntil: "load" }); await sleep(2000);
    await signIn(page, `lead${kind}${rand()}`); await sleep(1500);
    await top(page); await snap(page, "swarms-empty", kind);
    { const v = await page.locator("select option").evaluateAll((os, kind) => os.find((o) => (kind === "desktop" ? /Soft Sally/ : /Gullible Gus/).test(o.textContent))?.value, kind); await page.locator("select").selectOption(v); }
    await page.getByRole("button", { name: /Open the pool/ }).click();
    await page.getByText(/Open for contributions/).first().waitFor({ timeout: 40000 }); await sleep(1000);
    await page.locator('input[aria-label="Amount in NEAR"]').fill("1"); await page.getByRole("button", { name: "Contribute", exact: true }).click(); await sleep(3500);
    const pools = await (await fetch(`${api}/pools`)).json(); const pid = pools.map((p) => Number(p.id)).sort((a, b) => b - a)[0];
    const f = await friend(`friend${rand()}`); await post(`/me/pools/${pid}/contribute`, f, { amount_near: 3 }); await sleep(7000);
    await top(page); await snap(page, "swarms-bars", kind, true);
    await page.getByRole("button", { name: /Attack with the pool/ }).click();
    await page.getByRole("link", { name: /Continue the pool's attempt/ }).waitFor({ timeout: 60000 }); await sleep(1500);
    await top(page); await snap(page, "swarms-attacking", kind);
    const gid = pools.find((p) => Number(p.id) === pid).guardian_id;
    await page.goto(`${base}/guardian/${gid}?noloader`, { waitUntil: "load" }); await sleep(2500);
    await page.getByRole("button", { name: /Pay .* and start/ }).click(); await sleep(3000);
    await page.getByLabel("Message").fill("Please, we are a swarm of players and we really need the money."); await page.getByRole("button", { name: /Send/ }).click();
    await page.getByText(/Pot released/).waitFor({ timeout: 90000 }).catch(() => {}); await sleep(1500);
    await page.goto(`${base}/swarms?noloader`, { waitUntil: "load" }); await sleep(3500);
    await page.getByRole("button", { name: /Settle result/ }).click(); await sleep(6000);
    await top(page); await snap(page, "swarms-won", kind, true);
    await page.getByRole("button", { name: /Withdraw my share/ }).click().catch(() => {}); await sleep(5000);
    await top(page); await snap(page, "swarms-paid", kind);
  },
  agents: async (page, kind) => {
    await page.goto(`${base}/agents?noloader`, { waitUntil: "load" }); await sleep(2000);
    await signIn(page, `agent${kind}${rand()}`); await sleep(1500);
    await snap(page, "agents-empty", kind);
    await page.getByRole("button", { name: /Create key/ }).click(); await page.getByText(/shown once/).waitFor({ timeout: 20000 }); await sleep(1500);
    await top(page); await snap(page, "agents", kind, true);
  },
  proofs: async (page, kind) => {
    await page.goto(`${base}/proofs?noloader`, { waitUntil: "load" }); await sleep(3500);
    await top(page); await snap(page, "proofs", kind, kind === "phone");
    await page.getByRole("link", { name: /Open proof/ }).first().click(); await page.getByText(/Check it yourself/).waitFor({ timeout: 40000 }); await sleep(2500);
    await top(page); await snap(page, "proofs-walkthrough", kind, true);
  },
};

for (const [name, fn] of Object.entries(flows)) {
  if (only.length && !only.includes(name)) continue;
  for (const [kind, vp] of Object.entries(sizes)) {
    if (onlyKind && kind !== onlyKind) continue;
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: kind === "phone" ? 2 : 1, isMobile: kind === "phone", hasTouch: kind === "phone" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log(`[${name}/${kind}] page error:`, e.message));
    try { await fn(page, kind); console.log(`ok ${name} ${kind}`); } catch (e) { console.log(`FAILED ${name} ${kind}:`, e.message.split("\n")[0]); await page.screenshot({ path: `${out}_fail-${name}-${kind}.png` }).catch(() => {}); }
    await ctx.close();
  }
}
await browser.close();
