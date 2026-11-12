// Live end-to-end test of: passphrase toggle, human NFT transfer, agent-key transfers (permission, allowlist, approval), metadata snapshot.
// Usage: node --env-file=.env web/scripts/live-transfer-e2e.mjs https://tryvaultbreak.vercel.app
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = (process.argv[2] ?? "https://tryvaultbreak.vercel.app").replace(/\/+$/, "");
const out = new URL("../../docs/screens/deployed/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"); mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = () => Math.floor(Math.random() * 1e6).toString(36);
const results = []; const check = (name, ok, note = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const browser = await chromium.launch();
const api = async (path, { token, key, method = "POST", body } = {}) => {
  const r = await fetch(`${base}/api${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(key ? { "x-api-key": key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ } return { status: r.status, body: j ?? t.slice(0, 120) };
};
const login = async (name) => { const r = await api("/custodial/signin", { body: { name, secret: "demo-passphrase" } }); if (!r.body?.token) throw new Error(`signin ${name}: ${JSON.stringify(r.body)}`); return { token: r.body.token, account: r.body.account_id }; };
let lastPage = null;
const newPage = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); lastPage = page; return { ctx, page }; };
const go = async (page, path) => { await page.goto(`${base}${path}?noloader`, { waitUntil: "load" }); await sleep(3500); };
async function uiSignIn(page, name) {
  await page.getByRole("button", { name: /Sign in/ }).first().click(); await sleep(700);
  await page.getByLabel("Name").fill(name); await page.getByLabel("Passphrase", { exact: true }).fill("demo-passphrase");
  await page.getByRole("button", { name: /Continue/ }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: 60000 }); await sleep(2000);
}

try {
  // ---- 1. passphrase toggle (no account needed)
  {
    const { ctx, page } = await newPage(); await go(page, "/");
    await page.getByRole("button", { name: /Sign in/ }).first().click(); await sleep(700);
    const input = page.getByLabel("Passphrase", { exact: true });
    const toggle = page.getByRole("button", { name: "Show passphrase" });
    const hiddenByDefault = (await input.getAttribute("type")) === "password" && (await toggle.getAttribute("aria-pressed")) === "false";
    await input.fill("my-secret-pass"); await toggle.click();
    const shown = (await input.getAttribute("type")) === "text" && (await input.inputValue()) === "my-secret-pass" && (await page.getByRole("button", { name: "Hide passphrase" }).getAttribute("aria-pressed")) === "true";
    await page.screenshot({ path: `${out}xfer-1-passphrase-shown.png` });
    await page.getByRole("button", { name: "Hide passphrase" }).focus(); await page.keyboard.press("Enter");
    const keyboard = (await input.getAttribute("type")) === "password";
    await page.keyboard.press("Escape"); await page.getByRole("button", { name: /Sign in/ }).first().click();
    const resetHidden = (await page.getByLabel("Passphrase", { exact: true }).getAttribute("type")) === "password";
    check("1 passphrase toggle: hidden by default, eye shows it, keyboard (Enter) hides it, hidden again on reopen", hiddenByDefault && shown && keyboard && resetHidden, `default=${hiddenByDefault} shown=${shown} keyboard=${keyboard} reset=${resetHidden}`);
    await ctx.close();
  }

  // ---- 2. human transfer
  const aliceName = `alice${rid()}`, bobName = `bob${rid()}`, carolName = `carol${rid()}`;
  const alice = await newPage(); const gname = `Xfer Keep ${rid()}`;
  await go(alice.page, "/create"); await uiSignIn(alice.page, aliceName);
  await alice.page.getByLabel("Name", { exact: true }).first().fill(gname);
  await alice.page.getByText("Use a strong template").click();
  await alice.page.getByLabel("Starting pot (NEAR)").fill("0.5"); await sleep(1500);
  const topup = alice.page.getByRole("button", { name: /Add play credits/ }).first(); if (await topup.count()) { await topup.click(); await sleep(9000); }
  await alice.page.getByRole("button", { name: /Mint Guardian/ }).click();
  await alice.page.waitForURL(/\/guardian\//, { timeout: 120000 });
  const gid = new URL(alice.page.url()).pathname.split("/").pop();
  const aliceTok = (await login(aliceName)).token; const bob = await login(bobName); const carol = await login(carolName);
  const meta0 = (await (await fetch(`${base}/api/guardians/${gid}/metadata.json`)).json());
  console.log(`info  minted ${gid}; owner ${meta0.extra?.owner}`);

  // a player has an open attempt: transfer must be refused with a clear reason
  const play = await api(`/guardians/${gid}/play`, { token: carol.token });
  await go(alice.page, "/me"); await sleep(2500);
  await alice.page.getByRole("button", { name: "Transfer" }).first().click();
  await alice.page.getByLabel("Recipient").fill(bobName); await alice.page.getByRole("button", { name: /Continue/ }).click();
  await alice.page.getByText(/Confirm transfer/).waitFor({ timeout: 20000 });
  const confirmText = await alice.page.locator(".modal__card").innerText();
  await alice.page.screenshot({ path: `${out}xfer-2-confirm.png` });
  await alice.page.getByRole("button", { name: /^Transfer/ }).last().click();
  await alice.page.getByText(/open attempt/i).waitFor({ timeout: 60000 }).catch(() => {});
  const blockedMsg = /open attempt/i.test(await alice.page.locator(".modal__card").innerText());
  await alice.page.screenshot({ path: `${out}xfer-2-blocked-open-session.png` });
  check("2a transfer blocked while a session is open, with a clear message", !!play.body?.session_id && blockedMsg && confirmText.includes(gname) && confirmText.toLowerCase().includes(bobName.toLowerCase()), `confirm dialog names Guardian+recipient: ${confirmText.includes(gname) && confirmText.toLowerCase().includes(bobName.toLowerCase())}`);
  await api(`/sessions/${play.body.session_id}/close`, { token: carol.token }); await sleep(4000);

  // retry: now it goes through; explorer link shown
  await alice.page.getByRole("button", { name: /^Back$/ }).click().catch(() => {});
  await alice.page.getByRole("button", { name: /^Transfer/ }).last().click();
  await alice.page.getByText(/Transferred\./).waitFor({ timeout: 90000 }).catch(() => {});
  const doneText = await alice.page.locator(".modal__card").innerText();
  const txHref = await alice.page.locator(".modal__card a.txlink[href*='testnet.nearblocks.io/txns']").first().getAttribute("href").catch(() => null);
  await alice.page.screenshot({ path: `${out}xfer-2-done.png` });
  check("2b transfer succeeds and shows a testnet explorer link", /Transferred\./.test(doneText) && !!txHref, txHref ?? "");

  // recipient sees it; fees follow the new owner
  const bobUi = await newPage(); await go(bobUi.page, "/me"); await uiSignIn(bobUi.page, bobName); await go(bobUi.page, "/me"); await sleep(3000);
  const bobSees = (await bobUi.page.getByText(gname.toUpperCase()).count()) + (await bobUi.page.getByText(gname).count()) > 0;
  const bobFees = await bobUi.page.locator(".owned__bar strong").first().innerText().catch(() => "");
  await bobUi.page.screenshot({ path: `${out}xfer-2-recipient-my-guardians.png`, fullPage: true });
  const claimBtn = bobUi.page.getByRole("button", { name: "Claim" }).first();
  let claimed = false; if (await claimBtn.isEnabled().catch(() => false)) { await claimBtn.click(); claimed = await bobUi.page.getByText(/Claimed/).first().waitFor({ timeout: 40000 }).then(() => true).catch(() => false); }
  const aliceOld = await api("/me/guardians", { token: aliceTok, method: "GET" });
  check("2c recipient sees the Guardian in My Guardians; creator fees follow (Bob claims, Alice no longer owns it)", bobSees && claimed && !(aliceOld.body ?? []).some((g) => g.id === gid), `bobSees=${bobSees} fees=${bobFees} claimed=${claimed}`);

  // metadata (live and the Blob snapshot the site falls back to) shows the new owner
  await sleep(8000);
  const live = await (await fetch(`${base}/api/guardians/${gid}/metadata.json`, { cache: "no-store" })).json();
  const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(process.env.BLOB_READ_WRITE_TOKEN ?? "");
  const snap = m ? await (await fetch(`https://${m[1].toLowerCase()}.public.blob.vercel-storage.com/snapshots/${gid}.json?t=${Date.now()}`)).json().catch(() => null) : null;
  check("2d metadata shows the new owner (live and in the saved snapshot)", live.extra?.owner === bob.account && snap?.extra?.owner === bob.account, `live=${live.extra?.owner} snapshot=${snap?.extra?.owner} bob=${bob.account}`);

  // ---- 3. agent transfers (Bob owns it now; allowlist = Alice only)
  const agents = await newPage(); await go(agents.page, "/agents"); await uiSignIn(agents.page, bobName);
  const perm = agents.page.getByLabel(/Allow this key to transfer/);
  const defaultOff = !(await perm.isChecked());
  await perm.check();
  await agents.page.getByLabel(/Recipient allowlist/).fill(aliceName);
  await agents.page.getByRole("button", { name: /Create key/ }).click();
  await agents.page.getByText(/shown once/).waitFor({ timeout: 30000 });
  const gatedKey = (await agents.page.locator(".keybox code").first().innerText()).trim();
  await sleep(1500); await agents.page.screenshot({ path: `${out}xfer-3-agent-key.png`, fullPage: true });
  const plain = await api("/agent/keys", { token: bob.token, body: { budget_near: 1, label: "plain" } });
  const r1 = await api(`/guardians/${gid}/transfer`, { key: plain.body.api_key, body: { to: aliceName } });
  const r2 = await api(`/guardians/${gid}/transfer`, { key: gatedKey, body: { to: carolName } });
  const r3 = await api(`/guardians/${gid}/transfer`, { key: gatedKey, body: { to: aliceName } });
  check("3a key without the permission is refused; permission is off by default", defaultOff && r1.status === 403 && /transfer_nft/.test(JSON.stringify(r1.body)), `HTTP ${r1.status}`);
  check("3b recipient not on the allowlist is refused", r2.status === 403 && /allowlist/.test(JSON.stringify(r2.body)), `HTTP ${r2.status}`);
  check("3c allowed recipient with approval required becomes Pending (nothing moves yet)", r3.status === 202 && r3.body?.status === "pending", `HTTP ${r3.status}`);
  const stillBob = (await (await fetch(`${base}/api/guardians/${gid}/metadata.json`, { cache: "no-store" })).json()).extra?.owner === bob.account;
  const bobUi2 = await newPage(); await go(bobUi2.page, "/me"); await uiSignIn(bobUi2.page, bobName); await go(bobUi2.page, "/me"); await sleep(3500);
  const pendingVisible = await bobUi2.page.getByText(/awaiting your approval/).count();
  await bobUi2.page.screenshot({ path: `${out}xfer-3-pending-approval.png`, fullPage: true });
  await bobUi2.page.getByRole("button", { name: "Approve" }).first().click();
  await sleep(15000);
  const back = (await (await fetch(`${base}/api/guardians/${gid}/metadata.json`, { cache: "no-store" })).json()).extra?.owner;
  const aliceAcct = (await login(aliceName)).account;
  await bobUi2.page.screenshot({ path: `${out}xfer-3-after-approval.png`, fullPage: true });
  check("3d owner approves in My Guardians and the transfer runs", stillBob && pendingVisible > 0 && back === aliceAcct, `pending shown=${pendingVisible > 0}, owner after approval=${back}`);
} catch (e) { results.push(false); console.log("FAIL  scenario error:", String(e.message).split("\n")[0]); await lastPage?.screenshot({ path: `${out}xfer-FAIL.png`, fullPage: true }).catch(() => {}); }
await browser.close();
process.exit(results.every(Boolean) ? 0 : 1);
