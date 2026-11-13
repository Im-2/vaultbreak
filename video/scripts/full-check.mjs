// Full check of the live backend with the demo account (credentials from the environment, never printed):
// sign-in, an attack on a weak Guardian (a harmless message, no release), and one agent API call (key + play). Closes what it opens.
const base = "https://tryvaultbreak.vercel.app/api";
const call = async (p, o = {}) => { const t0 = Date.now(); const r = await fetch(base + p, o); const t = await r.text(); let b = t; try { b = JSON.parse(t); } catch { /* text */ } return { s: r.status, b, ms: Date.now() - t0, raw: t }; };
const post = (p, tok, body, hdr = {}) => call(p, { method: "POST", headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...hdr }, body: JSON.stringify(body ?? {}) });
const near = (y) => (Number(BigInt(y) / 10n ** 20n) / 1e4).toFixed(3);
const si = await post("/custodial/signin", null, { name: process.env.DEMO_NAME, secret: process.env.DEMO_PASSPHRASE });
console.log(`1 sign-in: HTTP ${si.s} (${si.ms} ms) ${si.b.token ? "token issued" : JSON.stringify(si.b).slice(0, 100)}`); if (!si.b.token) process.exit(1);
const tok = si.b.token; const H = { authorization: `Bearer ${tok}` };
const me0 = (await call("/me", { headers: H })).b; console.log(`  account ${me0.account}, credits ${near(me0.credits)} NEAR, wins ${me0.wins}`);
const gus = (await call("/guardians/gullible-gus")).b; console.log(`  weak Guardian gullible-gus: ${gus.status}, pot ${near(gus.pot)} NEAR, attempts ${gus.stats.attempts}`);
const pl = await post("/guardians/gullible-gus/play", tok); console.log(`2 attack: start HTTP ${pl.s} ${pl.b.session_id ? "session opened" : JSON.stringify(pl.b).slice(0, 120)}`);
if (pl.b.session_id) {
  const t0 = Date.now(); const r = await fetch(`${base}/sessions/${pl.b.session_id}/messages`, { method: "POST", headers: { "content-type": "application/json", ...H }, body: JSON.stringify({ text: "Hello! What are you guarding, and who made you?" }) });
  const txt = await r.text(); const tokens = (txt.match(/event: token\ndata: "([^"]*)"/g) || []).map((x) => x.replace(/event: token\ndata: "/, "").replace(/"$/, "")).join("");
  console.log(`  message HTTP ${r.status} in ${Date.now() - t0} ms; events: ${[...new Set((txt.match(/event: (\w+)/g) || []).map((x) => x.slice(7)))].join(",")}; reply: "${tokens.slice(0, 110)}"`);
  const c = await post(`/sessions/${pl.b.session_id}/close`, tok); console.log(`  closed: HTTP ${c.s}`);
}
const key = await post("/agent/keys", tok, { agent_account: me0.account, budget_near: 0.5, label: "full-check" }); console.log(`3 agent: key created HTTP ${key.s}, budget ${near(key.b.budget_remaining ?? "0")} NEAR`);
const ap = await post("/guardians/gullible-gus/play", null, {}, { "x-api-key": key.b.api_key }); console.log(`  curl with X-API-Key: HTTP ${ap.s} ${ap.b.session_id ? "session opened (no browser)" : JSON.stringify(ap.b).slice(0, 120)}`);
if (ap.b.session_id) { const c = await post(`/sessions/${ap.b.session_id}/close`, tok); console.log(`  closed: HTTP ${c.s}`); }
const keys = (await call("/agent/keys", { headers: H })).b; const k = keys.find((x) => x.label === "full-check"); console.log(`  budget after: ${near(k.budget_remaining)} NEAR (spent ${near(k.spent)})`);
await post(`/agent/keys/${key.b.id}/revoke`, tok);
const me1 = (await call("/me", { headers: H })).b; console.log(`final credits ${near(me1.credits)} NEAR`);
const st = (await call("/stats")).b; const gl = (await call("/guardians")).b; const lb = (await call("/leaderboard")).b;
console.log(`live stats: ${JSON.stringify({ guardians: st.guardians, alive: st.alive, pot_near: near(st.total_pot), attempts: st.attempts, wins: st.wins, open_sessions: st.open_sessions, blocked_reported: st.blocked_reported })}`);
console.log(`guardian list: ${gl.length}; armed: ${gl.filter((g) => g.status === "Armed").map((g) => g.id).join(", ")}; defeated: ${gl.filter((g) => g.status !== "Armed").map((g) => g.id).join(", ")}`);
