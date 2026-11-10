import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ScrambleText } from "../components/ScrambleText";
import { NFTCard } from "../components/NFTCard";
import { Pill } from "../components/Pill";
import { EmptyState, ErrorState, Skeleton, StatusDot } from "../components/States";
import type { Guardian, Leaderboard, Stats } from "../lib/api";
import { near, shortHash } from "../lib/format";
import { useConfig, useFetch } from "../lib/hooks";

type StatusFilter = "all" | "armed" | "defeated";
type Sort = "newest" | "pot" | "streak";

function StatsRow() {
  const { data: s, error, reload } = useFetch<Stats>("/stats", { interval: 6000 });
  if (error && !s) return <ErrorState message={error} onRetry={reload} />;
  const items: [string, string | null, string][] = [
    ["Total pots", s ? `${near(s.total_pot, 0)} NEAR` : null, "held by armed Guardians"],
    ["Open sessions", s ? String(s.open_sessions) : null, "attempts in progress now"],
    ["Guardians alive", s ? `${s.alive} / ${s.guardians}` : null, "still holding their pot"],
    ["Blocked today", s ? String(s.blocked_today) : null, "forbidden calls the vault refused"],
  ];
  return (
    <div className="statrow">
      {items.map(([k, v, note]) => (
        <div className="stat" key={k}><small>{k}</small><strong>{v ?? <Skeleton w={96} h={34} />}</strong><span>{note}</span></div>
      ))}
    </div>
  );
}

function Board() {
  const [tab, setTab] = useState<"guardians" | "attackers">("guardians");
  const lb = useFetch<Leaderboard>("/leaderboard", { interval: 10000 });
  const rows = tab === "guardians" ? lb.data?.guardians ?? [] : lb.data?.attackers ?? [];
  return (
    <section className="board">
      <div className="board__head">
        <div><small className="label">Leaderboard</small><h2 className="display display--md">Who holds, who breaks</h2></div>
        <div className="seg" role="tablist" aria-label="Leaderboard">
          <button role="tab" aria-selected={tab === "guardians"} className={tab === "guardians" ? "is-on" : ""} onClick={() => setTab("guardians")}>Guardians by streak</button>
          <button role="tab" aria-selected={tab === "attackers"} className={tab === "attackers" ? "is-on" : ""} onClick={() => setTab("attackers")}>Attackers by wins</button>
        </div>
      </div>
      {lb.error && !lb.data ? <ErrorState message={lb.error} onRetry={lb.reload} /> :
        lb.loading && !lb.data ? <div className="board__rows">{[0, 1, 2].map((i) => <div key={i} className="brow"><Skeleton h={22} /></div>)}</div> :
        rows.length === 0 ? <EmptyState title={tab === "guardians" ? "No Guardians ranked yet" : "No wins yet"} text={tab === "guardians" ? "Streaks appear once a Guardian has survived an attempt." : "Nobody has broken a Guardian on this network yet. Be the first."} /> : (
          <ol className="board__rows">
            {tab === "guardians"
              ? (lb.data!.guardians).map((g, i) => (
                <li key={g.id}><Link to={`/guardian/${g.id}`} className="brow">
                  <span className="brow__rank">{i + 1}</span><span className="brow__name">{g.name}</span>
                  <span className="brow__meta"><StatusDot status={g.status} /> {g.status}</span>
                  <span className="brow__meta">{g.attempts.toLocaleString("en-US")} attempts</span>
                  <span className="brow__val">{g.streak.toLocaleString("en-US")}<small> streak</small></span>
                </Link></li>))
              : (lb.data!.attackers).map((a, i) => (
                <li key={a.attacker}><div className="brow">
                  <span className="brow__rank">{i + 1}</span><span className="brow__name">{a.display ?? shortHash(a.attacker, 10, 8)}</span>
                  <span className="brow__meta">{a.display ? "play account" : "on-chain account"}</span><span className="brow__meta" />
                  <span className="brow__val">{a.wins}<small> {a.wins === 1 ? "win" : "wins"}</small></span>
                </div></li>))}
          </ol>
        )}
    </section>
  );
}

export default function Arena() {
  const g = useFetch<Guardian[]>("/guardians", { interval: 6000 });
  const cfg = useConfig();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<Sort>("pot");

  const list = useMemo(() => {
    let l = (g.data ?? []).filter((x) => status === "all" || x.status.toLowerCase() === status);
    l = l.slice().sort((a, b) => sort === "newest" ? b.created_at - a.created_at : sort === "streak" ? b.stats.streak - a.stats.streak : Number(BigInt(b.pot) - BigInt(a.pot)));
    return l;
  }, [g.data, status, sort]);

  return (
    <main className="page arena">
      <header className="arena__head">
        <div>
          <small className="label">Arena{cfg.data?.demo ? " · demo network, play money" : cfg.data ? ` · ${cfg.data.network}` : ""}</small>
          <ScrambleText as="h1" className="display display--md" on="mount" text="Pick a Guardian." />
        </div>
        <Pill to="/create" variant="solid" arrow>Create a Guardian</Pill>
      </header>

      <StatsRow />

      <div className="filters">
        <div className="filters__group" role="group" aria-label="Status">
          {(["all", "armed", "defeated"] as const).map((s) => <Pill key={s} small active={status === s} onClick={() => setStatus(s)}>{s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)}</Pill>)}
        </div>
        <div className="filters__group" role="group" aria-label="Sort">
          {([["newest", "Newest"], ["pot", "Biggest pot"], ["streak", "Longest streak"]] as const).map(([k, l]) => <Pill key={k} small active={sort === k} onClick={() => setSort(k)}>{l}</Pill>)}
        </div>
      </div>

      {g.error && !g.data ? <ErrorState message={g.error} onRetry={g.reload} /> :
        g.loading && !g.data ? <div className="cards">{[0, 1, 2].map((i) => <div key={i} className="cardskel"><Skeleton h="100%" r={26} /></div>)}</div> :
        list.length === 0 ? <EmptyState title={g.data?.length ? "Nothing matches that filter" : "No Guardians on this network"} text={g.data?.length ? "Try another status or sort." : "Be the first: write a prompt, seed a pot, and let people try to break it."} action={<Pill to="/create" variant="solid" arrow>Create a Guardian</Pill>} /> : (
          <div className="cards">{list.map((x) => <NFTCard key={x.id} g={x} to={`/guardian/${x.id}`} />)}</div>
        )}

      <Board />
    </main>
  );
}
