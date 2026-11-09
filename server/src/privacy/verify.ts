// Session verifier: takes the /proofs/:session_id document and prints PASS / FAIL / SKIP for the four Layer 2 checks.
//   (a) attestation valid            fresh NEAR AI report for the model: Intel TDX quote + REPORTDATA binds signer and nonce
//   (b) signing address matches      every exchange was signed by an address that the attestation vouches for
//   (c) signed exchange == transcript signature recovers to the signer; signed text == "<model>:sha256(req):sha256(res)";
//                                     the signed response is the assistant text in the stored transcript
//   (d) prompt matches commitment    revealed prompt hashes to the on-chain prompt_hash AND is the system message of every
//                                     signed request (ties the TEE-signed request to the committed prompt)
import { newNonce, verifyAttestation, type QuoteVerifier } from "./attestation.ts";
import { sha256Hex, signedText, verifySignature } from "./signing.ts";

export type Status = "PASS" | "FAIL" | "SKIP";
export interface CheckResult { id: "a" | "b" | "c" | "d"; title: string; status: Status; detail: string[] }

export interface VerifyDeps {
  /** fetches a fresh attestation report for (model, nonce) */
  fetchAttestation: (model: string, nonce: string) => Promise<any>;
  /** returns the prompt_hash committed on-chain in the vault contract */
  onchainPromptHash: (vaultAccount: string) => Promise<string>;
  verifyQuote?: QuoteVerifier;
}

export async function verifySession(proofs: any, deps: VerifyDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const exchanges: any[] = proofs.exchanges ?? [];
  const signed = exchanges.filter((e) => e.signature);
  const na = (id: CheckResult["id"], title: string, why: string) => out.push({ id, title, status: "SKIP", detail: [why] });
  const t = {
    a: "attestation valid (Intel TDX quote + signer/nonce binding)",
    b: "signing address matches the attested key",
    c: "signed exchange matches the stored transcript",
    d: "revealed prompt matches the on-chain commitment",
  };

  // ---- (a) + (b)
  let signers: string[] = [];
  if (!signed.length) {
    const why = `no signed exchanges for this session (model provider has no attestation, or the session predates capture): models used = ${[...new Set(exchanges.map((e) => e.model))].join(", ") || "none"}`;
    na("a", t.a, why); na("b", t.b, why);
  } else {
    const model = signed[0].model;
    const nonce = newNonce();
    try {
      const report = await deps.fetchAttestation(model, nonce);
      const att = await verifyAttestation(report, { nonce, model, verifyQuote: deps.verifyQuote });
      signers = att.signers.map((s) => s.address.toLowerCase().replace(/^0x/, ""));
      out.push({ id: "a", title: t.a, status: att.ok ? "PASS" : "FAIL", detail: [...att.checks.map((c) => `${c.ok ? "ok  " : "BAD "} ${c.name}${c.detail ? ` (${c.detail})` : ""}`), ...att.unverified.map((u) => `note: ${u}`)] });
    } catch (e: any) {
      out.push({ id: "a", title: t.a, status: "FAIL", detail: [`could not obtain/verify attestation: ${String(e?.message ?? e).slice(0, 200)}`] });
    }
    const bad = signed.filter((e) => !signers.includes(String(e.signing_address).toLowerCase().replace(/^0x/, "")));
    out.push({ id: "b", title: t.b, status: signers.length && !bad.length ? "PASS" : "FAIL",
      detail: signers.length ? [`attested signers: ${signers.map((s) => "0x" + s).join(", ")}`, ...bad.map((e) => `exchange ${e.idx} signed by unattested address ${e.signing_address}`)] : ["no attested signer to compare against (see check a)"] });
  }

  // ---- (c)
  if (!exchanges.length) na("c", t.c, "no model exchanges recorded");
  else {
    const detail: string[] = []; let ok = true;
    const assistantTurns: any[] = (proofs.turns ?? []).filter((x: any) => x.role === "assistant");
    for (const e of exchanges) {
      const tag = `exchange ${e.idx} (${e.chat_id})`;
      const resHash = sha256Hex(e.response_body);
      if (resHash !== e.response_hash) { ok = false; detail.push(`${tag}: stored response does not match its recorded hash`); continue; }
      // the signed response must be the assistant text in the stored transcript
      let content = "";
      try { content = JSON.parse(e.response_body)?.choices?.[0]?.message?.content ?? ""; } catch { ok = false; detail.push(`${tag}: response body is not JSON`); continue; }
      const stored = assistantTurns.find((x) => x.chat_id === e.chat_id);
      if (content && stored?.content !== content) { ok = false; detail.push(`${tag}: transcript assistant text differs from the signed response`); }
      if (!content && stored) { ok = false; detail.push(`${tag}: transcript has assistant text but the signed response is empty`); }
      if (!e.signature) { detail.push(`${tag}: no signature captured (${e.signature_error ?? "n/a"})`); ok = false; continue; }
      if (!verifySignature({ text: e.signed_text, signature: e.signature, signing_address: e.signing_address, signing_algo: e.signing_algo })) { ok = false; detail.push(`${tag}: signature does not recover to ${e.signing_address}`); continue; }
      if (e.request_body !== undefined) {
        const want = signedText(e.model, e.request_body, e.response_body);
        if (want !== e.signed_text) { ok = false; detail.push(`${tag}: signed text != "<model>:sha256(request):sha256(response)" recomputed from stored bytes`); continue; }
        detail.push(`${tag}: signature valid; signed text recomputed from stored request+response bytes`);
      } else {
        const parts = String(e.signed_text).split(":");
        const okResp = parts[parts.length - 1] === resHash && parts[parts.length - 2] === e.request_hash;
        if (!okResp) { ok = false; detail.push(`${tag}: signed hashes differ from recorded hashes`); continue; }
        detail.push(`${tag}: signature valid; response hash matches; request body still sealed (only its hash is checked)`);
      }
    }
    out.push({ id: "c", title: t.c, status: ok ? "PASS" : "FAIL", detail });
  }

  // ---- (d)
  if (!proofs.revealed || !proofs.prompt) na("d", t.d, "guardian not revealed yet (it must be Defeated or retired); the prompt is still sealed");
  else {
    const detail: string[] = []; let ok = true;
    try {
      const onchain = (await deps.onchainPromptHash(proofs.guardian.vault_account)).replace(/^0x/, "");
      const h = sha256Hex(proofs.prompt);
      if (h !== onchain) { ok = false; detail.push(`sha256(revealed prompt)=${h} != on-chain prompt_hash=${onchain}`); }
      else detail.push(`sha256(revealed prompt) == on-chain prompt_hash ${onchain}`);
    } catch (e: any) { ok = false; detail.push(`could not read on-chain commitment: ${String(e?.message ?? e).slice(0, 160)}`); }
    const withBodies = exchanges.filter((e) => e.request_body !== undefined);
    for (const e of withBodies) {
      let sys = ""; try { sys = JSON.parse(e.request_body)?.messages?.[0]?.content ?? ""; } catch { /* below */ }
      const jsonMode = typeof sys === "string" && sys.startsWith(proofs.prompt); // json-fallback mode appends tool instructions
      if (sys !== proofs.prompt && !jsonMode) { ok = false; detail.push(`exchange ${e.idx}: request's system message is not the revealed prompt`); }
    }
    if (withBodies.length) detail.push(`${withBodies.length} signed request(s) contain the revealed prompt as their system message`);
    else detail.push("no request bodies available to tie to the prompt");
    out.push({ id: "d", title: t.d, status: ok ? "PASS" : "FAIL", detail });
  }
  return out;
}

export function formatResults(rs: CheckResult[]): string {
  return rs.map((r) => `${r.status}  (${r.id}) ${r.title}\n${r.detail.map((d) => `        ${d}`).join("\n")}`).join("\n");
}
