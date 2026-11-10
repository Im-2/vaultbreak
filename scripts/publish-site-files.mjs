// Writes the two files the Vercel metadata function bundles with each deployment:
//   web/api/_backend.js    the backend URL (the function tries it first, with a short timeout)
//   web/api/_snapshots.js  the metadata of every Guardian as the backend reports it right now (last-resort fallback)
// Usage: node scripts/publish-site-files.mjs https://backend.example.com
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const url = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!url) throw new Error("usage: publish-site-files.mjs <backend url>");
writeFileSync("web/api/_backend.js", `// Written by scripts/publish-site-files.mjs on every deploy.\nexport default { url: ${JSON.stringify(url)} };\n`);
const prev = existsSync("web/api/_snapshots.js") ? readFileSync("web/api/_snapshots.js", "utf8") : "";
let snaps = {};
try { snaps = JSON.parse(/export default (\{[\s\S]*\});?\s*$/.exec(prev)?.[1] ?? "{}"); } catch { /* start empty */ }
try {
  const list = await (await fetch(`${url}/guardians`, { signal: AbortSignal.timeout(15000) })).json();
  for (const g of list) {
    try { const m = await (await fetch(`${url}/guardians/${g.id}/metadata.json`, { signal: AbortSignal.timeout(15000) })).json(); if (m?.title) snaps[g.id] = m; } catch { /* keep the previous snapshot */ }
  }
  console.log(`snapshots: ${Object.keys(snaps).length} Guardians`);
} catch (e) { console.log(`backend not reachable (${e.message}); keeping ${Object.keys(snaps).length} existing snapshots`); }
writeFileSync("web/api/_snapshots.js", `// Written by scripts/publish-site-files.mjs on every deploy: last known metadata per Guardian.\nexport default ${JSON.stringify(snaps, null, 1)};\n`);
