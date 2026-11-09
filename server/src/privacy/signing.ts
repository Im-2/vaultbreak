// Per-response signatures from NEAR AI Cloud (verified against docs.near.ai/cloud/verification/cloud-api/response-signatures):
//   signed text (provider_tee) = "<MODEL_ID>:<request_hash>:<response_hash>"
//   request_hash  = SHA-256(exact request-body bytes), response_hash = SHA-256(exact response-body bytes)
//   ecdsa   : EIP-191 personal_sign over `text`; recovered address must equal signing_address
//   ed25519 : signature over the UTF-8 bytes of `text`; signing_address is the hex public key
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { verifyMessage } from "ethers";

export const sha256Hex = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

export function signedText(model: string, requestBody: string, responseBody: string, kind: "provider_tee" | "gateway" = "provider_tee"): string {
  const rh = sha256Hex(requestBody), sh = sha256Hex(responseBody);
  return kind === "gateway" ? `${rh}:${sh}` : `${model}:${rh}:${sh}`;
}

export interface SignatureRecord { text: string; signature: string; signing_address: string; signing_algo: string }

const strip0x = (s: string) => s.replace(/^0x/i, "");

export function verifySignature(r: SignatureRecord): boolean {
  try {
    if (r.signing_algo === "ecdsa") {
      let sig = strip0x(r.signature);
      if (sig.length !== 130) return false;
      const v = parseInt(sig.slice(128), 16);
      if (v < 27) sig = sig.slice(0, 128) + (v + 27).toString(16).padStart(2, "0"); // accept v in {0,1}
      return verifyMessage(r.text, "0x" + sig).toLowerCase() === `0x${strip0x(r.signing_address)}`.toLowerCase();
    }
    if (r.signing_algo === "ed25519") {
      const pub = Buffer.from(strip0x(r.signing_address), "hex");
      if (pub.length !== 32) return false;
      const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub]), format: "der", type: "spki" });
      return edVerify(null, Buffer.from(r.text, "utf8"), key, Buffer.from(strip0x(r.signature), "hex"));
    }
  } catch { /* fallthrough */ }
  return false; // unsupported algorithms are rejected
}

/** GET {base}/signature/{chat_id}?signing_algo=... (the signature can lag the completion briefly: retry on 404). */
export async function fetchSignature(base: string, apiKey: string | undefined, chatId: string, algo = "ecdsa", tries = 5): Promise<SignatureRecord> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const res = await fetch(`${base.replace(/\/+$/, "")}/signature/${encodeURIComponent(chatId)}?signing_algo=${algo}`, {
      headers: { accept: "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body.signature && body.text) {
      return { text: body.text, signature: body.signature, signing_address: body.signing_address, signing_algo: body.signing_algo ?? algo };
    }
    last = `${res.status} ${JSON.stringify(body).slice(0, 200)}`;
    if (res.status !== 404) break;
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error(`signature unavailable for ${chatId}: ${last}`);
}
