// NEAR AI Cloud model attestation (docs.near.ai/cloud/verification). What this verifies, and what it does not:
//   VERIFIED  nonce echoed; signing_algo supported; Intel TDX quote signature chain + TCB status (via @phala/dcap-qvl,
//             collateral from Phala PCCS); TDX REPORTDATA binds the signing address (first 32 bytes, zero-padded) and
//             our nonce (last 32 bytes).
//   NOT DONE  (listed in `unverified`) NVIDIA GPU evidence via NRAS, compose-manifest hash vs MRCONFIG, RTMR3 event-log
//             replay, Sigstore image checks, gateway attestation, TLS-fingerprint binding.
import { randomBytes } from "node:crypto";

export interface AttCheck { name: string; ok: boolean; detail?: string }
export interface AttestationResult { ok: boolean; checks: AttCheck[]; signers: { address: string; algo: string }[]; unverified: string[] }

export const UNVERIFIED_PARTS = [
  "NVIDIA GPU evidence (NRAS) not checked",
  "compose manifest hash vs MRCONFIG / RTMR3 event-log replay not checked",
  "Sigstore container image checks not done",
  "gateway attestation and TLS-fingerprint binding not checked",
];

export const newNonce = () => randomBytes(32).toString("hex");

export async function fetchAttestation(base: string, model: string, nonce: string, algo = "ecdsa"): Promise<any> {
  const u = new URL(`${base.replace(/\/+$/, "")}/attestation/report`);
  u.search = new URLSearchParams({ model, provider: "near", signing_algo: algo, include_tls_fingerprint: "false", nonce }).toString();
  let last = "";
  for (let i = 0; i < 4; i++) { // upstream 5xx / network blips are common
    try {
      const res = await fetch(u, { headers: { "x-no-aliasing": "true", accept: "application/json" } });
      if (res.ok) return await res.json();
      last = `attestation report ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status < 500) break;
    } catch (e: any) { last = String(e?.message ?? e); }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(last);
}

export type QuoteVerifier = (quote: Buffer) => Promise<{ status: string; advisory_ids?: string[] }>;

export const defaultQuoteVerifier: QuoteVerifier = async (quote) => {
  const { getCollateralAndVerify } = await import("@phala/dcap-qvl");
  let last: unknown;
  for (let i = 0; i < 4; i++) { // collateral comes from the Phala PCCS over the network
    try { return (await getCollateralAndVerify(quote)) as any; } catch (e) {
      last = e;
      if (!/fetch failed|ETIMEDOUT|ECONNRESET|5dd|timeout/i.test(String((e as any)?.message ?? e))) break;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
};

/** TDX v4 quote: 48-byte header + TD report body; REPORTDATA is the last 64 bytes of the body (offset 568). */
export function quoteReportData(quote: Buffer): Buffer {
  if (quote.length < 632) throw new Error("quote too short");
  return quote.subarray(568, 632);
}

const hexToBuf = (s: string) => Buffer.from(s.replace(/^0x/i, ""), "hex");

export async function verifyAttestation(report: any, opts: { nonce: string; model?: string; verifyQuote?: QuoteVerifier; okStatuses?: string[] }): Promise<AttestationResult> {
  const verifyQuote = opts.verifyQuote ?? defaultQuoteVerifier;
  const okStatuses = opts.okStatuses ?? ["UpToDate"];
  const checks: AttCheck[] = [];
  const signers: AttestationResult["signers"] = [];
  const entries: any[] = (report?.model_attestations ?? []).filter((e: any) => !opts.model || !e.model_name || e.model_name === opts.model);
  checks.push({ name: "model_attestations present", ok: entries.length > 0, detail: `${entries.length} candidate(s)` });
  for (const [i, e] of entries.entries()) {
    const tag = `[${i}] ${e.signing_address}`;
    const algoOk = e.signing_algo === "ecdsa" || e.signing_algo === "ed25519";
    checks.push({ name: `${tag} signing_algo supported`, ok: algoOk, detail: e.signing_algo });
    checks.push({ name: `${tag} nonce echoed`, ok: (e.request_nonce ?? "").toLowerCase() === opts.nonce.toLowerCase() });
    let quote: Buffer | null = null;
    try { quote = hexToBuf(e.intel_quote); } catch { /* handled below */ }
    if (!quote || quote.length < 632) { checks.push({ name: `${tag} intel_quote parses`, ok: false }); continue; }
    // REPORTDATA binding: signing identity (zero-padded to 32 bytes) || nonce
    const expected = Buffer.concat([Buffer.concat([hexToBuf(e.signing_address), Buffer.alloc(32)]).subarray(0, 32), hexToBuf(opts.nonce)]);
    const bound = quoteReportData(quote).equals(expected);
    checks.push({ name: `${tag} TDX REPORTDATA binds signing address + nonce`, ok: bound });
    let status = "error", detail = "";
    try { const r = await verifyQuote(quote); status = r.status; detail = (r.advisory_ids ?? []).join(","); } catch (err: any) { detail = String(err?.message ?? err).slice(0, 160); }
    const qok = okStatuses.includes(status);
    checks.push({ name: `${tag} Intel TDX quote verifies (signature chain + TCB)`, ok: qok, detail: `${status}${detail ? " " + detail : ""}` });
    if (algoOk && bound && qok && (e.request_nonce ?? "").toLowerCase() === opts.nonce.toLowerCase()) signers.push({ address: e.signing_address, algo: e.signing_algo });
  }
  return { ok: signers.length > 0 && checks.every((c) => c.ok), checks, signers, unverified: UNVERIFIED_PARTS };
}
