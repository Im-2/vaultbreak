// Prints the demo account's balance and owned Guardians (credentials come from the environment; never printed).
const base = "https://tryvaultbreak.vercel.app/api";
const call = async (p, o = {}) => { const r = await fetch(base + p, o); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) }; } catch { return { s: r.status, b: t.slice(0, 100) }; } };
const name = process.argv[2] === "second" ? process.env.SECOND_NAME : process.env.DEMO_NAME, pass = process.argv[2] === "second" ? process.env.SECOND_PASSPHRASE : process.env.DEMO_PASSPHRASE;
const si = await call("/custodial/signin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, secret: pass }) });
if (!si.b.token) { console.log("signin failed", si.s, JSON.stringify(si.b).slice(0, 120)); process.exit(1); }
const H = { authorization: `Bearer ${si.b.token}` };
const me = (await call("/me", { headers: H })).b; const owned = (await call("/me/guardians", { headers: H })).b;
console.log("account", me.account, "| credits", (Number(BigInt(me.credits) / 10n ** 20n) / 1e4).toFixed(3), "NEAR | wins", me.wins, "failed", me.failed, "open", me.open);
console.log("owned:", Array.isArray(owned) ? owned.map((g) => `${g.id}(${g.status},pot ${(Number(BigInt(g.pot) / 10n ** 20n) / 1e4).toFixed(2)},fees ${(Number(BigInt(g.creator_balance) / 10n ** 20n) / 1e4).toFixed(3)})`).join(", ") : JSON.stringify(owned));
const keys = (await call("/agent/keys", { headers: H })).b; console.log("agent keys:", Array.isArray(keys) ? keys.length : keys);
