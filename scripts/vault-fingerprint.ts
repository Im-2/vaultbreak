// Prints the code hash of a deployed vault and its access keys (read from RPC), plus the sha256 of the local wasm.
//   node --import tsx scripts/vault-fingerprint.ts warden.registry.vbreak-t2funder-1109.testnet
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { listKeys, provider } from "../server/src/chain.ts";
const rpc = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org";
const vault = process.argv[2] ?? "warden.registry.vbreak-t2funder-1109.testnet";
const p = provider(rpc);
const acct: any = await p.viewAccount({ accountId: vault });
console.log("vault", vault, "on-chain code_hash", acct.codeHash ?? acct.code_hash);
const keys = await listKeys(p, vault);
console.log("keys", JSON.stringify(keys));
console.log("full-access keys:", (keys as any[]).filter((k) => k.kind === "FullAccess" || k.permission === "FullAccess").length);
if (existsSync("contracts/vault/out/vault.wasm")) console.log("local vault.wasm sha256", createHash("sha256").update(readFileSync("contracts/vault/out/vault.wasm")).digest("hex"));
