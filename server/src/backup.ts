// Off-site, encrypted backup of the backend's state, so a host with a wiped disk (or a new host) can recover everything:
// the SQLite database (guardians, sessions, transcripts, proofs, custodial accounts) and every key file (Guardian function-call
// keys, custodial play-account keys, the prompt-encryption key). Stored in Vercel Blob as ONE file encrypted with AES-256-GCM,
// key = scrypt(BACKUP_PASSPHRASE). The passphrase and the Blob token live only in the host's secret environment variables.
//   restoreIfEmpty(dataDir)  at boot, when the data directory has no database
//   startBackups(dataDir)    every 2 minutes, uploads when something changed
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

const TOKEN = () => process.env.BLOB_READ_WRITE_TOKEN;
const PASS = () => process.env.BACKUP_PASSPHRASE;
const PATHNAME = "state/vaultbreak-state.enc";
const blobBase = () => { const m = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(TOKEN() ?? ""); return m ? `https://${m[1].toLowerCase()}.public.blob.vercel-storage.com` : null; };
export const backupEnabled = () => !!TOKEN() && !!PASS();

function seal(plain: Buffer): Buffer {
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", scryptSync(PASS()!, salt, 32), iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from("VB1"), salt, iv, c.getAuthTag(), body]);
}
function open(blob: Buffer): Buffer {
  if (blob.subarray(0, 3).toString() !== "VB1") throw new Error("not a Vaultbreak backup");
  const salt = blob.subarray(3, 19), iv = blob.subarray(19, 31), tag = blob.subarray(31, 47);
  const d = createDecipheriv("aes-256-gcm", scryptSync(PASS()!, salt, 32), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(47)), d.final()]);
}

function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else if (!/vaultbreak\.db(-wal|-shm)?$/.test(e.name)) out.push(r);
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
  for (const f of listFiles(dataDir)) if (f !== ".backup-copy.db") files[f] = readFileSync(join(dataDir, f)).toString("base64");
  return Buffer.from(JSON.stringify({ v: 1, at: new Date().toISOString(), files }));
}
export function unpack(dataDir: string, plain: Buffer): number {
  const { files } = JSON.parse(plain.toString()) as { files: Record<string, string> };
  for (const [rel, b64] of Object.entries(files)) { const p = join(dataDir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, Buffer.from(b64, "base64")); }
  return Object.keys(files).length;
}

export async function restoreIfEmpty(dataDir: string, log: (m: string) => void = console.log): Promise<boolean> {
  if (existsSync(join(dataDir, "vaultbreak.db"))) return false;
  if (!backupEnabled()) { log("no database here and no backup configured (BLOB_READ_WRITE_TOKEN + BACKUP_PASSPHRASE): starting empty"); return false; }
  const r = await fetch(`${blobBase()}/${PATHNAME}`, { cache: "no-store" });
  if (!r.ok) { log(`no backup found (${r.status}): starting empty`); return false; }
  mkdirSync(dataDir, { recursive: true });
  const n = unpack(dataDir, open(Buffer.from(await r.arrayBuffer())));
  log(`restored ${n} files from the encrypted off-site backup`);
  return true;
}

export async function upload(packed: Buffer): Promise<boolean> {
  const r = await fetch(`https://blob.vercel-storage.com/${PATHNAME}`, { method: "PUT", body: seal(packed), headers: { authorization: `Bearer ${TOKEN()}`, "x-api-version": "7", "x-add-random-suffix": "0", "x-allow-overwrite": "1", "x-content-type": "application/octet-stream", "x-cache-control-max-age": "0" } });
  return r.ok;
}

export function startBackups(dataDir: string, log: (m: string) => void = console.log, everyMs = 120_000): void {
  if (!backupEnabled()) { log("off-site backup disabled (set BLOB_READ_WRITE_TOKEN and BACKUP_PASSPHRASE to enable)"); return; }
  let last = "";
  const tick = async () => {
    try {
      const packed = pack(dataDir);
      const stable = createHash("sha256").update(JSON.stringify(JSON.parse(packed.toString()).files)).digest("hex"); // ignores the timestamp
      if (stable === last) return;
      if (await upload(packed)) { last = stable; log(`off-site backup saved (${stable.slice(0, 8)})`); }
    } catch (e) { log(`backup failed: ${String(e).slice(0, 120)}`); }
  };
  setTimeout(() => void tick(), 10_000); (setInterval(() => void tick(), everyMs) as any).unref?.();
}
