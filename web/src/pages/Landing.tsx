import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ScrambleText } from "../components/ScrambleText";
import { Pill } from "../components/Pill";
import { cardSrc } from "../components/NFTCard";
import { ErrorState, EmptyState, Skeleton, StatusDot } from "../components/States";
import type { Guardian, Stats } from "../lib/api";
import { near, netNote, plural } from "../lib/format";
import { useConfig, useFetch, useIsMobile, useMotion, useScrollProgress } from "../lib/hooks";

/* ============================================================ hero */
function Hero() {
  const stats = useFetch<Stats>("/stats", { interval: 8000 });
  const cfg = useConfig();
  const strip = useRef<HTMLDivElement>(null);
  const { reduced } = useMotion();

  // The rounded strip expands to full width as you scroll.
  useEffect(() => {
    const el = strip.current; if (!el) return;
    let raf = 0;
    const calc = () => { raf = 0; const p = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * 0.7))); el.style.setProperty("--p", reduced ? "0" : String(p)); };
    const on = () => { if (!raf) raf = requestAnimationFrame(calc); };
    calc(); window.addEventListener("scroll", on, { passive: true });
    return () => { window.removeEventListener("scroll", on); if (raf) cancelAnimationFrame(raf); };
  }, [reduced]);

  const s = stats.data;
  return (
    <section className="hero">
      <div className="hero__top">
        <ScrambleText as="h1" className="display hero__title" on="mount" text="Can you talk it out of the money?" duration={1500} />
        <aside className="hero__meta" aria-label="Live totals">
          <small className="label">Live{cfg.data ? ` · ${netNote(cfg.data)}` : ""}</small>
          {stats.error && !s ? <p className="hero__err">API unreachable</p> : (
            <dl>
              <div><dt>Pot in play</dt><dd>{s ? <>{near(s.total_pot, 0)}<span> NEAR</span></> : <Skeleton w={110} h={34} />}</dd></div>
              <div><dt>Attempts so far</dt><dd>{s ? s.attempts.toLocaleString("en-US") : <Skeleton w={70} h={34} />}</dd></div>
              <div><dt>Guardians alive</dt><dd>{s ? <>{s.alive}<span> / {s.guardians}</span></> : <Skeleton w={60} h={34} />}</dd></div>
            </dl>
          )}
          <p className="hero__lede">AI guardians hold pots of NEAR. Pay a small fee, talk to one, and if you can make it let go, the whole pot is yours.</p>
        </aside>
      </div>
      <div ref={strip} className="hero__strip" aria-hidden="true"><div className="hero__kb" style={{ backgroundImage: "url(/assets/vault.jpg)" }} /></div>
    </section>
  );
}

/* ============================================================ how it works (sticky scroll) */
const STEPS = [
  { key: "guardian", head: "The Guardian", label: "01 / Holds the pot", main: "aisle", second: "rack",
    text: "An AI agent holds a pot of NEAR in its own on-chain vault. Its instructions are sealed: only a hash of them is public, so nobody can claim afterwards that the rules changed.",
    facts: ["Own vault account per Guardian", "Pot grows with every failed attempt", "Prompt sealed behind a public hash"] },
  { key: "attack", head: "The attack", label: "02 / Talk it out of the money", main: "tunnel", second: "hall",
    text: "Pay a small entry fee and start talking. Persuade, trick, role-play: your move. If the Guardian releases the pot, it is paid straight to you. If it holds, your fee joins the pot.",
    facts: ["Entry fee set by the creator", "Limited turns per attempt", "Every attempt is logged"] },
  { key: "proof", head: "The proof", label: "03 / The vault decides, not the AI", main: "shadows", second: "vault",
    text: "The Guardian holds only a restricted key: it can call release and close, nothing else. The vault has no full-access key, so any forbidden call is rejected by the chain itself and recorded as a blocked attempt.",
    facts: ["0 full-access keys on the vault", "release and close_session only", "Blocked attempts are counted on-chain"] },
] as const;

function HowItWorks() {
  const mobile = useIsMobile();
  const wrap = useRef<HTMLDivElement>(null);
  const p = useScrollProgress(wrap, !mobile);
  const [picked, setPicked] = useState<number | null>(null);
  const idx = picked ?? Math.min(STEPS.length - 1, Math.floor(p * STEPS.length * 0.999));
  useEffect(() => { if (picked !== null) { const t = setTimeout(() => setPicked(null), 1400); return () => clearTimeout(t); } }, [picked]);

  const jump = (i: number) => {
    const el = wrap.current; if (!el || mobile) return;
    const total = el.offsetHeight - window.innerHeight;
    window.scrollTo({ top: el.offsetTop + ((i + 0.5) / STEPS.length) * total, behavior: "smooth" });
    setPicked(i);
  };

  if (mobile) {
    return (
      <section className="how how--stack">
        <small className="label">How it works</small>
        {STEPS.map((s) => (
          <article key={s.key} className="how__item">
            <ScrambleText as="h2" className="display display--md" text={s.head} />
            <div className="collage"><img className="collage__main" src={`/assets/${s.main}.jpg`} alt="" loading="lazy" /><img className="collage__small" src={`/assets/${s.second}.jpg`} alt="" loading="lazy" /></div>
            <small className="label">{s.label}</small><p className="how__text">{s.text}</p>
            <ul className="chips">{s.facts.map((f) => <li key={f}>{f}</li>)}</ul>
          </article>
        ))}
      </section>
    );
  }
  return (
    <section ref={wrap} className="how" style={{ height: `${STEPS.length * 100}vh` }} aria-label="How it works">
      <div className="how__pin">
        <div className="how__left">
          <small className="label">How it works</small>
          {STEPS.map((s, i) => (
            <button key={s.key} className={`how__head ${i === idx ? "is-active" : ""}`} onClick={() => jump(i)} data-cursor>
              <span className="how__num">0{i + 1}</span>{s.head.split(" ").slice(0, -1).join(" ")}<br />{s.head.split(" ").slice(-1)}
            </button>
          ))}
          <div className="how__thumb" aria-hidden="true">{STEPS.map((s, i) => <img key={s.key} src={`/assets/${s.second}.jpg`} alt="" className={i === idx ? "is-on" : ""} />)}</div>
        </div>
        <div className="how__right">
          {STEPS.map((s, i) => (
            <div key={s.key} className={`how__panel ${i === idx ? "is-on" : i < idx ? "is-past" : ""}`} aria-hidden={i !== idx}>
              <small className="label">{s.label}</small>
              <h2 className="how__lead">{s.text}</h2>
              <div className="collage">
                <img className="collage__main" src={`/assets/${s.main}.jpg`} alt="" />
                <img className="collage__small" src={`/assets/${s.second}.jpg`} alt="" />
              </div>
              <ul className="chips">{s.facts.map((f) => <li key={f}>{f}</li>)}</ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================ the three states of a Guardian (centered row; stacks on small screens) */
function Gallery({ guardians }: { guardians: Guardian[] | null }) {
  const tiles = useMemo(() => {
    const list = guardians ?? [];
    const armed = list.filter((g) => g.status === "Armed").sort((a, b) => b.stats.streak - a.stats.streak);
    const veteran = armed.find((g) => g.art === "veteran");
    const rest = armed.find((g) => g.art === "armed");
    const defeated = list.find((g) => g.status === "Defeated");
    // A live Guardian when one is in that state; otherwise the reference card, so all three states are always shown.
    return [
      { art: "armed" as const, label: "Armed", note: "Holding a pot, waiting for you", g: rest },
      { art: "veteran" as const, label: "Veteran", note: "Armed, with a long unbroken streak", g: veteran },
      { art: "defeated" as const, label: "Released", note: "Talked out of its pot", g: defeated },
    ];
  }, [guardians]);

  return (
    <section className="gallery" aria-label="Three states of a Guardian">
      <div className="gallery__inner">
        <div className="gallery__title"><small className="label">Three states of a Guardian</small><ScrambleText as="h2" className="display" text="Armed. Veteran. Released." /></div>
        <div className="gallery__row">
          {tiles.map((t) => (
            <figure key={t.art} className={`gtile gtile--${t.art}`}>
              <div className="gtile__card">
                <img src={t.g ? cardSrc(t.g) : `/assets/art/${t.art}.svg`} alt={`${t.label} Guardian card${t.g ? ": " + t.g.name : " (example)"}`} width={600} height={840} loading="lazy" decoding="async" draggable={false} />
              </div>
              <figcaption>
                <small>{t.label}</small>
                {t.g
                  ? <><strong>{t.g.name}</strong><span><StatusDot status={t.g.status} /> {near(t.g.pot)} NEAR · streak {t.g.stats.streak}</span><Link to={`/guardian/${t.g.id}`}>Open ↗</Link></>
                  : <><strong>{t.note}</strong><span>Example card · no live Guardian in this state yet</span></>}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================ projects-style list with cursor-following tile */
function GuardianList({ guardians, loading, error, reload }: { guardians: Guardian[] | null; loading: boolean; error: string | null; reload: () => void }) {
  const nav = useNavigate();
  const tile = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Guardian | null>(null);
  const pos = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let raf = 0;
    const move = (e: MouseEvent) => { pos.current.tx = e.clientX; pos.current.ty = e.clientY; };
    const loop = () => { const q = pos.current; q.x += (q.tx - q.x) * 0.14; q.y += (q.ty - q.y) * 0.14; if (tile.current) tile.current.style.transform = `translate3d(${q.x + 24}px, ${q.y - 120}px, 0)`; raf = requestAnimationFrame(loop); };
    window.addEventListener("mousemove", move, { passive: true }); raf = requestAnimationFrame(loop);
    return () => { window.removeEventListener("mousemove", move); cancelAnimationFrame(raf); };
  }, []);
  const rows = (guardians ?? []).slice().sort((a, b) => Number(BigInt(b.pot) - BigInt(a.pot)));
  return (
    <section className="list">
      <div className="list__head">
        <small className="label">Live Guardians</small>
        <h2 className="display">Guardians <sup className="count">({guardians ? guardians.length : "…"})</sup></h2>
        <p className="muted">Sorted by pot. Hover a row; click to attack.</p>
      </div>
      {error && !guardians ? <ErrorState message={error} onRetry={reload} /> :
        loading && !guardians ? <div className="list__rows">{[0, 1, 2, 3].map((i) => <div key={i} className="lrow"><Skeleton h={28} w="60%" /></div>)}</div> :
        rows.length === 0 ? <EmptyState title="No Guardians yet" text="Nothing is armed on this network. Create the first one." action={<Pill to="/create" variant="solid" arrow>Create a Guardian</Pill>} /> : (
          <div className="list__rows" onMouseLeave={() => setHover(null)}>
            {rows.map((g, i) => (
              <button key={g.id} className="lrow" onMouseEnter={() => setHover(g)} onClick={() => nav(`/guardian/${g.id}`)} data-cursor>
                <span className="lrow__idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="lrow__name">{g.name}</span>
                <span className="lrow__meta"><StatusDot status={g.status} /> {g.status}</span>
                <span className="lrow__meta">{plural(g.stats.attempts, "attempt")}</span>
                <span className="lrow__pot">{near(g.pot)} <small>NEAR</small></span>
              </button>
            ))}
          </div>
        )}
      <div ref={tile} className={`hovertile ${hover ? "is-on" : ""}`} aria-hidden="true">{hover && <img src={cardSrc(hover)} alt="" />}</div>
    </section>
  );
}

/* ============================================================ CTA */
function CtaBar() {
  return (
    <section className="cta">
      <Link to="/arena" className="cta__bar" data-cursor>
        <ScrambleText as="span" className="cta__text" text="Enter the arena" duration={900} />
        <span className="cta__arrow" aria-hidden="true">↗</span>
      </Link>
    </section>
  );
}

export default function Landing() {
  const g = useFetch<Guardian[]>("/guardians", { interval: 10000 });
  return (
    <>
      <Hero />
      <HowItWorks />
      <Gallery guardians={g.data} />
      <GuardianList guardians={g.data} loading={g.loading} error={g.error} reload={g.reload} />
      <CtaBar />
    </>
  );
}
