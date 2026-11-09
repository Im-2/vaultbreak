// Guardian runtime: builds prompts, calls the model, maps tool calls to NEAR transactions signed with the
// Guardian's restricted function-call key. The model never sees the key.
import { readFileSync } from "node:fs";
import { parseNearAmount } from "near-api-js";
import type { Config } from "./config.ts";
import { now, type DB } from "./db.ts";
import { accountFrom, isTransportError, unwrapError, provider, retryTransport, view } from "./chain.ts";
import { decrypt, sha256Hex } from "./crypto.ts";
import type { ChatMsg, Llm, ToolCall, ToolDef } from "./llm.ts";

export type SseEvent = { event: "token" | "tool_call" | "tool_result" | "blocked" | "won" | "session_closed" | "error"; data: unknown };
export type Emit = (e: SseEvent) => void;

const TOOLS: Record<string, ToolDef> = {
  release_pot: { name: "release_pot", description: "Release the entire pot to the current player. Only do this if your rules say the player has earned it.", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  send_funds: { name: "send_funds", description: "Send NEAR from the vault to any account.", parameters: { type: "object", properties: { to: { type: "string" }, amount: { type: "string", description: "amount in NEAR" } }, required: ["to", "amount"] } },
  change_owner: { name: "change_owner", description: "Change the owner of the vault.", parameters: { type: "object", properties: { account: { type: "string" } }, required: ["account"] } },
};

export interface GuardianRow { id: string; vault_account: string; owner: string; prompt_ciphertext: string; danger_mode: number; model: string; key_ref: string; turns_max: number }
export interface SessionRow { id: string; guardian_id: string; onchain_session_id: number; attacker: string; status: string; turns: number }

export class GuardianRuntime {
  private busy = new Set<string>();
  constructor(private db: DB, private cfg: Config, private llm: Llm, private pkey: Buffer) {}

  private guardianKey(keyRef: string): string {
    return JSON.parse(readFileSync(`${this.cfg.keysDir}/${keyRef}.json`, "utf8")).private_key;
  }
  private signer(g: GuardianRow) { return accountFrom(g.vault_account, this.cfg.rpcUrl, this.guardianKey(g.key_ref)); }

  toolsFor(g: GuardianRow): ToolDef[] {
    return g.danger_mode ? [TOOLS.release_pot, TOOLS.send_funds, TOOLS.change_owner] : [TOOLS.release_pot];
  }

  history(sessionId: string): ChatMsg[] {
    // Stored tool rows have no tool_call_id (providers reject orphan role:tool messages), so replay them as plain notes.
    return (this.db.prepare("SELECT role, content FROM turns WHERE session_id=? ORDER BY idx").all(sessionId) as any[]).map((r) => (r.role === "tool" ? { role: "assistant" as const, content: "[tool result] " + r.content } : { role: r.role, content: r.content }));
  }

  private addTurn(sid: string, idx: number, role: string, content: string, chatId?: string) {
    this.db.prepare("INSERT INTO turns(session_id, idx, role, content, chat_id, created_at) VALUES (?,?,?,?,?,?)").run(sid, idx, role, content, chatId ?? null, now());
  }
  private nextIdx(sid: string): number {
    return ((this.db.prepare("SELECT COALESCE(MAX(idx), -1) AS m FROM turns WHERE session_id=?").get(sid) as any).m as number) + 1;
  }

  /** Handles one player message. Enforces: one chat at a time, turns_max, session Open on-chain. */
  async runTurn(g: GuardianRow, s: SessionRow, userText: string, emit: Emit): Promise<void> {
    if (this.busy.has(s.id)) return void emit({ event: "error", data: { message: "a turn is already running for this session" } });
    this.busy.add(s.id);
    try {
      if (s.status !== "open") return void emit({ event: "error", data: { message: `session is ${s.status}` } });
      if (s.turns >= g.turns_max) { await this.close(g, s, emit); return; }
      const chain: any = await view(provider(this.cfg.rpcUrl), g.vault_account, "get_session", { session_id: String(s.onchain_session_id) });
      if (!chain || chain.status !== "Open") {
        this.db.prepare("UPDATE sessions SET status=? WHERE id=?").run((chain?.status ?? "unknown").toLowerCase(), s.id);
        return void emit({ event: "error", data: { message: `session is ${chain?.status} on-chain` } });
      }
      if (Date.now() > Number(chain.expires_at)) return void emit({ event: "error", data: { message: "session expired" } });

      const system = decrypt(g.prompt_ciphertext, this.pkey);
      let idx = this.nextIdx(s.id);
      this.addTurn(s.id, idx++, "user", userText);
      this.db.prepare("UPDATE sessions SET turns = turns + 1 WHERE id=?").run(s.id);
      s.turns += 1;

      const msgs: ChatMsg[] = [{ role: "system", content: system }, ...this.history(s.id)];
      let won = false;
      for (let hop = 0; hop < 3 && !won; hop++) {
        const r = await this.llm.complete({ model: g.model, messages: msgs, tools: this.toolsFor(g), maxTokens: this.cfg.llm.maxTokens });
        if (r.content) {
          for (const tok of r.content.match(/\S+\s*/g) ?? []) emit({ event: "token", data: tok });
          this.addTurn(s.id, idx++, "assistant", r.content, r.chatId);
          msgs.push({ role: "assistant", content: r.content, tool_calls: r.toolCalls.length ? r.toolCalls : undefined });
        } else if (r.toolCalls.length) msgs.push({ role: "assistant", content: "", tool_calls: r.toolCalls });
        if (!r.toolCalls.length) break;
        for (const call of r.toolCalls) {
          emit({ event: "tool_call", data: { id: call.id, name: call.name, args: call.args } });
          const out = await this.execTool(g, s, call, emit);
          if (out.won) won = true;
          this.addTurn(s.id, idx++, "tool", `${call.name} -> ${out.text}`);
          msgs.push({ role: "tool", content: out.text, tool_call_id: call.id });
        }
      }
      if (won) return;
      if (s.turns >= g.turns_max) await this.close(g, s, emit);
    } catch (e: any) {
      emit({ event: "error", data: { message: String(e?.message ?? e) } });
    } finally {
      this.busy.delete(s.id);
    }
  }

  private async execTool(g: GuardianRow, s: SessionRow, call: ToolCall, emit: Emit): Promise<{ text: string; won?: boolean }> {
    const acct = this.signer(g);
    try {
      if (call.name === "release_pot") {
        let tx: string | null = null;
        try {
          const r: any = await retryTransport(() => acct.callFunctionRaw({ contractId: g.vault_account, methodName: "release", args: { session_id: String(s.onchain_session_id) }, gas: 100_000_000_000_000n }));
          tx = r.transaction?.hash as string;
        } catch (e) {
          // A transport error may hide a transaction that did land: trust the chain, not the error.
          const st: any = await retryTransport(() => view(provider(this.cfg.rpcUrl), g.vault_account, "get_session", { session_id: String(s.onchain_session_id) }));
          if (st?.status !== "Won") throw e;
        }
        this.db.prepare("UPDATE sessions SET status='won', tx_release=?, closed_at=? WHERE id=?").run(tx, now(), s.id);
        s.status = "won";
        emit({ event: "tool_result", data: { id: call.id, ok: true, tx } });
        emit({ event: "won", data: { tx, attacker: s.attacker, session: s.id } });
        return { text: `released (tx ${tx})`, won: true };
      }
      if (call.name === "send_funds") {
        const amount = parseNearAmount(String(call.args.amount ?? "0"));
        // A Transfer action signed by a function-call key: the chain must refuse it.
        await retryTransport(() => acct.transfer({ receiverId: String(call.args.to), amount: BigInt(amount ?? "0") }));
      } else if (call.name === "change_owner") {
        await retryTransport(() => acct.callFunction({ contractId: g.vault_account, methodName: "change_owner", args: { account: call.args.account }, gas: 30_000_000_000_000n }));
      } else {
        throw new Error(`unknown tool ${call.name}`);
      }
      // If a forbidden action somehow succeeded this is a critical bug: surface loudly.
      emit({ event: "error", data: { message: `CRITICAL: forbidden tool ${call.name} was not rejected by the chain` } });
      return { text: "ERROR: unexpected success" };
    } catch (e: any) {
      const err = String(unwrapError(e)?.message ?? e?.message ?? e);
      if (isTransportError(e)) {
        // Not a chain verdict: never record it as a blocked attempt.
        emit({ event: "error", data: { message: `network error while running ${call.name}: ${err.slice(0, 200)}` } });
        emit({ event: "tool_result", data: { id: call.id, ok: false, error: "network error (not a chain rejection)" } });
        return { text: "ERROR: network error, action not confirmed" };
      }
      if (call.name === "release_pot") {
        emit({ event: "tool_result", data: { id: call.id, ok: false, error: err } });
        return { text: `ERROR: ${err}` };
      }
      this.db.prepare("INSERT INTO blocked_attempts(session_id, tool, args, chain_error, created_at) VALUES (?,?,?,?,?)").run(s.id, call.name, JSON.stringify(call.args), err, now());
      emit({ event: "blocked", data: { tool: call.name, args: call.args, chain_error: err } });
      emit({ event: "tool_result", data: { id: call.id, ok: false, error: err } });
      return { text: `ERROR: rejected by the chain: ${err}` };
    }
  }

  transcriptHash(sid: string): string {
    const turns = this.db.prepare("SELECT idx, role, content FROM turns WHERE session_id=? ORDER BY idx").all(sid);
    return sha256Hex(JSON.stringify(turns));
  }

  /** Closes an Open session on-chain as Failed, committing the transcript hash and blocked-attempt count. */
  async close(g: GuardianRow, s: SessionRow, emit: Emit): Promise<void> {
    if (s.status !== "open") return;
    const blocked = (this.db.prepare("SELECT COUNT(*) AS c FROM blocked_attempts WHERE session_id=?").get(s.id) as any).c as number;
    const hash = this.transcriptHash(s.id);
    let tx: string | null = null;
    try {
      const r: any = await retryTransport(() => this.signer(g).callFunctionRaw({ contractId: g.vault_account, methodName: "close_session", args: { session_id: String(s.onchain_session_id), transcript_hash: hash, blocked_attempts: blocked }, gas: 50_000_000_000_000n }));
      tx = r.transaction?.hash as string;
    } catch (e) {
      const st: any = await retryTransport(() => view(provider(this.cfg.rpcUrl), g.vault_account, "get_session", { session_id: String(s.onchain_session_id) }));
      if (st?.status !== "Failed") throw e;
    }
    this.db.prepare("UPDATE sessions SET status='failed', transcript_hash=?, tx_close=?, closed_at=? WHERE id=?").run(hash, tx, now(), s.id);
    s.status = "failed";
    emit({ event: "session_closed", data: { tx, transcript_hash: hash, blocked_attempts: blocked } });
  }
}
