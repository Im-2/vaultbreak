// Deploys the swarm pool contract for a registry and LOCKS it (deploy key deleted: immutable code, no admin functions).
//   node --import tsx scripts/deploy-pool.ts --funder vbreak-pool-1109.testnet --registry registry.vbreak-reg2-1109.testnet [--name pool] [--fund 6] [--lock true|false]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { Account, KeyPair, KeyPairSigner } from "near-api-js";
import { accountFrom, listKeys, provider, retryTransport } from "../server/src/chain.ts";

const a: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!a.funder || !a.registry) throw new Error("usage: --funder <account> --registry <registry account>");
const rpc = a.rpc ?? process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org";
const funder = accountFrom(a.funder, rpc, JSON.parse(readFileSync(`.keys/${a.funder}.json`, "utf8")).private_key);
const id = `${a.name ?? "pool"}.${a.funder}`;
const wasm = readFileSync("contracts/pool/out/pool.wasm");
const fund = BigInt(Math.round(Number(a.fund ?? 6) * 1e6)) * 10n ** 18n;
const lock = (a.lock ?? "true") !== "false";
console.log(`deploying pool ${id} (${wasm.length} bytes) for registry ${a.registry}, lock=${lock}`);
const tmp = KeyPair.fromRandom("ed25519");
await retryTransport(() => funder.createAccount({ newAccountId: id, publicKey: tmp.getPublicKey().toString(), nearToTransfer: fund }));
const pool = new Account(id, provider(rpc), KeyPairSigner.fromSecretKey(tmp.toString() as `ed25519:${string}`));
await retryTransport(() => pool.deployContract(wasm));
await retryTransport(() => pool.callFunction({ contractId: id, methodName: "new", args: { registry: a.registry }, gas: 100_000_000_000_000n }));
if (lock) {
  await retryTransport(() => pool.deleteKey(tmp.getPublicKey().toString()));
  let keys = await listKeys(provider(rpc), id);
  for (let i = 0; i < 20 && keys.length; i++) { await new Promise((r) => setTimeout(r, 2000)); keys = await listKeys(provider(rpc), id); }
  if (keys.length) throw new Error(`pool still has keys after lock: ${JSON.stringify(keys)}`);
  console.log("locked: pool account has NO access keys (code is immutable)");
}
mkdirSync("deployments/pool", { recursive: true });
writeFileSync(`deployments/pool/${id}.json`, JSON.stringify({ pool: id, registry: a.registry, locked: lock, rpc }, null, 2));
console.log(`OK pool ${id}; manifest deployments/pool/${id}.json`);
