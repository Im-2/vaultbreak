// On-chain (sandbox) tests for the swarm pool against REAL registry-minted vaults: pro-rata split of winnings, refunds of
// unspent funds, vault refusal handling, one-session-per-attacker contention, authorisation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { startSandbox, makeAccount, deployRegistry, deployPool } from "./harness.mjs";
import { view, accountFrom, NEAR } from "../server/src/chain.ts";

const HASH = "ab".repeat(32);
const PARAMS = { min_fee: (NEAR / 10n).toString(), turns_max: 5, session_ttl_ms: "600000", max_open_per_attacker: 1 };
const GAS = 300_000_000_000_000n;
let ctx, reg, pool, creator, ops, agentA, agentB, agentC, stranger;
const gkeys = {};

async function expectFail(p, re) {
  let err;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, "expected the call to fail");
  const text = `${err?.message ?? ""}`;
  if (re) assert.match(text, re, `error was: ${text.slice(0, 500)}`);
}
const bal = async (id) => BigInt((await ctx.provider.viewAccount({ accountId: id })).amount);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function mintGuardian(id) {
  const kp = KeyPair.fromRandom("ed25519");
  gkeys[id] = kp;
  const req = BigInt(await view(ctx.provider, reg.id, "mint_requirements", {}));
  await creator.acct.callFunction({ contractId: reg.id, methodName: "mint_guardian", deposit: req + 2n * NEAR, gas: GAS,
    args: { args: { guardian_id: id, ops_account: ops.id, guardian_pk: kp.getPublicKey().toString(), prompt_hash: HASH, params: PARAMS, royalty_bps: 0, allowance: null } } });
  return { vault: `${id}.${reg.id}`, guardian: accountFrom(`${id}.${reg.id}`, ctx.rpcUrl, kp.toString()) };
}
const pstate = (id) => view(ctx.provider, pool.id, "get_pool", { pool_id: String(id) });
const call = (who, method, args = {}, deposit = 0n) => who.acct.callFunction({ contractId: pool.id, methodName: method, args, deposit, gas: 150_000_000_000_000n });
const newPool = async (who, gid, budget = 2n * NEAR, controller = null) => String(await call(who, "create_pool", { guardian_id: gid, target_fee_budget: budget.toString(), controller, deadline_ms: "3600000" }));

before(async () => {
  ctx = await startSandbox();
  [creator, ops, agentA, agentB, agentC, stranger] = await Promise.all(["creator", "ops", "agenta", "agentb", "agentc", "stranger"].map((n) => makeAccount(ctx, n, 80n)));
  reg = await deployRegistry(ctx);
  pool = await deployPool(ctx, reg.id);
});
after(async () => { await ctx?.stop(); });

test("vault records the payout in the session (pool settlement depends on it)", async () => {
  const { vault, guardian } = await mintGuardian("probe");
  await agentC.acct.callFunction({ contractId: vault, methodName: "start_session", args: {}, deposit: NEAR });
  const pot = BigInt((await view(ctx.provider, vault, "get_state")).pot);
  assert.equal((await view(ctx.provider, vault, "get_session", { session_id: "1" })).payout, "0");
  await guardian.callFunction({ contractId: vault, methodName: "release", args: { session_id: "1" } });
  const s = await view(ctx.provider, vault, "get_session", { session_id: "1" });
  assert.equal(s.status, "Won");
  assert.equal(BigInt(s.payout), pot);
});

test("ACCEPTANCE: two agents pool funds, attack a Guardian through the pool, winnings are split by contribution", async () => {
  const { vault, guardian } = await mintGuardian("alpha");
  const id = await newPool(agentA, "alpha"); // agent A is creator + controller
  const p0 = await pstate(id);
  assert.equal(p0.vault, vault, "vault derived from the registry, not chosen by the caller");
  assert.equal(p0.controller, agentA.id);

  // A puts in 1 NEAR, B puts in 3 NEAR  => 25% / 75%
  await call(agentA, "contribute", { pool_id: id }, NEAR);
  await call(agentB, "contribute", { pool_id: id }, 3n * NEAR);
  assert.equal((await pstate(id)).total_contributed, (4n * NEAR).toString());

  // authorisation: only the controller attacks; fees capped by the pool's money and target budget
  await expectFail(call(agentB, "attack_with_pool", { pool_id: id, fee: (NEAR / 10n).toString() }), /only the pool controller/);
  await expectFail(call(agentA, "attack_with_pool", { pool_id: id, fee: (3n * NEAR).toString() }), /target_fee_budget/);
  // the pool contract is the attacker; the vault's session is bound to it
  await call(agentA, "attack_with_pool", { pool_id: id, fee: (NEAR / 10n).toString() });
  const st = await pstate(id);
  assert.equal(st.status, "Attacking");
  assert.deepEqual(st.sessions, ["1"]);
  assert.equal(st.open_session, "1");
  assert.equal(st.fees_spent, (NEAR / 10n).toString());
  const sess = await view(ctx.provider, vault, "get_session", { session_id: "1" });
  assert.equal(sess.attacker, pool.id);
  // nobody can buy in after fees were spent
  await expectFail(call(agentC, "contribute", { pool_id: id }, NEAR), /no longer accepting/);
  // settle while the session is still open: nothing happens; it is permissionless
  assert.equal(await call(stranger, "settle", { pool_id: id }), "open");
  await expectFail(call(agentA, "withdraw", { pool_id: id }), /still running/);

  // the guardian is talked into releasing: the vault pays the pot to the POOL contract
  const potBefore = BigInt((await view(ctx.provider, vault, "get_state")).pot);
  await guardian.callFunction({ contractId: vault, methodName: "release", args: { session_id: "1" } });
  assert.equal(await call(stranger, "settle", { pool_id: id }), "won");
  const won = await pstate(id);
  assert.equal(won.status, "Won");
  assert.equal(won.winnings, potBefore.toString());
  assert.equal(won.open_session, null);

  // exact pro-rata amounts
  const value = potBefore + 4n * NEAR - NEAR / 10n; // winnings + unspent
  const shareA = BigInt(await view(ctx.provider, pool.id, "preview_share", { pool_id: id, account_id: agentA.id }));
  const shareB = BigInt(await view(ctx.provider, pool.id, "preview_share", { pool_id: id, account_id: agentB.id }));
  assert.equal(shareA, value / 4n);
  assert.equal(shareB, value * 3n / 4n);
  assert.ok(value - shareA - shareB < 2n, "at most dust is left over");

  // withdrawals pay exactly the share (balance rises by share minus the caller's own gas)
  await sleep(2500);
  for (const [who, share] of [[agentA, shareA], [agentB, shareB]]) {
    const before = await bal(who.id);
    await call(who, "withdraw", { pool_id: id });
    await sleep(2500);
    const gain = (await bal(who.id)) - before;
    assert.ok(gain > share - NEAR / 100n && gain <= share, `${who.id} gained ${gain}, share ${share}`);
  }
  assert.ok(shareB > 2n * shareA && shareB < 4n * shareA, "B put in 3x as much and got ~3x as much");
  await expectFail(call(agentA, "withdraw", { pool_id: id }), /already claimed/);
  await expectFail(call(stranger, "withdraw", { pool_id: id }), /not a contributor/);
  // the contract keeps no more than dust for this pool
  assert.ok(BigInt(await view(ctx.provider, pool.id, "get_held", {})) < 10n, "all money was paid out (dust only)");
});

test("lost pool: unspent funds are refunded pro rata; controller or deadline closes it", async () => {
  const { vault, guardian } = await mintGuardian("beta");
  const id = await newPool(agentA, "beta", 2n * NEAR);
  await call(agentB, "contribute", { pool_id: id }, 3n * NEAR);
  await call(agentC, "contribute", { pool_id: id }, NEAR);
  await call(agentA, "attack_with_pool", { pool_id: id, fee: (NEAR / 2n).toString() });
  await guardian.callFunction({ contractId: vault, methodName: "close_session", args: { session_id: "1", transcript_hash: HASH, blocked_attempts: 0 } });
  assert.equal(await call(stranger, "settle", { pool_id: id }), "lost");
  assert.equal((await pstate(id)).open_session, null);
  await expectFail(call(agentB, "refund", { pool_id: id }), /still running/);
  await expectFail(call(agentB, "close_pool", { pool_id: id }), /only the controller/);
  await call(agentA, "close_pool", { pool_id: id });
  const unspent = 4n * NEAR - NEAR / 2n;
  assert.equal(BigInt(await view(ctx.provider, pool.id, "preview_share", { pool_id: id, account_id: agentB.id })), unspent * 3n / 4n);
  await sleep(2500);
  const before = await bal(agentB.id);
  await call(agentB, "refund", { pool_id: id });
  await sleep(2500);
  const gain = (await bal(agentB.id)) - before;
  assert.ok(gain > unspent * 3n / 4n - NEAR / 100n && gain <= unspent * 3n / 4n, `refund ${gain}`);
  await call(agentC, "refund", { pool_id: id });
  await expectFail(call(agentB, "withdraw", { pool_id: id }), /already claimed/);
  await expectFail(call(agentA, "refund", { pool_id: id }), /not a contributor/);
  await expectFail(call(agentA, "attack_with_pool", { pool_id: id, fee: "1000" }), /pool is closed/);
});

test("vault refusal: the reserved fee is restored (defeated vault)", async () => {
  // 'alpha' was defeated in the acceptance test: the vault refuses new sessions
  const id = await newPool(agentA, "alpha");
  await call(agentA, "contribute", { pool_id: id }, NEAR);
  await call(agentA, "attack_with_pool", { pool_id: id, fee: (NEAR / 10n).toString() });
  const st = await pstate(id);
  assert.equal(st.fees_spent, "0", "fee returned: the vault said 'defeated'");
  assert.equal(st.status, "Funding");
  assert.equal(st.open_session, null);
  assert.deepEqual(st.sessions, []);
  // so contributions are still accepted and the money is all there to refund
  await call(agentB, "contribute", { pool_id: id }, NEAR);
  await call(agentA, "close_pool", { pool_id: id });
  assert.equal(BigInt(await view(ctx.provider, pool.id, "preview_share", { pool_id: id, account_id: agentB.id })), NEAR);
  await call(agentA, "refund", { pool_id: id }); await call(agentB, "refund", { pool_id: id });
});

test("contention: the pool contract is ONE attacker per vault, so a second pool is refused while a session is open", async () => {
  const { vault, guardian } = await mintGuardian("gamma");
  const p1 = await newPool(agentA, "gamma");
  const p2 = await newPool(agentB, "gamma");
  await call(agentA, "contribute", { pool_id: p1 }, NEAR);
  await call(agentB, "contribute", { pool_id: p2 }, NEAR);
  await call(agentA, "attack_with_pool", { pool_id: p1, fee: (NEAR / 10n).toString() });
  await call(agentB, "attack_with_pool", { pool_id: p2, fee: (NEAR / 10n).toString() }); // vault: too many open sessions
  const s2 = await pstate(p2);
  assert.equal(s2.fees_spent, "0");
  assert.equal(s2.open_session, null);
  assert.equal((await pstate(p1)).open_session, "1");
  // after pool 1's session ends, pool 2 can attack
  await guardian.callFunction({ contractId: vault, methodName: "close_session", args: { session_id: "1", transcript_hash: HASH, blocked_attempts: 0 } });
  await call(stranger, "settle", { pool_id: p1 });
  await call(agentB, "attack_with_pool", { pool_id: p2, fee: (NEAR / 10n).toString() });
  assert.equal((await pstate(p2)).open_session, "2");
});

test("pool creation rules and views", async () => {
  await expectFail(call(agentA, "create_pool", { guardian_id: "a.b", target_fee_budget: "1", controller: null, deadline_ms: "60000" }), /registry label/);
  await expectFail(call(agentA, "create_pool", { guardian_id: "x", target_fee_budget: "0", controller: null, deadline_ms: "60000" }), /target_fee_budget/);
  await expectFail(call(agentA, "contribute", { pool_id: "999" }, NEAR), /no such pool/);
  const all = await view(ctx.provider, pool.id, "list_pools", {});
  assert.ok(all.length >= 5);
  assert.equal(await view(ctx.provider, pool.id, "get_registry", {}), reg.id);
  // a delegated controller (an agent swarm leader) can run the attack while others only contribute
  const id = await newPool(agentA, "gamma", NEAR, agentC.id);
  assert.equal((await pstate(id)).controller, agentC.id);
});
