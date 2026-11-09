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
