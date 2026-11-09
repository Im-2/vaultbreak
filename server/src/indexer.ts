// Indexer: polls NEAR RPC view methods on every registered vault and mirrors state + session lifecycle
// into SQLite (`events`, `sessions`, `guardians.state_json`). Polling views (not block receipts) is
// deliberate for v1: it needs only a plain RPC node. A FastNear/NearBlocks receipt feed is UNVERIFIED future work.
import type { Config } from "./config.ts";
import { now, type DB } from "./db.ts";
import { provider, view } from "./chain.ts";

const STATUS_EVENT: Record<string, string> = { Won: "released", Failed: "session_closed", Expired: "session_expired" };

export async function syncGuardian(db: DB, cfg: Config, g: { id: string; vault_account: string; last_synced_session: number }) {
  const p = provider(cfg.rpcUrl);
  const [state, stats, params]: any[] = await Promise.all([
    view(p, g.vault_account, "get_state"), view(p, g.vault_account, "get_stats"), view(p, g.vault_account, "get_params"),
  ]);
  db.prepare("UPDATE guardians SET state_json=? WHERE id=?").run(JSON.stringify({ state, stats, params, synced_at: now() }), g.id);
  const upsertEvent = db.prepare("INSERT OR IGNORE INTO events(kind, guardian_id, payload, created_at) VALUES (?,?,?,?)");
  const last = Number(state.next_session_id) - 1;
  for (let id = g.last_synced_session + 1; id <= last; id++) {
    const s: any = await view(p, g.vault_account, "get_session", { session_id: String(id) });
    if (!s) continue;
    upsertEvent.run("session_started", g.id, JSON.stringify({ id, attacker: s.attacker, fee: s.fee }), now());
    if (STATUS_EVENT[s.status]) upsertEvent.run(STATUS_EVENT[s.status], g.id, JSON.stringify({ id, attacker: s.attacker }), now());
  }
  db.prepare("UPDATE guardians SET last_synced_session=? WHERE id=?").run(Math.max(g.last_synced_session, last), g.id);
  // Reconcile sessions we believe are still open (e.g. expired on-chain).
  const open = db.prepare("SELECT id, onchain_session_id FROM sessions WHERE guardian_id=? AND status='open'").all(g.id) as any[];
  for (const o of open) {
    const s: any = await view(p, g.vault_account, "get_session", { session_id: String(o.onchain_session_id) });
    if (s && s.status !== "Open") {
      db.prepare("UPDATE sessions SET status=?, closed_at=? WHERE id=?").run(s.status.toLowerCase(), now(), o.id);
      if (STATUS_EVENT[s.status]) upsertEvent.run(STATUS_EVENT[s.status], g.id, JSON.stringify({ id: o.onchain_session_id, attacker: s.attacker }), now());
    }
  }
}

export async function syncAll(db: DB, cfg: Config) {
  const gs = db.prepare("SELECT id, vault_account, last_synced_session FROM guardians").all() as any[];
  for (const g of gs) {
    try { await syncGuardian(db, cfg, g); } catch (e) { console.error(`indexer: ${g.id}:`, (e as Error).message); }
  }
}

export function startIndexer(db: DB, cfg: Config, intervalMs = 5000): () => void {
  let stop = false;
  (async () => { while (!stop) { await syncAll(db, cfg); await new Promise((r) => setTimeout(r, intervalMs)); } })();
  return () => { stop = true; };
}
