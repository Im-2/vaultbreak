// NFT card art v2: a TypeScript port of ui/nfts-v2/gen.py `card()` (the design's source of truth).
// Guilloche rosette, tick ring, microtext ring, keyhole medallion, stat rows, footer, three palettes.
// Text is drawn as PATHS (glyph outlines from Inter / DejaVu Sans Mono, see scripts/gen-art-glyphs.mjs), so the SVG looks the
// same on every device and marketplace without any font. The card wording stays "SEALED PROMPT"; it makes no verification claims.
import glyphs from "./art-glyphs.json" with { type: "json" };

export type ArtState = "armed" | "veteran" | "defeated";

const PAL: Record<ArtState, { f1: string; f2: string; f3: string; f4: string; acc: string; dot: string; bg1: string; bg2: string; status: string }> = {
  armed: { f1: "#f4e2a8", f2: "#c9a24a", f3: "#8a6420", f4: "#ecd28a", acc: "#d8b45c", dot: "#d8b45c", bg1: "#10131a", bg2: "#07090d", status: "ARMED" },
  veteran: { f1: "#f3f6fa", f2: "#aeb9c8", f3: "#68758a", f4: "#dfe6ee", acc: "#bfcad9", dot: "#9fd0c4", bg1: "#0f141b", bg2: "#06080c", status: "ARMED · VETERAN" },
  defeated: { f1: "#c9ccd2", f2: "#8b9099", f3: "#4f545d", f4: "#b5b9c1", acc: "#9a9fa8", dot: "#b5403f", bg1: "#12141a", bg2: "#08090c", status: "RELEASED" },
};

/** One rule for the art everywhere (API, NFT metadata, website): pot released -> defeated; armed with a long unbroken streak -> veteran; else armed. */
export const VETERAN_STREAK = 10;
export function artState(status: string, streak: number): ArtState {
  if (status === "Defeated") return "defeated";
  return streak >= VETERAN_STREAK ? "veteran" : "armed";
}

// ---------------------------------------------------------------- text as paths
type FontKey = "inter-500" | "inter-600" | "inter-700" | "mono-400";
const G = glyphs as Record<string, { upm: number; glyphs: Record<string, { a: number; d: string }> }>;
const glyphOf = (font: FontKey, ch: string) => G[font].glyphs[ch] ?? G[font].glyphs["?"] ?? G[font].glyphs[" "];
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Natural width of a run in px (advance widths + letter-spacing between glyphs). */
function runWidth(text: string, font: FontKey, size: number, spacing: number): number {
  const s = size / G[font].upm; let w = 0;
  for (const ch of text) w += glyphOf(font, ch).a * s + spacing;
  return w - (text.length ? spacing : 0);
}
/** Draws a run starting at x (left edge) on baseline y. */
function run(text: string, x: number, y: number, font: FontKey, size: number, spacing: number, fill: string, opacity?: number): string {
  const upm = G[font].upm, s = size / upm; let pen = 0; let paths = "";
  for (const ch of text) {
    const g = glyphOf(font, ch);
    if (g.d) paths += `<path transform="translate(${r1(pen)} 0)" d="${g.d}"/>`;
    pen += g.a + spacing / s;
  }
  return `<g transform="translate(${r1(x)} ${r1(y)}) scale(${s.toFixed(5)})" fill="${fill}"${opacity !== undefined ? ` fill-opacity="${opacity}"` : ""}>${paths}</g>`;
}
type Seg = { text: string; font: FontKey; size: number; spacing: number; fill: string; dx?: number };
/** Several runs on one baseline, placed from the left edge, the right edge or the middle. */
function line(segs: Seg[], x: number, y: number, anchor: "start" | "end" | "middle" = "start"): string {
  const widths = segs.map((s) => (s.dx ?? 0) + runWidth(s.text, s.font, s.size, s.spacing));
  const total = widths.reduce((a, b) => a + b, 0) + (segs.length - 1) * 0;
  let pen = anchor === "start" ? x : anchor === "end" ? x - total : x - total / 2;
  let out = "";
  segs.forEach((s, i) => { pen += s.dx ?? 0; out += run(s.text, pen, y, s.font, s.size, s.spacing, s.fill); pen += widths[i] - (s.dx ?? 0); });
  return out;
}
/** Text around a circle (microtext ring), clockwise from 9 o'clock, glyph tops pointing outward, stretched to `length` px. */
function ringText(text: string, cx: number, cy: number, r: number, font: FontKey, size: number, spacing: number, length: number, fill: string, opacity: number): string {
  const upm = G[font].upm, s = size / upm; const chars = [...text];
  const adv = chars.map((ch) => glyphOf(font, ch).a * s);
  const natural = adv.reduce((a, b) => a + b, 0) + spacing * chars.length;
  const gap = spacing + (length - natural) / chars.length; // lengthAdjust="spacing"
  let at = 0, paths = "";
  chars.forEach((ch, i) => {
    const g = glyphOf(font, ch);
    if (g.d) {
      const mid = at + adv[i] / 2, th = Math.PI + mid / r;
      const px = cx + r * Math.cos(th), py = cy + r * Math.sin(th), deg = (th * 180) / Math.PI + 90;
      paths += `<path transform="translate(${r1(px)} ${r1(py)}) rotate(${deg.toFixed(2)}) translate(${r1(-adv[i] / 2)} 0) scale(${s.toFixed(5)})" d="${g.d}"/>`;
    }
    at += adv[i] + gap;
  });
  return `<g fill="${fill}" fill-opacity="${opacity}">${paths}</g>`;
}

// ---------------------------------------------------------------- guilloche
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const fmt = (n: number) => { const t = n.toFixed(1); return t.endsWith(".0") ? t.slice(0, -2) : t; }; // 1 decimal, no trailing .0: keeps the SVG small
function hypo(R: number, r: number, d: number, rot: number, n: number, cx: number, cy: number): string {
  const k = (R - r) / r;
  const den = r / gcd(R - r, r); // Fraction(R-r, r).denominator
  const T = 2 * Math.PI * den;
  const a = (rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (T * i) / n;
    const x = (R - r) * Math.cos(t) + d * Math.cos(k * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(k * t);
    pts.push(`${fmt(cx + x * ca - y * sa)} ${fmt(cy + x * sa + y * ca)}`);
  }
  return "M" + pts.join(" L") + "Z";
}
function rosette(cx: number, cy: number): string {
  const specs: [number, number, number, number, number][] = [[172, 58, 64, 0, 0.5], [172, 58, 64, 60, 0.5], [172, 58, 64, 120, 0.5], [150, 50, 42, 30, 0.45], [150, 50, 42, 90, 0.45], [120, 41, 30, 0, 0.42], [120, 41, 30, 60, 0.42], [92, 31, 24, 15, 0.4]];
  return specs.map(([R, r, d, rot, op]) => `<path d="${hypo(R, r, d, rot, 1400, cx, cy)}" fill="none" stroke="url(#foil)" stroke-width=".55" stroke-opacity="${op}"/>`).join("");
}
function ticks(cx: number, cy: number): string {
  let s = "";
  for (let i = 0; i < 120; i++) {
    const a = (i * 3 * Math.PI) / 180, major = i % 10 === 0, r1v = 214, r2 = r1v - (major ? 11 : 5);
    s += `<line x1="${(cx + r1v * Math.cos(a)).toFixed(1)}" y1="${(cy + r1v * Math.sin(a)).toFixed(1)}" x2="${(cx + r2 * Math.cos(a)).toFixed(1)}" y2="${(cy + r2 * Math.sin(a)).toFixed(1)}" stroke="url(#foil)" stroke-width="${major ? 1.2 : 0.6}" stroke-opacity="${major ? 0.9 : 0.45}"/>`;
  }
  return s;
}

// ---------------------------------------------------------------- the card
export interface CardParams {
  state: ArtState; num: number; name: string; pot: string; attempts: string | number; streak: string | number; blocked: string | number; wins: string | number; hash: string;
}
const MUTED = "#8d95a3", LIGHT = "#eef1f6", DIM = "#6f7886", SOFT = "#aab2bf";
let rosetteCache: string | null = null; // the same for every card: compute once

export function cardSvg(c: CardParams): string {
  const p = PAL[c.state], W = 600, H = 840, cx = 300, cy = 330, defeated = c.state === "defeated";
  rosetteCache ??= rosette(cx, cy);
  const ring = "SEALED · ON-CHAIN · NEP-171 · THE VAULT HOLDS THE POT · THE AI CANNOT MOVE IT · VAULTBREAK · SEALED · ON-CHAIN · NEP-171 · THE VAULT HOLDS THE POT · THE AI CANNOT MOVE IT · VAULTBREAK ·";
  let medal = `<g>
      <circle cx="${cx}" cy="${cy}" r="226" fill="none" stroke="url(#foil)" stroke-width="1" stroke-opacity=".6"/>
      <circle cx="${cx}" cy="${cy}" r="203" fill="none" stroke="url(#foil)" stroke-width="1" stroke-opacity=".5"/>
      ${ringText(ring, cx, cy, 214.5, "inter-600", 6.6, 2.2, 1344, "url(#foil)", 0.85)}
      ${ticks(cx, cy)}
      ${rosetteCache}
      <circle cx="${cx}" cy="${cy}" r="74" fill="#0a0c11" stroke="url(#foil)" stroke-width="1.4"/>
      <circle cx="${cx}" cy="${cy}" r="66" fill="none" stroke="url(#foil)" stroke-width=".6" stroke-opacity=".7"/>
      <circle cx="${cx}" cy="${cy}" r="58" fill="none" stroke="url(#foil)" stroke-width=".5" stroke-opacity=".4" stroke-dasharray="1.2 3.2"/>
      <path d="M ${cx - 9.5} ${cy + 27} L ${cx - 4.5} ${cy + 3.5} A 14 14 0 1 1 ${cx + 4.5} ${cy + 3.5} L ${cx + 9.5} ${cy + 27} Z" fill="url(#foil)"/>
      <circle cx="${cx}" cy="${cy - 8}" r="4.4" fill="#0a0c11"/>
    </g>`;
  if (defeated) {
    medal = `<clipPath id="ca"><polygon points="0,0 ${cx + 30},0 ${cx - 34},${H} 0,${H}"/></clipPath><clipPath id="cb"><polygon points="${cx + 30},0 ${W},0 ${W},${H} ${cx - 34},${H}"/></clipPath>
        <g clip-path="url(#ca)" transform="translate(-5,3)">${medal}</g><g clip-path="url(#cb)" transform="translate(5,-3)">${medal}</g>
        <line x1="${cx + 30}" y1="110" x2="${cx - 34}" y2="555" stroke="#b5403f" stroke-width="1.2" stroke-opacity=".9"/>`;
  }
  const stamp = defeated
    ? `<g transform="rotate(-9 ${cx} ${cy + 8})"><rect x="${cx - 112}" y="${cy - 4}" width="224" height="40" rx="3" fill="#0b0c10" fill-opacity=".78" stroke="#b5403f" stroke-width="1.6"/>${line([{ text: "POT RELEASED", font: "inter-700", size: 15, spacing: 5, fill: "#d0504d" }], cx, cy + 22, "middle")}</g>`
    : "";
  const rows: [string, string | number][] = [["ATTEMPTS", c.attempts], ["STREAK", c.streak], ["BLOCKED", c.blocked], ["WINS", c.wins]];
  const rowsvg = rows.map(([k, v], i) => {
    const y = 690 + i * 26;
    return `<line x1="338" y1="${y - 20}" x2="562" y2="${y - 20}" stroke="#fff" stroke-opacity=".10"/>${run(k, 338, y, "inter-500", 10, 2.2, MUTED)}${line([{ text: String(v), font: "inter-600", size: 15, spacing: 0, fill: LIGHT }], 562, y + 1, "end")}`;
  }).join("");
  const name = [...c.name].slice(0, 28).join("");
  const nameSize = Math.min(31, Math.max(18, 31 * (470 / Math.max(470, runWidth(name, "inter-600", 31, 0.4))))); // long names shrink to fit
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Vaultbreak Guardian ${xml(c.name)}">
<title>Vaultbreak Guardian ${xml(c.name)}</title>
<defs>
 <linearGradient id="foil" gradientUnits="userSpaceOnUse" x1="60" y1="80" x2="540" y2="600"><stop offset="0" stop-color="${p.f1}"/><stop offset=".35" stop-color="${p.f2}"/><stop offset=".62" stop-color="${p.f3}"/><stop offset="1" stop-color="${p.f4}"/></linearGradient>
 <radialGradient id="bg" cx="50%" cy="36%" r="78%"><stop offset="0" stop-color="${p.bg1}"/><stop offset="1" stop-color="${p.bg2}"/></radialGradient>
 <radialGradient id="halo" cx="50%" cy="39%" r="46%"><stop offset="0" stop-color="${p.acc}" stop-opacity=".10"/><stop offset="1" stop-color="${p.acc}" stop-opacity="0"/></radialGradient>
 <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" result="n"/><feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .055 0"/></filter>
</defs>
<rect width="${W}" height="${H}" rx="26" fill="url(#bg)"/>
<rect width="${W}" height="${H}" rx="26" fill="url(#halo)"/>
<rect width="${W}" height="${H}" rx="26" filter="url(#grain)"/>
<rect x="10" y="10" width="${W - 20}" height="${H - 20}" rx="19" fill="none" stroke="url(#foil)" stroke-width="1.4"/>
<rect x="17" y="17" width="${W - 34}" height="${H - 34}" rx="13" fill="none" stroke="url(#foil)" stroke-width=".5" stroke-opacity=".55"/>

${run("VAULTBREAK", 42, 62, "inter-700", 12, 4, "url(#foil)")}
${line([{ text: "GUARDIAN  ", font: "inter-500", size: 11, spacing: 2.6, fill: MUTED }, { text: `No. ${String(Math.max(0, Math.floor(c.num))).padStart(4, "0")}`, font: "inter-600", size: 11, spacing: 2.6, fill: LIGHT }], W - 42, 62, "end")}
<line x1="42" y1="78" x2="${W - 42}" y2="78" stroke="#fff" stroke-opacity=".10"/>

${medal}
${stamp}

${run(name, 42, 618, "inter-600", nameSize, 0.4, "#f2f4f8")}
<circle cx="45" cy="640" r="3.4" fill="${p.dot}"/>
${run(p.status, 56, 644, "inter-600", 10.5, 2.8, SOFT)}

${run("POT", 42, 690, "inter-500", 10, 2.2, MUTED)}
${line([{ text: c.pot, font: "inter-600", size: 38, spacing: 0, fill: "#f2f4f8" }, { text: "NEAR", font: "inter-500", size: 15, spacing: 1.5, fill: MUTED, dx: 6 }], 42, 730)}
${rowsvg}
<line x1="42" y1="780" x2="${W - 42}" y2="780" stroke="#fff" stroke-opacity=".10"/>
${line([{ text: "SEALED PROMPT  ", font: "inter-500", size: 9.5, spacing: 2, fill: DIM }, { text: c.hash, font: "mono-400", size: 9.5, spacing: 0.6, fill: SOFT }], 42, 803)}
${run("NEP-171", W - 42 - runWidth("NEP-171", "inter-500", 9.5, 2), 803, "inter-500", 9.5, 2, DIM)}
</svg>`;
}

const xml = (s: string) => s.replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[ch] as string));

/** "1,008.68" from yoctoNEAR. */
export function potText(yocto: string | bigint): string {
  const v = BigInt(yocto); const cents = (v * 100n + 10n ** 24n / 2n) / 10n ** 24n;
  return `${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export const hashText = (h: string): string => (h && h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h || "-");
