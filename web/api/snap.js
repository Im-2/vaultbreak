// /api/stats and /api/guardians (the list), fast and never empty:
//   1. the live backend, with a short timeout (the backend caches these for a few seconds, so this is normally quick)
//   2. when it is slow or asleep: the snapshot bundled with the last deployment (clearly marked: x-vaultbreak-source: snapshot)
// Cached at the CDN with stale-while-revalidate, so after the first request a visitor is answered from the cache immediately while the
// CDN refreshes it from the backend in the background.
import backend from "./_backend.js";
import snaps from "./_snapshots.js";

const WHAT = { stats: { path: "/stats", timeout: 1800 }, guardians: { path: "/guardians", timeout: 3000 } };
const HEAD = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };

export default async function handler(req, res) {
  const what = req.query && req.query.what === "guardians" ? "guardians" : "stats";
  const send = (status, body, source, cache, extra = {}) => {
    for (const [k, v] of Object.entries({ ...HEAD, "x-vaultbreak-source": source, "cache-control": cache, ...extra })) res.setHeader(k, v);
    res.statusCode = status; res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  try {
    const r = await fetch(`${backend.url}${WHAT[what].path}`, { signal: AbortSignal.timeout(WHAT[what].timeout), headers: { accept: "application/json" } });
    const text = await r.text(); JSON.parse(text);
    if (r.ok) return send(200, text, "live", "public, s-maxage=15, stale-while-revalidate=600");
  } catch { /* slow or asleep: use the snapshot */ }
  const snap = snaps.snap && snaps.snap[what];
  if (snap) return send(200, snap, "snapshot", "public, s-maxage=5, stale-while-revalidate=60", { "x-vaultbreak-snapshot-at": String(snaps.snap.at || "") });
  return send(503, { error: "backend not reachable and no snapshot" }, "none", "no-store");
}
