import { useEffect, useState } from "react";

// "Site ready" = the loader has lifted. Scramble reveals wait for it so the first headline is seen resolving.
const KEY = "vb-loaded";
const EVT = "vb:ready";
let isReady = false;
try { isReady = sessionStorage.getItem(KEY) === "1"; } catch { /* ignore */ }

export const loaderNeeded = () => !isReady && !/[?&]noloader/.test(window.location.search);
export function markReady() {
  if (isReady) return;
  isReady = true;
  try { sessionStorage.setItem(KEY, "1"); } catch { /* ignore */ }
  window.dispatchEvent(new Event(EVT));
}
export function useSiteReady(): boolean {
  const [r, setR] = useState(() => isReady || !loaderNeeded());
  useEffect(() => { if (r) return; const on = () => setR(true); window.addEventListener(EVT, on); return () => window.removeEventListener(EVT, on); }, [r]);
  return r;
}
