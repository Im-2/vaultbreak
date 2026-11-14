# Hosting the backend off the author's laptop

**Status: DONE. The backend runs on Render's free plan (https://vaultbreak-backend-x6zt.onrender.com), deployed through the Render API.** The rest of this file is the background and the fallback options.

## What survives the laptop being off (done, tested live)
- `/api/guardians/:id/metadata.json` is served by a Vercel function (`web/api/metadata.js`). It asks the backend (2.5 s timeout), then falls back to the snapshot bundled with the last deployment, then to a JSON 404. Always valid JSON, `content-type: application/json`, CORS open, never an HTML error page. `/api/guardians/:id/image.svg` works the same way (`web/api/image.js`).
- The website shows a "backend offline" banner and friendly errors instead of blank pages (`OfflineBanner`).
- The backend's state is backed up, encrypted (AES-256-GCM, key from `BACKUP_PASSPHRASE`), into a free Render Postgres database (`DATABASE_URL`) at most every 12 minutes and only when it changed, plus once on shutdown; a Render secret file (`STATE_SEED_FILE`) holds a starting copy. At boot with an empty disk the newest of the two is restored (`server/src/backup.ts`). A host with a wiped disk therefore loses nothing beyond the last few minutes.

## Why the backend is still on the laptop
Every free always-on host needs an account (and some a card). Creating third-party accounts is something the assistant is not allowed to do, and none of these CLIs was installed or logged in. Findings from current sources (they contradict each other; verify on the pricing page before relying on them):
- **Render** free web service: 750 h/month, 512 MB, sleeps after 15 min idle, about 30-60 s cold start, ephemeral disk (so the backup/restore above is required). Card requirement is disputed.
- **Koyeb** free: one service, scales to zero after about an hour idle; card/hold reportedly required since 2026.
- **Hugging Face Spaces**: Docker Spaces on free hardware sleep when idle; reports conflict on whether Docker needs a paid plan.
- **Back4App Containers**: free tier, no card reported (256 MB, 0.25 CPU).
- **Railway / Fly**: no real free always-on tier now.
None is truly always-on and free; "free + sleeps when idle + cold start" is what is available. With restore-on-boot, a sleeping host is acceptable: the first request wakes it, and metadata keeps working meanwhile.

## What the human has to do (about 5 minutes), then it is done
1. Sign in to Render (or Back4App / Koyeb) with the GitHub account and create a Web Service from this repo (Docker; `render.yaml` and `Dockerfile` are ready).
2. Enter the secrets in the host dashboard (never in git): `MODEL_API_KEY` (Groq), `BACKUP_PASSPHRASE` and `DATABASE_URL` (a free Render Postgres; see `render.yaml`), `TESTNET_FUNDER_KEY` (the faucet account's key, from `.keys/vbreak-t2funder-1109.testnet.json`, field `private_key`).
3. Point the site at it: `node scripts/set-backend.mjs https://<service>.onrender.com && (cd web && vercel deploy --prod --yes)`.
The Docker image build is UNVERIFIED (the local Docker daemon was not running when this was written); the restore path itself was tested.

## Incident, 2026-11-13: the backup store was suspended
The first backup design wrote to Vercel Blob every 2 minutes (plus metadata snapshots). That exhausted Blob's free write quota, the store was suspended ("store_suspended", reads returned 403), and the next Render restart found no backup, started empty and crashed because it could not seed Guardians without their keys. The backend was down for several hours. Recovery: the state was rebuilt from the operator's laptop copy of 2026-11-11 (11 Guardians, 19 play accounts) and put into a free Render Postgres plus a Render secret file; the Blob backup was removed from the backend completely.

**Lost, and why:** everything the backend kept only on its disk after that copy: the keys and database rows of four Guardians that exist on-chain (`intuition`, `xfer-keep-6zqi`, `xfer-keep-94c9`, `xfer-keep-ev6r`; their vaults still hold their pots but nothing can sign for them, anyone can still call `expire_session`), 11 play accounts created after the copy (test accounts, including `judge2dyc`), and the session and transcript history after the copy (proof pages for those sessions). Chain state (pots, attempts, owners, transactions) is intact. `node scripts/audit-state.mjs <data dir>` lists exactly what is on-chain but missing locally.

## Incident, 2026-11-14: the first restart test of the Postgres design lost the newest state
A restart (Render API `restart`) started the new instance, which restored the newest Postgres row (taken 12 minutes earlier), while the old instance was still writing its final backup on SIGTERM. The new instance then wrote its own (older) state as the newest row, and the following writes pushed the good row out of the three kept rows. **Lost:** the Guardians created in the previous ~10 minutes (eight weak Guardians minted for the README; their vaults exist on testnet but their keys were only in the lost backup, so nothing can release those pots), four play accounts, one release and two sessions. Nothing from before 07:25 UTC was lost.

**Fixed the same day** (`server/src/backup.ts`):
1. After restoring, the instance waits for the previous instance's final write (20 s) and takes anything newer.
2. If a newer row still appears in the first 5 minutes, the instance exits so the host restarts it from that row.
3. An instance never overwrites a newer row (it skips the write and logs it).
4. The change check ignores the indexer's volatile `state_json`, and the boot state counts as already saved, so an idle backend no longer writes a row every 12 minutes (it did all night) and a restart no longer writes a stale one.

**Re-tested:** a new play account created seconds before a restart was still there after it (HTTP 200 with the same account id, not 201), and Guardian ids and statuses, session count and stats were identical before and after.
