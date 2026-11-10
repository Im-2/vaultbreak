import { useState } from "react";
import { shortHash } from "../lib/format";
import type { AppConfig } from "../lib/api";

/** A transaction hash: links to the explorer when the network has one, otherwise a copyable short hash. */
export function TxLink({ tx, cfg, label }: { tx: string | null | undefined; cfg: AppConfig | null | undefined; label?: string }) {
  const [copied, setCopied] = useState(false);
  if (!tx) return <span className="muted">-</span>;
  if (cfg?.explorer) return <a className="txlink" href={`${cfg.explorer}/txns/${tx}`} target="_blank" rel="noreferrer">{label ?? shortHash(tx, 6, 6)} ↗</a>;
  return (
    <button className="txlink" title="Copy transaction hash (local network: no explorer)" onClick={() => { navigator.clipboard?.writeText(tx).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }); }}>
      {copied ? "copied" : label ?? shortHash(tx, 6, 6)}
    </button>
  );
}

/** An account (vault, owner) or an NFT token: links to the explorer when the network has one, otherwise plain text. */
export function AcctLink({ id, cfg, nft, label }: { id: string | null | undefined; cfg: AppConfig | null | undefined; nft?: string; label?: string }) {
  if (!id) return <span className="muted">-</span>;
  const text = label ?? (id.length > 30 ? shortHash(id, 14, 12) : id);
  if (cfg?.explorer) return <a className="txlink" href={nft ? `${cfg.explorer}/nft-token/${id}/${nft}` : `${cfg.explorer}/address/${id}`} target="_blank" rel="noreferrer" title={id}>{text} ↗</a>;
  return <span className="mono" title={id}>{text}</span>;
}

export function Copy({ text, children }: { text: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button className="copy" onClick={() => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }); }} aria-label="Copy">
      {children ?? text}<span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}
