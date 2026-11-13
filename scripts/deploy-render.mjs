// Deploys the backend to Render's FREE plan through the Render API, with every secret in Render environment variables only.
//   node --env-file=.env scripts/deploy-render.mjs            (needs RENDER_API_KEY in .env)
// Reads secrets from the gitignored .env / .keys and sends them to Render over HTTPS; nothing secret is written to git.
// Then waits for the deploy, restores state from the encrypted Blob backup on first boot, and prints the service URL.
// Afterwards: node scripts/set-backend.mjs <url> && (cd web && vercel deploy --prod --yes)
import { readFileSync } from "node:fs";
const KEY = process.env.RENDER_API_KEY; if (!KEY) throw new Error("RENDER_API_KEY is not set (put it in .env)");
const API = "https://api.render.com/v1";
const call = async (path, method = "GET", body) => {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${KEY}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${t.slice(0, 300)}`);
  return j;
};
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} is not set in .env`); return v; };
const funderKey = process.env.TESTNET_FUNDER_KEY ?? JSON.parse(readFileSync(".keys/vbreak-t2funder-1109.testnet.json", "utf8")).private_key;
const envVars = [
  ["PORT", "8787"], ["NEAR_RPC_URL", "https://test.rpc.fastnear.com,https://near-testnet.drpc.org"], ["PUBLIC_BASE_URL", "https://tryvaultbreak.vercel.app"],
  ["MODEL_PROVIDER", process.env.MODEL_PROVIDER ?? "groq"], ["MODEL_NAME", process.env.MODEL_NAME ?? "openai/gpt-oss-120b"], ["MODEL_API_KEY", need("MODEL_API_KEY")],
  ["STATE_SEED_FILE", "/etc/secrets/state-seed.b64"], ["BACKUP_PASSPHRASE", need("BACKUP_PASSPHRASE")], ["TESTNET_FUNDER_KEY", funderKey],
].map(([key, value]) => ({ key, value }));

const NAME = "vaultbreak-backend";
const owners = await call("/owners?limit=5"); const ownerId = owners[0].owner.id;
let svc = (await call(`/services?name=${NAME}&limit=5`)).map((x) => x.service).find((s) => s.name === NAME);
if (!svc) {
  const created = await call("/services", "POST", {
    type: "web_service", name: NAME, ownerId, repo: "https://github.com/Im-2/vaultbreak", branch: "main", autoDeploy: "yes",
    serviceDetails: { runtime: "docker", plan: "free", region: "oregon", healthCheckPath: "/stats", envSpecificDetails: { dockerfilePath: "./Dockerfile", dockerContext: "." } },
    envVars,
  });
  svc = created.service; console.log("created service", svc.id);
} else {
  await call(`/services/${svc.id}/env-vars`, "PUT", envVars); console.log("updated env vars on", svc.id);
  await call(`/services/${svc.id}/deploys`, "POST", {});
}
const url = svc.serviceDetails?.url ?? (await call(`/services/${svc.id}`)).serviceDetails.url;
console.log("service url:", url);
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  const d = (await call(`/services/${svc.id}/deploys?limit=1`))[0]?.deploy;
  console.log("deploy", d?.status);
  if (d?.status === "live") break;
  if (["build_failed", "update_failed", "canceled", "deactivated"].includes(d?.status)) throw new Error(`deploy ${d.status}`);
}
console.log("done:", url);
