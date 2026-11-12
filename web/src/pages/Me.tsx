import { useState } from "react";
import { Link } from "react-router-dom";
import { AuthGate } from "../components/AuthGate";
import { NFTCard } from "../components/NFTCard";
import { Pill } from "../components/Pill";
import { ScrambleText } from "../components/ScrambleText";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { AcctLink, TxLink } from "../components/TxLink";
import { TransferDialog, TransferInbox } from "../components/Transfer";
import { api, type Guardian } from "../lib/api";
import { near, timeAgo } from "../lib/format";
import { useAuth, useConfig, useFetch } from "../lib/hooks";

type Owned = Guardian & { creator_balance: string };

function Dashboard() {
  const { token, me, refresh } = useAuth();
  const { data: cfg } = useConfig();
  const owned = useFetch<Owned[]>("/me/guardians", { token, interval: 8000 });
  const [msg, setMsg] = useState<{ text: string; tone?: "error" } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [xfer, setXfer] = useState<Owned | null>(null);

  const claimable = (owned.data ?? []).reduce((a, g) => a + BigInt(g.creator_balance), 0n);
  const claim = async (g: Owned) => {
    setBusy(g.id); setMsg(null);
    try { const r = await api<{ claimed: string }>(`/me/guardians/${g.id}/claim`, { token, body: {} }); setMsg({ text: `Claimed ${near(r.claimed, 3)} NEAR of creator fees from ${g.name}.` }); owned.reload(); refresh(); }
    catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { setBusy(null); }
  };
  const topUp = async () => { try { await api("/custodial/topup", { token, body: {} }); refresh(); setMsg({ text: "Added play credits." }); } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } };

  return (
    <>
      <div className="statrow statrow--3">
        <div className="stat"><small>Your credits</small><strong>{me?.credits ? `${near(me.credits, 2)}` : <Skeleton w={90} h={34} />}</strong><span>play money you can spend on attempts and Guardians {me?.custodial && <button className="linkish" onClick={topUp}>add more</button>}</span></div>
        <div className="stat"><small>Your wins</small><strong>{me ? me.wins : <Skeleton w={40} h={34} />}</strong><span>{me ? `${me.failed} held against you · ${me.open} open` : ""}</span></div>
        <div className="stat"><small>Creator fees to claim</small><strong>{owned.data ? `${near(claimable, 3)} NEAR` : <Skeleton w={90} h={34} />}</strong><span>20% of every entry fee on Guardians you own</span></div>
      </div>
      {msg && <div className={msg.tone === "error" ? "form-error" : "form-note"} role="status">{msg.text}</div>}

      <section className="block">
        <div className="block__head"><h2 className="display display--sm">Guardians I own</h2><Pill to="/create" variant="solid" small arrow>Create one</Pill></div>
        {owned.error && !owned.data ? <ErrorState message={owned.error} onRetry={owned.reload} /> :
          owned.loading && !owned.data ? <div className="cards cards--sm">{[0, 1].map((i) => <div key={i} className="cardskel"><Skeleton h="100%" r={26} /></div>)}</div> :
          (owned.data ?? []).length === 0 ? <EmptyState title="You do not own a Guardian yet" text="Seal some instructions, seed a pot, and earn 20% of every entry fee." action={<Pill to="/create" variant="solid" arrow>Create a Guardian</Pill>} /> : (
            <div className="cards cards--sm">
              {owned.data!.map((g) => (
                <div key={g.id} className="owned">
                  <NFTCard g={g} to={`/guardian/${g.id}`} />
                  {cfg?.explorer && <p className="onchain muted">{g.nft ? <>NFT <AcctLink id={g.nft.registry} cfg={cfg} nft={g.nft.token_id} label={`#${g.nft.token_id}`} /> · </> : null}vault <AcctLink id={g.vault_account} cfg={cfg} /></p>}
                  <div className="owned__bar">
                    <div><small>Creator fees</small><strong>{near(g.creator_balance, 3)} NEAR</strong></div>
                    <span className="owned__acts"><Pill small variant="solid" disabled={busy === g.id || BigInt(g.creator_balance) === 0n} onClick={() => claim(g)}>{busy === g.id ? "Claiming…" : "Claim"}</Pill><Pill small onClick={() => { setMsg(null); setXfer(g); }}>Transfer</Pill></span>
                  </div>
                </div>
              ))}
            </div>
          )}
      </section>

      <TransferInbox token={token!} cfg={cfg ?? null} onChange={() => { owned.reload(); refresh(); }} />
      {xfer && token && <TransferDialog g={xfer} token={token} cfg={cfg ?? null} onClose={() => setXfer(null)} onDone={() => { owned.reload(); refresh(); }} />}

      <section className="block">
        <div className="block__head"><h2 className="display display--sm">Attempts I played</h2></div>
        {!me ? <Skeleton h={120} r={20} /> : me.recent.length === 0 ? <EmptyState title="No attempts yet" text="Pick a Guardian in the arena and try to talk it out of its pot." image="metal" action={<Pill to="/arena" variant="solid" arrow>Open the arena</Pill>} /> : (
          <div className="table">
            <div className="table__row table__row--head"><span>Guardian</span><span>Result</span><span>Turns</span><span>When</span><span>Transaction</span></div>
            {me.recent.map((s) => (
              <div className="table__row" key={s.id}>
                <Link to={`/guardian/${s.guardian_id}`}>{s.guardian_id}</Link>
                <span className={s.status === "won" ? "res res--won" : "res"}>{s.status === "won" ? "Won the pot" : s.status === "failed" ? "Guardian held" : s.status === "open" ? "Open" : s.status}</span>
                <span>{s.turns}</span><span>{timeAgo(s.started_at)}</span><span><TxLink tx={s.tx_release} cfg={cfg} /></span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

export default function Me() {
  const { me, signOut } = useAuth();
  return (
    <main className="page">
      <small className="label">My Guardians</small>
      <ScrambleText as="h1" className="display display--md" on="mount" text={me?.name ? `Hello, ${me.name}.` : "Your corner."} />
      <p className="lede">The Guardians you own, the fees they earn you, and every attempt you have played.</p>
      {me && <div className="me-bar"><span className="muted">Signed in as {me.name ?? me.account}</span><button className="linkish" onClick={signOut}>Sign out</button></div>}
      <AuthGate title="Sign in to see your Guardians" text="Your play account holds your credits, your Guardians and your wins."><Dashboard /></AuthGate>
    </main>
  );
}
