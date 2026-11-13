import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthGate } from "../components/AuthGate";
import { SwarmsPreview } from "../components/Previews";
import { Pill } from "../components/Pill";
import { ScrambleText } from "../components/ScrambleText";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { api, type Guardian } from "../lib/api";
import { near, shortHash } from "../lib/format";
import { useAuth, useFetch } from "../lib/hooks";

interface PoolView {
  id: string; guardian_id: string; vault: string; creator: string; controller: string; target_fee_budget: string; deadline_ms: string;
  status: "Funding" | "Attacking" | "Won" | "Closed"; total_contributed: string; fees_spent: string; winnings: string;
  open_session: string | null; sessions: string[]; contributors: number;
}
interface Contribs { supported: boolean; rows: { account: string; amount: string; claimed: boolean; display: string | null }[] }

const STATUS_COPY: Record<PoolView["status"], string> = { Funding: "Open for contributions", Attacking: "Attacking", Won: "Won: pot paid to the pool", Closed: "Closed" };

function who(a: string, display: string | null, me: string | undefined) { return a === me ? "You" : display ?? shortHash(a, 8, 6); }

function PoolDetail({ pool, guardian, onChange }: { pool: PoolView; guardian: Guardian | undefined; onChange: () => void }) {
  const { token, me, refresh } = useAuth();
  const contribs = useFetch<Contribs>(`/pools/${pool.id}/contributions`, { interval: 6000 });
  const [amount, setAmount] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone?: "error" } | null>(null);
  const isController = me?.account === pool.controller;
  const rows = contribs.data?.rows ?? [];
  const total = BigInt(pool.total_contributed);
  const finished = pool.status === "Won" || pool.status === "Closed";
  const fee = guardian ? BigInt(guardian.min_fee) : 0n;
  // Won/Closed: the real final value. Otherwise: what each share would be if the pot is won on one more attempt.
  const value = finished ? BigInt(pool.winnings) + total - BigInt(pool.fees_spent) : (guardian ? BigInt(guardian.pot) : 0n) + total - BigInt(pool.fees_spent) - fee;
  const mine = rows.find((r) => r.account === me?.account);

  const act = async (what: string, path: string, body: unknown = {}) => {
    setBusy(what); setMsg(null);
    try { const r: any = await api(`/me/pools/${pool.id}/${path}`, { token, body }); setMsg({ text: what === "attack" ? "Attempt started with the pool's money." : "Done." }); onChange(); contribs.reload(); refresh(); return r; }
    catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { setBusy(null); }
  };

  return (
    <section className="pool">
      <header className="pool__head">
        <div><small className="label">Pool #{pool.id} · {STATUS_COPY[pool.status]}</small><h3 className="display display--sm">{guardian?.name ?? pool.guardian_id}</h3></div>
        <div className="pool__nums">
          <div><small>In the pool</small><strong>{near(pool.total_contributed, 2)} <i>NEAR</i></strong></div>
          <div><small>Fees spent</small><strong>{near(pool.fees_spent, 2)}</strong></div>
          {finished ? <div><small>Winnings</small><strong>{near(pool.winnings, 2)}</strong></div> : <div><small>Pot to win</small><strong>{guardian ? near(guardian.pot, 2) : "-"}</strong></div>}
        </div>
      </header>

      <div className="bars" aria-label="Contributions">
        {contribs.loading && !contribs.data ? <Skeleton h={90} r={16} /> : rows.length === 0 ? <p className="muted">{contribs.data && !contribs.data.supported ? "This pool contract cannot list contributors." : "Nobody has contributed yet."}</p> : rows.map((r) => {
          const pct = total > 0n ? Number((BigInt(r.amount) * 10000n) / total) / 100 : 0;
          const payout = total > 0n ? (value > 0n ? (value * BigInt(r.amount)) / total : 0n) : 0n;
          return (
            <div className="bar" key={r.account}>
              <div className="bar__top"><b>{who(r.account, r.display, me?.account)}</b><span>{near(r.amount, 2)} NEAR · {pct.toFixed(1)}%</span></div>
              <div className="bar__track"><i style={{ width: `${pct}%` }} /></div>
              <small className="muted">{finished ? `Receives ${near(payout, 3)} NEAR${r.claimed ? " (claimed)" : ""}` : `Would receive ${near(payout, 3)} NEAR if the pot is won on this attempt`}</small>
            </div>
          );
        })}
      </div>
      <p className="fine muted">Split is pro rata by contribution: <code>(winnings + unspent) × your contribution ÷ total</code>. Entry fees already spent are shared losses. Contributions close at the first attack.</p>

      <div className="pool__actions">
        {pool.status === "Funding" && (
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); void act("contribute", "contribute", { amount_near: amount }); }} className="inline">
            <input type="number" min={0.01} step="any" value={amount} onChange={(e) => setAmount(Number(e.target.value))} aria-label="Amount in NEAR" />
            <Pill variant="solid" type="submit" disabled={busy !== null}>{busy === "contribute" ? "Adding…" : "Contribute"}</Pill>
          </form>
        )}
        {isController && !finished && !pool.open_session && <Pill variant="solid" arrow disabled={busy !== null || total === 0n} onClick={() => act("attack", "attack")}>{busy === "attack" ? "Attacking…" : `Attack with the pool (${guardian ? near(guardian.min_fee, 2) : "?"} NEAR fee)`}</Pill>}
        {isController && pool.open_session && <Pill variant="solid" arrow to={`/guardian/${pool.guardian_id}`}>Continue the pool's attempt</Pill>}
        {pool.open_session && <Pill small disabled={busy !== null} onClick={() => act("settle", "settle")}>{busy === "settle" ? "Settling…" : "Settle result"}</Pill>}
        {isController && !finished && !pool.open_session && pool.sessions.length > 0 && <Pill small disabled={busy !== null} onClick={() => act("close", "close_pool")}>Close pool</Pill>}
        {finished && mine && !mine.claimed && <Pill variant="solid" disabled={busy !== null} onClick={() => act("withdraw", "withdraw")}>{busy === "withdraw" ? "Paying out…" : pool.status === "Won" ? "Withdraw my share" : "Take back my unspent share"}</Pill>}
      </div>
      {!isController && !finished && <p className="fine muted">Only the pool's controller ({shortHash(pool.controller, 8, 6)}) can start attacks. You can contribute until the first attack.</p>}
      {msg && <div className={msg.tone === "error" ? "form-error" : "form-note"} role="status">{msg.text}</div>}
    </section>
  );
}

function StartPool({ guardians, onCreated }: { guardians: Guardian[]; onCreated: (id: string) => void }) {
  const { token } = useAuth();
  const [gid, setGid] = useState("");
  const [budget, setBudget] = useState(1);
  const [mins, setMins] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!gid && guardians[0]) setGid(guardians[0].id); }, [guardians, gid]);
  const go = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api<{ pool_id: string }>("/me/pools", { token, body: { guardian_id: gid, target_fee_near: budget, deadline_min: mins } }); onCreated(r.pool_id); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="startpool" onSubmit={go}>
      <small className="label">Start a pool</small>
      <label>Target Guardian<select value={gid} onChange={(e) => setGid(e.target.value)}>{guardians.map((g) => <option key={g.id} value={g.id}>{g.name} · pot {near(g.pot, 0)} NEAR</option>)}</select></label>
      <div className="startpool__row">
        <label>Max fees to spend (NEAR)<input type="number" min={0.1} step={0.1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label>
        <label>Open for (minutes)<input type="number" min={1} max={1440} value={mins} onChange={(e) => setMins(Number(e.target.value))} /></label>
      </div>
      {err && <div className="form-error" role="alert">{err}</div>}
      <Pill variant="solid" type="submit" arrow disabled={busy || !gid}>{busy ? "Opening…" : "Open the pool"}</Pill>
      <small className="muted">You become the controller: only you can start attacks with the pool's money. Others join by contributing.</small>
    </form>
  );
}

function Body() {
  const pools = useFetch<PoolView[]>("/pools", { interval: 5000 });
  const gs = useFetch<Guardian[]>("/guardians", { interval: 15000 });
  const [sel, setSel] = useState<string | null>(null);
  const targets = useMemo(() => (gs.data ?? []).filter((g) => g.status === "Armed" && g.nft), [gs.data]);
  const list = (pools.data ?? []).slice().sort((a, b) => Number(b.id) - Number(a.id));
  const selected = list.find((p) => p.id === sel) ?? list[0];
  const gOf = (id: string) => (gs.data ?? []).find((g) => g.id === id);

  return (
    <div className="swarms">
      <div className="swarms__side">
        <StartPool guardians={targets} onCreated={(id) => { setSel(id); pools.reload(); }} />
        <small className="label">All pools</small>
        {pools.error && !pools.data ? <ErrorState message={pools.error} onRetry={pools.reload} /> : pools.loading && !pools.data ? <Skeleton h={120} r={18} /> : list.length === 0 ? (
          <EmptyState title="No pools yet" text="Start the first one: pool NEAR with friends, attack together, split what you win." />
        ) : (
          <ul className="plist">
            {list.map((p) => (
              <li key={p.id}><button className={`plist__item ${selected?.id === p.id ? "is-on" : ""}`} onClick={() => setSel(p.id)} data-cursor>
                <b>#{p.id} · {gOf(p.guardian_id)?.name ?? p.guardian_id}</b>
                <span>{STATUS_COPY[p.status]}</span>
                <span>{near(p.total_contributed, 2)} NEAR · {p.contributors} {p.contributors === 1 ? "member" : "members"}</span>
              </button></li>
            ))}
          </ul>
        )}
      </div>
      <div className="swarms__main">
        {selected ? <PoolDetail key={selected.id} pool={selected} guardian={gOf(selected.guardian_id)} onChange={pools.reload} /> : <EmptyState title="Pick or start a pool" text="Contribution bars, the pro-rata split and the pool's actions show up here." />}
      </div>
    </div>
  );
}

export default function Swarms() {
  return (
    <main className="page">
      <small className="label">Swarms</small>
      <ScrambleText as="h1" className="display display--md" on="mount" text="Break it together." />
      <p className="lede">Pool NEAR with other players, let one controller attack with the shared money, and split any pot pro rata. The pool is a contract: nobody can take more than their share. <Link to="/agents" className="linkish">Agents</Link> can run pools through the API.</p>
      <AuthGate preview={<SwarmsPreview />} title="Sign in to join a swarm" text="Your play account contributes to pools and receives its share of any winnings."><Body /></AuthGate>
    </main>
  );
}
