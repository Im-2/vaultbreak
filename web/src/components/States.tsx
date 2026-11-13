import type { ReactNode } from "react";
import { bgImage } from "./Pic";
import { Pill } from "./Pill";

export const Skeleton = ({ w, h = 16, r = 10, className = "" }: { w?: number | string; h?: number | string; r?: number; className?: string }) =>
  <span className={`skeleton ${className}`} style={{ width: w ?? "100%", height: h, borderRadius: r }} aria-hidden="true" />;

export function EmptyState({ title, text, image = "shadows", action }: { title: string; text: string; image?: "shadows" | "metal"; action?: ReactNode }) {
  return (
    <div className="state state--empty" style={{ backgroundImage: `linear-gradient(rgba(250,250,250,.86), rgba(250,250,250,.94)), ${bgImage(image, 960)}` }}>
      <h3>{title}</h3><p>{text}</p>{action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <span className="dot dot--red" /><div><h3>Something went wrong</h3><p>{message}</p></div>
      {onRetry && <Pill small onClick={onRetry}>Try again</Pill>}
    </div>
  );
}

export const StatusDot = ({ status }: { status: string }) => <span className={`dot ${status === "Armed" ? "dot--gold" : status === "Defeated" ? "dot--red" : "dot--grey"}`} aria-hidden="true" />;
