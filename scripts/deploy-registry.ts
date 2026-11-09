// Deploys the registry/factory. By default the registry is LOCKED: its bootstrap full-access key is deleted after init, so
// the code can never be changed (the vaults it mints never have a full-access key either). `admin` can still call set_base_uri.
//
//   node --import tsx scripts/deploy-registry.ts --funder vbreak-reg-1109.testnet [--name registry] [--base-uri URL]
//        [--fund 8] [--admin <account>] [--lock true|false] [--rpc URL]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { Account } from "near-api-js";
import { KeyPairSigner } from "near-api-js";
import { accountFrom, listKeys, provider, retryTransport } from "../server/src/chain.ts";

const a: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
if (!a.funder) throw new Error("missing --funder");
const rpc = a.rpc ?? process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org";
const funderKey = JSON.parse(readFileSync(`.keys/${a.funder}.json`, "utf8"));
const funder = accountFrom(a.funder, rpc, funderKey.private_key);
const id = `${a.name ?? "registry"}.${a.funder}`;
const admin = a.admin ?? a.funder;
const baseUri = a["base-uri"] ?? "http://localhost:8787";
const lock = (a.lock ?? "true") !== "false";
const wasm = readFileSync("contracts/registry/out/registry.wasm");
const fund = BigInt(Math.round(Number(a.fund ?? 8) * 1e6)) * 10n ** 18n;

console.log(`deploying registry ${id} (${wasm.length} bytes), admin=${admin}, lock=${lock}`);
const tmp = KeyPair.fromRandom("ed25519");
await retryTransport(() => funder.createAccount({ newAccountId: id, publicKey: tmp.getPublicKey().toString(), nearToTransfer: fund }));
const reg = new Account(id, provider(rpc), KeyPairSigner.fromSecretKey(tmp.toString() as `ed25519:${string}`));
await retryTransport(() => reg.deployContract(wasm));
await retryTransport(() => reg.callFunction({ contractId: id, methodName: "new", args: { admin, base_uri: baseUri }, gas: 100_000_000_000_000n }));
if (lock) {
  await retryTransport(() => reg.deleteKey(tmp.getPublicKey().toString()));
  let keys = await listKeys(provider(rpc), id);
  for (let i = 0; i < 20 && keys.length; i++) { await new Promise((r) => setTimeout(r, 2000)); keys = await listKeys(provider(rpc), id); }
  if (keys.length) throw new Error(`registry still has keys after lock: ${JSON.stringify(keys)}`);
  console.log("locked: registry account has NO access keys (code is immutable)");
} else {
  mkdirSync(".keys", { recursive: true });
  writeFileSync(`.keys/${id}.json`, JSON.stringify({ account_id: id, public_key: tmp.getPublicKey().toString(), private_key: tmp.toString() }));
  console.log("not locked: deploy key saved to .keys/");
}
const meta = await provider(rpc).callFunction({ contractId: id, method: "nft_metadata", args: {} });
mkdirSync("deployments/registry", { recursive: true });
writeFileSync(`deployments/registry/${id}.json`, JSON.stringify({ registry: id, admin, base_uri: baseUri, locked: lock, rpc, nft_metadata: meta }, null, 2));
console.log(`OK registry ${id}; manifest deployments/registry/${id}.json`);
