import { useCallback, useEffect, useRef, useState } from "react";
import { API, type AppConfig } from "./api";

interface Snapshot { at: number; stats: unknown; guardians: unknown; config: AppConfig | null }
let snapP: Promise<Snapshot | null> | null = null;
/** The numbers as of the last deployment: a small static file from the CDN, available before the backend answers. */
export const loadSnapshot = (): Promise<Snapshot | null> => (snapP ??= fetch("/snapshot.json").then((r) => (r.ok ? (r.json() as Promise<Snapshot>) : null)).catch(() => null));

export type Origin = "live" | "snapshot" | "cache" | null;

/**
 * Data that is never empty for more than a moment: first the numbers this browser saw last time (localStorage), else the deployment's
 * snapshot (a static file), then the live answer replaces them. \`origin\` says which one is on screen, \`refreshing\` that a live answer is
 * on its way. If the backend is asleep the API function itself answers with its snapshot (origin "snapshot"), so there are never empty blocks.
 */
export function useSnap<T>(path: "/stats" | "/guardians", key: "stats" | "guardians", interval = 10000) {
  const ls = `vb-snap:${key}`;
  const [data, setData] = useState<T | null>(() => { try { const s = localStorage.getItem(ls); return s ? (JSON.parse(s).v as T) : null; } catch { return null; } });
  const [origin, setOrigin] = useState<Origin>(() => (data ? "cache" : null));
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const live = useRef(false);

  useEffect(() => {
    if (data) return; let dead = false;
    void loadSnapshot().then((s) => { const v = s?.[key] as T | undefined; if (!dead && v && !live.current) { setData(v); setOrigin("snapshot"); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let dead = false;
    const run = async () => {
      setRefreshing(true);
      try {
        const r = await fetch(`${API}${path}`, { cache: "no-store" });
        if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) throw new Error(String(r.status));
        const v = (await r.json()) as T; const src = r.headers.get("x-vaultbreak-source");
        if (dead) return;
        live.current = true; setData(v); setOrigin(src === "snapshot" ? "snapshot" : "live"); setError(null);
        try { localStorage.setItem(ls, JSON.stringify({ v, at: Date.now() })); } catch { /* storage unavailable */ }
      } catch { if (!dead) setError("unreachable"); } finally { if (!dead) setRefreshing(false); }
    };
    void run(); const t = setInterval(run, interval);
    return () => { dead = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, interval, tick]);

  return { data, origin, refreshing, error, loading: data === null && refreshing, stale: origin !== "live", reload: useCallback(() => setTick((n) => n + 1), []) };
}

/** The network label before /config answers (from the snapshot). */
export function useSnapshotConfig(): AppConfig | null {
  const [c, setC] = useState<AppConfig | null>(null);
  useEffect(() => { let dead = false; void loadSnapshot().then((s) => { if (!dead && s?.config) setC(s.config); }); return () => { dead = true; }; }, []);
  return c;
}
