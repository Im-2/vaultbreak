import { serve } from "@hono/node-server";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { promptKey } from "./crypto.ts";
import { MockLlm, NearAiLlm, type Llm } from "./llm.ts";
import { createApp } from "./app.ts";
import { seedFromDeployments } from "./guardians.ts";
import { startIndexer } from "./indexer.ts";

export function makeLlm(cfg = loadConfig()): Llm {
  if (cfg.llm.model === "mock") return new MockLlm();
  if (!cfg.llm.apiKey) throw new Error("NEARAI_API_KEY is not set (put it in .env)");
  return new NearAiLlm(cfg.llm.baseUrl, cfg.llm.apiKey, cfg.llm.toolMode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const pkey = promptKey(cfg.keysDir);
  const seeded = seedFromDeployments(db, cfg, pkey);
  const { app } = createApp({ db, cfg, llm: makeLlm(cfg), pkey });
  startIndexer(db, cfg);
  serve({ fetch: app.fetch, port: cfg.port });
  console.log(`vaultbreak server on :${cfg.port} model=${cfg.llm.model} rpc=${cfg.rpcUrl} guardians=[${seeded.join(", ")}]`);
}
