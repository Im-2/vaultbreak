// Off-site, encrypted backup of the backend's state, so a host with a wiped disk (or a new host) can recover everything:
// the SQLite database (guardians, sessions, transcripts, proofs, custodial accounts) and every key file (Guardian function-call
// keys, custodial play-account keys, the prompt-encryption key).
//
// Stores (Vercel Blob is NOT used any more: its free write quota was exhausted and it suspended the store):
//   * Postgres  (DATABASE_URL)  the live store: a new encrypted row at most every 10-15 minutes and only when the state changed,
//                               plus one final write on SIGTERM (a deploy or restart), so a restart never goes back in time.
//   * Seed file (STATE_SEED_FILE, e.g. a Render secret file, base64 text) a static starting point, used when it is NEWER than Postgres.
// On boot, with an empty data directory, the NEWEST of the two (by the timestamp inside the backup) is restored.
// Everything is one file encrypted with AES-256-GCM, key = scrypt(BACKUP_PASSPHRASE); the passphrase lives only in the host's secrets.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import pg from "pg";

const PASS = () => process.env.BACKUP_PASSPHRASE;
const DBURL = () => process.env.DATABASE_URL;
const SEED = () => process.env.STATE_SEED_FILE;
export const backupEnabled = () => !!PASS() && (!!DBURL() || !!SEED());

function seal(plain: Buffer): Buffer {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", scryptSync(PASS()!, salt, 32), iv);
  const body = Buffer.concat([c.update(gzipSync(plain)), c.final()]);
  return Buffer.concat([Buffer.from("VB2"), salt, iv, c.getAuthTag(), body]);
}
function open(blob: Buffer): Buffer {
  const tag3 = blob.subarray(0, 3).toString();
  if (tag3 !== "VB1" && tag3 !== "VB2") throw new Error("not a Vaultbreak backup");
  const salt = blob.subarray(3, 19), iv = blob.subarray(19, 31), tag = blob.subarray(31, 47);
  const d = createDecipheriv("aes-256-gcm", scryptSync(PASS()!, salt, 32), iv); d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(blob.subarray(47)), d.final()]);
  return tag3 === "VB2" ? gunzipSync(plain) : plain;
}

function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (!/vaultbreak\.db(-wal|-shm)?$/.test(e.name) && e.name !== ".backup-copy.db") out.push(r);
  }
  return out;
}

/** Packs the data directory (a consistent copy of the database + every other file) into one buffer. */
export function pack(dataDir: string): Buffer {
  const files: Record<string, string> = {};
  const dbPath = join(dataDir, "vaultbreak.db");
  if (existsSync(dbPath)) {
    const tmp = join(dataDir, ".backup-copy.db"); rmSync(tmp, { force: true });
    const db = new DatabaseSync(dbPath); db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); db.close();
    files["vaultbreak.db"] = readFileSync(tmp).toString("base64"); rmSync(tmp, { force: true });
  }
  for (const f of listFiles(dataDir)) files[f] = readFileSync(join(dataDir, f)).toString("base64");
  return Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), files }));
}
export function unpack(dataDir: string, plain: Buffer): number {
  const { files } = JSON.parse(plain.toString()) as { files: Record<string, string> };
  for (const [rel, b64] of Object.entries(files)) { const p = join(dataDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(b64, "base64")); }
  return Object.keys(files).length;
}
const stampOf = (plain: Buffer): number => Date.parse(JSON.parse(plain.toString()).at ?? "") || 0;

// ---------------------------------------------------------------- Postgres
const client = () => new pg.Client({ connectionString: DBURL(), ssl: /@(localhost|127.0.0.1)[:/]/.test(DBURL() ?? "") ? undefined : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
async function pgRun<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = client(); await c.connect();
  try { await c.query("CREATE TABLE IF NOT EXISTS vb_state_backup (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), data BYTEA NOT NULL)"); return await fn(c); } finally { await c.end().catch(() => {}); }
}
const readPg = async (): Promise<Buffer | null> => pgRun(async (c) => { const r = await c.query("SELECT data FROM vb_state_backup ORDER BY id DESC LIMIT 1"); return r.rows[0]?.data ?? null; });
/** Operator override (BACKUP_RESTORE_ROW_AT=<ISO prefix>): the kept row whose own timestamp starts with this text. Remove the variable after one boot. */
const readPgAt = async (prefix: string): Promise<Buffer | null> => pgRun(async (c) => {
  const r = await c.query("SELECT data FROM vb_state_backup ORDER BY id DESC");
  for (const row of r.rows) { try { if (new Date(stampOf(open(row.data))).toISOString().startsWith(prefix)) return row.data as Buffer; } catch { /* unreadable row */ } }
  return null;
});
export async function writePg(sealed: Buffer): Promise<void> {
  await pgRun(async (c) => { await c.query("INSERT INTO vb_state_backup (data) VALUES ($1)", [sealed]); await c.query("DELETE FROM vb_state_backup WHERE id NOT IN (SELECT id FROM vb_state_backup ORDER BY id DESC LIMIT 3)"); });
}
const readSeed = (): Buffer | null => { const f = SEED(); if (!f || !existsSync(f)) return null; return Buffer.from(readFileSync(f, "utf8").trim(), "base64"); };

let restoredStamp = 0;
/** Restores the newest backup (Postgres or the seed file) when the data directory has no database. */
export async function restoreIfEmpty(dataDir: string, log: (m: string) => void = console.log): Promise<boolean> {
  if (existsSync(join(dataDir, "vaultbreak.db"))) return false;
  if (!PASS()) { log("no database here and BACKUP_PASSPHRASE is not set: starting empty"); return false; }
  const cands: { src: string; plain: Buffer; at: number }[] = [];
  const pick = process.env.BACKUP_RESTORE_ROW_AT;
  if (DBURL()) { try { const b = pick ? (await readPgAt(pick)) ?? (log(`BACKUP_RESTORE_ROW_AT=${pick}: no such row, using the newest`), await readPg()) : await readPg(); if (b) { const plain = open(b); cands.push({ src: "postgres", plain, at: stampOf(plain) }); } else log("postgres: no backup row yet"); } catch (e) { log(`postgres unavailable: ${String(e).slice(0, 100)}`); } }
  try { const b = readSeed(); if (b) { const plain = open(b); cands.push({ src: "seed file", plain, at: stampOf(plain) }); } } catch (e) { log(`seed file unreadable: ${String(e).slice(0, 100)}`); }
  if (!cands.length) { log("no backup found anywhere: starting empty"); return false; }
  cands.sort((a, b) => b.at - a.at);
  mkdirSync(dataDir, { recursive: true });
  let chosen = cands[0];
  // an operator override beats "newest"
  if (pick) { const p = cands.find((x) => x.src === "postgres"); if (p) chosen = p; }
  let n = unpack(dataDir, chosen.plain);
  restoredStamp = chosen.at;
  // A restart starts the new instance while the old one is still writing its final backup. Wait for it, then take anything newer.
  const settle = Number(process.env.BACKUP_SETTLE_MS ?? 20000);
  if (settle > 0 && DBURL() && !pick) {
    await new Promise((r) => setTimeout(r, settle));
    try { const b = await readPg(); if (b) { const plain = open(b); const at = stampOf(plain); if (at > chosen.at) { n = unpack(dataDir, plain); restoredStamp = at; chosen = { src: "postgres (final write of the previous instance)", plain, at }; } } } catch (e) { log(`settle re-check failed: ${String(e).slice(0, 100)}`); }
  }
  cands[0] = chosen;
  log(`restored ${n} files from the newest backup (${cands[0].src}, taken ${new Date(cands[0].at).toISOString()}${cands.length > 1 ? `; also saw ${cands[1].src} from ${new Date(cands[1].at).toISOString()}` : ""})`);
  return true;
}

/** A hash of what matters, ignoring volatile bookkeeping (rate-limit usage, login tokens) and the timestamp. */
function fingerprint(dataDir: string): string {
  const h = createHash("sha256");
  const dbPath = join(dataDir, "vaultbreak.db");
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const t of ["guardians", "sessions", "turns", "custodial", "api_keys", "nft_transfers", "blocked_attempts", "custodial_topups"]) {
        try { const q = t === "guardians" ? "SELECT id, vault_account, owner, ops, prompt_hash, prompt_ciphertext, revealed, retired, danger_mode, model, key_ref, name, turns_max, created_at, registry, pending FROM guardians" : `SELECT * FROM ${t}`; h.update(t + JSON.stringify(db.prepare(q).all())); } catch { /* table may not exist yet */ }
      }
    } finally { db.close(); }
  }
  for (const f of listFiles(dataDir)) h.update(f + readFileSync(join(dataDir, f)).length);
  return h.digest("hex");
}

let started: { dataDir: string; log: (m: string) => void; lastHash: string; lastAt: number; lastStamp: number } | null = null;
export async function backupNow(reason: string): Promise<boolean> {
  if (!started || !backupEnabled() || !DBURL()) return false;
  try {
    // never overwrite a newer row written by another instance (an old instance finishing its shutdown, or a new one that took over)
    if (started.lastStamp) { const b = await readPg(); if (b) { const at = stampOf(open(b)); if (at > started.lastStamp) { started.log(`backup skipped: the store already has a newer row (${new Date(at).toISOString()})`); return false; } } }
    const plain = pack(started.dataDir); await writePg(seal(plain)); started.lastStamp = stampOf(plain);
    started.lastAt = Date.now(); started.log(`backup saved to postgres (${reason})`); return true;
  } catch (e) { started.log(`backup failed: ${String(e).slice(0, 120)}`); return false; }
}

/**
 * Starts the backup loop: looks every minute, writes at most once per BACKUP_MIN_INTERVAL_MS (default 12 minutes) and only when the
 * state changed; writes once more on SIGTERM so a restart or deploy keeps the newest state.
 */
export function startBackups(dataDir: string, log: (m: string) => void = console.log): void {
  if (!PASS() || !DBURL()) { log("off-site backup disabled (set BACKUP_PASSPHRASE and DATABASE_URL to enable)"); return; }
  const minMs = Number(process.env.BACKUP_MIN_INTERVAL_MS ?? 12 * 60_000);
  // the state we booted with is already in the store (it was restored from it): only real changes get written
  started = { dataDir, log, lastHash: fingerprint(dataDir), lastAt: Date.now(), lastStamp: restoredStamp };
  const tick = async () => {
    if (!started) return;
    try {
      const h = fingerprint(dataDir);
      if (h === started.lastHash) return;
      if (started.lastAt && Date.now() - started.lastAt < minMs) return;
      if (await backupNow("state changed")) started.lastHash = h;
    } catch (e) { log(`backup check failed: ${String(e).slice(0, 120)}`); }
  };
  setTimeout(() => void tick(), 60_000); (setInterval(() => void tick(), 60_000) as any).unref?.();
  // A restart starts this instance while the previous one is still finishing its final write. If a newer row shows up in the store
  // during the first minutes, this instance booted from an older state: exit, so the host restarts it from the newest row.
  const bootAt = Date.now();
  const guard = setInterval(async () => {
    if (!started || !started.lastStamp || Date.now() - bootAt > 5 * 60_000) { if (Date.now() - bootAt > 5 * 60_000) clearInterval(guard); return; }
    try { const b = await readPg(); if (b && stampOf(open(b)) > started.lastStamp) { log("a newer backup appeared after boot (the previous instance's final write): restarting to restore it"); process.exit(0); } } catch { /* try again */ }
  }, 10_000); (guard as any).unref?.();
  let closing = false;
  const bye = async (sig: string) => { if (closing) return; closing = true; try { if (started && fingerprint(dataDir) !== started.lastHash) await backupNow(`final, ${sig}`); } finally { process.exit(0); } };
  process.on("SIGTERM", () => void bye("SIGTERM")); process.on("SIGINT", () => void bye("SIGINT"));
}

/** For tools: the sealed backup of a data directory as one buffer. */
export const sealedBackup = (dataDir: string): Buffer => seal(pack(dataDir));
