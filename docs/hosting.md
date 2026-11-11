# Hosting the backend off the author's laptop

**Status: DONE. The backend runs on Render's free plan (https://vaultbreak-backend-x6zt.onrender.com), deployed through the Render API.** The rest of this file is the background and the fallback options.

## What survives the laptop being off (done, tested live)
- `/api/guardians/:id/metadata.json` is served by a Vercel function (`web/api/metadata.js`). It asks the backend (2.5 s timeout), then falls back to the last snapshot the backend saved to Vercel Blob, then to the snapshot bundled with the deployment. Always valid JSON, `content-type: application/json`, CORS open, never an HTML error page. Unknown ids get a JSON 404.
- The website shows a "backend offline" banner and friendly errors instead of blank pages (`OfflineBanner`).
- The backend's state is backed up, encrypted (AES-256-GCM, key from `BACKUP_PASSPHRASE`), to Vercel Blob every 2 minutes when it changes, and restored at boot when the data directory is empty (`server/src/backup.ts`). A host with a wiped disk therefore loses nothing: guardians, sessions, transcripts, custodial accounts and every key come back.

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
2. Enter the secrets in the host dashboard (never in git): `MODEL_API_KEY` (Groq), `BLOB_READ_WRITE_TOKEN` and `BACKUP_PASSPHRASE` (both in the repo owner's local `.env`), `TESTNET_FUNDER_KEY` (the faucet account's key, from `.keys/vbreak-t2funder-1109.testnet.json`, field `private_key`).
3. Point the site at it: `node scripts/set-backend.mjs https://<service>.onrender.com && (cd web && vercel deploy --prod --yes)`.
The Docker image build is UNVERIFIED (the local Docker daemon was not running when this was written); the restore path itself was tested.
