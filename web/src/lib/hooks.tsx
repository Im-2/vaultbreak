import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, ApiError, type AppConfig, type Me } from "./api";

// ------------------------------------------------------------------ data fetching
export interface Fetched<T> { data: T | null; error: string | null; loading: boolean; reload: () => void }

/** Fetches `path` (skipped when null) and optionally polls. Keeps the last good data while refreshing. */
export function useFetch<T>(path: string | null, opts: { interval?: number; token?: string | null } = {}): Fetched<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    let dead = false;
    const run = async () => {
      try { const r = await api<T>(path, { token: opts.token }); if (!dead) { setData(r); setError(null); } }
      catch (e) { if (!dead) setError(e instanceof ApiError ? e.message : "Could not reach the API"); }
      finally { if (!dead) setLoading(false); }
    };
    setLoading((l) => l || data === null);
    run();
    const t = opts.interval ? setInterval(run, opts.interval) : null;
    return () => { dead = true; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, opts.interval, opts.token, tick]);
  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ------------------------------------------------------------------ motion preference
const MOTION_KEY = "vb-motion";
const prefersReduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
interface MotionCtx { reduced: boolean; toggle: () => void }
const MotionContext = createContext<MotionCtx>({ reduced: false, toggle: () => {} });
export function MotionProvider({ children }: { children: ReactNode }) {
  const [reduced, setReduced] = useState(() => { try { const s = localStorage.getItem(MOTION_KEY); return s ? s === "off" : prefersReduced(); } catch { return prefersReduced(); } });
  useEffect(() => { document.documentElement.dataset.motion = reduced ? "off" : "on"; }, [reduced]);
  const toggle = useCallback(() => setReduced((r) => { try { localStorage.setItem(MOTION_KEY, r ? "on" : "off"); } catch { /* ignore */ } return !r; }), []);
  return <MotionContext.Provider value={useMemo(() => ({ reduced, toggle }), [reduced, toggle])}>{children}</MotionContext.Provider>;
}
export const useMotion = () => useContext(MotionContext);

// ------------------------------------------------------------------ viewport helpers
export function useInView<T extends Element>(ref: RefObject<T>, opts: { once?: boolean; margin?: string } = {}): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); if (opts.once !== false) io.disconnect(); } else if (opts.once === false) setSeen(false); }, { rootMargin: opts.margin ?? "0px 0px -4% 0px", threshold: 0.01 });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, opts.once, opts.margin]);
  return seen;
}

export function useIsMobile(max = 768): boolean {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.innerWidth < max);
  useEffect(() => { const on = () => setM(window.innerWidth < max); window.addEventListener("resize", on); return () => window.removeEventListener("resize", on); }, [max]);
  return m;
}

/** Scroll progress (0..1) of an element tall enough to scroll through while a sticky child stays pinned. */
export function useScrollProgress(ref: RefObject<HTMLElement>, enabled = true): number {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const calc = () => {
      raf = 0;
      const el = ref.current; if (!el) return;
      const r = el.getBoundingClientRect();
      const total = r.height - window.innerHeight;
      setP(total <= 0 ? 0 : Math.min(1, Math.max(0, -r.top / total)));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(calc); };
    calc();
    window.addEventListener("scroll", on, { passive: true }); window.addEventListener("resize", on);
    return () => { window.removeEventListener("scroll", on); window.removeEventListener("resize", on); if (raf) cancelAnimationFrame(raf); };
  }, [ref, enabled]);
  return p;
}

export function useNow(intervalMs = 1000): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setN(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return n;
}

// ------------------------------------------------------------------ site config + auth (custodial, zero-wallet)
export const useConfig = () => useFetch<AppConfig>("/config");

const TOKEN_KEY = "vb-token";
interface AuthCtx {
  token: string | null; me: Me | null; ready: boolean;
  signIn: (name: string, secret: string) => Promise<void>; signOut: () => void; refresh: () => void;
  dialog: boolean; openDialog: () => void; closeDialog: () => void;
}
const AuthContext = createContext<AuthCtx>(null as unknown as AuthCtx);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } });
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState(false);
  const refresh = useCallback(() => {
    if (!token) { setMe(null); setReady(true); return; }
    api<Me>("/me", { token }).then(setMe).catch((e) => { if (e instanceof ApiError && e.status === 401) { setToken(null); try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } } }).finally(() => setReady(true));
  }, [token]);
  useEffect(refresh, [refresh]);
  const signIn = useCallback(async (name: string, secret: string) => {
    const r = await api<{ token: string }>("/custodial/signin", { body: { name, secret } });
    try { localStorage.setItem(TOKEN_KEY, r.token); } catch { /* ignore */ }
    setToken(r.token);
  }, []);
  const signOut = useCallback(() => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } setToken(null); setMe(null); }, []);
  const value = useMemo(() => ({ token, me, ready, signIn, signOut, refresh, dialog, openDialog: () => setDialog(true), closeDialog: () => setDialog(false) }), [token, me, ready, signIn, signOut, refresh, dialog]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);

/** Counts from 0 to `to` over `ms` (eased). Returns `to` immediately when motion is reduced. */
export function useCountUp(to: number, ms = 1400, run = true): number {
  const { reduced } = useMotion();
  const [v, setV] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    if (!run) return;
    if (reduced) { setV(to); return; }
    const t0 = performance.now();
    const step = (t: number) => { const k = Math.min(1, (t - t0) / ms); setV(to * (1 - Math.pow(1 - k, 3))); if (k < 1) raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [to, ms, run, reduced]);
  return v;
}
