import { createElement, useEffect, useRef, useState } from "react";
import { useInView, useMotion } from "../lib/hooks";
import { useSiteReady } from "./ready";

const GLYPHS = "abcdefghijklmnopqrstuvwxyz0123456789#%&?/";

interface Props {
  text: string;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  /** ms before the reveal starts */
  delay?: number;
  /** ms the whole reveal takes */
  duration?: number;
  /** start when scrolled into view (default) or immediately once the loader has lifted */
  on?: "view" | "mount";
}

/**
 * Headline that resolves from blurred, mismatched letters into clean text, letter by letter.
 * The final text always occupies the layout (invisible until done), so nothing jumps while it scrambles.
 * With reduced motion it simply fades in.
 */
export function ScrambleText({ text, as = "span", className, delay = 0, duration = 1100, on = "view" }: Props) {
  const { reduced } = useMotion();
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref);
  const ready = useSiteReady();
  const go = on === "mount" ? ready : seen && ready;
  const [chars, setChars] = useState<{ c: string; done: boolean }[] | null>(null);
  const [finished, setFinished] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!go || started.current) return;
    started.current = true;
    if (reduced) { setFinished(true); return; }
    const src = Array.from(text);
    const resolveAt = src.map((_, i) => delay + (i / Math.max(1, src.length)) * duration * 0.75 + Math.random() * duration * 0.25);
    const t0 = performance.now();
    let raf = 0, last = 0;
    const tick = (t: number) => {
      const el = t - t0;
      if (t - last > 55 || el >= Math.max(...resolveAt)) { // ~18fps glyph churn keeps it readable and cheap
        last = t;
        const next = src.map((ch, i) => ({ c: ch === " " || el >= resolveAt[i] ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0], done: ch === " " || el >= resolveAt[i] }));
        setChars(next);
      }
      if (el < Math.max(...resolveAt) + 60) raf = requestAnimationFrame(tick); else { setChars(null); setFinished(true); }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); started.current = false; }; // StrictMode runs effects twice: allow the re-run
  }, [go, reduced, text, delay, duration]);

  return createElement(
    as,
    { ref, className: `scramble ${className ?? ""} ${finished ? "is-done" : ""} ${reduced ? "is-reduced" : ""}`, "aria-label": text },
    <span className="scramble__final" aria-hidden={chars ? true : undefined}>{text}</span>,
    chars && (
      <span className="scramble__live" aria-hidden="true">
        {chars.map((x, i) => <span key={i} className={x.done ? "sc-ok" : "sc-mix"}>{x.c}</span>)}
      </span>
    ),
  );
}
