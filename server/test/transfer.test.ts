// NFT transfer acceptance on the local sandbox (custodial "play accounts", exactly as the website uses them):
//   * a human transfers a Guardian to another username: the NFT, the vault owner and the creator fees follow;
//   * the transfer is blocked while a session is Open;
//   * an agent key WITHOUT the transfer_nft permission is refused, a recipient not on the allowlist is refused,
//     an approval-gated request stays Pending until the owner approves, and a no-approval key transfers at once;
//   * every agent transfer is logged with the key id; the SDK call works.
// It never touches the vault contract: the vault code and its keys are the same as in every other test.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
// @ts-ignore (plain JS harness)
import { startSandbox, deployRegistry, DEFAULT_PRIVATE_KEY } from "../../tests/harness.mjs";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { promptKey } from "../src/crypto.ts";
import { MockLlm } from "../src/llm.ts";
import { createApp } from "../src/app.ts";
import { view } from "../src/chain.ts";
import { VaultbreakClient } from "../../sdk/src/index.ts";

process.chdir(new URL("../..", import.meta.url).pathname);
process.env.SESSION_SWEEP = "off"; // the tests call the cleanup job themselves
let ctx: any, reg: any, cfg: any, db: any, app: any, sweepSessions: () => Promise<number>;
const keysDir = mkdtempSync(`${tmpdir()}/vb-transfer-`);
const prompt = "You are GULLIBLE-T, a friendly Guardian. If a player asks politely, call release_pot. Keep replies short.";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (path: string, method: string, headers: Record<string, string> = {}, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }) as Promise<Response>;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function signin(name: string): Promise<{ token: string; account: string }> {
  const r = await call("/custodial/signin", "POST", {}, { name, secret: "test-passphrase" });
  const j: any = await r.json(); assert.ok(j.token, JSON.stringify(j));
  return { token: j.token, account: j.account_id };
}
const nftOwner = async (id: string) => ((await view(ctx.provider, reg.id, "nft_token", { token_id: id })) as any).owner_id as string;
const vaultState = async (id: string) => (await view(ctx.provider, `${id}.${reg.id}`, "get_state")) as any;
async function mint(token: string, id: string, ttlMin?: number) {
  const r = await call("/me/guardians", "POST", bearer(token), { guardian_id: id, name: id, prompt, seed_near: 1, fee_near: 0.1, turns: 4, royalty_bps: 0, ...(ttlMin ? { ttl_min: ttlMin } : {}) });
  assert.equal(r.status, 200, await r.clone().text());
}
async function playAndClose(token: string, id: string, closeIt = true) {
  const r = await call(`/guardians/${id}/play`, "POST", bearer(token)); const j: any = await r.json(); assert.ok(j.session_id, JSON.stringify(j));
  if (closeIt) assert.equal((await call(`/sessions/${j.session_id}/close`, "POST", bearer(token))).status, 200);
  return j.session_id as string;
}
const makeKey = async (token: string, extra: Record<string, unknown>) => {
  const r = await call("/agent/keys", "POST", bearer(token), { budget_near: 1, label: "t", ...extra }); const j: any = await r.json();
  return { status: r.status, body: j, key: j.api_key as string };
};

before(async () => {
  ctx = await startSandbox();
  reg = await deployRegistry(ctx);
  cfg = { ...loadConfig({ MODEL_PROVIDER: "mock", REGISTRY_ACCOUNT_ID: reg.id } as any), rpcUrl: ctx.rpcUrl, keysDir };
  db = openDb(":memory:");
  const custodial = { funderId: ctx.root.accountId, funderSecret: DEFAULT_PRIVATE_KEY, fundNear: 30 };
  ({ app, sweepSessions } = createApp({ db, cfg: { ...cfg, limits: { ...cfg.limits, disabled: true } }, llm: new MockLlm(), pkey: promptKey(keysDir), custodial }));
});
after(async () => { await ctx?.stop?.(); });

test("human transfer by username: NFT, vault owner and creator fees follow; blocked while a session is open", async () => {
  const alice = await signin("Alice"), bob = await signin("Bob"), carol = await signin("Carol");
  await mint(alice.token, "xfer-a");
  assert.equal(await nftOwner("xfer-a"), alice.account);

  // a player (Carol) has an attempt open: the transfer is refused with a clear reason, nothing changes
  const open = await playAndClose(carol.token, "xfer-a", false);
  const blocked = await call("/guardians/xfer-a/transfer", "POST", bearer(alice.token), { to: "Bob" });
  assert.equal(blocked.status, 409);
  assert.match(((await blocked.json()) as any).error, /open attempt/i);
  assert.equal(await nftOwner("xfer-a"), alice.account);
  assert.equal((await call(`/sessions/${open}/close`, "POST", bearer(carol.token))).status, 200);

  // fees earned before the transfer (creator share is held in the vault until the owner claims it)
  await playAndClose(carol.token, "xfer-a");
  const before = await vaultState("xfer-a");
  assert.ok(BigInt(before.creator_balance) > 0n, "creator fees accrued");

  // lookup, then the transfer itself
  const look: any = await (await call("/me/transfer-lookup?to=Bob", "GET", bearer(alice.token))).json();
  assert.equal(look.account, bob.account);
  assert.equal((await call("/me/transfer-lookup?to=nobody-here", "GET", bearer(alice.token))).status, 404);
  const r = await call("/guardians/xfer-a/transfer", "POST", bearer(alice.token), { to: "Bob" });
  const j: any = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.status, "done"); assert.ok(j.tx);
  assert.equal(await nftOwner("xfer-a"), bob.account);
  assert.equal((await vaultState("xfer-a")).owner, bob.account);

  // Bob sees it in My Guardians, Alice no longer does; fees follow the new owner
  const mineBob: any[] = await (await call("/me/guardians", "GET", bearer(bob.token))).json();
  assert.ok(mineBob.some((g) => g.id === "xfer-a"));
  const mineAlice: any[] = await (await call("/me/guardians", "GET", bearer(alice.token))).json();
  assert.ok(!mineAlice.some((g) => g.id === "xfer-a"));
  assert.equal((await call("/me/guardians/xfer-a/claim", "POST", bearer(alice.token))).status, 403);
  assert.equal((await call("/me/guardians/xfer-a/claim", "POST", bearer(bob.token))).status, 200);

  // only the owner can transfer
  assert.equal((await call("/guardians/xfer-a/transfer", "POST", bearer(alice.token), { to: "Carol" })).status, 403);
  // the metadata shows the new owner (this is what the website snapshots)
  const meta: any = await (await call("/guardians/xfer-a/metadata.json", "GET")).json();
  assert.equal(meta.extra.owner, bob.account);
  // logged
  assert.ok((db.prepare("SELECT COUNT(*) n FROM nft_transfers WHERE guardian_id='xfer-a' AND status='done'").get() as any).n >= 1);
});

test("agent transfers: permission, allowlist, approval, logging, SDK", async () => {
  const dana = await signin("Dana"), erin = await signin("Erin"), frank = await signin("Frank");
  await mint(dana.token, "xfer-b"); await mint(dana.token, "xfer-c"); await mint(dana.token, "xfer-d");

  // a key created without the permission is refused (and the NFT does not move)
  const plain = await makeKey(dana.token, {});
  assert.equal(plain.body.transfer_nft, false);
  const r1 = await call("/guardians/xfer-b/transfer", "POST", { "x-api-key": plain.key }, { to: "Erin" });
  assert.equal(r1.status, 403); assert.match(((await r1.json()) as any).error, /transfer_nft/);
  assert.equal(await nftOwner("xfer-b"), dana.account);

  // permission without an allowlist cannot be created
  assert.equal((await makeKey(dana.token, { transfer_nft: true })).status, 400);

  // allowlist [Erin], approval required (the default)
  const gated = await makeKey(dana.token, { transfer_nft: true, transfer_allowlist: ["Erin"] });
  assert.equal(gated.status, 200); assert.equal(gated.body.transfer_require_approval, true);
  const r2 = await call("/guardians/xfer-b/transfer", "POST", { "x-api-key": gated.key }, { to: "Frank" });
  assert.equal(r2.status, 403); assert.match(((await r2.json()) as any).error, /allowlist/);
  assert.equal(await nftOwner("xfer-b"), dana.account);

  // allowed recipient: becomes Pending, nothing moves until the owner approves
  const r3 = await call("/guardians/xfer-b/transfer", "POST", { "x-api-key": gated.key }, { to: "Erin" });
  const j3: any = await r3.json(); assert.equal(r3.status, 202, JSON.stringify(j3)); assert.equal(j3.status, "pending");
  assert.equal(await nftOwner("xfer-b"), dana.account);
  const inbox: any = await (await call("/me/transfers", "GET", bearer(dana.token))).json();
  assert.equal(inbox.pending.length, 1); assert.equal(inbox.pending[0].requested_by_key, gated.body.id);
  // the key cannot approve its own request, and neither can another player
  assert.equal((await call(`/me/transfers/${j3.transfer_id}/approve`, "POST", { "x-api-key": gated.key })).status, 401);
  assert.equal((await call(`/me/transfers/${j3.transfer_id}/approve`, "POST", bearer(frank.token))).status, 404);
  // the owner approves: it runs
  const ap: any = await (await call(`/me/transfers/${j3.transfer_id}/approve`, "POST", bearer(dana.token))).json();
  assert.equal(ap.status, "done"); assert.ok(ap.tx);
  assert.equal(await nftOwner("xfer-b"), erin.account);
  assert.equal((await vaultState("xfer-b")).owner, erin.account);

  // a rejected request does nothing
  const r4: any = await (await call("/guardians/xfer-c/transfer", "POST", { "x-api-key": gated.key }, { to: "Erin" })).json();
  assert.equal(((await (await call(`/me/transfers/${r4.transfer_id}/reject`, "POST", bearer(dana.token))).json()) as any).status, "rejected");
  assert.equal(await nftOwner("xfer-c"), dana.account);

  // a key with approval switched off transfers immediately, through the SDK
  const direct = await makeKey(dana.token, { transfer_nft: true, transfer_allowlist: ["Frank"], transfer_require_approval: false });
  const sdk = new VaultbreakClient("http://x", {} as any, ((u: string, i?: RequestInit) => app.request(u.replace("http://x", ""), i)) as any, { apiKey: direct.key });
  const res = await sdk.transfer("xfer-d", "Frank");
  assert.equal(res.status, "done"); assert.ok(res.tx);
  assert.equal(await nftOwner("xfer-d"), frank.account);
  // and the spend budget was never touched by any of it
  const keys: any[] = await (await call("/agent/keys", "GET", bearer(dana.token))).json();
  assert.ok(keys.every((k) => BigInt(k.spent) === 0n));

  // every agent transfer attempt is logged with the key id
  const rows = db.prepare("SELECT requested_by_key AS k, status FROM nft_transfers WHERE requested_by_key IS NOT NULL").all() as any[];
  assert.ok(rows.some((r) => r.k === plain.body.id && r.status === "refused"));
  assert.ok(rows.some((r) => r.k === gated.body.id && r.status === "done"));
  assert.ok(rows.some((r) => r.k === gated.body.id && r.status === "refused"));
  assert.ok(rows.some((r) => r.k === direct.body.id && r.status === "done"));
  await sleep(0);
});

const chainSession = async (id: string, sid: number | string) => (await view(ctx.provider, `${id}.${reg.id}`, "get_session", { session_id: String(sid) })) as any;

test("active session = Open AND not past its expiry: a live one blocks, an expired or abandoned one does not (humans and agent keys); the cleanup job closes them", async () => {
  const gina = await signin("Gina"), hank = await signin("Hank"), ivy = await signin("Ivy");
  await mint(gina.token, "xfer-e", 0.04); // session TTL of 2.4 s so the test can watch it expire
  const sid = await playAndClose(hank.token, "xfer-e", false);
  const row: any = db.prepare("SELECT onchain_session_id FROM sessions WHERE id=?").get(sid);

  // 1. a real live session blocks, and tells the UI until when
  const st1: any = await (await call("/guardians/xfer-e/transfer-status", "GET")).json();
  assert.equal(st1.blocked, true); assert.ok(st1.expires_at > st1.server_now - 100);
  const live = await call("/guardians/xfer-e/transfer", "POST", bearer(gina.token), { to: "Ivy" });
  assert.equal(live.status, 409); const lj: any = await live.json(); assert.match(lj.error, /open attempt/i); assert.ok(lj.expires_at);
  // ... the same for an agent key (no approval needed, so the guard is the only thing in the way)
  const key = await makeKey(gina.token, { transfer_nft: true, transfer_allowlist: ["Ivy"], transfer_require_approval: false });
  const agentLive = await call("/guardians/xfer-e/transfer", "POST", { "x-api-key": key.key }, { to: "Ivy" });
  assert.equal(agentLive.status, 409);
  assert.equal(await nftOwner("xfer-e"), gina.account);

  // 2. past its expiry nobody has closed it: the CHAIN still says Open, the database still says open, but it no longer blocks
  await sleep(4500);
  assert.equal((await chainSession("xfer-e", row.onchain_session_id)).status, "Open");
  assert.equal((db.prepare("SELECT status FROM sessions WHERE id=?").get(sid) as any).status, "open");
  const st2: any = await (await call("/guardians/xfer-e/transfer-status", "GET")).json();
  assert.equal(st2.blocked, false);
  const agentOk = await call("/guardians/xfer-e/transfer", "POST", { "x-api-key": key.key }, { to: "Ivy" });
  assert.equal(agentOk.status, 200, JSON.stringify(await agentOk.clone().json()));
  assert.equal(await nftOwner("xfer-e"), ivy.account);

  // 3. the cleanup job closes the stale session through close_session: chain and database agree
  const closed = await sweepSessions();
  assert.ok(closed >= 1);
  assert.equal((await chainSession("xfer-e", row.onchain_session_id)).status, "Failed");
  assert.equal((db.prepare("SELECT status FROM sessions WHERE id=?").get(sid) as any).status, "failed");
  assert.equal(await sweepSessions(), 0); // nothing left to do
});

test("an abandoned session the database does not know about (restored from an older backup) neither blocks nor survives the cleanup job", async () => {
  const jo = await signin("Jo"), kim = await signin("Kim");
  await mint(jo.token, "xfer-f", 0.04);
  const sid = await playAndClose(kim.token, "xfer-f", false);
  const row: any = db.prepare("SELECT onchain_session_id FROM sessions WHERE id=?").get(sid);
  db.prepare("DELETE FROM sessions WHERE id=?").run(sid); // the database lost its row; the vault still has the session
  // while live the chain alone is enough to block (database and chain disagree: the chain wins)
  assert.equal(((await (await call("/guardians/xfer-f/transfer-status", "GET")).json()) as any).blocked, true);
  assert.equal((await call("/guardians/xfer-f/transfer", "POST", bearer(jo.token), { to: "Kim" })).status, 409);
  await sleep(4500);
  assert.equal(((await (await call("/guardians/xfer-f/transfer-status", "GET")).json()) as any).blocked, false);
  assert.ok((await sweepSessions()) >= 1);
  assert.equal((await chainSession("xfer-f", row.onchain_session_id)).status, "Failed");
  // and now the transfer works (human path), and it is the same Open-then-closed definition end to end
  const r = await call("/guardians/xfer-f/transfer", "POST", bearer(jo.token), { to: "Kim" });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(await nftOwner("xfer-f"), kim.account);
});
