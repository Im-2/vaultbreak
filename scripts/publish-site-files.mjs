// Writes the two files the Vercel metadata function bundles with each deployment:
//   web/api/_backend.js    the backend URL (the function tries it first, with a short timeout)
//   web/api/_snapshots.js  the metadata of every Guardian as the backend reports it right now (last-resort fallback)
// Usage: node scripts/publish-site-files.mjs https://backend.example.com
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const url = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!url) throw new Error("usage: publish-site-files.mjs <backend url>");
writeFileSync("web/api/_backend.js", `// Written by scripts/publish-site-files.mjs on every deploy.\nexport default { url: ${JSON.stringify(url)} };\n`);
const prev = existsSync("web/api/_snapshots.js") ? readFileSync("web/api/_snapshots.js", "utf8") : "";
let snaps = { meta: {}, svg: {} };
try { const parsed = JSON.parse(/export default ({[sS]*});?s*$/.exec(prev)?.[1] ?? "{}"); snaps = { meta: parsed.meta ?? {}, svg: parsed.svg ?? {} }; } catch { /* start empty */ }
try {
  const list = await (await fetch(`${url}/guardians`, { signal: AbortSignal.timeout(15000) })).json();
  for (const g of list) {
    try { const m = await (await fetch(`${url}/guardians/${g.id}/metadata.json`, { signal: AbortSignal.timeout(15000) })).json(); if (m?.title) snaps.meta[g.id] = m; } catch { /* keep the previous snapshot */ }
    try { const t = await (await fetch(`${url}/guardians/${g.id}/image.svg`, { signal: AbortSignal.timeout(20000) })).text(); if (t.trimStart().startsWith("<svg")) snaps.svg[g.id] = t; } catch { /* keep the previous snapshot */ }
  }
  console.log(`snapshots: ${Object.keys(snaps.meta).length} metadata, ${Object.keys(snaps.svg).length} SVG`);
} catch (e) { console.log(`backend not reachable (${e.message}); keeping ${Object.keys(snaps.meta).length} existing snapshots`); }
writeFileSync("web/api/_snapshots.js", `// Written on every deploy by scripts/publish-site-files.mjs: last known metadata and card SVG per Guardian.
export default ${JSON.stringify(snaps)};
`);
