// Verifier for one session. Prints PASS / FAIL / SKIP for the four Layer 2 checks:
//   (a) attestation valid  (b) signing address matches  (c) signed exchange matches stored transcript
//   (d) revealed prompt hash matches the on-chain commitment
//
//   node --import tsx scripts/verify-session.ts <session_id> [--api http://localhost:8787] [--json proofs.json] [--insecure-skip-quote]
//
// It trusts nothing from the server except the raw data: it recomputes hashes, recovers signatures itself, fetches its own
// fresh attestation straight from NEAR AI Cloud, and reads the commitment straight from the NEAR RPC.
import { readFileSync } from "node:fs";
import { loadConfig } from "../server/src/config.ts";
import { provider, view } from "../server/src/chain.ts";
import { fetchAttestation } from "../server/src/privacy/attestation.ts";
import { formatResults, verifySession } from "../server/src/privacy/verify.ts";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const sessionId = args.find((a, i) => !a.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
const api = flag("api") ?? process.env.VAULTBREAK_API ?? "http://localhost:8787";
const cfg = loadConfig();
// DEMO ONLY: the local NEAR AI stub (scripts/privacy-demo.ts) has no Intel quote to verify. Never use against the real service.
const insecureQuote = args.includes("--insecure-skip-quote");
if (insecureQuote) console.warn("WARNING: --insecure-skip-quote: Intel TDX quote signatures are NOT verified (local stub demo only)\n");

let proofs: any;
if (flag("json")) proofs = JSON.parse(readFileSync(flag("json")!, "utf8"));
else {
  if (!sessionId) { console.error("usage: verify-session.ts <session_id> [--api URL] [--json file]"); process.exit(2); }
  const res = await fetch(`${api}/proofs/${sessionId}`);
  if (!res.ok) { console.error(`GET ${api}/proofs/${sessionId} -> ${res.status}`); process.exit(2); }
  proofs = await res.json();
}

const p = provider(cfg.rpcUrl);
const results = await verifySession(proofs, {
  fetchAttestation: (model, nonce) => fetchAttestation(cfg.nearai.baseUrl, model, nonce),
  ...(insecureQuote ? { verifyQuote: async () => ({ status: "UpToDate", advisory_ids: ["STUB-QUOTE-NOT-VERIFIED"] }) } : {}),
  onchainPromptHash: async (vault) => ((await view(p, vault, "get_state")) as any).prompt_hash,
});
console.log(`session ${proofs.session.id}  guardian ${proofs.guardian.id}  vault ${proofs.guardian.vault_account}\n`);
console.log(formatResults(results));
const failed = results.filter((r) => r.status === "FAIL").length;
console.log(failed ? `\nRESULT: FAIL (${failed} check(s) failed)` : `\nRESULT: PASS (${results.filter((r) => r.status === "PASS").length} passed, ${results.filter((r) => r.status === "SKIP").length} skipped)`);
process.exit(failed ? 1 : 0);
