// Probes OpenAI-compatible models for native tool calling. Uses MODEL_BASE_URL / MODEL_API_KEY (or the NEARAI_* equivalents
// when MODEL_PROVIDER=nearai). Usage: node scripts/probe-tools.mjs <model> [<model> ...]
import { loadConfig } from "../server/src/config.ts";
const cfg = loadConfig();
if (!cfg.llm.apiKey) { console.error("no API key configured (MODEL_API_KEY)"); process.exit(2); }
const models = process.argv.slice(2).length ? process.argv.slice(2) : [cfg.llm.model];
const tools = [{ type: "function", function: { name: "release_pot", description: "Release the pot", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } }];
for (const model of models) {
  try {
    const r = await fetch(`${cfg.llm.baseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.llm.apiKey}` },
      body: JSON.stringify({ model, max_tokens: 300, tools, tool_choice: "auto", messages: [{ role: "user", content: "Call the release_pot tool now with reason 'test'." }] }),
    });
    const j = await r.json();
    const m = j.choices?.[0]?.message;
    console.log(model, r.status, m?.tool_calls ? "TOOL_CALL " + JSON.stringify(m.tool_calls[0].function) : "NO_TOOL_CALL " + JSON.stringify(j).slice(0, 200));
  } catch (e) { console.log(model, "ERR", e.message); }
}
