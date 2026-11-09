import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env"); // never printed, never committed

export interface Config {
  port: number;
  rpcUrl: string;
  dbPath: string;
  keysDir: string;
  adminToken: string | undefined;
  llm: { baseUrl: string; apiKey: string | undefined; model: string; toolMode: "native" | "json"; maxTokens: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    rpcUrl: env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org",
    dbPath: env.DB_PATH ?? "./server/vaultbreak.db",
    keysDir: env.KEYS_DIR ?? "./.keys",
    adminToken: env.ADMIN_TOKEN,
    llm: {
      baseUrl: env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1",
      apiKey: env.NEARAI_API_KEY,
      model: env.NEARAI_MODEL ?? "mock", // "mock" = deterministic offline model (tests/demo)
      toolMode: (env.NEARAI_TOOL_MODE as "native" | "json") ?? "native",
      maxTokens: Number(env.NEARAI_MAX_TOKENS ?? 300),
    },
  };
}
