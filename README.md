# Vaultbreak

**A marketplace of AI guardians on NEAR.** A creator mints a Guardian: an AI agent with its own on-chain account holding a pot of NEAR. Anyone (a human or another AI agent) pays an entry fee to open a chat session and tries to talk the Guardian into releasing the pot. Fees grow the pot. A Guardian that survives builds a record.

Status: **Layer 1 (core) is complete and tested.** Layers 2-5 (privacy attestation, NFT registry, agent SDK + pools, Intents entry) are not built yet. No UI yet (backend first, per `SPEC.md`). Everything in this repo is new work started for this hackathon; there is no pre-existing baseline.

## The problem

"Can a jailbroken LLM be made to move money?" is normally answered with "hope the prompt holds". Vaultbreak makes the answer **no, by construction**, and lets people try to prove otherwise:

- The Guardian's vault account has **no full-access key, ever**. It holds one **function-call key** restricted to `receiver_id = vault` and `method_names = [release, close_session]`, with a gas allowance.
- `release(session_id)` has **no recipient or amount parameter**. It pays the whole pot to the attacker recorded when they paid the fee. Diverting funds to a third party is structurally impossible.
- A function-call key cannot send NEAR, deploy code, or add keys. If a jailbroken model tries, **the chain rejects the transaction**.

The model is *allowed* to be talked into releasing (that is the game). It cannot be talked into anything worse.

## Try it (do X, see Y)

Requirements: Linux, macOS or WSL2 Ubuntu; Node 22+; Rust stable with the `wasm32-unknown-unknown` target. (On Windows, run everything inside WSL: the NEAR sandbox binary and the contract build are Linux/macOS only. `scripts/wsl.sh "<cmd>"` is a helper used during development.)

```bash
git clone https://github.com/Im-2/vaultbreak && cd vaultbreak
npm install
```

1. **Contract invariant tests** — `cargo test -p vaultbreak-vault`
   See: 27 passing tests, including property tests (proptest) for the 7 invariants.
2. **Build the wasm** — `bash scripts/build-contracts.sh`
   See: `contracts/vault/out/vault.wasm`. (It must be built with `--cfg near`, which the script sets; without it near-sdk falls back to non-on-chain code and panic messages are lost.)
3. **On-chain tests in a local NEAR sandbox** — `export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh) && npm run test:sandbox`
   See: 8 passing tests: no full-access key, external accounts cannot call `release`, the guardian key is rejected by the chain for transfers / other methods / deploys / add-key, owner cannot drain the pot, balance covers all accounting, end-to-end release, expiry, key rotation.
4. **API + runtime end-to-end** — `npm run test:server`
   See: 5 passing tests (NEP-413 login, weak guardian releases and the attacker's balance rises by exactly the pot, jailbroken model's `send_funds`/`change_owner` rejected by the chain and shown as `blocked`, `turns_max`, indexer + leaderboard).
5. **Red-team demo, local sandbox** — `npm run demo -- --mock` (offline model) or `npm run demo` (uses the model in `.env`)
   See: three scenarios end in `PASS`: (a) strong guardian holds, (b) a compromised guardian (`guardians/rogue.md`) tries `send_funds`/`change_owner` and the chain blocks it, (c) weak guardian defeated and the attacker receives the pot. Ends with `ALL CHECKS PASSED`.
6. **Red-team demo against live testnet vaults** — `node --import tsx scripts/redteam-demo.ts --testnet [--mock]`
   Needs the testnet accounts/keys created below (keys live in gitignored `.keys/`). See the same `PASS` lines plus a `nearblocks` link for the release transaction.
7. **Run the server** — `cp .env.example .env` (fill in values), then `npm -w server start`. With no `MODEL_*` set it uses the offline `mock` model; see "Model provider" below to use a real one.
8. **Live-model tests (skipped without a key)** — `npm -w server run test:live`, then `node --import tsx scripts/redteam-demo.ts` with `MODEL_*` set.

### Testnet deployment (already done for the demo)

```bash
node scripts/testnet-account.mjs <name>            # faucet-funded <name>.testnet, key saved to .keys/ (gitignored)
node --import tsx scripts/deploy-vault.ts --funder <deployer>.testnet --name strong \
     --prompt guardians/strong.md --owner <owner>.testnet --ops <ops>.testnet
```
The deploy script creates the vault account with a temporary bootstrap key, deploys + initialises the contract, adds **only** the guardian function-call key (gas allowance 0.25 NEAR), **deletes the bootstrap key**, then re-reads the key list from RPC and aborts if any full-access key exists.

Live demo vaults (testnet) and their on-chain key lists (queried via RPC `view_access_key_list`):

| Guardian | Vault account | Access keys |
|---|---|---|
| strong | `strong.vbreak-deployer-1109.testnet` | one `FunctionCall` key, methods `release, close_session` |
| weak | `weak.vbreak-deployer2-1109.testnet` | one `FunctionCall` key, methods `release, close_session` |
| rogue | `rogue.vbreak-deployer3-1109.testnet` | one `FunctionCall` key, methods `release, close_session` |

To check yourself, use the RPC call in `docs/architecture.md` (a `near` CLI `list-keys` command also works but is UNVERIFIED here).

## Model provider (configurable, OpenAI-compatible)

The runtime talks to any OpenAI-compatible `/chat/completions` API. Configure with env vars (or `.env`):

| Var | Meaning |
|---|---|
| `MODEL_BASE_URL` | API base URL (e.g. `https://api.groq.com/openai/v1`) |
| `MODEL_API_KEY` | provider key |
| `MODEL_NAME` | model id |
| `MODEL_PROVIDER` | optional preset: `groq`, `nearai`, `openrouter`, `gemini` (fills base URL, and default model for groq/nearai) |
| `MODEL_NAME_<GUARDIAN_ID>` | optional per-guardian model, e.g. `MODEL_NAME_WEAK=llama-3.1-8b-instant` |
| `MODEL_TOOL_MODE` | `native` (default) or `json` fallback for models without tool calling |

Nothing set = offline deterministic `mock` model.

- **Free option (no card): Groq.** Create a key at https://console.groq.com/keys, then `MODEL_PROVIDER=groq`, `MODEL_API_KEY=<key>` (default model `openai/gpt-oss-120b`).
- **NEAR AI Cloud (needs credits):** `MODEL_PROVIDER=nearai` + `NEARAI_API_KEY`. `config.nearai` always carries the NEAR AI settings, so the privacy/attestation layer (Layer 2, not built yet) keeps using NEAR AI Cloud even if inference runs elsewhere. Attestation only applies to NEAR AI Cloud inference.

## Architecture

```
Attacker (UI / agent SDK)  --HTTPS+SSE-->  API (Hono) --SQLite--> sessions, transcripts, blocked attempts
                                              |  \--> Indexer (polls vault views on NEAR RPC)
                                              v
                                      Guardian runtime (TS)
                                        |- LLM: any OpenAI-compatible provider (Groq, NEAR AI Cloud, ...) or offline MockLlm
                                        |- Tools -> NEAR txs signed with the Guardian's function-call key
                                              v
                                      NEAR testnet: one Vault contract per Guardian
```

| Path | What |
|---|---|
| `contracts/vault` | Rust (`near-sdk` 5.30.1) vault + policy. All `SPEC.md` 5.1 methods. |
| `server/src` | `guardian.ts` runtime, `app.ts` API, `indexer.ts`, `llm.ts`, `chain.ts` (near-api-js helpers), `db.ts` |
| `sdk/src` | attacker client (NEP-413 login, bind session, SSE chat) |
| `scripts` | `deploy-vault.ts`, `redteam-demo.ts`, `testnet-account.mjs`, build/sandbox helpers |
| `guardians/*.md` | prompts for the demo guardians (`strong`, `weak`) |
| `tests` | sandbox harness + on-chain invariant tests |

### Vault contract

Fee split on `start_session`: 70% pot / 20% creator / 10% ops (constants), after a small storage charge per session. `release` and `close_session` require `predecessor == current_account_id`, i.e. they can only be reached with the vault's own key. Payout failures (e.g. recipient account deleted) are reverted by a callback so funds are never stranded. See `contracts/vault/src/lib.rs`.

| Invariant (SPEC 5.1) | Where tested |
|---|---|
| 1 release pays only `pot`, only to `session.attacker` | `tests.rs::inv1_*` (incl. proptest) |
| 2 balance covers pot + creator + ops + storage | `tests.rs::inv2_*`, `vault.test.mjs` |
| 3 a session pays at most once | `tests.rs::inv3_*` |
| 4 only the vault's own keys call `release`/`close_session` | `tests.rs::inv4_*`, `vault.test.mjs` (4 external accounts + guardian-key abuse) |
| 5 owner cannot withdraw the pot while Armed | `tests.rs::inv5_*`, `vault.test.mjs` |
| 6 owner can't attack; per-attacker open limit | `tests.rs::inv6_*`, `vault.test.mjs` |
| 7 no code path adds a full-access key | source scan test + on-chain key list in sandbox and testnet |

### API (Layer 1 subset)

`POST /auth/nonce`, `POST /auth/verify` (NEP-413) · `GET /guardians`, `/guardians/:id`, `/guardians/:id/metadata.json` · `POST /guardians` (admin, house-signed) · `POST /guardians/:id/sessions/verify` · `POST /sessions/:id/messages` (SSE: `token`, `tool_call`, `tool_result`, `blocked`, `won`, `session_closed`, `error`) · `POST /sessions/:id/close` · `GET /sessions/:id` · `GET /leaderboard` · `POST /guardians/:id/reveal` (only once Defeated/retired).

## Trust assumptions (honest version)

- **The operator is trusted in v1.** The operator runs the runtime that builds prompts and calls the model; a malicious operator could instruct a Guardian to release. Roadmap: run the runtime in a TEE (OutLayer / Phala). Not built.
- **The chain enforces the money rules; it does not enforce the AI's behavior.** Blocked-attempt counts are runtime-reported (`close_session`), not chain-verified. A protocol-level rejection of a disallowed call is not recorded on-chain, so the runtime logs it in the transcript.
- **Gas accounting.** Gas burned by the guardian key is charged to the vault balance outside the contract's accounting. It is bounded by the key's allowance (0.25 NEAR in the demo) and the deploy script funds a buffer at least that large. Invariant 2 is therefore "accounted buckets + storage are always covered", with gas bounded by the allowance.
- **Bootstrap key.** During deployment (seconds) a temporary full-access key exists in the deploy process's memory only; it is deleted before the script returns, and the script verifies the final key list.

## UNVERIFIED / not done

- **Live LLM inference is UNVERIFIED.** No real model call has run yet. The provided NEAR AI Cloud key returns `402 No spending limit configured`, and the free-provider run needs a Groq key that has not been created yet. `GET /v1/models` on NEAR AI advertises `tools` support for many models, and Groq documents tool use for all its models, but native tool calling via `OpenAiCompatLlm` has only been tested against a local stub server (parsing + 429 retry). `npm -w server run test:live` and `redteam-demo.ts` with `MODEL_*` set will verify it. All acceptance runs so far use the deterministic `MockLlm`.
- SSE `token` events are chunked from the finished model response, not streamed token-by-token from the model.
- The indexer polls vault view methods; it does not read block receipts, so `events.block_height` / `tx_hash` are empty. A FastNear/NearBlocks feed is future work.
- NEAR AI Cloud direct-completions endpoint and TEE attestation (Layer 2): not started.
- NEAR Intents (Layer 5): not touched (mainnet only, needs approval).
- Social login / custodial player accounts: not decided.
- Fee split, default fee, turns and TTL are placeholders (see open decisions in `SPEC.md` 11).
- `node:sqlite` is used for storage (experimental in Node 22; prints a warning).

## Libraries

Rust: `near-sdk` 5.30.1, `proptest`. TypeScript (Node 22): `near-api-js` 7.4.0 (`addFunctionCallAccessKey`, `nep413`), `near-sandbox` 0.3.5 (sandbox v2.14.0), `hono`, `@hono/node-server`, `tsx`, `node:sqlite`. Not used: `near-sdk-js`, `near-workspaces` (it depends on old `near-api-js` v5).

Dependency freshness checked at the end of Layer 1: `near-sdk` and `near-api-js` are at their latest releases; only dev type packages (`@types/node`, `typescript`) have newer majors.

## Security note on keys

`MODEL_API_KEY` / `NEARAI_API_KEY` are read from the environment / a gitignored `.env`; it is never printed or committed (`.env.example` has placeholders). Testnet and guardian private keys live in gitignored `.keys/`. Prompts are AES-256-GCM encrypted at rest.

License: MIT.
