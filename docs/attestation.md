# Verify it yourself: prompt commit-reveal + TEE-signed exchanges (Layer 2)

## What is being proven

| Claim | Mechanism |
|---|---|
| The Guardian's secret prompt was fixed **before** anyone played | `sha256(system_prompt)` is stored on-chain in the vault (`prompt_hash`) at creation. The prompt stays encrypted at rest. |
| The prompt is revealed honestly | After the Guardian is **Defeated** (or retired), `POST /guardians/:id/reveal` publishes it. Anyone checks `sha256(prompt) == on-chain prompt_hash`. |
| The model answers really came from a model in a TEE | NEAR AI Cloud signs every response (`GET /v1/signature/{chat_id}`). The signing key is bound to genuine TEE hardware by an attestation report. |
| That TEE-signed request **contained the committed prompt** | The signature covers `sha256(exact request bytes)`. After reveal the stored request is published; its first (system) message must equal the revealed prompt. |

Formats below are taken from the NEAR AI Cloud docs (`docs.near.ai/cloud/verification/...`), no longer a guess:

```
signed text (provider_tee) = "<MODEL_ID>:<request_hash>:<response_hash>"
request_hash  = SHA-256(exact request-body bytes)       response_hash = SHA-256(exact response-body bytes)
ecdsa   : EIP-191 personal_sign over the text; the recovered address must equal signing_address
ed25519 : signature over the UTF-8 bytes of the text; signing_address is the hex public key
attestation: GET /v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa&nonce=<32B hex>
             TDX REPORTDATA (64 B) = signing address (zero-padded to 32 B) || your nonce
```

## Run it offline (no credits, no network beyond the local sandbox)

```bash
export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh)
npm run demo:privacy
```
This starts a local NEAR sandbox and a **local stub of NEAR AI Cloud** that signs with a real secp256k1 key, plays a session against the weak Guardian, defeats it, then runs the standalone verifier twice. Expected: before reveal `(a) (b) (c)` PASS and `(d)` SKIP (the prompt is still sealed); after reveal all four PASS, `RESULT: PASS (4 passed, 0 skipped)`.

The stub has no Intel quote, so the demo passes `--insecure-skip-quote` to the verifier and prints a warning. **Never use that flag against the real service.**

## Run it against the real NEAR AI Cloud

Needs credits on the key (signatures are only produced for completions).

```bash
# .env:  MODEL_PROVIDER=nearai   NEARAI_API_KEY=...   (MODEL_NAME defaults to anthropic/claude-haiku-5-5; use a NEAR-hosted TEE model for real attestation)
npm -w server start                          # exchanges + signatures are captured automatically for provider nearai
# play a session (sdk/ or scripts/redteam-demo.ts), defeat the guardian, then:
curl -X POST localhost:8787/guardians/<id>/reveal
node --import tsx scripts/verify-session.ts <session_id> --api http://localhost:8787
```

## The four checks (`scripts/verify-session.ts`)

The verifier trusts nothing from the server except raw data: it recomputes hashes, recovers signatures itself, fetches its **own fresh attestation straight from NEAR AI Cloud** (new random nonce), and reads the commitment straight from the NEAR RPC.

- **(a) attestation valid** - fresh report for the model; nonce echoed; **Intel TDX quote signature chain and TCB status verified with `@phala/dcap-qvl`** (collateral from the Phala PCCS); the quote's REPORTDATA must bind the signing address and the nonce.
- **(b) signing address matches** - every signed exchange's `signing_address` is one the attestation vouches for.
- **(c) signed exchange matches the stored transcript** - signature recovers to the signer; the signed text equals `<model>:sha256(request):sha256(response)` recomputed from the stored bytes (request bytes only after reveal, before that only the recorded hashes are compared); the signed response's assistant text equals the stored transcript.
- **(d) revealed prompt matches the on-chain commitment** - `sha256(revealed prompt) == vault.prompt_hash` read from chain, and every signed request has that prompt as its system message. SKIP until the Guardian is revealed.

Output is `PASS` / `FAIL` / `SKIP`. `SKIP` is used when a check cannot apply (for example sessions served by a provider without attestation, such as Groq); it is never reported as PASS.

## Try the real attestation right now (no key, no credits)

```bash
LIVE_ATTESTATION=1 npm -w server run test:live        # last test: fetches + fully verifies a real NEAR AI attestation
curl 'localhost:8787/guardians/<id>/attestation?model=z-ai/glm-5.3-flash'   # same, via the API (any NEAR AI Cloud model id)
```
Verified live on 2026-11-09 with `z-ai/glm-5.3-flash` and `Qwen/Qwen3.8-27B`: TDX quote status `UpToDate`, REPORTDATA bound to the model's signing address and our nonce. (Some models were temporarily unavailable upstream with HTTP 503; the client retries.)

## What this does NOT prove (honest limits)

- **NOT verified yet:** NVIDIA GPU evidence (NRAS), compose-manifest hash vs MRCONFIG / RTMR3 event-log replay, Sigstore image checks, gateway attestation, TLS-fingerprint binding. The verifier lists these as `note:` lines on every run. The Intel TDX quote itself is verified.
- **No credits yet, so no real signature has been captured.** The signature path (`fetchSignature`, EIP-191 recovery, `signed text` format) is implemented to the documented spec and tested against a stub that signs with a real secp256k1 key; it has not been run against NEAR AI's signing endpoint. UNVERIFIED until credits exist. The exact JSON field names of `/v1/signature/{id}` are taken from the docs' prose (`text`, `signature`, `signing_address`, `signing_algo`).
- **The operator still builds the request.** The signed request proves *which* prompt reached the model, but a malicious operator could have committed an honest prompt and then sent a different one; check (d) catches that **only for the requests the operator chose to record**, and it assumes the recorded request/response bytes are the ones actually exchanged. Running the runtime in a TEE is the roadmap fix (not built).
- A prompt can only be revealed once the Guardian is Defeated or retired; before that, sessions verify (a)-(c) with the request body sealed (only its hash is checked).
