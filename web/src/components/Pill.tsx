import type { ReactNode } from "react";
import { Link } from "react-router-dom";

interface Props {
  to?: string; href?: string; onClick?: () => void; children: ReactNode;
  variant?: "solid" | "outline" | "ghost"; arrow?: boolean; small?: boolean; disabled?: boolean; type?: "button" | "submit"; className?: string; active?: boolean;
}

/** Fully rounded pill. solid = black with white text and a diagonal arrow; outline = hairline that fills black on hover. */
export function Pill({ to, href, onClick, children, variant = "outline", arrow, small, disabled, type = "button", className = "", active }: Props) {
  const cls = `pill pill--${variant} ${small ? "pill--sm" : ""} ${active ? "is-active" : ""} ${className}`;
  const inner = <>{children}{arrow && <span className="pill__arrow" aria-hidden="true">↗</span>}</>;
  if (to) return <Link to={to} className={cls}>{inner}</Link>;
  if (href) return <a href={href} className={cls} target="_blank" rel="noreferrer">{inner}</a>;
  return <button type={type} className={cls} onClick={onClick} disabled={disabled}>{inner}</button>;
}
