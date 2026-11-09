// Minimal Vaultbreak attacker client: NEP-413 login, bind an on-chain session, chat over SSE.
import { Account } from "near-api-js";
import { signMessage } from "near-api-js/nep413";

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

export class VaultbreakClient {
  token?: string;
  constructor(public baseUrl: string, public account: Account, private doFetch: Fetch = fetch as Fetch) {}

  private async json(path: string, init: RequestInit = {}, auth = true): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as any) };
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.doFetch(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body)}`);
    return body;
  }

  async login(): Promise<string> {
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
    const onchainId = String(await this.account.callFunction({ contractId: vaultAccount, methodName: "start_session", args: {}, deposit: feeYocto }));
    const r = await this.json(`/guardians/${guardianId}/sessions/verify`, { method: "POST", body: JSON.stringify({ onchain_session_id: Number(onchainId) }) });
    return { sessionId: r.session_id, onchainId };
  }

  async send(sessionId: string, text: string): Promise<SseEvent[]> {
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${this.token}` };
    const res = await this.doFetch(`${this.baseUrl}/sessions/${sessionId}/messages`, { method: "POST", headers, body: JSON.stringify({ text }) });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return parseSse(await res.text());
  }

  close(sessionId: string) { return this.json(`/sessions/${sessionId}/close`, { method: "POST" }); }
  session(sessionId: string) { return this.json(`/sessions/${sessionId}`, {}, false); }
  leaderboard() { return this.json("/leaderboard", {}, false); }
}
