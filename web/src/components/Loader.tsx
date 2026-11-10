import { useEffect, useState } from "react";
import { Mark } from "./Mark";
import { markReady, loaderNeeded } from "./ready";
import { useMotion } from "../lib/hooks";

/** Full-screen dark loader: mark + wordmark centred, a large light percentage counter bottom-right, then it lifts away. */
export function Loader() {
  const { reduced } = useMotion();
  const [show] = useState(loaderNeeded);
  const [pct, setPct] = useState(0);
  const [lifting, setLifting] = useState(false);
  const [gone, setGone] = useState(!show);

  useEffect(() => {
    if (!show) { markReady(); return; }
    document.documentElement.classList.add("is-loading");
    const dur = reduced ? 350 : 1900;
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      setPct(Math.round(100 * (1 - Math.pow(1 - k, 2.4))));
      if (k < 1) raf = requestAnimationFrame(step);
      else {
        setLifting(true); // lift away, then reveal
        setTimeout(() => { markReady(); document.documentElement.classList.remove("is-loading"); }, reduced ? 0 : 450);
        setTimeout(() => setGone(true), reduced ? 200 : 1000);
      }
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); document.documentElement.classList.remove("is-loading"); };
  }, [show, reduced]);

  if (gone) return null;
  return (
    <div className={`loader ${lifting ? "is-lifting" : ""}`} role="status" aria-label={`Loading ${pct}%`}>
      <div className="loader__center">
        <Mark size={44} light />
        <span className="loader__word">Vaultbreak</span>
      </div>
      <div className="loader__pct" aria-hidden="true">{pct}%</div>
    </div>
  );
}
