/** Vaultbreak mark: a vault wheel with a keyhole eye. */
export function Mark({ size = 28, light = false }: { size?: number; light?: boolean }) {
  const c = light ? "#fafafa" : "#0a0a0a";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="mark">
      <circle cx="32" cy="32" r="29" fill="none" stroke={c} strokeWidth="3.5" />
      <circle cx="32" cy="32" r="17" fill="none" stroke={c} strokeWidth="2.5" />
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i * Math.PI) / 4;
        return <line key={i} x1={32 + Math.cos(a) * 22} y1={32 + Math.sin(a) * 22} x2={32 + Math.cos(a) * 27} y2={32 + Math.sin(a) * 27} stroke={c} strokeWidth="2.5" strokeLinecap="round" />;
      })}
      <circle cx="32" cy="29.5" r="4.4" fill={c} />
      <path d="M30 31.5h4l1.6 11h-7.2z" fill={c} />
    </svg>
  );
}
