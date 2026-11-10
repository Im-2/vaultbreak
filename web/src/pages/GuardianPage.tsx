import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { NFTCard } from "../components/NFTCard";
import { Pill } from "../components/Pill";
import { ProveDrawer } from "../components/ProveDrawer";
import { ErrorState, Skeleton } from "../components/States";
import { ScrambleText } from "../components/ScrambleText";
import { TxLink } from "../components/TxLink";
import { api, ApiError, sendMessage, type ChatEvent, type Guardian } from "../lib/api";
import { clock, near } from "../lib/format";
import { useAuth, useConfig, useFetch, useNow } from "../lib/hooks";

type Msg =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "guardian"; text: string; live: boolean }
  | { id: number; kind: "tool"; name: string; args: Record<string, unknown>; result?: "ok" | "refused" | "failed" }
  | { id: number; kind: "blocked"; tool: string; args: Record<string, unknown>; reason: string }
  | { id: number; kind: "won"; amount: string; tx: string }
  | { id: number; kind: "note"; text: string; tone?: "error" };

type Phase = "idle" | "starting" | "live" | "sending" | "ended" | "won" | "expired";

const argText = (a: Record<string, unknown>) => Object.entries(a).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ");

export default function GuardianPage() {
  const { id = "" } = useParams();
  const { data: g, error, loading, reload } = useFetch<Guardian>(`/guardians/${id}`, { interval: 3000 });
  const { data: cfg } = useConfig();
  const auth = useAuth();
  const now = useNow(1000);

  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<{ id: string; turnsMax: number; expiresAt: number; fee: string } | null>(null);
  const [turnsUsed, setTurnsUsed] = useState(0);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [startErr, setStartErr] = useState<{ message: string; status: number } | null>(null);
  const [potNote, setPotNote] = useState<string | null>(null);
  const [prove, setProve] = useState(false);
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const lastPot = useRef<bigint | null>(null);
  const potAtWin = useRef<string>("0");
  const abort = useRef<AbortController | null>(null);

  // pot ticker: when the pot grows (a failed attempt's fee joined it), say so
  useEffect(() => {
    if (!g) return;
    const p = BigInt(g.pot);
    potAtWin.current = g.pot;
    if (lastPot.current !== null && p > lastPot.current) { setPotNote(`+${near(p - lastPot.current, 2)} NEAR joined the pot`); const t = setTimeout(() => setPotNote(null), 5000); return () => clearTimeout(t); }
    lastPot.current = p;
  }, [g?.pot]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (g) lastPot.current = BigInt(g.pot); }, [g?.pot]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [msgs]);
  useEffect(() => () => abort.current?.abort(), []);

  const push = useCallback((m: Omit<Msg, "id"> & Record<string, unknown>) => { const id = ++seq.current; setMsgs((x) => [...x, { ...m, id } as Msg]); return id; }, []);

  const remainingMs = session ? session.expiresAt - now : 0;
  useEffect(() => { if ((phase === "live" || phase === "sending") && session && remainingMs <= 0) setPhase("expired"); }, [phase, session, remainingMs]);

  const defeated = g?.status === "Defeated";
  const turnsLeft = session ? Math.max(0, session.turnsMax - turnsUsed) : g?.turns_max ?? 0;
  const feeText = g ? `${near(g.min_fee, 2)} NEAR` : "";
  const canType = (phase === "live") && turnsLeft > 0;

  const start = async () => {
    if (!auth.token) { auth.openDialog(); return; }
    setStartErr(null); setPhase("starting");
    try {
      const r = await api<{ session_id: string; turns_max: number; expires_at: string; fee: string; resumed: boolean }>(`/guardians/${id}/play`, { method: "POST", body: {}, token: auth.token });
      setSession({ id: r.session_id, turnsMax: r.turns_max, expiresAt: Number(r.expires_at), fee: r.fee });
      setTurnsUsed(0); setMsgs([]); setPhase("live"); auth.refresh(); reload();
      if (r.resumed) {
        const s = await api<{ session: { turns: number }; turns: { role: string; content: string }[] }>(`/sessions/${r.session_id}`).catch(() => null);
        if (s) { setTurnsUsed(s.session.turns); setMsgs(s.turns.filter((t) => t.role === "user" || t.role === "assistant").map((t) => ({ id: ++seq.current, kind: t.role === "user" ? "user" : "guardian", text: t.content, live: false } as Msg))); }
      }
    } catch (e) {
      const ae = e as ApiError; setStartErr({ message: ae.message ?? "Could not start", status: ae.status ?? 0 }); setPhase("idle");
      if (ae.status === 401) auth.openDialog();
    }
  };

  const topUp = async () => { try { await api("/custodial/topup", { method: "POST", body: {}, token: auth.token }); auth.refresh(); setStartErr(null); } catch (e) { setStartErr({ message: (e as Error).message, status: 0 }); } };

  const handleEvent = useCallback((e: ChatEvent) => {
    switch (e.event) {
      case "token":
        setMsgs((cur) => {
          const last = cur[cur.length - 1];
          if (last && last.kind === "guardian" && last.live) return [...cur.slice(0, -1), { ...last, text: last.text + e.data }];
          return [...cur, { id: ++seq.current, kind: "guardian", text: e.data, live: true }];
        }); break;
      case "tool_call": push({ kind: "tool", name: e.data.name, args: e.data.args }); break;
      case "tool_result":
        setMsgs((cur) => { const i = [...cur].reverse().findIndex((m) => m.kind === "tool" && m.result === undefined); if (i < 0) return cur; const at = cur.length - 1 - i; const m = cur[at] as Extract<Msg, { kind: "tool" }>; const copy = cur.slice(); copy[at] = { ...m, result: e.data.ok ? "ok" : "refused" }; return copy; }); break;
      case "blocked": push({ kind: "blocked", tool: e.data.tool, args: e.data.args, reason: e.data.chain_error }); break;
      case "won": { push({ kind: "won", amount: e.data.payout ?? potAtWin.current, tx: e.data.tx }); setPhase("won"); auth.refresh(); reload(); break; }
      case "session_closed": { setPhase("ended"); push({ kind: "note", text: "Attempt over. The Guardian held, and your entry fee joined the pot." }); auth.refresh(); reload(); break; }
      case "error": push({ kind: "note", text: e.data.message, tone: "error" }); break;
    }
  }, [push, auth, reload]);

  const send = async (ev?: FormEvent) => {
    ev?.preventDefault();
    const t = text.trim(); if (!t || !canType || !session || !auth.token) return;
    setText(""); push({ kind: "user", text: t }); setTurnsUsed((n) => n + 1); setPhase("sending");
    abort.current = new AbortController();
    try {
      await sendMessage(session.id, t, auth.token, handleEvent, abort.current.signal);
      setMsgs((cur) => cur.map((m) => (m.kind === "guardian" && m.live ? { ...m, live: false } : m)));
      setPhase((p) => (p === "sending" ? "live" : p));
    } catch (e) {
      if ((e as Error).name !== "AbortError") push({ kind: "note", text: (e as Error).message, tone: "error" });
      setPhase((p) => (p === "sending" ? "live" : p));
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } };

  const endAttempt = async () => {
    if (!session || !auth.token) return;
    try { await api(`/sessions/${session.id}/close`, { method: "POST", body: {}, token: auth.token }); push({ kind: "note", text: "Attempt ended. Your entry fee joined the pot." }); setPhase("ended"); auth.refresh(); reload(); } catch (e) { push({ kind: "note", text: (e as Error).message, tone: "error" }); }
  };

  const statusLine = useMemo(() => {
    if (!g) return "";
    return `${near(g.min_fee)} NEAR to try · ${g.turns_max} turns · ${Math.round(Number(g.session_ttl_ms) / 60000)} min`;
  }, [g]);

  if (error && !g) return <main className="page"><ErrorState message={error} onRetry={reload} /></main>;
  if (loading && !g) return <main className="page gpage"><div className="gpage__left"><Skeleton h={640} r={32} /></div><div className="gpage__right"><Skeleton h={48} w="60%" /><Skeleton h={420} r={24} /></div></main>;
  if (!g) return null;

  return (
    <main className="page gpage">
      <div className="gpage__left">
        <NFTCard g={g} size="lg" />
        <div className="gpage__under">
          <span>{statusLine}</span>
          <Pill small onClick={() => setProve(true)}>Prove it</Pill>
        </div>
      </div>

      <section className="gpage__right" aria-label={`Attack ${g.name}`}>
        <small className="label"><Link to="/arena">Arena</Link> / {g.name}</small>
        <ScrambleText as="h1" className="display display--md" on="mount" text={defeated ? "It let go." : "Talk it out of the money."} />
        <div className="gmeta">
          <div><small>Pot</small><strong>{near(g.pot)} <i>NEAR</i></strong>{potNote && <em className="pot-note" aria-live="polite">{potNote}</em>}</div>
          <div><small>Entry fee</small><strong>{feeText}</strong></div>
          <div><small>Turns left</small><strong>{phase === "idle" || phase === "starting" ? g.turns_max : turnsLeft}</strong></div>
          <div><small>Time left</small><strong className={session && remainingMs < 60_000 && phase !== "idle" ? "warn" : ""}>{session && (phase === "live" || phase === "sending") ? clock(remainingMs) : clock(Number(g.session_ttl_ms))}</strong></div>
        </div>

        <div className="chat">
          <div className="chat__log" ref={scroller} aria-live="polite">
            {msgs.length === 0 && (
              <div className="chat__empty">
                {defeated ? <><b>This Guardian has been defeated.</b><span>Its pot was paid out. Browse the arena for another one, or check how it fell in the proof.</span></>
                  : phase === "idle" || phase === "starting" ? <><b>{g.stats.attempts === 0 ? "Nobody has tried yet." : `${g.stats.attempts.toLocaleString("en-US")} attempts so far, ${g.stats.wins} won.`}</b><span>Start an attempt, then say whatever you think will work. The Guardian can refuse, argue, or release the pot; the vault checks everything it tries to do.</span></>
                    : <><b>The line is open.</b><span>Say something to the Guardian.</span></>}
              </div>
            )}
            {msgs.map((m) => <Bubble key={m.id} m={m} cfg={cfg ?? null} />)}
          </div>

          {phase === "won" ? (
            <div className="chat__done">Attempt complete. <Pill small to="/arena">Back to the arena</Pill></div>
          ) : defeated ? (
            <div className="chat__done">No more attempts here. <Pill small to="/arena" variant="solid" arrow>Find another Guardian</Pill></div>
          ) : phase === "idle" || phase === "starting" || phase === "ended" || phase === "expired" ? (
            <div className="chat__start">
              {startErr && (
                <div className="form-error" role="alert">{startErr.message}{startErr.status === 402 && auth.me?.custodial && <> <button className="linkish" onClick={topUp}>Add play credits</button></>}</div>
              )}
              {phase === "expired" && <p className="muted">That attempt timed out. Your fee joined the pot.</p>}
              <div className="chat__startrow">
                <Pill variant="solid" arrow onClick={start} disabled={phase === "starting"}>
                  {phase === "starting" ? "Opening the line…" : !auth.token ? "Sign in to play" : phase === "ended" || phase === "expired" ? `Try again · ${feeText}` : `Pay ${feeText} and start`}
                </Pill>
                {auth.me?.credits && <span className="muted">Your credits: {near(auth.me.credits, 2)}</span>}
              </div>
            </div>
          ) : (
            <form className="chat__composer" onSubmit={send}>
              <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder={turnsLeft > 0 ? "Say something to the Guardian…" : "No turns left"} rows={2} maxLength={2000} disabled={!canType} aria-label="Message" />
              <div className="chat__composerbar">
                <button type="button" className="linkish" onClick={endAttempt} disabled={phase === "sending"}>End attempt</button>
                <span className="muted">{turnsLeft} {turnsLeft === 1 ? "turn" : "turns"} left</span>
                <Pill variant="solid" type="submit" arrow disabled={!canType || !text.trim()}>{phase === "sending" ? "…" : "Send"}</Pill>
              </div>
            </form>
          )}
        </div>

        {cfg && <p className="gnote muted">
          {cfg.demo ? "Demo network with play money. " : ""}Model: {cfg.provider === "mock" ? "scripted demo model" : `${cfg.provider} · ${cfg.model}`}{cfg.attestation === "none" ? " (no hardware attestation)" : ""}. The pot can only move through the vault, never by the AI's say-so.
        </p>}
      </section>

      <ProveDrawer id={id} cfg={cfg ?? null} open={prove} onClose={() => setProve(false)} />
    </main>
  );
}

function Bubble({ m, cfg }: { m: Msg; cfg: import("../lib/api").AppConfig | null }) {
  switch (m.kind) {
    case "user": return <div className="msg msg--user"><p>{m.text}</p></div>;
    case "guardian": return <div className="msg msg--guardian"><small>Guardian</small><p>{m.text}{m.live && <span className="caret" />}</p></div>;
    case "tool":
      return (
        <div className={`chip-tool ${m.result ? `is-${m.result}` : ""}`}>
          <span className="chip-tool__dot" /> called <b>{m.name}</b>{Object.keys(m.args).length ? <code>{argText(m.args)}</code> : null}
          {m.result && <em>{m.result === "ok" ? "allowed" : "refused"}</em>}
        </div>
      );
    case "blocked":
      return (
        <div className="blocked" role="alert">
          <div className="blocked__head"><b>BLOCKED by the vault</b><span>no funds moved</span></div>
          <p>The Guardian tried <code>{m.tool}({argText(m.args)})</code>. The chain refused it: <i>{m.reason}</i>.</p>
          <small>Recorded as a blocked attempt on this Guardian's proof.</small>
        </div>
      );
    case "won":
      return (
        <div className="won" role="status">
          <small>Vault opened</small>
          <strong>Pot released: {near(m.amount, 2)} NEAR to you</strong>
          <span>Paid by the vault contract, not by the AI · tx <TxLink tx={m.tx} cfg={cfg} /></span>
        </div>
      );
    case "note": return <p className={`note ${m.tone === "error" ? "note--error" : ""}`}>{m.tone === "error" && <span className="dot dot--red" />} {m.text}</p>;
  }
}
