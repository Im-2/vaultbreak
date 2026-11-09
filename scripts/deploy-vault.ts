// Deploys one Guardian vault. The vault ends with ONLY a restricted function-call key (no full-access key).
// Usage: node --import tsx scripts/deploy-vault.ts --funder vbreak-deployer-1109.testnet --name strong \
//          --prompt guardians/strong.md --owner X.testnet --ops Y.testnet [--seed 2] [--fee 0.1] [--turns 8] [--ttl-min 10] [--rpc URL]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { KeyPair } from "near-api-js";
import { accountFrom, deployVault, NEAR, listKeys, provider } from "../server/src/chain.ts";

const a: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const need = (k: string) => { if (!a[k]) throw new Error(`missing --${k}`); return a[k]; };
const near = (s: string) => BigInt(Math.round(parseFloat(s) * 1e6)) * 10n ** 18n;

const rpc = a.rpc ?? process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org";
const funderId = need("funder");
const funderKey = JSON.parse(readFileSync(`.keys/${funderId}.json`, "utf8"));
const funder = accountFrom(funderId, rpc, funderKey.private_key);
const vaultId = `${need("name")}.${funderId}`;
const prompt = readFileSync(need("prompt"), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
const guardianKp = KeyPair.fromRandom("ed25519");
const wasm = readFileSync("contracts/vault/out/vault.wasm");
const params = {
  min_fee: near(a.fee ?? "0.1").toString(), turns_max: Number(a.turns ?? 8),
  session_ttl_ms: String(Number(a["ttl-min"] ?? 10) * 60_000), max_open_per_attacker: 1,
};
const allowance = near(a.allowance ?? "0.25");
mkdirSync(".keys", { recursive: true });
writeFileSync(`.keys/guardian-${vaultId}.json`, JSON.stringify({ vault: vaultId, public_key: guardianKp.getPublicKey().toString(), private_key: guardianKp.toString() }, null, 2));
// (key saved BEFORE any chain action so a late failure cannot orphan the vault)
console.log(`deploying ${vaultId} (prompt sha256 ${promptHash})`);
const { keys } = await deployVault({
  rpcUrl: rpc, funder, vaultId, wasm, owner: need("owner"), opsAccount: need("ops"),
  guardianPublicKey: guardianKp.getPublicKey().toString(), promptHashHex: promptHash, params,
  seedYocto: near(a.seed ?? "2"), gasBufferYocto: allowance + NEAR / 20n, allowanceYocto: allowance,
});
mkdirSync("deployments", { recursive: true });
const manifest = { vault_account: vaultId, owner: a.owner, ops: a.ops, prompt_hash: promptHash, prompt_file: a.prompt, key_ref: `guardian-${vaultId}`, guardian_public_key: guardianKp.getPublicKey().toString(), params, rpc };
writeFileSync(`deployments/${vaultId}.json`, JSON.stringify(manifest, null, 2));
// Independent re-check straight from the RPC.
const check = await listKeys(provider(rpc), vaultId);
console.log("access keys on vault:", JSON.stringify(check));
if (check.some((k) => k.kind === "FullAccess")) throw new Error("FULL ACCESS KEY PRESENT");
console.log("OK: no full-access key. Manifest: deployments/" + vaultId + ".json");
