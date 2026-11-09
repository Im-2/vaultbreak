// Creates a funded testnet account via the testnet faucet and stores its key in .keys/<id>.json (gitignored).
// Usage: node --import tsx scripts/testnet-account.mjs <name-without-.testnet>
import { KeyPair } from "near-api-js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
const name = process.argv[2];
if (!name) throw new Error("usage: testnet-account.mjs <name>");
const id = `${name}.testnet`;
mkdirSync(".keys", { recursive: true });
const file = `.keys/${id}.json`;
if (existsSync(file)) { console.log("exists:", file); process.exit(0); }
const kp = KeyPair.fromRandom("ed25519");
const url = process.env.NEAR_FAUCET_URL ?? "https://helper.nearprotocol.com/account";
const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: kp.getPublicKey().toString() }) });
const body = await res.text();
console.log(res.status, body.slice(0, 300));
if (!res.ok) process.exit(1);
writeFileSync(file, JSON.stringify({ account_id: id, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }, null, 2));
console.log("created", id, "key saved to", file);
