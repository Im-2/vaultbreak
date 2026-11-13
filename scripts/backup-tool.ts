// Operator tool for the encrypted state backup (see server/src/backup.ts). Reads BACKUP_PASSPHRASE (and DATABASE_URL for `push`) from the
// environment; never prints them.
//   node --env-file=.env --import tsx scripts/backup-tool.ts seed <dataDir> <outFile>   write the sealed backup as base64 text (a Render secret file)
//   node --env-file=.env --import tsx scripts/backup-tool.ts push <dataDir>             write the sealed backup into Postgres
//   node --env-file=.env --import tsx scripts/backup-tool.ts check <outFile>            decrypt a seed file and print what it contains (no keys)
import { writeFileSync, readFileSync } from "node:fs";
import { sealedBackup, writePg, unpack } from "../server/src/backup.ts";
import { createDecipheriv, scryptSync } from "node:crypto";
import { gunzipSync } from "node:zlib";
const [cmd, a, b] = process.argv.slice(2);
if (cmd === "seed") { const buf = sealedBackup(a); writeFileSync(b, buf.toString("base64")); console.log(`seed written: ${buf.length} bytes sealed, ${Math.round(buf.toString("base64").length / 1024)} KB as base64`); }
else if (cmd === "push") { const buf = sealedBackup(a); await writePg(buf); console.log(`pushed ${buf.length} bytes to postgres`); }
else if (cmd === "check") {
  const blob = Buffer.from(readFileSync(a, "utf8").trim(), "base64"); const salt = blob.subarray(3, 19), iv = blob.subarray(19, 31), tag = blob.subarray(31, 47);
  const d = createDecipheriv("aes-256-gcm", scryptSync(process.env.BACKUP_PASSPHRASE!, salt, 32), iv); d.setAuthTag(tag);
  const plain = blob.subarray(0, 3).toString() === "VB2" ? gunzipSync(Buffer.concat([d.update(blob.subarray(47)), d.final()])) : Buffer.concat([d.update(blob.subarray(47)), d.final()]);
  const j = JSON.parse(plain.toString()); console.log(`taken ${j.at}; ${Object.keys(j.files).length} files; names: ${Object.keys(j.files).filter((f) => !f.startsWith("keys/")).join(", ")}; key files: ${Object.keys(j.files).filter((f) => f.startsWith("keys/")).length}`);
  void unpack;
} else console.log("usage: seed <dataDir> <outFile> | push <dataDir> | check <file>");
