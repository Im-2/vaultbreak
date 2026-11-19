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

## Incident, 2026-11-19: Render suspended every free service ("Monthly Quota Exceeded")
**Symptom:** the keepalive workflow run of 2026-11-19 13:38 UTC failed (`curl: (22) ... 503` on all 4 attempts over about 1 minute); `https://tryvaultbreak.vercel.app/api/health` and `https://vaultbreak-backend-x6zt.onrender.com/health` both answered **503 "Service Suspended"**. Earlier runs (every few hours, from 2026-11-16) had all passed.

**Root cause:** Render's free plan gives **750 instance hours per month per workspace, shared by all free web services in it**. The workspace "My Workspace" holds six free web services (`vaultbreak-backend`, `kitestall`, `purser`, `keel-bot`, `vowed-backend`, `handoff-api`) and a free Postgres. At 2026-11-19 12:25 UTC Render suspended **all six** with the reason `billing` ("Monthly Quota Exceeded") and suspended the Postgres too. The earlier README claim that one always-on service fits in 750 hours is true only when no other free service is running in the workspace. Nothing crashed: the last logs (12:22 UTC) are normal, and the last deploy (`190cf20`, 2026-11-14) is still the live one.

**Why it cannot be fixed from outside:** the Render API refuses to resume it (`only services suspended by a user can be resumed`), and a ping does not help. It needs one of: (1) an owner action in the Render dashboard (Billing: add a payment method or move this service to a paid instance type), or (2) waiting for the quota to reset on the first of the month (2026-12-01 00:00 UTC), after which the services can be resumed in the dashboard. State is safe: it lives in the encrypted Postgres backup (the database is suspended, not deleted; it still expires on 2026-12-13) and in the secret-file seed.

**What still works while the backend is suspended** (Vercel serves them from bundled snapshots): the landing page and its numbers, the Guardian list and Arena cards, and `/api/guardians/<id>/metadata.json` and `image.svg`. Sign-in, play, create, swarms and agent keys need the backend.

**Prevention:** keep only Vaultbreak running in the workspace (suspend the other five in the dashboard, or put them in another workspace); with one service, 744 hours fit in a 31-day month.

## Health states and monitoring
| What you see | Meaning | What to do |
|---|---|---|
| `GET /api/health` -> 200 `{"ok":true,"uptime_s":N}` | backend up (small `uptime_s`: it just restarted) | nothing |
| 200 after 20 to 60 s, first request slow | cold start after sleeping | normal; the site shows "Waking up the demo backend…" |
| 502/503/504 for more than 2 minutes, HTML body | crash loop or the host is down | Render dashboard -> Logs and Events |
| 503 with an HTML page titled **Service Suspended** | Render suspended it (quota or billing) | see the incident above; it needs the dashboard |

**Pingers.** (1) The backend pings its own `/health` every 4 minutes while it runs. (2) `.github/workflows/keepalive.yml` pings `/api/health` every 10 minutes (GitHub often runs it only every few hours) and, since 2026-11-19, retries for about 10 minutes before failing, so one cold start no longer marks a run red; a red run now means the backend stayed unhealthy for 10 minutes, and the log shows the HTTP status and the first line of the body. (3) **External pinger (to be created by the owner, it needs an account):** on cron-job.org (free) create a job with URL `https://tryvaultbreak.vercel.app/api/health`, schedule every 5 minutes, request timeout 60 s, "treat as failed" on a non-2xx status, and enable failure notification by email. UptimeRobot (5-minute free monitor) works the same way. A pinger keeps a sleeping service awake and shows an outage quickly; it cannot undo a billing suspension.
