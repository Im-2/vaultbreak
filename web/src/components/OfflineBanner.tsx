import { useEffect, useState } from "react";
import { API } from "../lib/api";

/** Shows a clear notice when the backend cannot be reached (it is a free, self-hosted demo), instead of blank or broken pages. */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let dead = false;
    const check = async () => {
      try {
        const r = await fetch(`${API}/config`, { cache: "no-store" });
        const ok = r.ok && (r.headers.get("content-type") ?? "").includes("json");
        if (!dead) setOffline(!ok);
      } catch { if (!dead) setOffline(true); }
    };
    void check();
    const t = setInterval(check, offline ? 5000 : 20000);
    return () => { dead = true; clearInterval(t); };
  }, [offline]);
  if (!offline) return null;
  return (
    <div className="offline" role="alert">
      <b>The demo backend is offline right now.</b> It runs on the author's own machine (a free demo), so live data, chats and sign-in are unavailable until it is back. This page checks again every few seconds. NFT metadata links still work from the last saved snapshot.
    </div>
  );
}
