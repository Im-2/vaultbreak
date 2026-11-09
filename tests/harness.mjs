// Sandbox harness: starts a local NEAR sandbox and returns a funded root account.
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { accountFrom, provider } from "../server/src/chain.ts";

export const WASM = readFileSync(fileURLToPath(new URL("../contracts/vault/out/vault.wasm", import.meta.url)));

export async function startSandbox() {
  const sb = await Sandbox.start({});
  const root = accountFrom(DEFAULT_ACCOUNT_ID, sb.rpcUrl, DEFAULT_PRIVATE_KEY);
  return { sb, root, rpcUrl: sb.rpcUrl, provider: provider(sb.rpcUrl), stop: () => sb.tearDown() };
}

/** Creates a funded account with a fresh full-access key (for attackers/owner/ops in tests). */
export async function makeAccount(ctx, name, nearAmount = 50n) {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}.${ctx.root.accountId}`;
  await ctx.root.createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: nearAmount * 10n ** 24n });
  return { id, kp, acct: accountFrom(id, ctx.rpcUrl, kp.toString()) };
}

export const REGISTRY_WASM = readFileSync(fileURLToPath(new URL("../contracts/registry/out/registry.wasm", import.meta.url)));

/** Deploys + initialises the registry on `registry.<root>` and returns its account (full-access key kept by the deployer only). */
export async function deployRegistry(ctx, { baseUri = "http://localhost:8787", fundNear = 40n, name = "registry" } = {}) {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}.${ctx.root.accountId}`;
  await ctx.root.createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: fundNear * 10n ** 24n });
  const acct = accountFrom(id, ctx.rpcUrl, kp.toString());
  await acct.deployContract(REGISTRY_WASM);
  await acct.callFunction({ contractId: id, methodName: "new", args: { admin: id, base_uri: baseUri }, gas: 100_000_000_000_000n });
  return { id, acct, kp };
}

export const POOL_WASM = readFileSync(fileURLToPath(new URL("../contracts/pool/out/pool.wasm", import.meta.url)));

/** Deploys + initialises the swarm pool contract for `registryId` on `pool.<root>`. */
export async function deployPool(ctx, registryId, { fundNear = 20n, name = "pool" } = {}) {
  const kp = KeyPair.fromRandom("ed25519");
  const id = `${name}.${ctx.root.accountId}`;
  await ctx.root.createAccount({ newAccountId: id, publicKey: kp.getPublicKey().toString(), nearToTransfer: fundNear * 10n ** 24n });
  const acct = accountFrom(id, ctx.rpcUrl, kp.toString());
  await acct.deployContract(POOL_WASM);
  await acct.callFunction({ contractId: id, methodName: "new", args: { registry: registryId }, gas: 100_000_000_000_000n });
  return { id, acct, kp };
}
