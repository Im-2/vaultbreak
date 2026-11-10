import { useEffect, useRef } from "react";

/** A small dot that follows the mouse with easing and grows over interactive elements. Disabled on touch devices. */
export function Cursor() {
  const dot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    document.documentElement.classList.add("has-cursor");
    const el = dot.current!;
    let x = -50, y = -50, tx = -50, ty = -50, raf = 0, hot = false, light = false;
    const onMove = (e: MouseEvent) => {
      tx = e.clientX; ty = e.clientY;
      const t = e.target as Element | null;
      hot = !!t?.closest("a, button, [role=button], input, textarea, select, [data-cursor]");
      light = !!t?.closest(".dark, .loader");
      el.style.opacity = "1";
    };
    const onLeave = () => { el.style.opacity = "0"; };
    const loop = () => {
      x += (tx - x) * 0.2; y += (ty - y) * 0.2;
      el.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${hot ? 3.2 : 1})`;
      el.classList.toggle("is-light", light);
      raf = requestAnimationFrame(loop);
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    raf = requestAnimationFrame(loop);
    return () => { window.removeEventListener("mousemove", onMove); document.removeEventListener("mouseleave", onLeave); cancelAnimationFrame(raf); document.documentElement.classList.remove("has-cursor"); };
  }, []);
  return <div ref={dot} className="cursor-dot" aria-hidden="true" />;
}
