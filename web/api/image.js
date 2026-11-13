// The Guardian card art (SVG) that does not depend on the backend being up.
//   /api/guardians/:id/image.svg  ->  (vercel.json rewrite)  ->  /api/image?id=:id
// 1. live SVG from the backend (short timeout)  2. the last SVG the backend saved to Vercel Blob  3. the SVG bundled with this
// deployment  4. a JSON 404. Always the right content-type and CORS open; never an HTML error page.
import backend from "./_backend.js";
import bundled from "./_snapshots.js";

const TIMEOUT_MS = 3500;
const SVG = { "content-type": "image/svg+xml; charset=utf-8", "access-control-allow-origin": "*" };

async function getSvg(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  return { status: r.status, text: text.trimStart().startsWith("<svg") ? text : null };
}

export default async function handler(req, res) {
  const id = String((req.query && req.query.id) || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  const send = (status, body, source, cache, json = false) => {
    for (const [k, v] of Object.entries(json ? { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } : SVG)) res.setHeader(k, v);
    res.statusCode = status; res.setHeader("x-vaultbreak-source", source); res.setHeader("cache-control", cache); res.end(body);
  };
  if (!id) return send(400, JSON.stringify({ error: "missing guardian id" }), "none", "no-store", true);

  let missing = false;
  try {
    const live = await getSvg(`${backend.url}/guardians/${id}/image.svg`);
    if (live.status === 200 && live.text) return send(200, live.text, "live", "public, s-maxage=20, stale-while-revalidate=600");
    if (live.status === 404) missing = true;
  } catch { /* backend offline or slow: fall back */ }
  if (missing) return send(404, JSON.stringify({ error: "unknown guardian", id }), "live", "public, s-maxage=60", true);

  const b = bundled.svg && bundled.svg[id];
  if (b) return send(200, b, "bundled-snapshot", "public, s-maxage=30, stale-while-revalidate=3600");
  return send(404, JSON.stringify({ error: "unknown guardian, and the backend is offline so there is no snapshot", id }), "none", "public, s-maxage=15", true);
}
