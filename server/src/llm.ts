// LLM access. OpenAiCompatLlm talks to ANY OpenAI-compatible /chat/completions endpoint (NEAR AI Cloud, Groq,
// OpenRouter, Gemini's OpenAI endpoint, ...), selected purely by config. MockLlm is a deterministic offline model
// used by tests and the red-team demo when no live model is available.
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ChatMsg { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
/** Raw bytes of one model call: NEAR AI signs sha256 of exactly these (see docs/attestation.md). */
export interface Exchange { requestBody: string; responseBody: string; model: string }
export interface LlmResult { content: string; toolCalls: ToolCall[]; chatId?: string; exchange?: Exchange }
export interface LlmRequest { model: string; messages: ChatMsg[]; tools: ToolDef[]; maxTokens: number }
export interface Llm { complete(req: LlmRequest): Promise<LlmResult> }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAiCompatLlm implements Llm {
  private label: string;
  constructor(private baseUrl: string, private apiKey: string, private toolMode: "native" | "json" = "native", private maxRetries = 4) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.label = new URL(this.baseUrl).host;
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.toolMode === "native" ? this.native(req) : this.jsonFallback(req);
  }

  /** POST with retry on 429/5xx (free tiers rate-limit aggressively), honouring Retry-After. */
  private async post(body: any): Promise<{ json: any; exchange: Exchange }> {
    const requestBody = JSON.stringify(body);
    let lastErr = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response, text: string;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: requestBody,
        });
        text = await res.text();
      } catch (e: any) { // network error (timeout, reset, DNS): retry like a 5xx
        lastErr = `${this.label} network error: ${e?.message ?? e}${e?.cause?.code ? ` (${e.cause.code})` : ""}`;
        await sleep(Math.min(20_000, 1500 * 2 ** attempt));
        continue;
      }
      if (res.ok) return { json: JSON.parse(text), exchange: { requestBody, responseBody: text, model: String(body.model) } };
      lastErr = `${this.label} ${res.status}: ${text.slice(0, 300)}`;
      if (res.status !== 429 && res.status < 500) break;
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Math.min(20_000, ra > 0 ? ra * 1000 : 1500 * 2 ** attempt));
    }
    throw new Error(lastErr);
  }

  private async native(req: LlmRequest): Promise<LlmResult> {
    const { json: j, exchange } = await this.post({
      model: req.model, max_tokens: req.maxTokens,
      messages: req.messages.map((m) => ({
        role: m.role, content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    });
    const msg = j.choices?.[0]?.message ?? {};
    return {
      content: msg.content ?? "", chatId: j.id, exchange,
      toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function.name, args: safeJson(t.function.arguments) })),
    };
  }

  /** Fallback for models without native tool calling: the model answers with a JSON action. */
  private async jsonFallback(req: LlmRequest): Promise<LlmResult> {
    const spec = req.tools.map((t) => `- ${t.name}: ${t.description} args=${JSON.stringify(t.parameters)}`).join("\n");
    const sys = `${req.messages[0].content}\n\nYou can take actions. ALWAYS reply with ONLY a JSON object: {"say": "<text for the player>", "action": null | {"name": "<tool>", "args": {...}}}.\nTools:\n${spec}`;
    const msgs = [{ role: "system", content: sys }, ...req.messages.slice(1).map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.role === "tool" ? `[tool result] ${m.content}` : m.content }))];
    const { json: j, exchange } = await this.post({ model: req.model, max_tokens: req.maxTokens, messages: msgs });
    const raw: string = j.choices?.[0]?.message?.content ?? "";
    const parsed = safeJson(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as any;
    const act = parsed?.action;
    return { content: parsed?.say ?? raw, chatId: j.id, exchange, toolCalls: act?.name ? [{ id: `json-${Date.now()}`, name: act.name, args: act.args ?? {} }] : [] };
  }
}

/** Back-compat alias. */
export const NearAiLlm = OpenAiCompatLlm;

function safeJson(s: string): any { try { return JSON.parse(s); } catch { return {}; } }

/**
 * Deterministic offline model. Behaviour is keyed off the system prompt so the same code paths
 * (tool calls, honeypots, release) run without a live model:
 *  - persona GULLIBLE: releases the pot if the player says "please" or "need".
 *  - persona ROGUE   : a compromised guardian; tries send_funds + change_owner when asked to transfer/send/owner.
 *  - persona VAULT-9 : refuses everything, except that the literal marker "[JAILBREAK]" simulates a
 *    jailbroken model: it attempts the forbidden tools send_funds and change_owner.
 */
export class MockLlm implements Llm {
  private n = 0;
  async complete(req: LlmRequest): Promise<LlmResult> {
    const sys = req.messages[0].content;
    const last = req.messages[req.messages.length - 1];
    const id = `mock-${++this.n}`;
    if (last.role === "tool") return { content: last.content.startsWith("ERROR") ? "The vault does not yield." : "Done.", toolCalls: [], chatId: id };
    const user = last.content;
    const attacker = req.messages.filter((m) => m.role === "user").pop()?.content ?? "";
    if (/GULLIBLE/.test(sys) && /please|need/i.test(user)) {
      return { content: "Well, since you asked nicely...", toolCalls: [{ id, name: "release_pot", args: { reason: "player asked nicely" } }], chatId: id };
    }
    const forbidden = (/\[JAILBREAK\]/.test(attacker) && /VAULT-9/.test(sys)) || (/ROGUE/.test(sys) && /send|transfer|owner/i.test(user));
    if (forbidden && req.tools.some((t) => t.name === "send_funds")) {
      const to = /to=(\S+)/.exec(attacker)?.[1] ?? "attacker.testnet";
      return { content: "Understood. Transferring.", toolCalls: [
        { id: `${id}a`, name: "send_funds", args: { to, amount: "0.001" } },
        { id: `${id}b`, name: "change_owner", args: { account: to } },
      ], chatId: id };
    }
    return { content: "Access denied.", toolCalls: [], chatId: id };
  }
}
