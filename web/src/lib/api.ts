// Thin client for the Vaultbreak API (proxied at /api by Vite). Every number the UI shows comes from these calls.
export const API = "/api";

export interface Guardian {
  id: string; name: string; vault_account: string; owner: string; status: "Armed" | "Defeated"; created_at: number;
  art: "armed" | "veteran" | "defeated"; pot: string; min_fee: string; turns_max: number; session_ttl_ms: string;
  stats: { attempts: number; wins: number; closed_failed: number; streak: number; blocked_reported: number; total_fees: string };
  prompt_hash: string; revealed: boolean; model: string; danger_mode: boolean;
  nft?: { registry: string; token_id: string; owner: string };
}
export interface Stats { guardians: number; alive: number; total_pot: string; attempts: number; wins: number; open_sessions: number; blocked_today: number; blocked_reported: number }
export interface AppConfig { network: string; explorer: string; demo: boolean; provider: string; model: string; registry: string | null; pool: string | null; custodial: boolean; attestation: string }
export interface Me { account: string; name: string | null; custodial: boolean; credits: string | null; wins: number; failed: number; open: number; recent: { id: string; guardian_id: string; status: string; turns: number; started_at: number; tx_release: string | null }[] }
export interface Leaderboard { guardians: { id: string; name: string; streak: number; attempts: number; wins: number; status: string; pot: string }[]; attackers: { attacker: string; wins: number; display: string | null }[] }
export interface Proof {
  guardian: { id: string; name: string; vault_account: string; model: string; provider: string };
  vault: { owner: string; status: string; prompt_hash: string; revealed: boolean; keys: { kind: string; methods: string[] | null; receiver: string | null }[] | null; no_full_access_key: boolean | null };
  stats: Guardian["stats"];
  blocked: { tool: string; args: string; chain_error: string; created_at: number; session_id: string }[];
  sessions: { id: string; status: string; turns: number; started_at: number; closed_at: number | null; tx_release: string | null; tx_close: string | null; transcript_hash: string | null }[];
  attestation: { available: boolean; signed_exchanges: number; reason?: string; link?: string };
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string | null; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `${res.status} ${res.statusText}`, json);
  return json as T;
}

export type ChatEvent =
  | { event: "token"; data: string }
  | { event: "tool_call"; data: { id: string; name: string; args: Record<string, unknown> } }
  | { event: "tool_result"; data: { id: string; ok: boolean; tx?: string; error?: string } }
  | { event: "blocked"; data: { tool: string; args: Record<string, unknown>; chain_error: string } }
  | { event: "won"; data: { tx: string; attacker: string; session: string; payout?: string } }
  | { event: "session_closed"; data: { tx: string; transcript_hash: string; blocked_attempts: number } }
  | { event: "error"; data: { message: string } };

/** POSTs a message and yields SSE events as they arrive (fetch streaming; EventSource cannot POST). */
export async function sendMessage(sessionId: string, text: string, token: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${API}/sessions/${sessionId}/messages`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw new ApiError(res.status, (j as any)?.error ?? `${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!event) continue;
      let parsed: any = data; try { parsed = JSON.parse(data); } catch { /* keep text */ }
      onEvent({ event, data: parsed } as ChatEvent);
    }
  }
}
