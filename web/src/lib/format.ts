const Y = 10n ** 24n;

/** yoctoNEAR (string | bigint) -> "1,234.56". */
export function near(yocto: string | bigint | null | undefined, digits = 2): string {
  if (yocto == null) return "-";
  const v = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  const neg = v < 0n; const a = neg ? -v : v;
  const scale = 10n ** BigInt(digits);
  const rounded = (a * scale + Y / 2n) / Y; // round half up
  const whole = rounded / scale, frac = rounded % scale;
  const w = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${w}${digits ? "." + frac.toString().padStart(digits, "0") : ""}`;
}
export const nearNum = (yocto: string | bigint) => Number((typeof yocto === "bigint" ? yocto : BigInt(yocto)) / 10n ** 20n) / 1e4;

export function shortHash(h: string | null | undefined, a = 6, b = 4): string {
  if (!h) return "-";
  return h.length <= a + b + 1 ? h : `${h.slice(0, a)}…${h.slice(-b)}`;
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
};

export const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
