import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, modelFor } from "../src/config.ts";
import { OpenAiCompatLlm } from "../src/llm.ts";
import { createServer } from "node:http";

test("no model env => offline mock", () => {
  assert.equal(loadConfig({}).llm.provider, "mock");
  assert.equal(loadConfig({ NEARAI_MODEL: "x" }).llm.model, "mock");
});

test("explicit MODEL_* works for any OpenAI-compatible provider", () => {
  const c = loadConfig({ MODEL_BASE_URL: "https://example.test/v1", MODEL_API_KEY: "k", MODEL_NAME: "m" });
  assert.deepEqual([c.llm.provider, c.llm.baseUrl, c.llm.apiKey, c.llm.model], ["custom", "https://example.test/v1", "k", "m"]);
});

test("groq preset: base URL + default model, key from MODEL_API_KEY", () => {
  const c = loadConfig({ MODEL_PROVIDER: "groq", MODEL_API_KEY: "gk" });
  assert.equal(c.llm.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(c.llm.model, "openai/gpt-oss-120b");
  assert.equal(c.llm.apiKey, "gk");
});

test("nearai preset reads NEARAI_API_KEY; MODEL_* overrides still win", () => {
  const c = loadConfig({ MODEL_PROVIDER: "nearai", NEARAI_API_KEY: "nk" });
  assert.equal(c.llm.baseUrl, "https://cloud-api.near.ai/v1");
  assert.equal(c.llm.apiKey, "nk");
  assert.equal(loadConfig({ MODEL_PROVIDER: "nearai", NEARAI_API_KEY: "nk", MODEL_NAME: "other" }).llm.model, "other");
  // the NEAR AI settings stay available for the privacy layer even when inference uses another provider
  const g = loadConfig({ MODEL_PROVIDER: "groq", MODEL_API_KEY: "gk", NEARAI_API_KEY: "nk" });
  assert.equal(g.nearai.apiKey, "nk");
  assert.equal(g.nearai.baseUrl, "https://cloud-api.near.ai/v1");
});

test("misconfiguration is an error, not a silent fallback", () => {
  assert.throws(() => loadConfig({ MODEL_PROVIDER: "openrouter" }), /MODEL_BASE_URL and MODEL_NAME/);
});

test("per-guardian model override", () => {
  const env = { MODEL_PROVIDER: "groq", MODEL_API_KEY: "k", MODEL_NAME_WEAK: "llama-3.1-8b-instant" };
  const c = loadConfig(env);
  assert.equal(modelFor(c, "weak", env), "llama-3.1-8b-instant");
  assert.equal(modelFor(c, "strong", env), "openai/gpt-oss-120b");
});

test("OpenAiCompatLlm: tool calls parsed, 429 retried with Retry-After", async () => {
  let hits = 0, seen: any;
  const srv = createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits++; seen = { auth: req.headers.authorization, body: JSON.parse(body), url: req.url };
      if (hits === 1) { res.writeHead(429, { "retry-after": "0" }); return void res.end('{"error":"rate"}'); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chat-1", choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "release_pot", arguments: '{"reason":"x"}' } }] } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const port = (srv.address() as any).port;
  const llm = new OpenAiCompatLlm(`http://127.0.0.1:${port}/v1`, "secret");
  const r = await llm.complete({ model: "m", maxTokens: 10, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }], tools: [{ name: "release_pot", description: "d", parameters: { type: "object", properties: {} } }] });
  srv.close();
  assert.equal(hits, 2);
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.auth, "Bearer secret");
  assert.deepEqual(r.toolCalls, [{ id: "c1", name: "release_pot", args: { reason: "x" } }]);
  assert.equal(r.chatId, "chat-1");
});
