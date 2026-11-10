import { Link } from "react-router-dom";
import type { Guardian } from "../lib/api";
import { near, shortHash } from "../lib/format";

/**
 * The Guardian "NFT" card. The art is the supplied emblem (cropped; its baked-in demo numbers are NOT used);
 * every figure on the card is live data from the vault.
 */
export function NFTCard({ g, size = "sm", to }: { g: Guardian; size?: "sm" | "lg"; to?: string }) {
  const body = (
    <article className={`nft nft--${g.art} nft--${size}`}>
      <header className="nft__head"><span>VAULTBREAK</span><span>GUARDIAN · {g.id.toUpperCase().slice(0, 14)}</span></header>
      <div className="nft__art"><img src={`/assets/emblem-${g.art}.webp`} alt={`${g.name} vault emblem`} loading="lazy" draggable={false} /></div>
      <h3 className="nft__name">{g.name}</h3>
      <div className={`nft__badge nft__badge--${g.status.toLowerCase()}`}><i />{g.status.toUpperCase()}</div>
      <div className="nft__pot">
        <div><small>POT</small><strong>{near(g.pot)} NEAR</strong></div>
        <div className="nft__hash"><small>SEALED PROMPT</small><span>{shortHash(g.prompt_hash)}</span></div>
      </div>
      <dl className="nft__stats">
        <div><dt>ATTEMPTS</dt><dd>{g.stats.attempts.toLocaleString("en-US")}</dd></div>
        <div><dt>STREAK</dt><dd className="acc">{g.stats.streak.toLocaleString("en-US")}</dd></div>
        <div><dt>BLOCKED</dt><dd>{g.stats.blocked_reported.toLocaleString("en-US")}</dd></div>
      </dl>
    </article>
  );
  return to ? <Link to={to} className="nft-link">{body}</Link> : body;
}
