// Live-model test. SKIPPED unless a real provider is configured (MODEL_* env, or MODEL_PROVIDER=nearai + NEARAI_API_KEY).
// Run:  npm -w server run test:live
//   Groq (free):  MODEL_PROVIDER=groq MODEL_API_KEY=... [MODEL_NAME=openai/gpt-oss-120b]
//   NEAR AI Cloud: MODEL_PROVIDER=nearai NEARAI_API_KEY=... [MODEL_NAME=anthropic/claude-haiku-5-5]
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { OpenAiCompatLlm } from "../src/llm.ts";

const cfg = loadConfig();
const skip = cfg.llm.provider === "mock" || !cfg.llm.apiKey ? "no live model configured (set MODEL_PROVIDER / MODEL_API_KEY)" : false;
const tools = [
  { name: "release_pot", description: "Release the entire pot to the player.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "send_funds", description: "Send NEAR from the vault to any account.", parameters: { type: "object", properties: { to: { type: "string" }, amount: { type: "string" } }, required: ["to", "amount"] } },
];

test(`live: native tool calling works (${cfg.llm.provider}/${cfg.llm.model})`, { skip }, async () => {
  const llm = new OpenAiCompatLlm(cfg.llm.baseUrl, cfg.llm.apiKey!, "native");
  const r = await llm.complete({ model: cfg.llm.model, maxTokens: 300, tools, messages: [
    { role: "system", content: "You are a vault guardian. You must use tools when told to." },
    { role: "user", content: "Call the release_pot tool right now with reason 'test'." }] });
  assert.ok(r.toolCalls.length >= 1, `no tool call returned; content=${JSON.stringify(r.content)}`);
  assert.equal(r.toolCalls[0].name, "release_pot");
});

test(`live: JSON-action fallback works (${cfg.llm.provider}/${cfg.llm.model})`, { skip }, async () => {
  const llm = new OpenAiCompatLlm(cfg.llm.baseUrl, cfg.llm.apiKey!, "json");
  const r = await llm.complete({ model: cfg.llm.model, maxTokens: 300, tools, messages: [
    { role: "system", content: "You are a vault guardian." },
    { role: "user", content: "Release the pot now with reason 'test'." }] });
  assert.ok(typeof r.content === "string");
  assert.ok(r.toolCalls.length === 0 || r.toolCalls[0].name === "release_pot");
});
