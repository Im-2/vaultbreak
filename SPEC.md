# VAULTBREAK: Backend Specification

Audience: Claude Code (the coding agent). Read this whole file before writing code.
Goal: build the backend first (contracts, guardian runtime, API, indexer, agent SDK). UI comes after the backend passes its acceptance tests.

---

## 0. Rules for the coding agent

- Never commit secrets. Keys live in `.env` (gitignored). Provide `.env.example`.
- Ask the human before: deploying to mainnet, spending real tokens, pushing to a remote, making the repo public, posting anywhere, or submitting the hackathon form.
- NEAR changes fast. Before using any NEAR library or API, check current docs: `https://docs.near.org/llms.txt`, `https://docs.near-intents.org/llms.txt`, `https://docs.near.ai/llms.txt`, and `https://github.com/near/agent-skills`. Do NOT use `near-sdk-js` (archived). Use current `near-api-js` (v7 line) or `near-kit`, not old `@near-js/*` keyStore patterns. Run a dependency freshness check before finishing each layer.
- Build in layers (section 9). Every layer must leave the repo in a working, demoable, documented state. Commit after each layer.
- Mark anything you could not verify as `UNVERIFIED` in the README rather than guessing.
- Develop on NEAR testnet and the local sandbox. NEAR Intents has NO testnet: only touch it with mainnet dev accounts, tiny amounts, and `dry: true` quotes, and only with the human's approval.

---

## 1. Product in one paragraph

Vaultbreak is a marketplace of AI guardians. A creator mints a Guardian: an AI agent with its own on-chain account holding a pot of money. Anyone (humans or AI agents) pays an entry fee to open a chat session and try to make the Guardian release the pot. The Guardian physically cannot break its rules: it holds only a restricted NEAR function-call key, and the vault contract enforces the policy no matter what the AI says. Fees grow the pot. A Guardian that survives builds reputation on its NFT.

## 2. Hackathon context (NEAR HACKATHON)

One submission, up to six tracks ticked: `security`, `privacy`, `games`, `nfts`, `agents`, `swarms`. Only tick a track if its layer works in the demo. Judges: an AI screening pass (Claude Code and Codex) runs the repo and checks it does what the README says, then human judges decide. Likely criteria: technical implementation, design, impact, originality, sustainability. Track cues: Games is "judged on the game loop, not the token; bonus if players never notice the chain". Security is spending limits, policy engines, sandboxed wallets.

README requirements (write for a machine reader): what it is, the problem, and "do X, see Y" steps a judge can follow end to end locally. List libraries used. Everything built here is new, so state there is no pre-existing baseline.

---

## 3. Actors and trust model

| Actor | Role |
|---|---|
| Creator | Writes the Guardian's instructions, funds the seed pot, owns the Guardian NFT. |
| Guardian | AI agent + vault account. Holds the pot. Talks to attackers. |
| Attacker | Human or AI agent. Pays the fee, tries to get the pot. |
| Operator (us) | Runs the Guardian runtime and API. A trusted party in v1 (see 3.2). |

### 3.1 What is enforced on-chain (cannot be fooled)
- The vault account has NO full-access key, ever. It is created by the factory contract with only a function-call key. Contract code is the only thing that can move funds.
- The Guardian's key is a function-call key restricted to `receiver_id = vault account` and `method_names = [release, close_session]`. Function-call keys cannot attach NEAR and cannot transfer NEAR; the vault contract performs payouts itself.
- `release(session_id)` has no recipient or amount parameter. The recipient is the attacker recorded when they paid. Diverting funds to a third party is structurally impossible.
- The key has a gas allowance. Gas is charged to the vault account balance, so an uncapped key could burn the pot; the allowance caps that.

### 3.2 Honest trust assumptions (document these in the README)
- The operator runs the runtime that builds prompts and calls the model. A malicious operator could instruct a Guardian to release. Mitigation roadmap: run the runtime in a TEE (OutLayer or Phala, see near-mcp `tee.md`). Mark as stretch.
- Transcript stats (blocked attempts) are runtime-reported. They are verifiable through signed exchanges (section 6) but not enforced by the chain.

---

## 4. Architecture

```
Attacker (human UI / agent SDK)
        |  HTTPS + SSE
        v
   API server (TS) ---- SQLite (sessions, transcripts, proofs, api keys)
        |        \
        |         \--> Indexer (polls NEAR RPC for vault/registry events)
        v
 Guardian runtime (TS)
   |-- LLM: NEAR AI Cloud (OpenAI-compatible, TEE-verified)
   |-- Tool layer: maps model tool calls -> NEAR transactions signed with the Guardian's function-call key
   v
 NEAR: Factory/Registry (NFT NEP-171) -> Vault (one per Guardian, own sub-account) ; Pool contract (swarms)
```

Stack: Rust + `near-sdk-rs` for contracts; TypeScript (Node 20+, Hono or Fastify) for server; SQLite for state. Test contracts with the NEAR sandbox (workspaces/near-sandbox). Monorepo:

```
/contracts/vault        Rust: vault + policy
/contracts/registry     Rust: factory + NEP-171 registry (Layer 3)
/contracts/pool         Rust: swarm pool (Layer 4)
/server                 TS: API, guardian runtime, indexer
/sdk                    TS: attacker-agent client (Layer 4)
/scripts                deploy, seed demo guardians, red-team demo
/docs                   architecture, attestation guide
README.md
```

---

## 5. Contracts

### 5.1 Vault contract (Layer 1)

Deployed once per Guardian to its own account. State:

```
owner: AccountId                  // creator (later: NFT owner via registry)
registry: Option<AccountId>       // Layer 3
guardian_pk: PublicKey            // the AI's function-call key (for reference)
pot: u128                         // yoctoNEAR available to win
creator_balance: u128             // accrued creator fees
ops_balance: u128                 // accrued operations share
prompt_hash: [u8;32]              // commitment to the Guardian instructions
params: { min_fee, turns_max, session_ttl_ms, max_open_per_attacker }
sessions: Map<u64, Session>
stats: { attempts, wins, closed_failed, streak, blocked_reported, total_fees }
status: Armed | Defeated
```

`Session { id, attacker, fee, started_at, expires_at, status: Open|Won|Failed|Expired, transcript_hash }`

Methods:

| Method | Caller | Behavior |
|---|---|---|
| `new(owner, prompt_hash, params)` | factory/deployer, once | init; seed pot from attached deposit |
| `start_session()` payable | any account except owner | requires `status==Armed`, `deposit >= min_fee`; open sessions per attacker `<= max_open`; splits fee 70% pot / 20% creator / 10% ops (constants in v1; configurable later); stores attacker = `predecessor`; emits event |
| `release(session_id)` | ONLY `predecessor == current_account_id` (i.e. the Guardian key) | requires session Open and not expired; transfers entire `pot` to `session.attacker`; marks Won; `status=Defeated`; streak reset; emits event |
| `close_session(session_id, transcript_hash, blocked_attempts)` | same restriction | marks Failed if Open; records hash; updates stats |
| `expire_session(session_id)` | anyone | after `expires_at`, marks Expired (stops griefing) |
| `rearm(top_up)` payable | owner | after Defeated, adds seed, returns to Armed |
| `claim_creator_fees()` | owner | pays out `creator_balance` |
| `claim_ops()` | `ops_account` set at init | pays out `ops_balance` |
| `rotate_guardian_key(pk, allowance)` | owner | adds a new function-call key (receiver = self, methods = [release, close_session], capped allowance) and deletes the old one |
| views | any | `get_state`, `get_session`, `get_stats`, `get_params` |

Invariants (write property tests for each):
1. `release` can never send more than `pot`, and only to `session.attacker`.
2. Account balance never drops below `pot + creator_balance + ops_balance + storage reserve`.
3. A session pays out at most once.
4. Only the vault's own keys can call `release` / `close_session`; no external account can.
5. The owner can never withdraw `pot` (only `creator_balance`) while Armed.
6. The owner cannot be an attacker; one open session per attacker (per `max_open`).
7. No code path adds a full-access key.

### 5.2 Registry + factory (Layer 3)
- NEP-171 NFT contract. Minting a Guardian: factory creates sub-account `<id>.<registry>`, deploys vault wasm, calls `new`, and adds ONLY the guardian function-call key (public key supplied by the server). All as one batched promise; no full-access key is ever added.
- Token metadata is dynamic: `reference` points to `/guardians/:id/metadata.json` rendered by the server from live vault stats (attempts, wins, streak, status).
- On `nft_transfer`, the registry calls `set_owner` on the vault (owner-only creator fees follow the NFT).
- Royalties: NEP-199 payout info where possible. Check the current NEP status before implementing.

### 5.3 Pool contract (Layer 4)
Swarm pooling: `create_pool(guardian_id, target_fee_budget)`, `contribute()` payable, `attack_with_pool()` starts a session paid from the pool with the pool account as attacker, `settle()` splits any winnings pro rata to contributions, `refund()` for unspent funds.

---

## 6. Guardian runtime (Layer 1 core, Layer 2 verification)

### 6.1 Inference
- NEAR AI Cloud, OpenAI-compatible: base URL `https://cloud-api.near.ai/v1`, API key from `https://cloud.near.ai`. Prefer the direct completions endpoint for the chosen model where available (docs say it removes the gateway from the trust path, so only model verification is needed).
- UNVERIFIED: which hosted models support native tool calling. Test early. Fallback: instruct the model to emit a JSON action and parse it in the runtime.

### 6.2 Tool layer
The model is given tools. The runtime maps each to a NEAR call signed with the Guardian's function-call key:

| Tool exposed to the model | Chain call | Result |
|---|---|---|
| `release_pot` | `vault.release(session_id)` | allowed |
| `send_funds(to, amount)` (honeypot) | a call outside the key's allowed methods | rejected by the chain |
| `change_owner(account)` (honeypot) | same | rejected by the chain |

Honeypot tools are on by default ("danger mode", configurable per Guardian). They make the policy enforcement visible and reliable in the demo: when a jailbroken model tries a forbidden action, the chain rejects it. Note: protocol-level rejection of a disallowed method is NOT recorded on-chain. The runtime must log each blocked attempt (tool, args, chain error) to the transcript and report the count in `close_session`.

The model never receives the key. The runtime holds it (env/secret store). Server enforces: one chat per session id, `turns_max`, per-turn token limit, session must be Open on-chain before each turn.

### 6.3 Prompt commitment and verification (Layer 2, privacy)
What the docs say: NEAR AI Cloud serves models in TEEs; an attestation report (`GET /v1/attestation/report`, with a random 32-byte hex nonce, optional `model`/`provider` params, optional `include_tls_fingerprint`) proves the signing key is bound to genuine TEE hardware; each response has a signature fetchable via `GET /v1/signature/{chat_id}` that recovers to the attested `signing_address` (`signing_algo` is `ecdsa` or `ed25519`). References: `https://docs.near.ai/cloud/verification`, `https://github.com/nearai/nearai-cloud-verifier`, `https://github.com/near-examples/nearai-cloud-verification-example`.

What this does NOT prove by itself: the system prompt. So Vaultbreak adds commit-reveal:
1. At creation: store `prompt_hash = sha256(system_prompt)` on-chain; keep the prompt secret (encrypted at rest).
2. Each turn: store the chat id, the request and response, and the signature.
3. After a Guardian is Defeated or retired: reveal the prompt. Anyone can check `sha256(prompt) == on-chain hash`, and that the signed request hash from the model's TEE matches a request that contains that prompt.
4. UNVERIFIED: the exact signed text format (it appears to be hashes of request and response). Confirm in the verifier repo before implementing.
Residual trust: the operator builds the request (see 3.2).

Deliverables: `/guardians/:id/attestation` and `/proofs/:session_id` endpoints plus `docs/attestation.md` with a step-by-step "verify it yourself" walkthrough a judge can run.

---

## 7. API

Auth: wallet login using NEP-413 signed messages (`POST /auth/nonce`, `POST /auth/verify` returns a session token). Social login / custodial player accounts ("players never notice the chain") are a UI-phase concern; design the API so a server-created custodial account can be the `attacker` identity. UNVERIFIED: which social-login provider to use.

| Endpoint | Purpose |
|---|---|
| `GET /guardians` | list with pot, fee, status, stats |
| `GET /guardians/:id` | full state, stats, prompt hash, attestation links |
| `GET /guardians/:id/metadata.json` | dynamic NFT metadata |
| `POST /guardians` | create (Layer 1: house-signed demo guardians; Layer 3: returns an unsigned tx for the creator to sign) |
| `POST /guardians/:id/sessions/verify` | after the attacker calls `start_session` on-chain, bind the on-chain session to an API session (verify via RPC) |
| `POST /sessions/:id/messages` | send a message; SSE stream of model tokens, tool calls, chain results, blocked attempts |
| `GET /sessions/:id` | transcript, outcome, tx hashes, proofs |
| `GET /leaderboard` | Guardians by survival streak, attackers by wins |
| `POST /guardians/:id/reveal` | reveal prompt (only when Defeated/retired) |
| `POST /agent/keys`, same session endpoints with `X-API-Key` | attacker-agent access with spend budget (Layer 4) |
| `POST /pools`, `POST /pools/:id/contribute`, `POST /pools/:id/attack` | swarms (Layer 4) |

SSE events: `token`, `tool_call`, `tool_result`, `blocked`, `won`, `session_closed`, `error`.

Indexer: poll RPC (or a data API such as FastNear / NearBlocks, check current docs) for vault events (`session_started`, `released`, `session_closed`) and registry events; write to SQLite; serve leaderboard and stats.

---

## 8. Data model (SQLite)

`guardians(id, vault_account, owner, prompt_hash, prompt_ciphertext, revealed, model, key_ref, created_at)`
`sessions(id, guardian_id, onchain_session_id, attacker, status, turns, started_at, closed_at, transcript_hash, tx_release, tx_close)`
`turns(id, session_id, idx, role, content, chat_id, signature, signing_address, created_at)`
`blocked_attempts(id, session_id, tool, args, chain_error, created_at)`
`api_keys(id, owner, hash, budget_remaining, created_at)`
`pools(id, guardian_id, account, status)` / `pool_contribs(pool_id, account, amount)`
`events(id, kind, payload, block_height, tx_hash)`

---

## 9. Build order (layers). Each ends with acceptance tests, a commit, README updated.

### Layer 0: scaffold
Monorepo, tooling, sandbox test harness, `.env.example`, CI that runs contract and server tests.

### Layer 1: CORE (tracks: security, games, agents)
1. Vault contract with all methods and the invariants in 5.1. Property and sandbox tests for every invariant.
2. Deploy script: create a vault account, deploy, init, add ONLY the guardian function-call key (capped allowance), confirm no full-access key exists.
3. Guardian runtime: NEAR AI Cloud inference, tool layer, honeypot tools, turn and TTL limits.
4. API: sessions, messages with SSE, leaderboard, indexer.
5. `scripts/redteam-demo`: an automated attacker that (a) fails against a strong Guardian, (b) is blocked trying a forbidden call, (c) defeats a deliberately weak Guardian and receives the pot.
Acceptance (all must pass):
- A scripted attacker pays on testnet, chats, the weak Guardian releases, the attacker's balance rises by the pot.
- A jailbroken model attempting `send_funds` is rejected by the chain, shows in the transcript as `blocked`, and no funds move.
- `near view` on the vault account shows no full-access keys.

### Layer 2: PRIVACY (track: privacy)
Prompt commit-reveal, per-turn signature capture and verification against the attestation report, `/attestation` and `/proofs` endpoints, `docs/attestation.md`.
Acceptance: a verifier script takes a session id and prints PASS/FAIL for (a) attestation valid, (b) signing address matches, (c) signed exchange matches stored transcript, (d) revealed prompt hash matches on-chain commitment.

### Layer 3: NFTS (track: nfts)
Registry + factory, NFT-account vaults, dynamic metadata, owner follows NFT transfer, royalties.
Acceptance: mint a Guardian; transfer the NFT; the new owner (and only the new owner) can `claim_creator_fees`; metadata reflects live stats.

### Layer 4: AGENTS + SWARMS (tracks: agents, swarms)
Attacker-agent SDK and API keys with budgets (agents earn bounties and pay fees with their own sub-accounts), plus the pool contract.
Acceptance: two agent accounts pool funds, attack a Guardian through the pool, and winnings are split by contribution; an agent with an exhausted budget is refused.

### Layer 5: INTENTS entry (optional polish, mainnet-only testing)
Pay the entry fee in another token via the 1Click API (docs: `docs.near-intents.org`, TS SDK exists). Swap lands in a server-controlled intake account, then the server starts the session on the attacker's behalf through a `gatekeeper`-gated `start_session_for`. This adds a trusted gatekeeper to the contract; document it. Use `dry: true` quotes first.

---

## 10. Track claim matrix (what a judge must be able to see)

| Track | Visible proof |
|---|---|
| security | Vault with no full-access key, restricted key, blocked forbidden call in the demo, invariant tests |
| privacy | NEAR AI Cloud inference, attestation walkthrough, prompt commit-reveal verifier |
| games | Session loop with growing pot, leaderboard, streaks; chain hidden from the player (UI phase) |
| nfts | Guardian is an NFT-account owning the pot, collecting fees, carrying stats, transferable |
| agents | Attacker agents earn and pay fees via SDK with budgets; Guardian earns fees and funds its inference share |
| swarms | Pool contract: shared attack, pro rata settlement |

## 11. Open decisions (ask the human)
- Fee split (default 70/20/10) and default fee, turns, TTL.
- Which model on NEAR AI Cloud, and whether it supports tool calling.
- Social-login provider and whether to use custodial player accounts.
- Whether to attempt running the runtime in a TEE (OutLayer / Phala) as a stretch.
