// Guardian registration + creation helpers (house-signed guardians in Layer 1).
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { modelFor, type Config } from "./config.ts";
import { now, type DB } from "./db.ts";
import { accountFrom, deployVault, NEAR } from "./chain.ts";
import { encrypt, sha256Hex } from "./crypto.ts";

export interface Registration {
  vault_account: string; owner: string; ops?: string; prompt: string; prompt_hash: string;
  key_ref: string; name?: string; model: string; danger_mode?: boolean; turns_max: number;
}

export function guardianId(vaultAccount: string): string { return vaultAccount.split(".")[0]; }

export function registerGuardian(db: DB, pkey: Buffer, r: Registration): string {
  if (sha256Hex(r.prompt) !== r.prompt_hash) throw new Error("prompt does not match the committed prompt_hash");
  const id = guardianId(r.vault_account);
  db.prepare(`INSERT OR REPLACE INTO guardians(id, vault_account, owner, ops, prompt_hash, prompt_ciphertext, model, key_ref, name, turns_max, danger_mode, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, r.vault_account, r.owner, r.ops ?? null, r.prompt_hash, encrypt(r.prompt, pkey), r.model, r.key_ref, r.name ?? id, r.turns_max, r.danger_mode === false ? 0 : 1, now());
  return id;
}

/** Registers every deployments/*.json manifest (written by scripts/deploy-vault.ts). */
export function seedFromDeployments(db: DB, cfg: Config, pkey: Buffer, dir = "deployments"): string[] {
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
    ids.push(registerGuardian(db, pkey, {
      vault_account: m.vault_account, owner: m.owner, ops: m.ops, prompt: readFileSync(m.prompt_file, "utf8"),
      prompt_hash: m.prompt_hash, key_ref: m.key_ref, model: m.model ?? modelFor(cfg, guardianId(m.vault_account)), turns_max: m.params.turns_max,
    }));
  }
  return ids;
}

export interface CreateOpts {
  name: string; prompt: string; owner: string; ops: string; seedNear?: number; feeNear?: number;
  turns?: number; ttlMin?: number; dangerMode?: boolean; model?: string; funderId: string; wasm: Uint8Array;
}

/** House-signed creation: deploys a vault (no full-access key) funded by the operator account, then registers it. */
export async function createGuardian(db: DB, cfg: Config, pkey: Buffer, o: CreateOpts): Promise<string> {
  const funderKey = JSON.parse(readFileSync(`${cfg.keysDir}/${o.funderId}.json`, "utf8")).private_key;
  const funder = accountFrom(o.funderId, cfg.rpcUrl, funderKey);
  const vaultId = `${o.name}.${o.funderId}`;
  const kp = KeyPair.fromRandom("ed25519");
  const near = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
  const params = { min_fee: near(o.feeNear ?? 0.1).toString(), turns_max: o.turns ?? 8, session_ttl_ms: String((o.ttlMin ?? 10) * 60_000), max_open_per_attacker: 1 };
  const promptHash = sha256Hex(o.prompt);
  const allowance = near(0.25);
  const keyRef = `guardian-${vaultId}`;
  // Save the guardian key BEFORE any chain action so a late failure cannot orphan the vault.
  mkdirSync(cfg.keysDir, { recursive: true });
  writeFileSync(`${cfg.keysDir}/${keyRef}.json`, JSON.stringify({ vault: vaultId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
  await deployVault({ rpcUrl: cfg.rpcUrl, funder, vaultId, wasm: o.wasm, owner: o.owner, opsAccount: o.ops,
    guardianPublicKey: kp.getPublicKey().toString(), promptHashHex: promptHash, params,
    seedYocto: near(o.seedNear ?? 2), gasBufferYocto: allowance + NEAR / 20n, allowanceYocto: allowance });
  return registerGuardian(db, pkey, { vault_account: vaultId, owner: o.owner, ops: o.ops, prompt: o.prompt, prompt_hash: promptHash, key_ref: keyRef, name: o.name, model: o.model ?? modelFor(cfg, o.name), danger_mode: o.dangerMode, turns_max: params.turns_max });
}
