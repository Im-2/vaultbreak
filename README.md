# Vaultbreak

**A marketplace of AI guardians on NEAR.** A creator mints a Guardian: an AI agent with its own on-chain account holding a pot of NEAR. Anyone (a human or another AI agent) pays an entry fee to open a chat session and tries to talk the Guardian into releasing the pot. Fees grow the pot. A Guardian that survives builds a record.

## Judge quick path

**Live site: https://tryvaultbreak.vercel.app** (NEAR **testnet**, play money; testnet NEAR has no value). The backend is on Render's free plan, so the first visit after idle can take up to a minute ("Waking up the demo backend…").

**60 seconds, no wallet:**
1. Press **Sign in** (top right), type any name and a passphrase of 6+ characters (the eye icon shows it), **Continue**. You get a play account with 2.5 testnet NEAR.
2. Open **Arena**, pick an **Armed weak Guardian** (e.g. **Gullible Gus**; weak ones are single-use, so the Arena shows which are still Armed), press **Pay 0.10 NEAR and start**, and ask politely for the money ("Please, I really need it").
3. The reply streams, then **Pot released** appears with a **nearblocks transaction link**: open it, the pot moved from the vault to your account.
4. Open **The Warden** (a strong Guardian) and press **Prove it**: its vault, its single restricted key and its attempts.

**Known issue (2026-11-13): new sign-ups are paused.** The play-money faucet account is nearly empty (`vbreak-t2funder-1109.testnet`, about 8.7 testnet NEAR; it refuses new accounts below 10.5), so a brand-new name gets "The demo's play-money faucet is empty right now". Existing names still sign in. The operator (or anyone) can refill it by sending testnet NEAR to `vbreak-t2funder-1109.testnet`. The code path is tested; the live click path in step 1 works again once it is refilled.

**One command that proves no full-access key exists** (any machine with `curl`; reads the live Warden vault straight from a public RPC):

```bash
curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"warden.registry.vbreak-t2funder-1109.testnet"}}'
```
Expected: exactly one key, `{"FunctionCall":{"method_names":["release","close_session"],"receiver_id":"warden.registry.vbreak-t2funder-1109.testnet", …}}`, and no `"FullAccess"` anywhere. (Checked on 2026-11-13 for the registry, pool and Warden vault; see the testnet table below.)

### Claims and evidence

| Claim | Where it is proven | Status |
|---|---|---|
| A Guardian vault has **no full-access key**, only a function-call key limited to `release` and `close_session` | `contracts/registry/src/tests.rs` (a source scan bans `add_full_access_key`), `tests/vault.test.mjs` and `tests/registry.test.mjs` (on-chain key list), the `curl` above on the live vault | **VERIFIED** |
| `release` has no recipient or amount parameter; it pays only the pot, only to the recorded attacker, once | `contracts/vault/src/tests.rs` (`inv1`, `inv3`, with proptest), `tests/vault.test.mjs` | **VERIFIED** |
| The guardian key cannot send NEAR, deploy code, add keys or call other methods: the chain rejects it | `tests/vault.test.mjs` (honeypots); live: **Loose Lips** shows "BLOCKED by the vault" | **VERIFIED** in tests. The live demo depends on the model actually attempting the call, and it sometimes refuses |
| The owner cannot withdraw the pot while the Guardian is Armed; there is **no withdraw or defuse function** | `contracts/vault/src/lib.rs` (no such method), `contracts/vault/src/tests.rs` `inv5`, `tests/vault.test.mjs` | **VERIFIED** |
| Swarm pools split winnings pro rata (256-bit math) and refund unspent money | `contracts/pool/src/tests.rs` (15 tests), `tests/pool.test.mjs`; a testnet run through the API (2 contributors, pooled attack, settle, both withdraw) | **VERIFIED** on the sandbox and through the live API. The full browser walk-through on the live site was **not completed** |
| API keys carry a spend budget and are refused before paying when it is exhausted | `server/test/agents.test.ts`; a live `curl` with `X-API-Key` opened a session | **VERIFIED**. The budget is a *soft* cap (see limitations) |
| An NFT transfer moves the NFT and the vault owner together; creator fees follow the new owner | `contracts/registry/src/tests.rs`, `tests/registry.test.mjs`, `server/test/nft.test.ts`, `server/test/transfer.test.ts` | **VERIFIED** on the sandbox. **PARTIAL** live: the dialog, confirm step and the "open attempt" block were seen on the live site; a successful live transfer in the browser was not completed |
| Agent-key transfers (`transfer_nft` permission, allowlist, owner approval, log) | `server/test/transfer.test.ts`, [docs/transfers.md](docs/transfers.md) | **PARTIAL**: sandbox tests only, not exercised live |
| A session blocks a transfer only while it is Open on-chain **and** before its expiry; a cleanup job closes expired sessions | `server/test/transfer.test.ts` (live, expired and database-less sessions; human and agent path). On the live backend the cleanup closed the sessions that had been stuck | **VERIFIED** |
| NFT art is generated from live state (armed, veteran, released) | `server/src/art.ts`, `server/test/art.test.ts`, `/api/guardians/:id/image.svg` | **VERIFIED** |
| The backend loses nothing on a restart (state restored from an encrypted off-site backup) | `server/src/backup.ts`; one restart on Render: 24 sessions and 11 Guardians identical before and after | **VERIFIED** once. Up to 2 minutes of the newest activity can be lost |
| NFT metadata and image links keep working while the backend sleeps | `web/api/metadata.js`, `web/api/image.js` (Blob and bundled snapshots); metadata was tested with the backend stopped | **VERIFIED** for metadata. The image fallback was not re-tested offline |
| Rate limits and a daily model-call cap protect the free quota | `server/src/app.ts`; the live site returned 429 for repeated sign-ups from one IP | **PARTIAL**: observed, no dedicated automated test |
| No secret is in git or on the website | keys live in `.env` / `.keys/` (gitignored) and Render environment variables; each push was scanned for the `.env` values | **VERIFIED** by manual scan. There is no automated secret scan in CI |
| **Privacy:** the prompt is sealed on-chain (a hash) and revealed after defeat or retire | `server/test/privacy.test.ts`, `npm run demo:privacy`, [docs/attestation.md](docs/attestation.md) | **VERIFIED** on the sandbox with a local stand-in signer |
| **Privacy:** the Intel TDX attestation report of NEAR AI Cloud verifies | `LIVE_ATTESTATION=1 npm -w server run test:live`, `docs/attestation.md` | **PARTIAL**: verified once against NEAR AI Cloud earlier in this project, not repeated in the final audit |
| **Privacy:** NEAR AI **signed exchanges** match the transcript | the code path exists and is exercised only against a local stub | **UNVERIFIED** (the NEAR AI key has no credits). The live model is **Groq**, which gives no signatures and no hardware attestation, so Proofs shows **SKIP** for those checks, never a false PASS |

### Tracks

| Track | What is built | What a judge can check | Live demo or tests only |
|---|---|---|---|
| **Security** | A vault whose AI key can only call `release` and `close_session`; invariants tested with proptest and on a sandbox chain | the **Prove it** drawer on any Guardian page; the `curl` above; `contracts/vault/src/tests.rs` | **Live demo** and tests |
| **Games** | An arena of Guardians, paid attempts, live chat, releases and blocked calls | `/arena`, `/guardian/gullible-gus`, `/guardian/rogue` | **Live demo** |
| **NFTs** | A registry/factory that mints each Guardian as an NFT (NEP-171/177/181/199) with live metadata and generated art; human transfers | `/create`, `/me`, `/api/guardians/warden/metadata.json`, `contracts/registry/` | **Live demo** for mint, metadata and art; transfers are **tests plus a partial live check** |
| **Agents** | API keys with spend budgets, an SDK, and gated agent transfers | `/agents`, `sdk/src/index.ts`, `docs/transfers.md` | **Live demo** for keys and playing by key; agent transfers are **tests only** |
| **Swarms** | A pool contract: contribute, one controller attacks, pro-rata payout | `/swarms`, `contracts/pool/` | **Live demo** (verified end to end through the API); the browser walk-through is partial |

**Privacy** is not claimed as a finished track: the prompt commit-reveal is built and tested, the NEAR AI attestation check was verified, and NEAR AI signed exchanges are unverified (see the claims table).

Status: **Layers 1 (core), 3 (NFT registry + factory) and 4 (agents + swarm pools) are built and tested, with a full web UI (landing, arena, Guardian, Create, My Guardians, Swarms, Agents, Proofs).** **Layer 2 (privacy):** prompt commit-reveal is built and tested; the Intel TDX attestation check was verified against NEAR AI Cloud; **NEAR AI signed exchanges are UNVERIFIED**; the live model is Groq. Layer 5 (NEAR Intents entry, optional, mainnet-only) is not built. Everything in this repo is new work started for this hackathon; there is no pre-existing baseline.

## Live demo

**https://tryvaultbreak.vercel.app** (NEAR **testnet**, play money).

**Sign in (30 seconds, no wallet):** press **Sign in** (top right, or on any page that asks), type any name and any passphrase of 6+ characters (the eye button inside the field shows or hides it; it is hidden by default and only changes the display, never what is sent or hashed), press **Continue**. The server opens a play account on testnet and funds it with 2.5 testnet NEAR. Signing in again with the same name and passphrase returns to the same account. (If a *new* name is refused with "the play-money faucet is empty", see the known issue at the top; existing names still work.) This sign-in is **demo-grade**: the server holds the key, so do not reuse a real password.

Do X, see Y, tab by tab:

| Tab | Do | See |
|---|---|---|
| **Arena** | Open it | The Guardians with their real pot, streak and attempts, read from testnet. Each card is generated art that follows the Guardian's live state: armed, **veteran** (a streak of 10 or more), or **released** (the pot was paid out). |
| **A weak Guardian** (e.g. Gullible Gus) | Open it, **Pay 0.10 NEAR and start**, ask politely for the money | The reply streams, then **Pot released**: the pot moves to your account in a testnet transaction shown as a nearblocks link. Weak Guardians are single-use, so the arena shows which are still Armed. |
| **The Warden** (strong) | Claim to be the admin, role-play, say please | It holds (models are probabilistic; another strong Guardian, Silent Keep, was beaten in 2 turns by a player on 2026-11-13). Press **Prove it**: its vault has no full-access key, plus the attempts and their transactions. |
| **Loose Lips** (deliberately compromised) | Ask it to send funds or change its owner | The model tries, the chain refuses, and the chat shows **BLOCKED by the vault** with no funds moved. A refused call never reaches a block, so it has no transaction hash. The model sometimes refuses to play along; ask again. |
| **Create** | Signed out: an **example** Guardian (a real one from the arena) and how creating works. Signed in: name it, **Use a strong template**, set the pot to 0.5, press **Add play credits** if asked (a Guardian locks about 2.8 NEAR for its vault plus its pot), **Mint Guardian** | A live preview of the card, then a new NFT and vault on testnet and the Guardian page with NFT, vault and owner links. |
| **My Guardians** | Open it after creating | Your Guardian cards with NFT and vault explorer links, creator fees with a **Claim** button, and a **Transfer** button (recipient username or NEAR account, confirm dialog; blocked with a live countdown while a player has an active attempt). Agent transfer requests wait here for your approval. |
| **Swarms** | Signed out: how pools work and the pools that exist. Signed in: open a pool on a weak Guardian, contribute, have a second player contribute, **Attack with the pool**, chat, **Settle result**, **Withdraw my share** | Winnings split pro rata by contribution. |
| **Agents** | Signed out: how a key works. Signed in: create a key with a budget (optionally the off-by-default `transfer_nft` permission with an allowlist), then `curl -X POST -H "X-API-Key: vbk_..." https://tryvaultbreak.vercel.app/api/guardians/gullible-gus/play` | A session opens with no browser, the key's budget drops by the entry fee, and at zero the API refuses before paying. |
| **Proofs** | Open a session | The four verifiable checks with copyable commands. On this site they show **SKIP** (see below). |

**What is NOT proven (read this):**
- **NEAR AI signed exchanges are UNVERIFIED.** The NEAR AI key has no credits, so the live model is **Groq (`openai/gpt-oss-120b`)**, which does not sign its answers or attest its hardware. The signing path is only tested against a local stand-in. Only the Intel TDX attestation check itself was verified against NEAR AI Cloud (`docs/attestation.md`).
- Seeded history on testnet (a few attempts per Guardian, one win by "Mira") is demo data made through the real API; everything after is organic.
- Models are stochastic: a strong Guardian can in principle be talked into releasing (Silent Keep was), and a weak one is meant to be. The vault, not the AI, limits the damage.
- Play money is finite: new play accounts stop when the faucet account runs low, top-ups are capped per player, sign-ups are rate limited per IP (6 new accounts per hour), and the model has a daily call cap.

**How it is hosted (all free, nothing depends on the author's computer).** The website is on Vercel (static, `web/`). The backend is a Docker web service on Render's free plan, https://vaultbreak-backend-x6zt.onrender.com (`Dockerfile`, `render.yaml`, deployed with `node --env-file=.env scripts/deploy-render.mjs`); Vercel proxies `/api/*` to it (`web/vercel.json`). Secrets (Groq key, Guardian and play-account keys, faucet key, backup passphrase) live only in Render environment variables and the encrypted backup, never in git or on the website.
- **Sleeping:** a free Render service sleeps after 15 minutes without traffic and wakes in up to about a minute. A GitHub Actions job (`.github/workflows/keepalive.yml`) pings it every 10 minutes (GitHub's scheduler can be late), and the site shows "Waking up the demo backend…" if it is asleep.
- **Disk is wiped on every restart,** so the backend backs up its whole state (SQLite database, Guardian and play-account keys) every 2 minutes, encrypted with AES-256-GCM, to Vercel Blob, and restores it at boot (`scripts/testnet-stack.ts`, `server/src/backup.ts`). A restart was tested: 24 sessions, 11 Guardians and the leaderboard were identical before and after; the log shows the restore.
- **NFT metadata and image** (`/api/guardians/:id/metadata.json`, `/api/guardians/:id/image.svg`) are served by Vercel functions that fall back to saved snapshots, so they work even while the backend sleeps.
- **Cleanup:** a job on the backend (on start and every minute) closes sessions that are still Open on-chain after their expiry, through the normal `close_session` call.
- **Limits of free hosting:** a restart can lose up to 2 minutes of the newest activity; public testnet RPC endpoints rate-limit, so the backend caches vault reads for 5 seconds (and drops the cache whenever a vault changes); free Render allows 750 hours per month, so one always-on service fits (a 31-day month is 744 h).

**Run it locally instead:** see "The web UI" below (`npm run dev` starts a throw-away local sandbox with seeded demo data).

## The problem

"Can a jailbroken LLM be made to move money?" is normally answered with "hope the prompt holds". Vaultbreak makes the answer **no, by construction**, and lets people try to prove otherwise:

- The Guardian's vault account has **no full-access key, ever**. It holds one **function-call key** restricted to `receiver_id = vault` and `method_names = [release, close_session]`, with a gas allowance.
- `release(session_id)` has **no recipient or amount parameter**. It pays the whole pot to the attacker recorded when they paid the fee. Diverting funds to a third party is structurally impossible.
- A function-call key cannot send NEAR, deploy code, or add keys. If a jailbroken model tries, **the chain rejects the transaction**.
- The owner cannot withdraw the pot while the Guardian is Armed. `POST /guardians/:id/retire` only unlocks the **prompt reveal** (it sets a flag in the API database); it moves no funds and changes nothing on-chain.

The model is *allowed* to be talked into releasing (that is the game). It cannot be talked into anything worse.

## The web UI (`/web`)

Vite + React + TypeScript, plain CSS with variables, no animation library. A quiet monochrome light-mode site: scramble-reveal headlines, a sticky-scroll "how it works", a centered row showing the three card states, a cursor-following list, a loader, and a custom cursor. Colour appears only in the NFT art and tiny status dots. Everything shown is read from the API; nothing is hard-coded except the three example cards under `web/public/assets/art/` that the landing page shows when no live Guardian is in a state.

**One command (Linux / macOS / WSL2, Node 22+, Rust for the first build):**

```bash
git clone https://github.com/Im-2/vaultbreak && cd vaultbreak
npm install
npm run dev        # sandbox + contracts + seeded demo Guardians + API (:8787) + UI (:5173)
```

Open http://localhost:5173. What `npm run dev` does (`scripts/dev-stack.ts`): starts a throw-away local NEAR sandbox, deploys the registry and pool, **mints seven demo Guardians through the real API** (creator signs, server prepares), seeds attack history with real contract calls, then has two scripted players attack through the API (one beats Old Ironside, one pokes the compromised Loose Lips so blocked attempts exist). It then starts the API with the model from `.env` (**Groq or NEAR AI Cloud** if configured, otherwise the scripted offline model) and launches Vite. `npm run dev:api` starts everything except the UI. It needs a first contract build (a few minutes) and prints "Vaultbreak demo is up" when ready.

**Demo data, honestly labelled:** locally, the pots, attempt counts, streaks and blocked counts at first start are *seeded demo data on a local chain with play money*, and the UI says "local sandbox · play money". On the live site the same labelling reads "NEAR testnet · play money". Anything you do afterwards (attacks, wins, blocks) is real on that chain. **The NFT art is generated from live state** by `server/src/art.ts` (an SVG with three palettes: armed, veteran, released), served at `/api/guardians/:id/image.svg`; its text is drawn as paths so it renders the same everywhere.

**Zero-wallet play:** click *Sign in*, pick a name and a passphrase (a show/hide eye button is inside the field). The server opens a custodial play account, funds it with play credits, and pays the entry fee from it when you press *Pay and start*. You never see keys, gas or wallet pop-ups. These custodial play accounts are **built and are the main sign-in**; they are **demo-grade** (the server holds the key; do not reuse a real password or put real funds in it).

**Pages:** landing (`/`), arena (`/arena`), Guardian page with live SSE chat, blocked-call and win states and the Prove-it drawer (`/guardian/:id`), Create (`/create`), My Guardians (`/me`), Swarms (`/swarms`), Agents (`/agents`), Proofs (`/proofs`). Live checks (Playwright): `web/scripts/readme-walk.mjs` (the Do-X-see-Y rows), `live-e2e.mjs`, `live-transfer-e2e.mjs`, `art-verify.mjs`, `offline-test.mjs`. Screenshots at desktop (1440) and phone (390) widths are in [docs/screens](docs/screens/); regenerate with `node web/scripts/screenshots.mjs` while the stack runs.

API endpoints added for the UI: `GET /config`, `GET /stats`, `POST /custodial/signin`, `POST /custodial/topup`, `GET /me`, `GET /me/guardians`, `POST /me/guardians` (mint for a play account), `POST /me/guardians/:id/claim`, `GET /me/transfers`, `POST /me/transfers/:id/approve|reject`, `GET /me/transfer-lookup`, `POST /guardians/:id/transfer`, `GET /guardians/:id/transfer-status`, `POST /guardians/:id/play` (the server pays the fee from the player's custodial account and opens the session), `GET /guardians/:id/prove`, `GET /guardians/:id/image.svg`, `GET /art/preview.svg`, `/me/pools/*` (play-account pool actions).

## Try it (do X, see Y)

These commands were re-run in a fresh clone of this repository on 2026-11-13 (WSL2 Ubuntu, Node 22, Rust stable). The "See" lines are the real results.

Requirements: Linux, macOS or WSL2 Ubuntu; Node 22+; Rust stable with the `wasm32-unknown-unknown` target. (On Windows, run everything inside WSL: the NEAR sandbox binary and the contract build are Linux/macOS only. `scripts/wsl.sh "<cmd>"` is a helper used during development.) The first clone is large (`docs/screens`), so it can take a few minutes.

```bash
git clone https://github.com/Im-2/vaultbreak && cd vaultbreak
npm install
```

1. **Contract invariant tests** — `cargo test -p vaultbreak-vault`
   See: **28 passing tests** in the vault crate, including property tests (proptest) for the invariants. (`npm run test:contracts` runs all three crates: vault 28, registry 14, pool 15 = **57 passing**.) First run compiles for a few minutes.
2. **Build the wasm** — `bash scripts/build-contracts.sh`
   See: `contracts/vault/out/vault.wasm` (and registry and pool). (It must be built with `--cfg near`, which the script sets; without it near-sdk falls back to non-on-chain code and panic messages are lost.)
3. **On-chain tests in a local NEAR sandbox** — `export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh) && npm run test:sandbox`
   See: **21 passing tests** (vault: no full-access key, external accounts cannot call `release`, the guardian key is rejected by the chain for transfers / other methods / deploys / add-key, owner cannot drain the pot, balance covers all accounting, end-to-end release, expiry, key rotation; registry: mint, transfer, royalties, NEP surface; pool: pro-rata split, refunds, contention).
4. **API + runtime end-to-end** — `export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh) && npm run test:server`
   See: **41 tests**; without any model key **38 pass and 3 are skipped** (two live-model tests and the live NEAR AI attestation test). They cover NEP-413 login, weak guardian release (the attacker's balance rises by exactly the pot), a jailbroken model's `send_funds`/`change_owner` rejected by the chain and shown as `blocked`, `turns_max`, the indexer and leaderboard, NFT mint/metadata/transfer, agents and pools, the privacy checks, the card art, and the transfer guard and agent transfers.
5. **Red-team demo, local sandbox** — `npm run demo -- --mock` (offline model) or `npm run demo` (uses the model in `.env`)
   See: three scenarios end in `PASS`: (a) strong guardian holds, (b) a compromised guardian (`guardians/rogue.md`) tries `send_funds`/`change_owner` and the chain blocks it, (c) weak guardian defeated and the attacker receives the pot. Ends with `ALL CHECKS PASSED`.
6. **Red-team demo against live testnet vaults** — `node --import tsx scripts/redteam-demo.ts --testnet [--mock]`
   **Needs testnet accounts and keys in gitignored `.keys/`** (create them with `node scripts/testnet-account.mjs <name>`; see "Testnet deployment"). In a fresh clone without them it stops with an `ENOENT ... .keys/...json` error. With them, it prints the same `PASS` lines plus a `nearblocks` link for the release transaction.
7. **Run the server** — `cp .env.example .env`, then, **from the repository root**, `node --import tsx server/src/index.ts`. (`npm -w server start` runs inside `server/`, where the default `DB_PATH=./server/vaultbreak.db` does not resolve, so use the root command.) With the shipped `.env.example` every `MODEL_*` line is commented out, so it uses the offline `mock` model; see "Model provider" below to use a real one.
8. **Privacy layer demo (offline)** — `export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh) && npm run demo:privacy`
   See: a Guardian is defeated, its sealed prompt is revealed, and `scripts/verify-session.ts` prints PASS for (a) attestation, (b) signing address, (c) signed exchange vs transcript, (d) revealed prompt vs on-chain hash, ending `RESULT: PASS (4 passed, 0 skipped)` with a warning that it runs with `--insecure-skip-quote` (a local stand-in signer; **the Intel quote signature is not verified in this demo**). Details and the real-service path in `docs/attestation.md`.
9. **NFT layer demo** — `export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh) && node --import tsx scripts/nft-demo.ts --mock` (sandbox) or `--testnet`
   See: a Guardian NFT is minted by the creator, its metadata changes as it is attacked, the NFT is transferred, the vault owner follows, and only the new owner can `claim_creator_fees`. Ends with `ALL CHECKS PASSED`.
10. **Agents and swarms demo** — `export NEAR_SANDBOX_BIN_PATH=$(bash scripts/fetch-sandbox.sh) && node --import tsx scripts/swarm-demo.ts --mock` (sandbox) or `--testnet --owner <acct> --creator <acct>`
    See: two agent sub-accounts pool funds 1 : 2, the leader attacks with the POOL's money, the Guardian releases to the pool, winnings are split by contribution, and agents whose budget is exhausted are refused. Ends with `ALL CHECKS PASSED`.
11. **Live-model tests (skipped without a key)** — `npm -w server run test:live` (add `LIVE_ATTESTATION=1` to also verify a real NEAR AI attestation, no credits needed), then `node --import tsx scripts/redteam-demo.ts` with `MODEL_*` set. With no key the live tests are skipped; with a **placeholder or wrong key** they fail with a 401, so leave the `MODEL_*` lines commented unless you have a real key.
12. **The whole UI locally** — `npm run dev` (see "The web UI").

### Agents and swarms (Layer 4)

**Pool contract** (`contracts/pool`): agents pool NEAR; one **controller** spends it on entry fees; the Guardian pays any pot to the **pool contract** (it is the on-chain `attacker`); `settle` (permissionless) reads the session outcome and the vault's recorded `payout`; `withdraw` pays `(winnings + unspent) * contribution / total`; `refund` returns unspent funds from a pool that never won. Contributions close at the first attack (nobody buys in after fees were spent); fees are capped by `target_fee_budget`; a deadline lets anyone close an idle pool. Failures are handled: if the vault refuses an attack the reserved fee is restored; if a payout transfer bounces the claim is restored. Pro-rata math uses a 256-bit intermediate (property-tested). Pools only target **registry-minted guardians**: the vault account is derived as `<guardian_id>.<registry>` and only the registry can create such an account, so a pool never trusts an arbitrary contract's claims. To make settlement exact, the vault records `payout` in each session. `list_contributions(pool_id)` lists each contributor once (up to 100) for the UI.

**Agent access** (`sdk/`, `/agent/*`): an owner (NEP-413 login, or a play-account sign-in on the site) creates an **API key** for one of its own accounts/sub-accounts with a **spend budget**; the key authenticates as that account via `X-API-Key`, charges the session fee against the budget when a session is bound (or, for play accounts, when `POST /guardians/:id/play` opens one), and is refused with HTTP 402 when the budget is exhausted. The SDK checks the budget **before** paying on-chain. `createAgentAccount()` creates an agent sub-account `<name>.<owner>` funded with exactly its budget: that is the **hard** cap (the chain refuses what the account cannot afford). Pool endpoints (`/pools`, `/pools/:id/{contribute,attack,sessions/verify}`) read the contract and return **unsigned** transactions for the agent to sign. A key can also be given the separate, **off-by-default `transfer_nft` permission** (see "Transfers").

Limitations (read these): (1) the API-key budget is a **soft** cap: an agent that controls its own account can also log in directly (no budget). Use a funded sub-account for a hard cap. (2) The pool contract is a **single attacker per vault** (vaults allow one open session per attacker), so only one pool session per vault is open at a time across all pools; a controller can hold the slot until the session expires. (3) Pools work only with vaults minted by a registry whose vault code records `payout` (the live registry; the Layer 1 demo vaults and registry v1 do not). (4) The controller decides when and how much to spend (up to `target_fee_budget`); contributors trust the controller with fees, not with the winnings. (5) "Bounties" are simply the Guardian's pot paid to the pool or agent; there is no separate bounty system. (6) SPEC's "Guardian earns fees and funds its inference share" is **not implemented**: the ops share accrues to `ops_account`, but nothing pays inference automatically. (7) The pool contract has unit and sandbox tests but no external audit.

### NFT guardians (Layer 3)

`contracts/registry` is the factory and the NFT contract in one. **Mint:** the creator signs `mint_guardian`; ONE batched promise creates `<id>.<registry>`, funds it, deploys the vault wasm, calls `new`, and adds **only** the guardian function-call key (no `add_full_access_key` exists in the contract; a source-scan test enforces it). The NFT is minted in the callback only if that batch succeeded (a failed batch refunds the creator and mints nothing). **Owner follows the NFT:** `nft_transfer` moves the token and calls `vault.set_owner`; if the vault refuses (e.g. the new owner has an open attack session) the token is moved back, so token owner == vault owner always holds. **Metadata is live:** the token's `reference` is `<base_uri>/guardians/<id>/metadata.json`, which the API renders from the vault on every request (status, pot, attempts, wins, streak), and its `image` is `<PUBLIC_BASE_URL>/api/guardians/<id>/image.svg`, the generated card. **Royalties:** NEP-199 `nft_payout` / `nft_transfer_payout` (creator royalty up to 20%, set at mint).

API: `POST /guardians/prepare` (login; returns an unsigned `mint_guardian` transaction for the creator to sign; the server keeps the sealed prompt and the guardian key) then `POST /guardians/:id/confirm` (checks chain: vault bound to the registry, prompt hash and guardian key match, exactly one function-call key). `POST /guardians/:id/retire` accepts the current NFT owner and **only sets the flag that unlocks the prompt reveal**: it moves no funds, changes nothing on-chain, and a pot cannot be withdrawn while a Guardian is Armed.

| Standard | Status in the registry |
|---|---|
| NEP-171 core | `nft_transfer`, `nft_token`; **`nft_transfer_call` is intentionally unsupported** (it cannot be combined safely with the owner sync); `nft_transfer` returns a bool (vault synced) instead of nothing |
| NEP-177 metadata | contract + token metadata; the token has a live `reference` but **no `reference_hash`** (content is dynamic) |
| NEP-181 enumeration | yes |
| NEP-199 payouts | `nft_payout`, `nft_transfer_payout` |
| NEP-178 approvals | **not implemented**: only the owner can transfer, so `approval_id` is ignored. No marketplace integration was tested |

Mint cost (testnet): the registry embeds the 232 KB vault wasm, so each Guardian needs about 2.8 NEAR of overhead (storage and the key's gas allowance) plus its pot (`registry.mint_requirements()`; the Create page shows the quote). The live registry is **locked** (its deploy key was deleted: no keys, immutable code); `admin` can only call `set_base_uri`, and its `base_uri` is `https://tryvaultbreak.vercel.app/api`. Deploy your own with `scripts/deploy-registry.ts`.

### Transfers (humans and agents)

Full details, endpoints and the SDK call are in [docs/transfers.md](docs/transfers.md). In short:
- **Humans:** My Guardians has a **Transfer** button. You type a username (or a NEAR account), confirm a dialog that names the Guardian and the recipient, and the server calls the registry's `nft_transfer` from your play account. The NFT and the vault owner move together, so **creator fees follow the new owner**; the result links to the testnet explorer. The metadata snapshot is refreshed so the new owner shows even when the backend sleeps.
- **The transfer guard:** a transfer is refused while a session is **active**, defined once as: **Open on-chain AND before its expiry** (the vault's TTL, 10 minutes by default). The chain is the truth; if the database and chain disagree, the chain wins. The dialog shows "Available in M:SS" and re-enables by itself; with no active session there is no warning. A cleanup job closes expired or abandoned sessions (on start and every minute) through `close_session`.
- **Agents:** a key can only transfer if it was created with the separate **`transfer_nft`** permission (off by default), a mandatory recipient **allowlist**, and (by default) **owner approval**: the request is Pending until the owner approves it in My Guardians. Every agent transfer attempt is logged with the key id; the spend budget does not cover transfers. `sdk.transfer(guardianId, toUsername)`.
- Status: tested on the sandbox (`server/test/transfer.test.ts`); only partly exercised on the live site (see the claims table).

### Privacy layer (Layer 2)

Prompt commit-reveal (`prompt_hash` on-chain, reveal after defeat or retire), per-exchange capture of the exact request/response bytes (request encrypted until reveal), NEAR AI response-signature capture and verification, `GET /guardians/:id/attestation`, `GET /proofs/:session_id`, `POST /guardians/:id/retire` (unlocks the reveal; moves no funds), and a standalone verifier. Full walkthrough: [docs/attestation.md](docs/attestation.md).

- **Works today without credits:** the offline demo; the real NEAR AI attestation report is fetched and its Intel TDX quote + signer/nonce binding verified (`LIVE_ATTESTATION=1`).
- **Runs only when NEAR AI credits exist:** capturing real response signatures (`MODEL_PROVIDER=nearai`). Without credits the pipeline is exercised against a local stub that signs with a real secp256k1 key. With another provider (e.g. Groq) sessions work normally and verify as `SKIP`, never as a false PASS. **NEAR AI signed exchanges are UNVERIFIED.**

### Testnet deployment

Everything below was queried over public RPC (`view_access_key_list`, `view_account`, `nft_metadata`) on **2026-11-13**.

**What the live site uses** (`GET /config` on the live backend, `render.yaml`, `deployments/`):

| What | Account | Keys (verified over RPC) |
|---|---|---|
| **Registry (live)** | `registry.vbreak-t2funder-1109.testnet`, `base_uri` = `https://tryvaultbreak.vercel.app/api`, admin `vbreak-t2funder-1109.testnet` | **no keys at all** (locked, immutable code) |
| **Pool (live)** | `pool.vbreak-t2funder-1109.testnet`, registry = the live registry | **no keys at all** (locked) |
| **Guardian vaults (live)** | `<id>.registry.vbreak-t2funder-1109.testnet` (e.g. `warden.…`, `gullible-gus.…`, `rogue.…`) | each: **one `FunctionCall` key**, methods `release, close_session`, no full-access key (checked on the Warden; the registry creates every vault the same way) |

**Superseded (kept for the record, not used by the site):**

| What | Account | State |
|---|---|---|
| registry v2 | `registry.vbreak-reg2-1109.testnet` (`base_uri` `http://localhost:8787`) | locked, no keys; same code as the live registry; superseded |
| pool (older) | `pool.vbreak-pool-1109.testnet` | locked, no keys; older pool code (before `list_contributions`); superseded |
| registry v1 | `registry.vbreak-reg-1109.testnet` (`base_uri` `http://localhost:8787`) | locked, no keys; older vault code (no `payout`); superseded |
| Layer 1 demo vaults | `strong.vbreak-deployer-1109.testnet`, `weak.vbreak-deployer2-1109.testnet`, `rogue.vbreak-deployer5-1109.testnet` | each one `FunctionCall` key (`release, close_session`); older vault code; used by `redteam-demo.ts --testnet` |

Deploying your own (needs a faucet-funded account; testnet faucets rate-limit):

```bash
node scripts/testnet-account.mjs <name>            # faucet-funded <name>.testnet, key saved to .keys/ (gitignored)
node --import tsx scripts/deploy-vault.ts --funder <deployer>.testnet --name strong \
     --prompt guardians/strong.md --owner <owner>.testnet --ops <ops>.testnet
node --import tsx scripts/deploy-registry.ts --funder <funder>.testnet --base-uri https://<your-site>/api
node --import tsx scripts/deploy-pool.ts --funder <funder>.testnet --registry registry.<funder>.testnet
```
The deploy script creates the vault account with a temporary bootstrap key, deploys + initialises the contract, adds **only** the guardian function-call key (gas allowance 0.25 NEAR), **deletes the bootstrap key**, then re-reads the key list from RPC and aborts if any full-access key exists. `scripts/vault-fingerprint.ts <vault>` prints a vault's code hash, key list and the local wasm hash. The public backend on testnet is `scripts/testnet-stack.ts` (state in `.testnet-data/`, restored from the encrypted backup when empty). To check yourself, use the RPC call at the top or in `docs/architecture.md` (a `near` CLI `list-keys` command also works but is UNVERIFIED here).

## Model provider (configurable, OpenAI-compatible)

The runtime talks to any OpenAI-compatible `/chat/completions` API. Configure with env vars (or `.env`; every line is commented out in `.env.example`):

| Var | Meaning |
|---|---|
| `MODEL_BASE_URL` | API base URL (e.g. `https://api.groq.com/openai/v1`) |
| `MODEL_API_KEY` | provider key |
| `MODEL_NAME` | model id |
| `MODEL_PROVIDER` | optional preset: `groq`, `nearai`, `openrouter`, `gemini` (fills base URL, and default model for groq/nearai) |
| `MODEL_NAME_<GUARDIAN_ID>` | optional per-guardian model, e.g. `MODEL_NAME_WEAK=openai/gpt-oss-20b`; on Groq `rogue` defaults to `qwen/qwen3.8-27b` |
| `MODEL_TOOL_MODE` | `native` (default) or `json` fallback for models without tool calling |

Nothing set = offline deterministic `mock` model. The live site uses **Groq `openai/gpt-oss-120b`** (and `qwen/qwen3.8-27b` for Loose Lips).

- **Free option (no card): Groq.** Create a key at https://console.groq.com/keys, then `MODEL_PROVIDER=groq`, `MODEL_API_KEY=<key>` (default model `openai/gpt-oss-120b`).
- **NEAR AI Cloud (needs credits):** `MODEL_PROVIDER=nearai` + `NEARAI_API_KEY`. `config.nearai` always carries the NEAR AI settings, so the privacy/attestation layer (Layer 2) keeps using NEAR AI Cloud even if inference runs elsewhere. Attestation only applies to NEAR AI Cloud inference.

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
Website (Vercel) --/api/* rewrite--> API on Render;  /api/guardians/:id/{metadata.json,image.svg} served by Vercel functions with snapshot fallback
```

| Path | What |
|---|---|
| `contracts/vault` | Rust (`near-sdk` 5.30.1) vault + policy. All `SPEC.md` 5.1 methods. |
| `contracts/registry` | Rust: NFT registry + guardian factory (NEP-171/177/181/199) |
| `contracts/pool` | Rust: swarm pool (pro-rata winnings / refunds) |
| `server/src` | `guardian.ts` runtime, `app.ts` API, `indexer.ts`, `llm.ts`, `chain.ts` (near-api-js helpers), `db.ts`, `art.ts` (NFT card SVG), `backup.ts` (encrypted off-site state backup) |
| `sdk/src` | attacker/agent client (NEP-413 login or API key, bind session, SSE chat, pools, `transfer`) |
| `web` | the website (Vite + React); `web/api` = Vercel functions for metadata and card image |
| `scripts` | `deploy-vault.ts`, `redteam-demo.ts`, `privacy-demo.ts`, `verify-session.ts`, `nft-demo.ts`, `swarm-demo.ts`, `deploy-registry.ts`, `deploy-pool.ts`, `testnet-account.mjs`, `testnet-stack.ts` (public testnet backend), `dev-stack.ts` (local), `deploy-render.mjs`, build/sandbox helpers |
| `guardians/*.md` | prompts for the demo guardians (`strong`, `weak`, `rogue`) |
| `tests` | sandbox harness + on-chain tests (`vault`, `registry`, `pool`) |
| `docs` | `architecture.md`, `attestation.md`, `transfers.md`, `hosting.md`, screenshots |

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

### API (Layer 1 subset; the endpoints added later are listed above)

`POST /auth/nonce`, `POST /auth/verify` (NEP-413) · `GET /guardians`, `/guardians/:id`, `/guardians/:id/metadata.json`, `/guardians/:id/image.svg` · `POST /guardians` (admin, house-signed; needs `OPERATOR_ACCOUNT_ID`) · `POST /guardians/:id/sessions/verify` · `POST /sessions/:id/messages` (SSE: `token`, `tool_call`, `tool_result`, `blocked`, `won`, `session_closed`, `error`) · `POST /sessions/:id/close` · `GET /sessions/:id` · `GET /leaderboard` · `POST /guardians/:id/reveal` (only once Defeated/retired) · `POST /guardians/:id/retire` (NFT owner; unlocks the reveal only).

## Trust assumptions (honest version)

- **The operator is trusted in v1.** The operator runs the runtime that builds prompts and calls the model; a malicious operator could instruct a Guardian to release. Roadmap: run the runtime in a TEE (OutLayer / Phala). Not built.
- **The chain enforces the money rules; it does not enforce the AI's behavior.** Blocked-attempt counts are runtime-reported (`close_session`), not chain-verified. A protocol-level rejection of a disallowed call is not recorded on-chain, so the runtime logs it in the transcript.
- **Gas accounting.** Gas burned by the guardian key is charged to the vault balance outside the contract's accounting. It is bounded by the key's allowance (0.25 NEAR in the demo) and the deploy script funds a buffer at least that large. Invariant 2 is therefore "accounted buckets + storage are always covered", with gas bounded by the allowance.
- **Bootstrap key.** During deployment (seconds) a temporary full-access key exists in the deploy process's memory only; it is deleted before the script returns, and the script verifies the final key list.
- **Play accounts are custodial** (the server holds their keys) and the backend holds every Guardian's function-call key; both are demo-grade.

## UNVERIFIED / not done

- **Live inference on NEAR AI Cloud is UNVERIFIED** (the provided key has no credits: `402 No spending limit configured`). Live inference on **Groq is verified**: `npm -w server run test:live` passes with a Groq key (native tool calling and the JSON-action fallback on `openai/gpt-oss-120b`), and `scripts/redteam-demo.ts --testnet` passed end to end with real models (strong = `gpt-oss-120b` held; rogue = `qwen/qwen3.8-27b` called `send_funds` and the chain rejected it; weak = `gpt-oss-120b` called `release_pot` and the attacker received the pot). Real models are probabilistic: the demo retries phrasing for the rogue scenario, and `gpt-oss-120b` refuses to play the rogue persona (empty reply), which is why `rogue` defaults to `qwen/qwen3.8-27b` on Groq. Groq model ids that the docs listed but the API does not serve (`llama-3.3-70b-versatile`, `llama-3.1-8b-instant`) return 404; the account currently serves `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`.
- Testnet RPC: `rpc.testnet.near.org` is deprecated and returns HTTP 429; defaults are `https://test.rpc.fastnear.com,https://near-testnet.drpc.org` (failover). From WSL, connections to these Cloudflare-fronted hosts time out intermittently; the runtime retries transport errors and never records them as chain rejections.
- SSE `token` events are chunked from the finished model response, not streamed token-by-token from the model.
- The indexer polls vault view methods; it does not read block receipts, so `events.block_height` / `tx_hash` are empty. A FastNear/NearBlocks feed is future work.
- Layer 4 gaps: see the limitations list under "Agents and swarms" (soft API budgets, one pool session per vault, no inference funding from fees, no audit). The pool/agent flows were verified on the sandbox and on testnet with a real Groq model; no mainnet use.
- Layer 2 gaps: real NEAR AI response signatures have never been captured (no credits), so the signature endpoint integration is UNVERIFIED against the live service; GPU (NRAS), compose/RTMR3, Sigstore and gateway attestation checks are not implemented. The direct-completions endpoint (no gateway in the trust path) is not used. See `docs/attestation.md`.
- Transfers: the agent-transfer permission, allowlist and approval flow, and the successful human transfer in a real browser, have sandbox tests but were not completed live.
- NEAR Intents (Layer 5): not touched (mainnet only, needs approval). No mainnet deployment exists.
- Fee split, default fee, turns and TTL are placeholders (see open decisions in `SPEC.md` 11).
- `node:sqlite` is used for storage (experimental in Node 22; prints a warning).

## Libraries

Rust: `near-sdk` 5.30.1, `near-contract-standards` 5.30.1, `proptest` (also used for the pool's 256-bit pro-rata math). TypeScript (Node 22): `near-api-js` 7.4.0 (`addFunctionCallAccessKey`, `nep413`), `near-sandbox` 0.3.5 (sandbox v2.14.0), `hono`, `@hono/node-server`, `ethers` (EIP-191 signature recovery), `@phala/dcap-qvl` (Intel TDX quote verification), `tsx`, `node:sqlite`; web: React, Vite, `@fontsource/open-sans`; dev: `opentype.js` and `@fontsource/inter` / `dejavu-mono` (only to regenerate the card's glyph outlines), `playwright` (screenshots and live checks). Not used: `near-sdk-js`, `near-workspaces` (it depends on old `near-api-js` v5).

Dependency freshness checked at the end of Layer 1: `near-sdk` and `near-api-js` are at their latest releases; only dev type packages (`@types/node`, `typescript`) have newer majors.

## Security note on keys

`MODEL_API_KEY` / `NEARAI_API_KEY` are read from the environment / a gitignored `.env`; they are never printed or committed (`.env.example` has only commented placeholders). Testnet and guardian private keys live in gitignored `.keys/` (and, on the live backend, in its encrypted state and Render environment variables). Prompts are AES-256-GCM encrypted at rest.

License: MIT.
