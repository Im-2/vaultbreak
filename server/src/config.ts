import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load .env from the cwd, else from the repo root (npm workspaces run scripts from server/). Never printed, never committed.
for (const f of [".env", fileURLToPath(new URL("../../.env", import.meta.url))]) {
  if (existsSync(f)) { process.loadEnvFile(f); break; }
}

export interface LlmConfig {
  provider: string;      // nearai | groq | openrouter | gemini | custom | mock
  baseUrl: string;
  apiKey: string | undefined;
  model: string;         // "mock" = deterministic offline model
  toolMode: "native" | "json";
  maxTokens: number;
}

export interface Config {
  port: number;
  rpcUrl: string;
  dbPath: string;
  keysDir: string;
  adminToken: string | undefined;
  llm: LlmConfig;
  /** NEAR AI Cloud settings, used by the verification/privacy layer regardless of the inference provider. */
  nearai: { baseUrl: string; apiKey: string | undefined };
}

/** Provider presets: only base URL / default model. Keys always come from env. */
export const PRESETS: Record<string, { baseUrl: string; model?: string }> = {
  nearai: { baseUrl: "https://cloud-api.near.ai/v1", model: "anthropic/claude-haiku-5-5" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
};

/**
 * Model provider selection (all OpenAI-compatible):
 *   MODEL_BASE_URL, MODEL_API_KEY, MODEL_NAME            explicit settings (any provider)
 *   MODEL_PROVIDER=nearai|groq|openrouter|gemini         optional preset for the base URL (+ default model)
 *   MODEL_PROVIDER=nearai                                 also reads the key from NEARAI_API_KEY if MODEL_API_KEY is unset
 * With nothing set the provider is "mock" (offline, deterministic).
 * Legacy NEARAI_BASE_URL / NEARAI_MODEL / NEARAI_TOOL_MODE are honoured when MODEL_* is absent and NEARAI_API_KEY is set.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nearai = { baseUrl: env.NEARAI_BASE_URL ?? PRESETS.nearai.baseUrl, apiKey: env.NEARAI_API_KEY };
  let provider = env.MODEL_PROVIDER?.toLowerCase();
  if (!provider) provider = env.MODEL_BASE_URL ? "custom" : env.MODEL_NAME && env.MODEL_NAME !== "mock" ? (nearai.apiKey ? "nearai" : "custom") : "mock";
  const preset = PRESETS[provider];
  const baseUrl = env.MODEL_BASE_URL ?? preset?.baseUrl ?? (provider === "nearai" ? nearai.baseUrl : "");
  const model = provider === "mock" ? "mock" : (env.MODEL_NAME ?? env.NEARAI_MODEL ?? preset?.model ?? "");
  const apiKey = env.MODEL_API_KEY ?? (provider === "nearai" ? nearai.apiKey : undefined);
  if (provider !== "mock" && (!baseUrl || !model)) throw new Error("MODEL_BASE_URL and MODEL_NAME are required (or set MODEL_PROVIDER to a preset); unset them to use the offline mock model");
  return {
    port: Number(env.PORT ?? 8787),
    rpcUrl: env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com,https://near-testnet.drpc.org",
    dbPath: env.DB_PATH ?? "./server/vaultbreak.db",
    keysDir: env.KEYS_DIR ?? "./.keys",
    adminToken: env.ADMIN_TOKEN,
    llm: {
      provider, baseUrl, apiKey, model,
      toolMode: ((env.MODEL_TOOL_MODE ?? env.NEARAI_TOOL_MODE) as "native" | "json") ?? "native",
      maxTokens: Number(env.MODEL_MAX_TOKENS ?? env.NEARAI_MAX_TOKENS ?? 300),
    },
    nearai,
  };
}

/**
 * Built-in per-provider defaults. The "rogue" guardian simulates a jailbroken model; openai/gpt-oss-120b refuses to play
 * it (empty reply, no tool call, verified on Groq), while qwen/qwen3.8-27b follows the prompt and emits the forbidden calls.
 */
const GUARDIAN_MODEL_DEFAULTS: Record<string, Record<string, string>> = { groq: { rogue: "qwen/qwen3.8-27b" } };

/** Per-guardian model: MODEL_NAME_<GUARDIAN_ID> override, else a provider default, else MODEL_NAME. */
export function modelFor(cfg: Config, guardianId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (cfg.llm.provider === "mock") return "mock";
  return env[`MODEL_NAME_${guardianId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] ?? GUARDIAN_MODEL_DEFAULTS[cfg.llm.provider]?.[guardianId] ?? cfg.llm.model;
}
