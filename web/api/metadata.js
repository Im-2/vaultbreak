// NFT metadata that does not depend on the backend being up.
//   /api/guardians/:id/metadata.json  ->  (vercel.json rewrite)  ->  /api/metadata?id=:id
// 1. live stats from the backend (short timeout)  2. the last snapshot the backend saved to Vercel Blob
// 3. the snapshot bundled with this deployment  4. a clear JSON error. Always valid JSON, CORS open, never an HTML/text error page.
import backend from "./_backend.js";
import bundled from "./_snapshots.js";

const TIMEOUT_MS = 2500;
const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
};

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body };
}


export default async function handler(req, res) {
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }
  const id = String((req.query && req.query.id) || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  const send = (status, body, source, cache) => {
    res.statusCode = status;
    res.setHeader("x-vaultbreak-source", source);
    res.setHeader("cache-control", cache);
    res.end(JSON.stringify(body));
  };
  if (!id) return send(400, { error: "missing guardian id" }, "none", "no-store");

  // 1. live
  let backendSaidMissing = false;
  try {
    const live = await getJson(`${backend.url}/guardians/${id}/metadata.json`);
    if (live.status === 200 && live.body && live.body.title) return send(200, live.body, "live", "public, s-maxage=20, stale-while-revalidate=600");
    if (live.status === 404 && live.body && live.body.error) backendSaidMissing = true;
  } catch { /* backend offline or slow: fall back */ }
  if (backendSaidMissing) return send(404, { error: "unknown guardian", id }, "live", "public, s-maxage=60");


  // 3. snapshot bundled with this deployment
  if (bundled.meta && bundled.meta[id]) return send(200, stale(bundled.meta[id], "bundled-snapshot"), "bundled-snapshot", "public, s-maxage=30, stale-while-revalidate=3600");

  return send(404, { error: "unknown guardian, and the backend is offline so there is no snapshot", id }, "none", "public, s-maxage=15");
}

function stale(body, source) {
  const extra = Object.assign({}, body.extra, { stale: true, snapshot_source: source });
  return Object.assign({}, body, { extra });
}
