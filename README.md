# Vaultbreak

**A marketplace of AI guardians on NEAR.** A creator mints a Guardian: an AI agent with its own on-chain account holding a pot of NEAR. Anyone (a human or another AI agent) pays an entry fee to open a chat session and tries to talk the Guardian into releasing the pot. Fees grow the pot. A Guardian that survives builds a record.

Status: **Layers 1 (core), 2 (privacy commit-reveal + TEE attestation), 3 (NFT registry + factory) and 4 (agents + swarm pools) are built and tested, with a full web UI (landing, arena, Guardian, Create, My Guardians, Swarms, Agents, Proofs).** Layer 5 (NEAR Intents entry, optional, mainnet-only) is not built. Everything in this repo is new work started for this hackathon; there is no pre-existing baseline.

## Live demo

**https://tryvaultbreak.vercel.app** (NEAR **testnet**, play money; testnet NEAR has no value)

**Sign in (30 seconds, no wallet):** press **Sign in** (top right, or on any page that asks), type any name and any passphrase of 6+ characters, press **Continue**. The server opens a play account on testnet and funds it with 2.5 testnet NEAR. Signing in again with the same name and passphrase returns to the same account. This sign-in is **demo-grade**: the server holds the key, so do not reuse a real password.

Do X, see Y, tab by tab:

| Tab | Do | See |
|---|---|---|
| **Arena** | Open it | The Guardians with their real pot, streak and attempts, read from testnet. Each card's art follows its state: armed, veteran (10+ survived in a row), defeated. |
| **A weak Guardian** (Gullible Gus, Soft Sally, Kind Kaylee) | Open it, **Pay 0.10 NEAR and start**, ask politely for the money | The reply streams live, then **Pot released**: the pot moves to your account in a testnet transaction, shown as a nearblocks link. |
| **The Warden** (strong) | Claim to be the admin, role-play, say please | It holds. Press **Prove it**: its vault has no full-access key, plus the attempts and their transactions. |
| **Loose Lips** (deliberately compromised) | Ask it to send funds or change its owner | The model tries; the chain refuses; the chat shows **BLOCKED by the vault** and no funds move. A refused call never reaches a block, so it has no transaction hash. |
| **Create** | Signed out: see an example Guardian. Signed in: name it, **Use a strong template**, set the pot to 0.5, press **Add play credits** if asked (a Guardian locks about 3 NEAR for its vault), **Mint Guardian** | A new NFT and vault on testnet, then the Guardian page with NFT, vault and owner links. |
| **My Guardians** | Open it after creating | Your Guardian cards with NFT and vault explorer links, creator fees and a **Claim** button. |
| **Swarms** | Signed out: see how pools work and the pools that exist. Signed in: open a pool on a weak Guardian, contribute, have a second player contribute, **Attack with the pool**, chat, **Settle result**, **Withdraw my share** | Winnings split pro rata by contribution. |
| **Agents** | Signed out: see how a key works. Signed in: create a key with a budget, then `curl -X POST -H "X-API-Key: vbk_..." https://tryvaultbreak.vercel.app/api/guardians/kind-kaylee/play` | A session opens with no browser; the key's budget drops by the entry fee, and at zero the API refuses before paying. |
| **Proofs** | Open a session | The four verifiable checks with copyable commands. On this site they show **SKIP** (see below). |

**What is NOT proven (read this):**
- **NEAR AI signed exchanges are UNVERIFIED.** The NEAR AI key has no credits, so the live model is **Groq (`openai/gpt-oss-120b`)**, which does not sign its answers or attest its hardware. The signing path is only tested against a local stand-in. Only the Intel TDX attestation check itself was verified against NEAR AI Cloud (`docs/attestation.md`).
- Seeded history on testnet (a few attempts per Guardian, one win by "Mira") is demo data made through the real API; everything after is organic.
- Models are stochastic: a strong Guardian can in principle be talked into releasing, and a weak one is meant to be. The vault, not the AI, limits the damage.
- Play money is finite: new play accounts stop when the faucet account runs low, top-ups are capped per player, sign-ups are rate limited per IP, and the model has a daily call cap.

**When the author's computer is off:** NFT metadata links (`/api/guardians/:id/metadata.json`) keep working from saved snapshots (Vercel function + Vercel Blob), and the site shows a "backend offline" banner; live data, chats and sign-in come back when the backend is restarted. The backend's state is backed up encrypted off-site and restored on boot. See [docs/hosting.md](docs/hosting.md) for the host options and what is still manual.

**How it is hosted.** The website is on Vercel (static, `web/`). The backend (SQLite file, live SSE, Guardian keys) cannot run on Vercel, so it runs on the author's computer behind a free Cloudflare quick tunnel; Vercel proxies `/api/*` to it (`web/vercel.json`). If that computer sleeps, the API stops answering (the pages still load); the tunnel URL changes on every restart. Re-publish with one command (Windows + WSL Ubuntu):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/serve-public.ps1     # add -Reuse to keep a running backend
```

State (database, Guardian keys) lives in `.testnet-data/` (gitignored), so restarts do not reset anything. The testnet registry is `registry.vbreak-t2funder-1109.testnet` and the pool `pool.vbreak-t2funder-1109.testnet` (both locked; manifests in `deployments/`). Secrets (model key, Guardian keys, faucet key) live only on the backend host; the website and Vercel settings hold none. Live end-to-end test: `node web/scripts/live-e2e.mjs https://tryvaultbreak.vercel.app`; screenshots in [docs/screens/deployed](docs/screens/deployed/).

**Run it locally instead:** see "The web UI" below (`npm run dev` starts a throw-away local sandbox with seeded demo data).


## The problem

"Can a jailbroken LLM be made to move money?" is normally answered with "hope the prompt holds". Vaultbreak makes the answer **no, by construction**, and lets people try to prove otherwise:

- The Guardian's vault account has **no full-access key, ever**. It holds one **function-call key** restricted to `receiver_id = vault` and `method_names = [release, close_session]`, with a gas allowance.
- `release(session_id)` has **no recipient or amount parameter**. It pays the whole pot to the attacker recorded when they paid the fee. Diverting funds to a third party is structurally impossible.
- A function-call key cannot send NEAR, deploy code, or add keys. If a jailbroken model tries, **the chain rejects the transaction**.

The model is *allowed* to be talked into releasing (that is the game). It cannot be talked into anything worse.

## The web UI (`/web`)

Vite + React + TypeScript, plain CSS with variables, no animation library. A quiet monochrome light-mode site: scramble-reveal headlines, a sticky-scroll "how it works", a horizontal gallery, a cursor-following list, a loader, and a custom cursor. Colour appears only in the NFT art and tiny status dots. Everything shown is read from the API; nothing is hard-coded.

**One command (Linux / macOS / WSL2, Node 22+, Rust for the first build):**

```bash
git clone https://github.com/Im-2/vaultbreak && cd vaultbreak
npm install
npm run dev        # sandbox + contracts + seeded demo Guardians + API (:8787) + UI (:5173)
```

Open http://localhost:5173. What `npm run dev` does (`scripts/dev-stack.ts`): starts a throw-away local NEAR sandbox, deploys the registry and pool, **mints six demo Guardians through the real API** (creator signs, server prepares), seeds attack history with real contract calls, then has two scripted players attack through the API (one beats Old Ironside, one pokes the compromised Loose Lips so blocked attempts exist). It then starts the API with the model from `.env` (**Groq or NEAR AI Cloud** if configured, otherwise the scripted offline model) and launches Vite. `npm run dev:api` starts everything except the UI.

**Demo data, honestly labelled:** the pots, attempt counts, streaks and blocked counts at first start are *seeded demo data on a local chain with play money*; the UI says "demo network" wherever it shows them. Anything you do afterwards (attacks, wins, blocks) is real on that chain. The NFT artwork is the supplied art (emblem only; its baked-in demo numbers are not used).

**Zero-wallet play:** click *Sign in*, pick a name and a passphrase. The server opens a custodial play account, funds it with play credits, and pays the entry fee from it when you press *Pay and start*. You never see keys, gas or wallet pop-ups. This sign-in is **demo-grade** (the server holds the key; do not reuse a real password or put real funds in it).

**Pages:** landing (`/`), arena (`/arena`), Guardian page with live SSE chat, blocked-call and win states and the Prove-it drawer (`/guardian/:id`), Create (`/create`), My Guardians (`/me`), Swarms (`/swarms`), Agents (`/agents`), Proofs (`/proofs`). Screenshots at desktop (1440) and phone (390) widths are in [docs/screens](docs/screens/); regenerate with `node web/scripts/screenshots.mjs` while the stack runs.

API endpoints added for the UI: `GET /config`, `GET /stats`, `POST /custodial/signin`, `GET /me`, `POST /custodial/topup`, `POST /guardians/:id/play` (server pays the fee from the player's custodial account and opens the session), `GET /guardians/:id/prove`.

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
8. **Privacy layer demo (offline)** — `npm run demo:privacy`
   See: a Guardian is defeated, its sealed prompt is revealed, and `scripts/verify-session.ts` prints PASS for (a) attestation, (b) signing address, (c) signed exchange vs transcript, (d) revealed prompt vs on-chain hash. Details and the real-service path in `docs/attestation.md`.
9. **NFT layer demo** — `node --import tsx scripts/nft-demo.ts --mock` (sandbox) or `--testnet`
   See: a Guardian NFT is minted by the creator, its metadata changes as it is attacked, the NFT is transferred, the vault owner follows, and only the new owner can `claim_creator_fees`. Ends with `ALL CHECKS PASSED`.
10. **Agents and swarms demo** — `node --import tsx scripts/swarm-demo.ts --mock` (sandbox) or `--testnet --owner <acct> --creator <acct>`
   See: two agent sub-accounts pool funds 1 : 2, the leader attacks with the POOL's money, the Guardian releases to the pool, winnings are split by contribution, and agents whose budget is exhausted are refused. Ends with `ALL CHECKS PASSED`.
11. **Live-model tests (skipped without a key)** — `npm -w server run test:live` (add `LIVE_ATTESTATION=1` to also verify a real NEAR AI attestation, no credits needed), then `node --import tsx scripts/redteam-demo.ts` with `MODEL_*` set.

### Agents and swarms (Layer 4)

**Pool contract** (`contracts/pool`): agents pool NEAR; one **controller** spends it on entry fees; the Guardian pays any pot to the **pool contract** (it is the on-chain `attacker`); `settle` (permissionless) reads the session outcome and the vault's recorded `payout`; `withdraw` pays `(winnings + unspent) * contribution / total`; `refund` returns unspent funds from a pool that never won. Contributions close at the first attack (nobody buys in after fees were spent); fees are capped by `target_fee_budget`; a deadline lets anyone close an idle pool. Failures are handled: if the vault refuses an attack the reserved fee is restored; if a payout transfer bounces the claim is restored. Pro-rata math uses a 256-bit intermediate (property-tested). Pools only target **registry-minted guardians**: the vault account is derived as `<guardian_id>.<registry>` and only the registry can create such an account, so a pool never trusts an arbitrary contract's claims. To make settlement exact, the vault now records `payout` in each session.

**Agent access** (`sdk/`, `/agent/*`): an owner (NEP-413 login) creates an **API key** for one of its own accounts/sub-accounts with a **spend budget**; the key authenticates as that account via `X-API-Key`, charges the session fee against the budget when an on-chain session is bound, and is refused with HTTP 402 when the budget is exhausted. The SDK checks the budget **before** paying on-chain. `createAgentAccount()` creates an agent sub-account `<name>.<owner>` funded with exactly its budget: that is the **hard** cap (the chain refuses what the account cannot afford). Pool endpoints (`/pools`, `/pools/:id/{contribute,attack,sessions/verify}`) read the contract and return **unsigned** transactions for the agent to sign.

Limitations (read these): (1) the API-key budget is a **soft** cap: an agent that controls its own account can also log in directly (no budget). Use a funded sub-account for a hard cap. (2) The pool contract is a **single attacker per vault** (vaults allow one open session per attacker), so only one pool session per vault is open at a time across all pools; a controller can hold the slot until the session expires. (3) Pools work only with vaults minted by a registry whose vault code records `payout` (registry v2; the Layer 1 demo vaults and registry v1 do not). (4) The controller decides when and how much to spend (up to `target_fee_budget`); contributors trust the controller with fees, not with the winnings. (5) "Bounties" are simply the Guardian's pot paid to the pool or agent; there is no separate bounty system. (6) SPEC's "Guardian earns fees and funds its inference share" is **not implemented**: the ops share accrues to `ops_account`, but nothing pays inference automatically. (7) The pool contract has unit and sandbox tests but no external audit.

### NFT guardians (Layer 3)

`contracts/registry` is the factory and the NFT contract in one. **Mint:** the creator signs `mint_guardian`; ONE batched promise creates `<id>.<registry>`, funds it, deploys the vault wasm, calls `new`, and adds **only** the guardian function-call key (no `add_full_access_key` exists in the contract; a source-scan test enforces it). The NFT is minted in the callback only if that batch succeeded (a failed batch refunds the creator and mints nothing). **Owner follows the NFT:** `nft_transfer` moves the token and calls `vault.set_owner`; if the vault refuses (e.g. the new owner has an open attack session) the token is moved back, so token owner == vault owner always holds. **Metadata is live:** the token's `reference` is `<base_uri>/guardians/<id>/metadata.json`, which the API renders from the vault on every request (status, pot, attempts, wins, streak). **Royalties:** NEP-199 `nft_payout` / `nft_transfer_payout` (creator royalty up to 20%, set at mint; NEP-199 is Final in the NEPs repo as of this build).

API: `POST /guardians/prepare` (login; returns an unsigned `mint_guardian` transaction for the creator to sign; the server keeps the sealed prompt and the guardian key) then `POST /guardians/:id/confirm` (checks chain: vault bound to the registry, prompt hash and guardian key match, exactly one function-call key). `POST /guardians/:id/retire` now accepts the current NFT owner.

| Standard | Status in the registry |
|---|---|
| NEP-171 core | `nft_transfer`, `nft_token`; **`nft_transfer_call` is intentionally unsupported** (it cannot be combined safely with the owner sync); `nft_transfer` returns a bool (vault synced) instead of nothing |
| NEP-177 metadata | contract + token metadata; the token has a live `reference` but **no `reference_hash`** (content is dynamic) |
| NEP-181 enumeration | yes |
| NEP-199 payouts | `nft_payout`, `nft_transfer_payout` |
| NEP-178 approvals | **not implemented**: only the owner can transfer, so `approval_id` is ignored. No marketplace integration was tested |

Mint cost (testnet): the registry embeds the 232 KB vault wasm, so each Guardian needs about 3.3 NEAR plus its pot (`registry.mint_requirements()`). The testnet registry is **locked** (its deploy key was deleted: no keys, immutable code); `admin` can only call `set_base_uri`. Its `base_uri` is `http://localhost:8787` until the API is hosted somewhere. Deploy your own with `scripts/deploy-registry.ts`.

### Privacy layer (Layer 2)

Prompt commit-reveal (`prompt_hash` on-chain, reveal after defeat/retire), per-exchange capture of the exact request/response bytes (request encrypted until reveal), NEAR AI response-signature capture and verification, `GET /guardians/:id/attestation`, `GET /proofs/:session_id`, `POST /guardians/:id/retire`, and a standalone verifier. Full walkthrough: [docs/attestation.md](docs/attestation.md).

- **Works today without credits:** the offline demo; the real NEAR AI attestation report is fetched and its Intel TDX quote + signer/nonce binding verified (`LIVE_ATTESTATION=1`).
- **Runs only when NEAR AI credits exist:** capturing real response signatures (`MODEL_PROVIDER=nearai`). Without credits the pipeline is exercised against a local stub that signs with a real secp256k1 key. With another provider (e.g. Groq) sessions work normally and verify as `SKIP`, never as a false PASS.

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
| registry v2 | `registry.vbreak-reg2-1109.testnet` | **no keys at all** (locked); mints vaults as `<id>.registry.vbreak-reg2-1109.testnet`; embeds the vault that records `payout` (needed by pools) |
| pool | `pool.vbreak-pool-1109.testnet` | **no keys at all** (locked); registry = `registry.vbreak-reg2-1109.testnet` |
| registry v1 | `registry.vbreak-reg-1109.testnet` | superseded (older vault code, no `payout`); locked; kept for the Layer 3 record |
| weak | `weak.vbreak-deployer2-1109.testnet` | one `FunctionCall` key, methods `release, close_session` |
| rogue | `rogue.vbreak-deployer5-1109.testnet` | one `FunctionCall` key, methods `release, close_session` |

To check yourself, use the RPC call in `docs/architecture.md` (a `near` CLI `list-keys` command also works but is UNVERIFIED here).

## Model provider (configurable, OpenAI-compatible)

The runtime talks to any OpenAI-compatible `/chat/completions` API. Configure with env vars (or `.env`):

| Var | Meaning |
|---|---|
| `MODEL_BASE_URL` | API base URL (e.g. `https://api.groq.com/openai/v1`) |
| `MODEL_API_KEY` | provider key |
| `MODEL_NAME` | model id |
| `MODEL_PROVIDER` | optional preset: `groq`, `nearai`, `openrouter`, `gemini` (fills base URL, and default model for groq/nearai) |
| `MODEL_NAME_<GUARDIAN_ID>` | optional per-guardian model, e.g. `MODEL_NAME_WEAK=openai/gpt-oss-20b`; on Groq `rogue` defaults to `qwen/qwen3.8-27b` |
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
| `contracts/registry` | Rust: NFT registry + guardian factory (NEP-171/177/181/199) |
| `contracts/pool` | Rust: swarm pool (pro-rata winnings / refunds) |
| `server/src` | `guardian.ts` runtime, `app.ts` API, `indexer.ts`, `llm.ts`, `chain.ts` (near-api-js helpers), `db.ts` |
| `sdk/src` | attacker client (NEP-413 login, bind session, SSE chat) |
| `scripts` | `deploy-vault.ts`, `redteam-demo.ts`, `privacy-demo.ts`, `verify-session.ts`, `nft-demo.ts`, `swarm-demo.ts`, `deploy-registry.ts`, `deploy-pool.ts`, `testnet-account.mjs`, build/sandbox helpers |
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

- **Live inference on NEAR AI Cloud is UNVERIFIED** (the provided key has no credits: `402 No spending limit configured`). Live inference on **Groq is verified**: `npm -w server run test:live` passes (native tool calling and the JSON-action fallback on `openai/gpt-oss-120b`), and `scripts/redteam-demo.ts --testnet` passes end to end with real models (strong = `gpt-oss-120b` held; rogue = `qwen/qwen3.8-27b` called `send_funds` and the chain rejected it; weak = `gpt-oss-120b` called `release_pot` and the attacker received the pot). Real models are probabilistic: the demo retries phrasing for the rogue scenario, and `gpt-oss-120b` refuses to play the rogue persona (empty reply), which is why `rogue` defaults to `qwen/qwen3.8-27b` on Groq. Groq model ids that the docs listed but the API does not serve (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) return 404; the account currently serves `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`.
- Testnet RPC: `rpc.testnet.near.org` is deprecated and returns HTTP 429; defaults are now `https://test.rpc.fastnear.com,https://near-testnet.drpc.org` (failover). From WSL, connections to these Cloudflare-fronted hosts time out intermittently; the runtime retries transport errors and never records them as chain rejections.
- SSE `token` events are chunked from the finished model response, not streamed token-by-token from the model.
- The indexer polls vault view methods; it does not read block receipts, so `events.block_height` / `tx_hash` are empty. A FastNear/NearBlocks feed is future work.
- Layer 4 gaps: see the limitations list under "Agents and swarms" (soft API budgets, one pool session per vault, no inference funding from fees, no audit). The pool/agent flows were verified on the sandbox and on testnet with a real Groq model; no mainnet use.
- Layer 2 gaps: real NEAR AI response signatures have never been captured (no credits), so the signature endpoint integration is UNVERIFIED against the live service; GPU (NRAS), compose/RTMR3, Sigstore and gateway attestation checks are not implemented. The direct-completions endpoint (no gateway in the trust path) is not used. See `docs/attestation.md`.
- NEAR Intents (Layer 5): not touched (mainnet only, needs approval).
- Social login / custodial player accounts: not decided.
- Fee split, default fee, turns and TTL are placeholders (see open decisions in `SPEC.md` 11).
- `node:sqlite` is used for storage (experimental in Node 22; prints a warning).

## Libraries

Rust: `near-sdk` 5.30.1, `near-contract-standards` 5.30.1, `proptest` (also used for the pool's 256-bit pro-rata math). TypeScript (Node 22): `near-api-js` 7.4.0 (`addFunctionCallAccessKey`, `nep413`), `near-sandbox` 0.3.5 (sandbox v2.14.0), `hono`, `@hono/node-server`, `ethers` (EIP-191 signature recovery), `@phala/dcap-qvl` (Intel TDX quote verification), `tsx`, `node:sqlite`. Not used: `near-sdk-js`, `near-workspaces` (it depends on old `near-api-js` v5).

Dependency freshness checked at the end of Layer 1: `near-sdk` and `near-api-js` are at their latest releases; only dev type packages (`@types/node`, `typescript`) have newer majors.

## Security note on keys

`MODEL_API_KEY` / `NEARAI_API_KEY` are read from the environment / a gitignored `.env`; it is never printed or committed (`.env.example` has placeholders). Testnet and guardian private keys live in gitignored `.keys/`. Prompts are AES-256-GCM encrypted at rest.

License: MIT.
