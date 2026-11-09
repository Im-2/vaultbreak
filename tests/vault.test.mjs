// On-chain (sandbox) tests for the vault: invariants 2, 4, 5, 6, 7 plus the end-to-end release flow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { startSandbox, makeAccount, WASM } from "./harness.mjs";
import { deployVault, listKeys, view, accountFrom, NEAR } from "../server/src/chain.ts";

const HASH = "ab".repeat(32);
const PARAMS = { min_fee: (NEAR / 10n).toString(), turns_max: 5, session_ttl_ms: "60000", max_open_per_attacker: 1 };
let ctx, owner, ops, alice, bob, guardianKp, vaultId, guardian;

async function expectFail(p, re) {
  let err;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, "expected the call to fail");
  const text = `${err?.message ?? ""} ${JSON.stringify(err?.type ?? "")} ${JSON.stringify(err?.context ?? "")} ${JSON.stringify(err?.kind ?? "")}`;
  if (re) assert.match(text, re, `error was: ${text.slice(0, 600)}`);
}
const state = () => view(ctx.provider, vaultId, "get_state");
const bal = async (id) => BigInt((await ctx.provider.viewAccount({ accountId: id })).amount);

async function newVault(name, params = PARAMS) {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}.${ctx.root.accountId}`;
  const { keys } = await deployVault({
    rpcUrl: ctx.rpcUrl, funder: ctx.root, vaultId: id, wasm: WASM, owner: owner.id, opsAccount: ops.id,
    guardianPublicKey: kp.getPublicKey().toString(), promptHashHex: HASH, params,
    seedYocto: 5n * NEAR, gasBufferYocto: 1n * NEAR, allowanceYocto: NEAR / 2n,
  });
  return { id, kp, keys, guardian: accountFrom(id, ctx.rpcUrl, kp.toString()) };
}

before(async () => {
  ctx = await startSandbox();
  [owner, ops, alice, bob] = await Promise.all(["owner", "ops", "alice", "bob"].map((n) => makeAccount(ctx, n)));
  ({ id: vaultId, kp: guardianKp, guardian } = await newVault("vault1"));
});
after(async () => { await ctx?.stop(); });

test("invariant 7: vault has no full-access key, only the guardian function-call key", async () => {
  const keys = await listKeys(ctx.provider, vaultId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "FunctionCall");
  assert.equal(keys[0].publicKey, guardianKp.getPublicKey().toString());
  assert.equal(keys[0].receiverId, vaultId);
  assert.deepEqual(keys[0].methodNames, ["release", "close_session"]);
  assert.ok(BigInt(keys[0].allowance) > 0n && BigInt(keys[0].allowance) <= NEAR / 2n);
  const s = await state();
  assert.equal(s.status, "Armed");
  assert.equal(s.pot, (5n * NEAR).toString());
});

test("invariant 4: external accounts cannot call release / close_session", async () => {
  await alice.acct.callFunction({ contractId: vaultId, methodName: "start_session", args: {}, deposit: NEAR });
  for (const who of [alice, bob, owner, ops]) {
    await expectFail(who.acct.callFunction({ contractId: vaultId, methodName: "release", args: { session_id: "1" } }), /only the guardian key/);
    await expectFail(who.acct.callFunction({ contractId: vaultId, methodName: "close_session", args: { session_id: "1", transcript_hash: HASH, blocked_attempts: 0 } }), /only the guardian key/);
  }
  assert.equal((await view(ctx.provider, vaultId, "get_session", { session_id: "1" })).status, "Open");
});

test("security: the guardian key is rejected by the chain for forbidden actions (honeypots)", async () => {
  const potBefore = (await state()).pot;
  const vaultBefore = await bal(vaultId);
  // 1. a transfer action (send_funds honeypot): function-call keys cannot send NEAR
  await expectFail(guardian.transfer({ receiverId: bob.id, amount: 1000n }), /RequiresFullAccess|full access|not allowed/i);
  // 2. a method outside the allow-list (change_owner honeypot)
  await expectFail(guardian.callFunction({ contractId: vaultId, methodName: "rotate_guardian_key", args: { pk: guardianKp.getPublicKey().toString(), allowance: "1" } }), /MethodNameMismatch|method/i);
  await expectFail(guardian.callFunction({ contractId: vaultId, methodName: "claim_creator_fees", args: {} }), /MethodNameMismatch|method/i);
  // 3. a different receiver
  await expectFail(guardian.callFunction({ contractId: bob.id, methodName: "release", args: {} }), /ReceiverMismatch|receiver/i);
  // 4. add a key / deploy
  await expectFail(guardian.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey().toString()), /RequiresFullAccess|full access/i);
  await expectFail(guardian.deployContract(WASM), /RequiresFullAccess|full access/i);
  assert.equal((await state()).pot, potBefore);
  const keys = await listKeys(ctx.provider, vaultId);
  assert.equal(keys.length, 1);
  assert.ok(vaultBefore - (await bal(vaultId)) < NEAR / 100n, "only negligible gas may leave the vault");
});

test("invariants 5 & 6: owner cannot attack or drain the pot; per-attacker limit", async () => {
  await expectFail(owner.acct.callFunction({ contractId: vaultId, methodName: "start_session", args: {}, deposit: NEAR }), /owner cannot attack/);
  await expectFail(alice.acct.callFunction({ contractId: vaultId, methodName: "start_session", args: {}, deposit: NEAR }), /too many open sessions/);
  await expectFail(bob.acct.callFunction({ contractId: vaultId, methodName: "claim_creator_fees", args: {} }), /only owner/);
  await expectFail(owner.acct.callFunction({ contractId: vaultId, methodName: "rearm", args: {}, deposit: NEAR }), /vault is armed/);
  const s = await state();
  const ownerBefore = await bal(owner.id);
  await owner.acct.callFunction({ contractId: vaultId, methodName: "claim_creator_fees", args: {} });
  const gain = (await bal(owner.id)) - ownerBefore;
  assert.ok(gain > 0n && gain <= BigInt(s.creator_balance), "owner receives at most creator_balance");
  assert.equal((await state()).pot, s.pot);
});

test("invariant 2: vault balance always covers pot + creator + ops + storage", async () => {
  const s = await state();
  const acct = await ctx.provider.viewAccount({ accountId: vaultId });
  const storage = BigInt(acct.storage_usage) * 10n ** 19n;
  const owed = BigInt(s.pot) + BigInt(s.creator_balance) + BigInt(s.ops_balance) + storage;
  assert.ok(BigInt(acct.amount) >= owed, `balance ${acct.amount} < owed ${owed}`);
});

test("end to end: guardian releases, attacker gains exactly the pot, pays once", async () => {
  const s = await state();
  const pot = BigInt(s.pot);
  const before = await bal(alice.id);
  await guardian.callFunction({ contractId: vaultId, methodName: "release", args: { session_id: "1" } });
  const gain = (await bal(alice.id)) - before;
  assert.equal(gain, pot, "attacker balance rises by exactly the pot");
  const after = await state();
  assert.equal(after.status, "Defeated");
  assert.equal(after.pot, "0");
  assert.equal((await view(ctx.provider, vaultId, "get_session", { session_id: "1" })).status, "Won");
  assert.equal((await view(ctx.provider, vaultId, "get_stats")).wins, 1);
  await expectFail(guardian.callFunction({ contractId: vaultId, methodName: "release", args: { session_id: "1" } }), /defeated|not open/);
  await expectFail(bob.acct.callFunction({ contractId: vaultId, methodName: "start_session", args: {}, deposit: NEAR }), /defeated/);
  // owner can re-arm after defeat
  await owner.acct.callFunction({ contractId: vaultId, methodName: "rearm", args: {}, deposit: 2n * NEAR });
  assert.equal((await state()).status, "Armed");
});

test("close_session records hash + blocked attempts; expire_session works after TTL", async () => {
  await bob.acct.callFunction({ contractId: vaultId, methodName: "start_session", args: {}, deposit: NEAR });
  await guardian.callFunction({ contractId: vaultId, methodName: "close_session", args: { session_id: "2", transcript_hash: HASH, blocked_attempts: 3 } });
  const sess = await view(ctx.provider, vaultId, "get_session", { session_id: "2" });
  assert.equal(sess.status, "Failed");
  assert.equal(sess.transcript_hash, HASH);
  const st = await view(ctx.provider, vaultId, "get_stats");
  assert.equal(st.blocked_reported, 3);
  assert.equal(st.streak, 1);

  const v2 = await newVault("vault2", { ...PARAMS, session_ttl_ms: "2000" });
  await alice.acct.callFunction({ contractId: v2.id, methodName: "start_session", args: {}, deposit: NEAR });
  await expectFail(bob.acct.callFunction({ contractId: v2.id, methodName: "expire_session", args: { session_id: "1" } }), /not expired yet/);
  await new Promise((r) => setTimeout(r, 4000));
  await bob.acct.callFunction({ contractId: v2.id, methodName: "expire_session", args: { session_id: "1" } });
  assert.equal((await view(ctx.provider, v2.id, "get_session", { session_id: "1" })).status, "Expired");
  // an expired session can no longer be released by the guardian
  await alice.acct.callFunction({ contractId: v2.id, methodName: "start_session", args: {}, deposit: NEAR });
  await new Promise((r) => setTimeout(r, 4000));
  await expectFail(v2.guardian.callFunction({ contractId: v2.id, methodName: "release", args: { session_id: "2" } }), /session expired/);
});

test("rotate_guardian_key adds a restricted key and removes the old one; still no full access", async () => {
  const newKp = KeyPair.fromRandom("ed25519");
  await owner.acct.callFunction({ contractId: vaultId, methodName: "rotate_guardian_key", args: { pk: newKp.getPublicKey().toString(), allowance: (NEAR / 4n).toString() }, gas: 100_000_000_000_000n });
  const keys = await listKeys(ctx.provider, vaultId);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].publicKey, newKp.getPublicKey().toString());
  assert.equal(keys[0].kind, "FunctionCall");
  assert.deepEqual(keys[0].methodNames, ["release", "close_session"]);
  await expectFail(guardian.callFunction({ contractId: vaultId, methodName: "close_session", args: { session_id: "1", transcript_hash: HASH, blocked_attempts: 0 } }));
});
