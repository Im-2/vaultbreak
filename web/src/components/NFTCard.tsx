import { Link } from "react-router-dom";
import { API, type Guardian } from "../lib/api";

/** The URL of a Guardian's card art (SVG, drawn from live vault data; state: armed, veteran or defeated). The query only busts the cache when numbers change. */
export const cardSrc = (g: Pick<Guardian, "id" | "status" | "pot" | "stats">) => `${API}/guardians/${g.id}/image.svg?v=${g.status}-${g.stats.attempts}-${g.stats.streak}-${g.stats.blocked_reported}-${g.stats.wins}-${g.pot.length}${g.pot.slice(0, 6)}`;

/** A Guardian card: the art itself carries the name, state, pot, stats and sealed-prompt hash, so there is one source of truth. */
export function NFTCard({ g, size = "sm", to, src }: { g: Guardian; size?: "sm" | "lg"; to?: string; src?: string }) {
  const label = `${g.name}: ${g.art === "defeated" ? "pot released" : g.art === "veteran" ? "armed, veteran" : "armed"}`;
  const body = (
    <article className={`nftcard nftcard--${size}`}>
      <img src={src ?? cardSrc(g)} alt={label} width={600} height={840} loading="lazy" decoding="async" draggable={false} />
    </article>
  );
  return to ? <Link to={to} className="nft-link" aria-label={label}>{body}</Link> : body;
}
