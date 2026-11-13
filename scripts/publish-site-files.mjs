// Writes the two files the Vercel metadata function bundles with each deployment:
//   web/api/_backend.js    the backend URL (the function tries it first, with a short timeout)
//   web/api/_snapshots.js  the metadata of every Guardian as the backend reports it right now (last-resort fallback)
// Usage: node scripts/publish-site-files.mjs https://backend.example.com
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const url = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!url) throw new Error("usage: publish-site-files.mjs <backend url>");
writeFileSync("web/api/_backend.js", `// Written by scripts/publish-site-files.mjs on every deploy.\nexport default { url: ${JSON.stringify(url)} };\n`);
const prev = existsSync("web/api/_snapshots.js") ? readFileSync("web/api/_snapshots.js", "utf8") : "";
let snaps = { meta: {}, svg: {}, snap: null };
try { const parsed = JSON.parse(/export default ({[sS]*});?s*$/.exec(prev)?.[1] ?? "{}"); snaps = { meta: parsed.meta ?? {}, svg: parsed.svg ?? {}, snap: parsed.snap ?? null }; } catch { /* start empty */ }
try {
  const list = await (await fetch(`${url}/guardians`, { signal: AbortSignal.timeout(15000) })).json();
  for (const g of list) {
    try { const m = await (await fetch(`${url}/guardians/${g.id}/metadata.json`, { signal: AbortSignal.timeout(15000) })).json(); if (m?.title) snaps.meta[g.id] = m; } catch { /* keep the previous snapshot */ }
    try { const t = await (await fetch(`${url}/guardians/${g.id}/image.svg`, { signal: AbortSignal.timeout(20000) })).text(); if (t.trimStart().startsWith("<svg")) snaps.svg[g.id] = t; } catch { /* keep the previous snapshot */ }
  }
  console.log(`snapshots: ${Object.keys(snaps.meta).length} metadata, ${Object.keys(snaps.svg).length} SVG`);
} catch (e) { console.log(`backend not reachable (${e.message}); keeping ${Object.keys(snaps.meta).length} existing snapshots`); }
// stats + guardian list for the landing page: live if the backend answers, otherwise derived from the metadata snapshots
const fromMeta = (m) => { const x = m.extra ?? {}; const a = (m.attributes ?? []).find((q) => q.trait_type === "tier")?.value;
  return { id: m.external_url?.split("/guardian/")[1] ?? x.nft?.token_id, name: String(m.title ?? "").replace(/^Guardian /, ""), vault_account: x.vault_account, owner: x.owner, status: x.status, created_at: 0, art: a ?? (x.status === "Defeated" ? "defeated" : "armed"), pot: x.pot, min_fee: "100000000000000000000000", turns_max: 8, session_ttl_ms: "600000",
    stats: { attempts: x.attempts, wins: x.wins, closed_failed: 0, streak: x.streak, blocked_reported: x.blocked_reported, total_fees: x.total_fees ?? "0" }, prompt_hash: x.prompt_hash ?? "", revealed: !!x.revealed, model: "", danger_mode: true, nft: x.nft }; };
let list = null, stats = null;
try { list = await (await fetch(`${url}/guardians`, { signal: AbortSignal.timeout(20000) })).json(); stats = await (await fetch(`${url}/stats`, { signal: AbortSignal.timeout(20000) })).json(); } catch { /* derive below */ }
if (!Array.isArray(list)) {
  list = Object.values(snaps.meta).map(fromMeta);
  const alive = list.filter((g) => g.status === "Armed");
  stats = { guardians: list.length, alive: alive.length, total_pot: alive.reduce((a, g) => a + BigInt(g.pot ?? 0), 0n).toString(), attempts: list.reduce((a, g) => a + Number(g.stats.attempts ?? 0), 0), wins: list.reduce((a, g) => a + Number(g.stats.wins ?? 0), 0), open_sessions: 0, blocked_today: 0, blocked_reported: list.reduce((a, g) => a + Number(g.stats.blocked_reported ?? 0), 0) };
}
let config = null; try { config = await (await fetch(`${url}/config`, { signal: AbortSignal.timeout(20000) })).json(); } catch { /* keep null */ }
snaps.snap = { at: Date.now(), stats, guardians: list };
writeFileSync("web/public/snapshot.json", JSON.stringify({ at: snaps.snap.at, stats, guardians: list, config }));
console.log(`landing snapshot: ${list.length} Guardians, stats ${JSON.stringify(stats).slice(0, 90)}`);
writeFileSync("web/api/_snapshots.js", `// Written on every deploy by scripts/publish-site-files.mjs: last known metadata and card SVG per Guardian.
export default ${JSON.stringify(snaps)};
`);
