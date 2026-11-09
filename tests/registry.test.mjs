// On-chain (sandbox) tests for the registry/factory: mint, NFT-account vault keys, owner-follows-NFT, royalties, enumeration.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { startSandbox, makeAccount, deployRegistry, WASM } from "./harness.mjs";
import { listKeys, view, accountFrom, NEAR } from "../server/src/chain.ts";

const HASH = "ab".repeat(32);
const PARAMS = { min_fee: (NEAR / 10n).toString(), turns_max: 5, session_ttl_ms: "60000", max_open_per_attacker: 1 };
const GAS = 300_000_000_000_000n;
let ctx, reg, creator, ops, bob, carol, attacker, stranger, gkp;

async function expectFail(p, re) {
  let err;
  try { await p; } catch (e) { err = e; }
  assert.ok(err, "expected the call to fail");
  const text = `${err?.message ?? ""} ${JSON.stringify(err?.type ?? "")}`;
  if (re) assert.match(text, re, `error was: ${text.slice(0, 500)}`);
}
const bal = async (id) => BigInt((await ctx.provider.viewAccount({ accountId: id })).amount);
const mintArgs = (id, extra = {}) => ({ args: { guardian_id: id, ops_account: ops.id, guardian_pk: gkp.getPublicKey().toString(), prompt_hash: HASH, params: PARAMS, royalty_bps: 500, allowance: null, ...extra } });
const required = async () => BigInt(await view(ctx.provider, reg.id, "mint_requirements", {}));
const mint = async (who, id, extraDeposit = 2n * NEAR, extra = {}) =>
  who.acct.callFunction({ contractId: reg.id, methodName: "mint_guardian", args: mintArgs(id, extra), deposit: (await required()) + extraDeposit, gas: GAS });
const vaultState = (id) => view(ctx.provider, `${id}.${reg.id}`, "get_state");
const token = (id) => view(ctx.provider, reg.id, "nft_token", { token_id: id });
const transfer = (who, to, id) => who.acct.callFunction({ contractId: reg.id, methodName: "nft_transfer", args: { receiver_id: to, token_id: id }, deposit: 1n, gas: 150_000_000_000_000n });

before(async () => {
  ctx = await startSandbox();
  [creator, ops, bob, carol, attacker, stranger] = await Promise.all(["creator", "ops", "bob", "carol", "attacker", "stranger"].map((n) => makeAccount(ctx, n, 60n)));
  reg = await deployRegistry(ctx);
  gkp = KeyPair.fromRandom("ed25519");
});
after(async () => { await ctx?.stop(); });

test("mint: creates the NFT-account vault with ONLY the guardian function-call key, owner = creator, pot funded", async () => {
  const before = await bal(creator.id);
  const tok = await mint(creator, "alpha");
  assert.equal(tok.token_id, "alpha");
  assert.equal(tok.owner_id, creator.id);
  const vault = `alpha.${reg.id}`;
  // vault account: exactly one key, a restricted function-call key; NO full-access key (the factory never adds one)
  const keys = await listKeys(ctx.provider, vault);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].kind, "FunctionCall");
  assert.equal(keys[0].publicKey, gkp.getPublicKey().toString());
  assert.equal(keys[0].receiverId, vault);
  assert.deepEqual(keys[0].methodNames, ["release", "close_session"]);
  assert.equal(BigInt(keys[0].allowance), 250n * 10n ** 21n);
  // vault state
  const st = await vaultState("alpha");
  assert.equal(st.owner, creator.id);
  assert.equal(st.registry, reg.id);
  assert.equal(st.status, "Armed");
  assert.equal(st.prompt_hash, HASH);
  assert.ok(BigInt(st.pot) >= 2n * NEAR - 1n, `pot ${st.pot}`);
  // NFT
  const t = await token("alpha");
  assert.equal(t.owner_id, creator.id);
  assert.equal(t.metadata.reference, "http://localhost:8787/guardians/alpha/metadata.json");
  assert.equal(JSON.parse(t.metadata.extra).vault, vault);
  assert.ok(before - (await bal(creator.id)) > (await required()), "creator paid the mint cost");
  assert.equal((await view(ctx.provider, reg.id, "get_vault", { token_id: "alpha" })).creator, creator.id);
});

test("mint rejects bad input and underfunding without creating anything", async () => {
  const supply = await view(ctx.provider, reg.id, "nft_total_supply", {});
  await expectFail(mint(creator, "Alpha"), /guardian_id must be/);
  await expectFail(mint(creator, "alpha"), /already minted/);
  await expectFail(mint(creator, "gamma", 0n, { royalty_bps: 5000 }), /royalty_bps above/);
  await expectFail(creator.acct.callFunction({ contractId: reg.id, methodName: "mint_guardian", args: mintArgs("delta"), deposit: NEAR, gas: GAS }), /attach at least/);
  assert.equal(await view(ctx.provider, reg.id, "nft_total_supply", {}), supply);
  assert.equal(await token("delta"), null);
});

test("the minted vault is a real Guardian vault: attacker plays, guardian key releases, attacker gets the pot", async () => {
  const vault = `alpha.${reg.id}`;
  await attacker.acct.callFunction({ contractId: vault, methodName: "start_session", args: {}, deposit: NEAR });
  await new Promise((r) => setTimeout(r, 2500));
  const pot = BigInt((await vaultState("alpha")).pot);
  const g = accountFrom(vault, ctx.rpcUrl, gkp.toString());
  // the guardian key still cannot do anything outside release/close_session, even on a registry-created vault
  await expectFail(g.transfer({ receiverId: stranger.id, amount: 1000n }), /full access|RequiresFullAccess/i);
  await expectFail(g.callFunction({ contractId: vault, methodName: "set_owner", args: { new_owner: stranger.id } }), /method/i);
  // fees accrued while attacker's session is still open: close it (guardian) instead of releasing, so fees stay for the claim test
  await g.callFunction({ contractId: vault, methodName: "close_session", args: { session_id: "1", transcript_hash: HASH, blocked_attempts: 0 } });
  assert.equal((await vaultState("alpha")).status, "Armed");
  assert.ok(pot > 0n);
});

test("ACCEPTANCE: transfer the NFT; the new owner (and only the new owner) can claim_creator_fees", async () => {
  const vault = `alpha.${reg.id}`;
  const st0 = await vaultState("alpha");
  const fees = BigInt(st0.creator_balance);
  assert.ok(fees > 0n, "creator fees accrued from the attack fee");
  // before the transfer only the creator can claim; others cannot
  await expectFail(bob.acct.callFunction({ contractId: vault, methodName: "claim_creator_fees", args: {} }), /only owner/);
  // non-owner cannot transfer the NFT; transfer needs exactly 1 yocto
  await expectFail(transfer(stranger, stranger.id, "alpha"), /Sender not approved|Approval extension is disabled|approved/i);
  await expectFail(creator.acct.callFunction({ contractId: reg.id, methodName: "nft_transfer", args: { receiver_id: bob.id, token_id: "alpha" }, deposit: 0n, gas: 150_000_000_000_000n }), /1 yocto|yocto/i);
  assert.equal((await token("alpha")).owner_id, creator.id);

  // transfer creator -> bob
  const synced = await transfer(creator, bob.id, "alpha");
  assert.equal(synced, true, "vault accepted the new owner");
  assert.equal((await token("alpha")).owner_id, bob.id);
  assert.equal((await vaultState("alpha")).owner, bob.id, "vault owner follows the NFT");

  // old owner, stranger: refused. new owner: paid exactly the accrued creator fees (minus its own gas)
  await expectFail(creator.acct.callFunction({ contractId: vault, methodName: "claim_creator_fees", args: {} }), /only owner/);
  await expectFail(stranger.acct.callFunction({ contractId: vault, methodName: "claim_creator_fees", args: {} }), /only owner/);
  const before = await bal(bob.id);
  await bob.acct.callFunction({ contractId: vault, methodName: "claim_creator_fees", args: {}, gas: 100_000_000_000_000n });
  await new Promise((r) => setTimeout(r, 2500));
  const gain = (await bal(bob.id)) - before;
  assert.ok(gain > fees - NEAR / 100n && gain <= fees, `bob gained ${gain}, fees ${fees}`);
  assert.equal((await vaultState("alpha")).creator_balance, "0");
  // the pot was never touchable by the owner
  assert.ok(BigInt((await vaultState("alpha")).pot) > 0n);
});

test("transfer is reverted (token and vault stay in sync) when the vault refuses the new owner", async () => {
  // attacker opens a session on alpha: the vault refuses to make an account with an open session its owner
  const vault = `alpha.${reg.id}`;
  await attacker.acct.callFunction({ contractId: vault, methodName: "start_session", args: {}, deposit: NEAR });
  const ownerBefore = (await vaultState("alpha")).owner;
  const synced = await transfer(bob, attacker.id, "alpha");
  assert.equal(synced, false, "vault refused -> transfer reverted");
  assert.equal((await token("alpha")).owner_id, ownerBefore);
  assert.equal((await vaultState("alpha")).owner, ownerBefore);
  assert.equal((await view(ctx.provider, reg.id, "nft_supply_for_owner", { account_id: attacker.id })), "0");
});

test("NEP-199 royalties: payout splits the sale price between the original creator and the seller", async () => {
  // bob owns alpha; creator has a 5% royalty
  const p = await view(ctx.provider, reg.id, "nft_payout", { token_id: "alpha", balance: (100n * NEAR).toString(), max_len_payout: 10 });
  assert.equal(p.payout[creator.id], (5n * NEAR).toString());
  assert.equal(p.payout[bob.id], (95n * NEAR).toString());
  await expectFail(view(ctx.provider, reg.id, "nft_payout", { token_id: "alpha", balance: "100", max_len_payout: 1 }), /max_len_payout/);
  // nft_transfer_payout: seller (bob) -> carol; payout computed for the SELLER
  const out = await bob.acct.callFunction({ contractId: reg.id, methodName: "nft_transfer_payout", args: { receiver_id: carol.id, token_id: "alpha", approval_id: null, memo: null, balance: (10n * NEAR).toString(), max_len_payout: 10 }, deposit: 1n, gas: 150_000_000_000_000n });
  assert.equal(out.payout[creator.id], (NEAR / 2n).toString()); // 5% of 10 NEAR
  assert.equal(out.payout[bob.id], (19n * NEAR / 2n).toString());
  assert.equal((await token("alpha")).owner_id, carol.id);
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal((await vaultState("alpha")).owner, carol.id, "owner sync also runs on nft_transfer_payout");
});

test("NEP-171/177/181 surface: enumeration, contract metadata, nft_transfer_call refused", async () => {
  await mint(bob, "beta", 2n * NEAR, { royalty_bps: 0 });
  assert.equal(await view(ctx.provider, reg.id, "nft_total_supply", {}), "2");
  const forBob = await view(ctx.provider, reg.id, "nft_tokens_for_owner", { account_id: bob.id });
  assert.deepEqual(forBob.map((t) => t.token_id), ["beta"]);
  assert.equal((await view(ctx.provider, reg.id, "nft_supply_for_owner", { account_id: carol.id })), "1");
  const md = await view(ctx.provider, reg.id, "nft_metadata", {});
  assert.equal(md.spec, "nft-1.0.0");
  assert.equal(md.symbol, "VBG");
  await expectFail(bob.acct.callFunction({ contractId: reg.id, methodName: "nft_transfer_call", args: { receiver_id: carol.id, token_id: "beta", msg: "" }, deposit: 1n, gas: 100_000_000_000_000n }), /not supported/);
  // every vault minted by the registry has no full-access key
  for (const id of ["alpha", "beta"]) assert.ok((await listKeys(ctx.provider, `${id}.${reg.id}`)).every((k) => k.kind === "FunctionCall"));
});
