// Points the website at a permanent backend URL: updates the /api rewrite and the metadata function's backend, then redeploy.
// Usage: node scripts/set-backend.mjs https://vaultbreak-backend.onrender.com && (cd web && vercel deploy --prod --yes)
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const url = (process.argv[2] ?? "").replace(/\/+$/, ""); if (!/^https:\/\//.test(url)) throw new Error("usage: set-backend.mjs https://backend.example.com");
const p = "web/vercel.json"; const j = JSON.parse(readFileSync(p, "utf8"));
const r = j.rewrites.find((x) => x.source === "/api/:path*"); r.destination = `${url}/:path*`;
writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
spawnSync("node", ["scripts/publish-site-files.mjs", url], { stdio: "inherit" });
console.log("updated web/vercel.json and web/api/_backend.js; now run: cd web && vercel deploy --prod --yes");
