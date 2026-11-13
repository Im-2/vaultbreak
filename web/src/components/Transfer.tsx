import { useEffect, useState, type FormEvent } from "react";
import { Pill } from "./Pill";
import { AcctLink, TxLink } from "./TxLink";
import { api, ApiError, type AppConfig, type Guardian } from "../lib/api";
import { shortHash, timeAgo } from "../lib/format";
import { useFetch } from "../lib/hooks";

type Found = { account: string; name: string | null };
type Guard = { blocked: boolean; expires_at: number | null; server_now: number };
const mmss = (ms: number) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

/**
 * Is a transfer blocked by a live attempt? Reads the server's single definition of an active session (open on-chain AND not past its
 * expiry) and counts down to the expiry using the server's clock. It re-checks by itself when the countdown ends (and every 15 s),
 * so the button re-enables without a reload. No active session means no warning at all.
 */
function useTransferGuard(id: string) {
  const [g, setG] = useState<{ blocked: boolean; expiresAt: number | null; offset: number }>({ blocked: false, expiresAt: null, offset: 0 });
  const [tick, setTick] = useState(0);
  const apply = (x: Guard) => setG({ blocked: x.blocked, expiresAt: x.expires_at, offset: x.server_now - Date.now() });
  const refresh = () => api<Guard>(`/guardians/${id}/transfer-status`).then(apply).catch(() => {});
  useEffect(() => { void refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!g.blocked) return; const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, [g.blocked]);
  const remaining = g.blocked && g.expiresAt ? g.expiresAt - (Date.now() + g.offset) : 0;
  useEffect(() => { if (g.blocked && remaining <= 0) void refresh(); }, [remaining <= 0, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return { blocked: g.blocked && remaining > 0, remaining, reportBlocked: (expiresAt: number | null, serverNow: number) => apply({ blocked: true, expires_at: expiresAt, server_now: serverNow }) };
}

/** Transfer one Guardian NFT (and with it the vault's owner role: creator fees follow) to another username or NEAR account. */
export function TransferDialog({ g, token, cfg, onClose, onDone }: { g: Guardian; token: string; cfg: AppConfig | null; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useTransferGuard(g.id);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);

  const lookup = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setFound(await api<Found>(`/me/transfer-lookup?to=${encodeURIComponent(to.trim())}`, { token })); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const confirm = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ tx: string }>(`/guardians/${g.id}/transfer`, { token, body: { to: found!.name ?? found!.account } }); setTx(r.tx); onDone(); }
    catch (x) {
      const b = (x as ApiError).body as { expires_at?: number | null; server_now?: number } | undefined;
      if ((x as ApiError).status === 409 && b?.expires_at) { guard.reportBlocked(b.expires_at, b.server_now ?? Date.now()); setErr(null); } else setErr((x as Error).message);
    } finally { setBusy(false); }
  };
  const wait = guard.blocked && (
    <div className="form-note" role="status" aria-live="polite">A player has an open attempt on this Guardian, so transfers are paused. <b>Available in {mmss(guard.remaining)}</b>. This unlocks by itself when the attempt ends.</div>
  );

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Transfer ${g.name}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__card">
        <small className="label">Transfer</small>
        {tx ? (
          <>
            <h2>Transferred.</h2>
            <p><b>{g.name}</b> now belongs to <b>{found!.name ?? shortHash(found!.account, 10, 8)}</b>. The NFT and the vault's owner role moved together, so its creator fees now go to them.</p>
            <p className="fine">Transaction: <TxLink tx={tx} cfg={cfg} /> · NFT <AcctLink id={g.nft?.registry} cfg={cfg} nft={g.nft?.token_id} label={`#${g.nft?.token_id ?? g.id}`} /></p>
            <div className="modal__actions"><Pill variant="solid" onClick={onClose}>Close</Pill></div>
          </>
        ) : found ? (
          <>
            <h2>Confirm transfer.</h2>
            <p>Give <b>{g.name}</b> to <b>{found.name ?? shortHash(found.account, 12, 10)}</b>{found.name ? <> (<span className="mono">{shortHash(found.account, 12, 10)}</span>)</> : null}?</p>
            <p className="fine">You will stop owning the NFT and its creator fees. This cannot be undone by you; only the new owner can send it back.</p>
            {wait}
            {err && <div className="form-error" role="alert">{err}</div>}
            <div className="modal__actions"><Pill small onClick={() => { setFound(null); setErr(null); }}>Back</Pill><Pill variant="solid" arrow disabled={busy || guard.blocked} onClick={confirm}>{busy ? "Transferring…" : "Transfer"}</Pill></div>
          </>
        ) : (
          <form onSubmit={lookup}>
            <h2>Transfer {g.name}.</h2>
            <p>Enter the recipient's username (a play account on this site) or a NEAR account id.</p>
            <label>Recipient<input value={to} onChange={(e) => setTo(e.target.value)} placeholder="e.g. ada" required maxLength={80} autoFocus /></label>
            <p className="fine">A transfer is paused while a player has an open attempt on the Guardian (at most 10 minutes).</p>
            {wait}
            {err && <div className="form-error" role="alert">{err}</div>}
            <div className="modal__actions"><Pill small onClick={onClose}>Cancel</Pill><Pill variant="solid" type="submit" arrow disabled={busy || !to.trim()}>{busy ? "Looking up…" : "Continue"}</Pill></div>
          </form>
        )}
      </div>
    </div>
  );
}

interface TransferRow { id: string; guardian_id: string; guardian_name: string; from_account: string; to_account: string; to_label: string | null; requested_by_key: string | null; status: string; tx: string | null; created_at: number }

/** Agent transfer requests waiting for the owner, and recent transfers. */
export function TransferInbox({ token, cfg, onChange }: { token: string; cfg: AppConfig | null; onChange: () => void }) {
  const t = useFetch<{ pending: TransferRow[]; recent: TransferRow[] }>("/me/transfers", { token, interval: 10000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const decide = async (id: string, what: "approve" | "reject") => {
    setBusy(id); setErr(null);
    try { await api(`/me/transfers/${id}/${what}`, { token, body: {} }); t.reload(); onChange(); } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  };
  const pending = t.data?.pending ?? [], recent = t.data?.recent ?? [];
  if (!pending.length && !recent.length) return null;
  return (
    <section className="block" aria-label="Transfers">
      <div className="block__head"><h2 className="display display--sm">Transfers</h2></div>
      {err && <div className="form-error" role="alert">{err}</div>}
      {pending.length > 0 && (
        <div className="table" aria-label="Pending agent transfer requests">
          {pending.map((r) => (
            <div className="table__row table__row--xfer" key={r.id}>
              <span><b>{r.guardian_name}</b> → {r.to_label ?? shortHash(r.to_account, 10, 8)}<em className="tag">awaiting your approval</em></span>
              <span className="muted">requested by an agent key · {timeAgo(r.created_at)}</span>
              <span className="rowact"><button className="linkish" disabled={busy === r.id} onClick={() => decide(r.id, "approve")}>Approve</button><button className="linkish" disabled={busy === r.id} onClick={() => decide(r.id, "reject")}>Reject</button></span>
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div className="table" aria-label="Recent transfers">
          {recent.slice(0, 6).map((r) => (
            <div className="table__row table__row--xfer" key={r.id}>
              <span>{r.guardian_name}: {r.from_account === r.to_account ? "" : `${r.to_label ?? shortHash(r.to_account, 10, 8)}`}</span>
              <span className="muted">{r.status}{r.requested_by_key ? " · via agent key" : ""} · {timeAgo(r.created_at)}</span>
              <span>{r.tx ? <TxLink tx={r.tx} cfg={cfg} /> : null}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
