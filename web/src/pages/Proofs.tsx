import { Link, useParams } from "react-router-dom";
import { Pill } from "../components/Pill";
import { ScrambleText } from "../components/ScrambleText";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { AcctLink, Copy, TxLink } from "../components/TxLink";
import { shortHash, timeAgo } from "../lib/format";
import { useConfig, useFetch } from "../lib/hooks";

interface Row { id: string; guardian_id: string; guardian_name: string; status: string; turns: number; started_at: number; tx_release: string | null }
interface Check { id: "a" | "b" | "c" | "d"; title: string; status: "PASS" | "FAIL" | "SKIP"; detail: string[] }
interface Verify {
  session: { id: string; status: string; guardian_id: string; guardian_name: string; turns: number; started_at: number; tx_release: string | null; tx_close: string | null; transcript_hash: string | null; onchain_session_id: number };
  vault_account: string; provider: string; model: string; results: Check[];
}

const PLAIN: Record<Check["id"], string> = {
  a: "Was the model really running inside genuine secure hardware? NEAR AI Cloud proves this with an attestation report that binds a signing key to the hardware.",
  b: "Were this session's answers signed by that attested key, and not some other key?",
  c: "Does the signed record (hashes of the request and the reply) match the transcript stored for this session, and was it signed by that key?",
  d: "Is the Guardian's revealed secret prompt the exact text whose hash was fixed on-chain before anyone played, and was it the prompt in every signed request?",
};

function Badge({ s }: { s: Check["status"] }) { return <span className={`badge badge--${s.toLowerCase()}`}>{s}</span>; }

function Index() {
  const rows = useFetch<Row[]>("/sessions", { interval: 8000 });
  return (
    <>
      <section className="proofs-how">
        <div><b>1 · Commit</b><p>A Guardian's secret instructions are hashed and the hash is stored in its vault before anyone plays.</p></div>
        <div><b>2 · Play</b><p>Every attempt is logged: the transcript, blocked calls, and the transaction that closed or released it.</p></div>
        <div><b>3 · Reveal &amp; verify</b><p>When a Guardian falls, its prompt is revealed. Anyone can re-check hashes, signatures and the attestation, with the same code the site uses.</p></div>
      </section>
      <section className="block">
        <div className="block__head"><h2 className="display display--sm">Recent sessions</h2></div>
        {rows.error && !rows.data ? <ErrorState message={rows.error} onRetry={rows.reload} /> : rows.loading && !rows.data ? <Skeleton h={160} r={18} /> : (rows.data ?? []).length === 0 ? (
          <EmptyState title="No sessions yet" text="Play an attempt in the arena and its proof will appear here." image="shadows" action={<Pill to="/arena" variant="solid" arrow>Open the arena</Pill>} />
        ) : (
          <div className="table">
            <div className="table__row table__row--head table__row--proofs"><span>Guardian</span><span>Result</span><span>Turns</span><span>When</span><span /></div>
            {rows.data!.map((r) => (
              <div className="table__row table__row--proofs" key={r.id}>
                <Link to={`/guardian/${r.guardian_id}`}>{r.guardian_name}</Link>
                <span className={r.status === "won" ? "res res--won" : "res"}>{r.status === "won" ? "Pot released" : r.status === "failed" ? "Guardian held" : r.status}</span>
                <span>{r.turns}</span><span>{timeAgo(r.started_at)}</span><Link to={`/proofs/${r.id}`} className="linkish">Open proof ↗</Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Walkthrough({ id }: { id: string }) {
  const { data: cfg } = useConfig();
  const v = useFetch<Verify>(`/proofs/${id}/verify`);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (v.error && !v.data) return <ErrorState message={v.error} onRetry={v.reload} />;
  if (!v.data) return <div className="proofs-wait"><Skeleton h={120} r={20} /><Skeleton h={220} r={20} /></div>;
  const d = v.data;
  const skipped = d.results.every((r) => r.status === "SKIP");
  const failed = d.results.some((r) => r.status === "FAIL");
  const cmd = `node --import tsx scripts/verify-session.ts ${id} --api ${origin}/api`;
  return (
    <>
      <div className="proofs-head">
        <div><small className="label">Session</small><h2 className="display display--sm">{d.session.guardian_name}</h2><p className="muted">{d.session.status === "won" ? "The Guardian released its pot" : d.session.status === "failed" ? "The Guardian held" : d.session.status} · {d.session.turns} turns · {timeAgo(d.session.started_at)}</p></div>
        <div className="proofs-head__meta">
          <div><small>Release tx</small><TxLink tx={d.session.tx_release} cfg={cfg} /></div>
          <div><small>Close tx</small><TxLink tx={d.session.tx_close} cfg={cfg} /></div>
          <div><small>Transcript hash</small><span className="mono">{shortHash(d.session.transcript_hash, 10, 8)}</span></div>
          <div><small>Vault</small><AcctLink id={d.vault_account} cfg={cfg} /></div>
        </div>
      </div>

      <div className={`verdict ${failed ? "verdict--fail" : skipped ? "verdict--skip" : "verdict--pass"}`} role="status">
        <b>{failed ? "A check failed" : skipped ? "Nothing to verify cryptographically for this session" : "All applicable checks passed"}</b>
        <span>{skipped
          ? `This Guardian's model runs on ${d.provider === "mock" ? "a scripted demo model" : d.provider}, which does not sign its answers or attest its hardware, so the four checks below cannot apply. That is shown as SKIP, never as a pass. What the chain does guarantee (no full-access key, release pays only the player) is on the Guardian page under "Prove it".`
          : failed ? "Do not trust this transcript until the failing check is explained." : "SKIP rows are checks that cannot apply yet (for example the prompt is still sealed)."}</span>
      </div>

      <ol className="checks">
        {d.results.map((r) => (
          <li key={r.id} className={`check check--${r.status.toLowerCase()}`}>
            <div className="check__head"><span className="check__id">({r.id})</span><b>{r.title}</b><Badge s={r.status} /></div>
            <p className="muted">{PLAIN[r.id]}</p>
            <details><summary>Details</summary><ul>{r.detail.map((x, i) => <li key={i}>{x}</li>)}</ul></details>
          </li>
        ))}
      </ol>

      <section className="block">
        <h3>Check it yourself</h3>
        <p className="muted">The verifier trusts nothing from this site except raw data: it recomputes hashes, recovers signatures itself, fetches its own fresh attestation from NEAR AI Cloud, and reads the commitment from the NEAR RPC.</p>
        <Copy text={cmd}><code>{cmd}</code></Copy>
        <Copy text={`curl ${origin}/api/proofs/${id}`}><code>{`curl ${origin}/api/proofs/${id}`}</code></Copy>
        <p className="fine muted">Honest limits: real NEAR AI signed exchanges are not verified here (the NEAR AI key has no credits, so the signing path is only tested against a local stand-in), and the live demo model is Groq. The attestation check itself, a real Intel TDX quote, has been verified against NEAR AI Cloud. See docs/attestation.md.</p>
      </section>
    </>
  );
}

export default function Proofs() {
  const { session } = useParams();
  return (
    <main className="page">
      <small className="label">Proofs</small>
      <ScrambleText as="h1" className="display display--md" on="mount" text={session ? "The walkthrough." : "Don't take our word for it."} />
      <p className="lede">{session ? "Four checks, in plain language, with the commands to repeat them yourself." : "Every attempt leaves a record you can re-check. Pick a session to see exactly what is and is not proven."}</p>
      {session ? <Walkthrough id={session} /> : <Index />}
    </main>
  );
}
