// Read-only: compares a local backend state directory with what exists ON-CHAIN for the live registry/pool, and lists which
// Guardians and play accounts exist on-chain but have no key (or database row) in the local copy. Prints no keys.
//   node scripts/audit-state.mjs .testnet-data
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
const dir = process.argv[2] ?? ".testnet-data";
const RPC = ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"];
const REG = "registry.vbreak-t2funder-1109.testnet", POOL = "pool.vbreak-t2funder-1109.testnet", FUNDER = "vbreak-t2funder-1109.testnet";
const rpc = async (method, params) => { for (let t = 0; t < 4; t++) for (const u of RPC) { try { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20000) }); const j = await r.json(); if (j.result) return j.result; } catch { /* next */ } } throw new Error(`rpc ${method} failed`); };
const view = async (acct, m, args = {}) => { const r = await rpc("query", { request_type: "call_function", finality: "final", account_id: acct, method_name: m, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }); return JSON.parse(Buffer.from(r.result).toString()); };

const db = new DatabaseSync(`${dir}/vaultbreak.db`);
const dbG = new Map(db.prepare("SELECT id, vault_account, key_ref, owner FROM guardians").all().map((g) => [g.id, g]));
const dbC = new Map(db.prepare("SELECT account_id, display_name, key_ref FROM custodial").all().map((c) => [c.account_id, c]));
const keyFiles = new Set(existsSync(`${dir}/keys`) ? readdirSync(`${dir}/keys`) : []);
const total = Number(await view(REG, "nft_total_supply"));
const tokens = []; for (let from = 0; from < total; from += 50) tokens.push(...(await view(REG, "nft_tokens", { from_index: String(from), limit: 50 })));
console.log(`on-chain: ${tokens.length} NFT Guardians in ${REG}`);
const seenAccts = new Map(); const note = (a, why) => { if (a && a.endsWith(`.${FUNDER}`) && !a.includes(".registry.") && a !== `registry.${FUNDER}` && a !== `pool.${FUNDER}`) { (seenAccts.get(a) ?? seenAccts.set(a, new Set()).get(a)).add(why); } };
const missingG = [];
for (const t of tokens) {
  const id = t.token_id, vault = `${id}.${REG}`;
  const g = dbG.get(id); const gk = g ? keyFiles.has(`${g.key_ref}.json`) : false;
  let st = null, next = 0; try { st = await view(vault, "get_state"); next = Number(st.next_session_id); } catch { /* vault unreadable */ }
  note(t.owner_id, `owns ${id}`);
  for (let i = 1; i < next; i++) { try { const s = await view(vault, "get_session", { session_id: String(i) }); if (s?.attacker) note(s.attacker, `played ${id}`); } catch { /* skip */ } }
  const ok = !!g && gk;
  console.log(`${ok ? "OK     " : "MISSING"} ${id.padEnd(18)} status=${st?.status ?? "?"} owner=${t.owner_id.split(".")[0]} db=${g ? "yes" : "NO"} guardian-key=${gk ? "yes" : "NO"}`);
  if (!ok) missingG.push(id);
}
try { const pools = await view(POOL, "list_pools", { from_index: "0", limit: 50 }).catch(() => []); for (const p of pools) { note(p.controller, `pool ${p.id} controller`); const cs = await view(POOL, "list_contributions", { pool_id: String(p.id) }).catch(() => []); for (const c of cs) note(c.account ?? c.account_id, `pool ${p.id} contributor`); } } catch { /* pool listing optional */ }
console.log(`\nplay-account-like accounts seen on-chain: ${seenAccts.size}`);
const missingA = [];
for (const [a, why] of seenAccts) { const c = dbC.get(a); const ck = c ? keyFiles.has(`${c.key_ref}.json`) : false; console.log(`${c && ck ? "OK     " : "MISSING"} ${a.split(".")[0].padEnd(20)} ${c ? `name=${c.display_name}` : "not in local DB"} key=${ck ? "yes" : "NO"}  (${[...why].slice(0, 3).join("; ")})`); if (!(c && ck)) missingA.push(a); }
console.log(`\nlocal copy: ${dbG.size} Guardians, ${dbC.size} play accounts, ${keyFiles.size} key files`);
console.log(`on-chain Guardians WITHOUT keys/db locally: ${missingG.length ? missingG.join(", ") : "none"}`);
console.log(`on-chain play accounts WITHOUT keys/db locally: ${missingA.length}${missingA.length ? " (" + missingA.map((a) => a.split(".")[0]).join(", ") + ")" : ""}`);
