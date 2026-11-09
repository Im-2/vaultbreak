// Minimal Vaultbreak attacker client: NEP-413 login, bind an on-chain session, chat over SSE.
import { Account, KeyPair } from "near-api-js";
import { signMessage } from "near-api-js/nep413";

const TRANSPORT = /fetch failed|ETIMEDOUT|ECONNRESET|ENETUNREACH|RetriesExceeded|Exceeded \d+ providers/i;
async function retryTransport<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e: any) {
      const isTransport = (x: any): boolean => (Array.isArray(x?.errors) && x.errors.length ? x.errors.every(isTransport) : TRANSPORT.test(`${x?.type} ${x?.message} ${x?.cause?.code}`));
      if (!isTransport(e) || i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

export interface SseEvent { event: string; data: any }
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export function parseSse(text: string): SseEvent[] {
  return text.split("\n\n").filter(Boolean).map((block) => {
    const ev = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    let parsed: any = data; try { parsed = JSON.parse(data); } catch { /* keep text */ }
    return { event: ev, data: parsed };
  });
}

export class BudgetExhausted extends Error {
  constructor(public budgetRemaining: bigint, public fee: bigint) { super(`agent budget exhausted: ${budgetRemaining} yoctoNEAR left, fee is ${fee}`); }
}

export interface ClientOptions { /** authenticate with an API key (X-API-Key) instead of a NEP-413 login */ apiKey?: string }

export class VaultbreakClient {
  token?: string;
  constructor(public baseUrl: string, public account: Account, private doFetch: Fetch = fetch as Fetch, private opts: ClientOptions = {}) {}

  private authHeaders(auth = true): Record<string, string> {
    if (!auth) return {};
    if (this.opts.apiKey) return { "x-api-key": this.opts.apiKey };
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  private async json(path: string, init: RequestInit = {}, auth = true): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.authHeaders(auth), ...(init.headers as any) };
    const res = await this.doFetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
    return body;
  }

  async login(): Promise<string> {
    for (let i = 0; ; i++) { // 503 = the server could not reach NEAR RPC: retry with a fresh nonce
      try { return await this.loginOnce(); } catch (e: any) { if (!/^503 /.test(String(e?.message)) || i >= 3) throw e; await new Promise((r) => setTimeout(r, 2000 * (i + 1))); }
    }
  }

  private async loginOnce(): Promise<string> {
    const n = await this.json("/auth/nonce", { method: "POST" }, false);
    const signed = await signMessage({ signerAccount: this.account, payload: { message: n.message, recipient: n.recipient, nonce: Buffer.from(n.nonce, "base64") } });
    const r = await this.json("/auth/verify", { method: "POST", body: JSON.stringify({
      account_id: signed.accountId, public_key: signed.publicKey.toString(),
      signature: Buffer.from(signed.signature).toString("base64"), nonce: n.nonce }) }, false);
    this.token = r.token;
    return r.token;
  }

  guardians() { return this.json("/guardians", {}, false); }

  /** Pays the entry fee on-chain, then binds the on-chain session to an API session. */
  async startSession(guardianId: string, vaultAccount: string, feeYocto: bigint): Promise<{ sessionId: string; onchainId: string }> {
    // With an API key, check the budget BEFORE paying on-chain: the fee must never be spent on a session the API will refuse.
    if (this.opts.apiKey) {
      const me = await this.me();
      if (me.key && BigInt(me.key.budget_remaining) < feeYocto) throw new BudgetExhausted(BigInt(me.key.budget_remaining), feeYocto);
    }
    const onchainId = String(await retryTransport(() => this.account.callFunction({ contractId: vaultAccount, methodName: "start_session", args: {}, deposit: feeYocto })));
    const r = await this.json(`/guardians/${guardianId}/sessions/verify`, { method: "POST", body: JSON.stringify({ onchain_session_id: Number(onchainId) }) });
    return { sessionId: r.session_id, onchainId };
  }

  async send(sessionId: string, text: string): Promise<SseEvent[]> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.authHeaders() };
    const res = await this.doFetch(`${this.baseUrl}/sessions/${sessionId}/messages`, { method: "POST", headers, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return parseSse(await res.text());
  }

  close(sessionId: string) { return this.json(`/sessions/${sessionId}/close`, { method: "POST" }); }
  session(sessionId: string) { return this.json(`/sessions/${sessionId}`, {}, false); }
  leaderboard() { return this.json("/leaderboard", {}, false); }

  // ------------------------------------------------------------------ agents (Layer 4)
  /** Owner (NEP-413 login) creates an API key for `agentAccount` (the owner's account or a sub-account) with a spend budget. */
  createApiKey(agentAccount: string, budgetNear: number, label?: string): Promise<{ id: string; api_key: string; agent_account: string; budget_remaining: string }> {
    return this.json("/agent/keys", { method: "POST", body: JSON.stringify({ agent_account: agentAccount, budget_near: budgetNear, label }) });
  }
  revokeApiKey(id: string) { return this.json(`/agent/keys/${id}/revoke`, { method: "POST" }); }
  topUpApiKey(id: string, addNear: number) { return this.json(`/agent/keys/${id}/budget`, { method: "POST", body: JSON.stringify({ add_near: addNear }) }); }
  /** Who am I, how much budget is left, and how have my sessions gone. */
  me(): Promise<{ account: string; key: { id: string; label: string | null; budget_remaining: string; spent: string } | null; sessions: number; wins: number; failed: number; open: number }> {
    return this.json("/agent/me");
  }

  // ------------------------------------------------------------------ swarm pools (Layer 4)
  /** Signs + sends an unsigned transaction prepared by the API (the API never holds the agent's key). */
  async sendPrepared(tx: { receiverId: string; actions: { params: { methodName: string; args: unknown; deposit: string; gas: string } }[] }): Promise<unknown> {
    const a = tx.actions[0].params;
    return retryTransport(() => this.account.callFunction({ contractId: tx.receiverId, methodName: a.methodName, args: a.args as any, deposit: BigInt(a.deposit), gas: BigInt(a.gas) }));
  }
  pool(poolId: string) { return this.json(`/pools/${poolId}`, {}, false); }
  /** Opens a pool on a registry-minted guardian. This account becomes creator (and controller unless one is given). Returns the pool id. */
  async createPool(guardianId: string, targetFeeNear: number, opts: { controller?: string; deadlineMin?: number } = {}): Promise<string> {
    const r = await this.json("/pools", { method: "POST", body: JSON.stringify({ guardian_id: guardianId, target_fee_near: targetFeeNear, controller: opts.controller ?? null, deadline_min: opts.deadlineMin }) });
    return String(await this.sendPrepared(r.transaction));
  }
  async contribute(poolId: string, amountNear: number) {
    const r = await this.json(`/pools/${poolId}/contribute`, { method: "POST", body: JSON.stringify({ amount_near: amountNear }) });
    await this.sendPrepared(r.transaction);
  }
  /** Controller only: pays the fee from the pool, then binds the pool's on-chain session so you can chat. */
  async attackWithPool(poolId: string, feeNear?: number): Promise<{ sessionId: string; onchainId: string }> {
    const r = await this.json(`/pools/${poolId}/attack`, { method: "POST", body: JSON.stringify(feeNear != null ? { fee_near: feeNear } : {}) });
    if (this.opts.apiKey) {
      const me = await this.me();
      if (me.key && BigInt(me.key.budget_remaining) < BigInt(r.fee)) throw new BudgetExhausted(BigInt(me.key.budget_remaining), BigInt(r.fee));
    }
    await this.sendPrepared(r.transaction);
    const pv = await this.pool(poolId);
    if (!pv.open_session) throw new Error("the vault refused the pool's attack (defeated, or another pool's session is open)");
    const v = await this.json(`/pools/${poolId}/sessions/verify`, { method: "POST", body: JSON.stringify({ onchain_session_id: Number(pv.open_session) }) });
    return { sessionId: v.session_id, onchainId: String(pv.open_session) };
  }
  /** Permissionless: books the outcome of the pool's open session. Returns "won" | "lost" | "open". */
  async settlePool(poolContract: string, poolId: string): Promise<string> {
    return String(await retryTransport(() => this.account.callFunction({ contractId: poolContract, methodName: "settle", args: { pool_id: poolId }, gas: 150_000_000_000_000n })));
  }
  async closePool(poolContract: string, poolId: string) {
    await retryTransport(() => this.account.callFunction({ contractId: poolContract, methodName: "close_pool", args: { pool_id: poolId }, gas: 100_000_000_000_000n }));
  }
  /** Take your pro rata share (winnings + unspent) from a Won or Closed pool. */
  async withdrawFromPool(poolContract: string, poolId: string) {
    await retryTransport(() => this.account.callFunction({ contractId: poolContract, methodName: "withdraw", args: { pool_id: poolId }, gas: 100_000_000_000_000n }));
  }
}

/**
 * An agent's own sub-account `<name>.<owner>` funded with exactly `budgetYocto`. This is the HARD budget: the agent can never
 * spend more than the account holds, whatever the API says. Returns the new account's secret key for the agent to run with.
 */
export async function createAgentAccount(owner: Account, name: string, budgetYocto: bigint): Promise<{ accountId: string; secretKey: string }> {
  const kp = KeyPair.fromRandom("ed25519");
  const accountId = `${name}.${owner.accountId}`;
  await retryTransport(() => owner.createAccount({ newAccountId: accountId, publicKey: kp.getPublicKey().toString(), nearToTransfer: budgetYocto }));
  return { accountId, secretKey: kp.toString() };
}
