import { useEffect, useRef, useState } from "react";
import { API } from "../lib/api";

/**
 * A clear notice when the backend cannot be reached, instead of blank or broken pages.
 * The backend is on free hosting that sleeps when idle, so the first message is "waking up" (cold start, up to about a minute);
 * if it is still unreachable after 2 minutes the wording changes to "offline".
 */
export function OfflineBanner() {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const sinceRef = useRef<number | null>(null);
  useEffect(() => {
    let dead = false;
    const check = async () => {
      let ok = false;
      try {
        const r = await fetch(`${API}/config`, { cache: "no-store" });
        ok = r.ok && (r.headers.get("content-type") ?? "").includes("json");
      } catch { ok = false; }
      if (dead) return;
      if (ok) { sinceRef.current = null; setSince(null); }
      else if (sinceRef.current === null) { sinceRef.current = Date.now(); setSince(sinceRef.current); }
      setNow(Date.now());
    };
    void check();
    const t = setInterval(check, 5000);
    return () => { dead = true; clearInterval(t); };
  }, []);
  if (since === null) return null;
  const waking = now - since < 120_000;
  return (
    <div className="offline" role="alert">
      {waking ? (
        <><b>Waking up the demo backend…</b> It runs on free hosting that sleeps when idle, so the first visit takes up to a minute. This page checks again every few seconds. NFT metadata links keep working meanwhile.</>
      ) : (
        <><b>The demo backend is not answering right now.</b> Live data, chats and sign-in are unavailable until it is back. This page keeps checking. NFT metadata links still work from the last saved snapshot.</>
      )}
    </div>
  );
}
