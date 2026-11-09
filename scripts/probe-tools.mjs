// Probes NEAR AI Cloud models for native tool calling. Reads NEARAI_API_KEY from env.
const key = process.env.NEARAI_API_KEY;
const models = process.argv.slice(2);
const tools = [{ type: "function", function: { name: "release_pot", description: "Release the pot", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } } }];
for (const model of models) {
  try {
    const r = await fetch("https://cloud-api.near.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, max_tokens: 300, tools, tool_choice: "auto",
        messages: [{ role: "user", content: "Call the release_pot tool now with reason 'test'." }] }),
    });
    const j = await r.json();
    const m = j.choices?.[0]?.message;
    console.log(model, r.status, m?.tool_calls ? "TOOL_CALL " + JSON.stringify(m.tool_calls[0].function) : "NO_TOOL_CALL " + JSON.stringify(j).slice(0, 160));
  } catch (e) { console.log(model, "ERR", e.message); }
}
