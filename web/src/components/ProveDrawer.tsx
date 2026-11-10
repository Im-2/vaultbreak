import { useEffect } from "react";
import { AcctLink, Copy, TxLink } from "./TxLink";
import { ErrorState, Skeleton } from "./States";
import type { AppConfig, Proof } from "../lib/api";
import { shortHash, timeAgo } from "../lib/format";
import { useFetch } from "../lib/hooks";

/** "Prove it": what the vault guarantees (enforced by the chain), what is logged, and what is NOT proven, in plain language. */
export function ProveDrawer({ id, cfg, open, onClose }: { id: string; cfg: AppConfig | null; open: boolean; onClose: () => void }) {
  const { data: p, error, reload } = useFetch<Proof>(open ? `/guardians/${id}/prove` : null);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [open, onClose]);
  return (
    <>
      <div className={`scrim ${open ? "is-on" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside className={`drawer ${open ? "is-on" : ""}`} role="dialog" aria-label="Prove it" aria-hidden={!open}>
        <header><div><small className="label">Prove it</small><h2>What can this Guardian actually do?</h2></div><button className="drawer__x" onClick={onClose} aria-label="Close">×</button></header>
        {error && !p ? <ErrorState message={error} onRetry={reload} /> : !p ? <div className="drawer__skel"><Skeleton h={22} /><Skeleton h={80} r={16} /><Skeleton h={22} w="60%" /></div> : (
          <div className="drawer__body">
            <section>
              <h3>The vault decides, enforced by the chain</h3>
              <ul className="proof-list">
                <li className={p.vault.no_full_access_key ? "ok" : "bad"}>
                  <b>{p.vault.no_full_access_key === null ? "Could not read the vault's keys right now" : p.vault.no_full_access_key ? "No full-access key on the vault" : "A full-access key exists on this vault"}</b>
                  <span>Nobody, including the creator and us, holds a key that can sign arbitrary transactions as this vault.</span>
                </li>
                {(p.vault.keys ?? []).map((k, i) => (
                  <li key={i} className="ok"><b>The Guardian's key: {k.kind === "FunctionCall" ? "function-call key" : k.kind}</b><span>{k.methods ? <>can only call {k.methods.map((m, j) => <span key={m}>{j > 0 && " and "}<code>{m}</code></span>)} on <code>{shortHash(k.receiver ?? "", 8, 14)}</code>. It cannot attach or send NEAR.</> : "unrestricted"}</span></li>
                ))}
                <li className="ok"><b>Release has no recipient or amount</b><span>When the Guardian releases, the vault pays the whole pot to the account that paid for that attempt. The AI cannot redirect it.</span></li>
              </ul>
            </section>

            <section>
              <h3>Sealed prompt</h3>
              <p>The Guardian's instructions are secret, but their hash was fixed in the vault before anyone played. {p.vault.revealed ? "They have since been revealed and can be checked against it." : "They are revealed once the Guardian is defeated or retired, so you can check nothing changed."}</p>
              <Copy text={p.vault.prompt_hash}><code>{p.vault.prompt_hash}</code></Copy>
            </section>

            <section>
              <h3>Blocked attempts</h3>
              <p><b>{p.stats.blocked_reported.toLocaleString("en-US")}</b> reported on-chain across {p.stats.attempts.toLocaleString("en-US")} attempts. When a model tries a forbidden call, the chain refuses it and the attempt is logged here. A refused call is rejected before it is included in a block, so it has no transaction hash; the attempt’s close transaction (below) records the blocked count on-chain.</p>
              {p.blocked.length === 0 ? <p className="muted">No refused calls logged by this server yet.</p> : (
                <ul className="blocked-list">{p.blocked.map((b, i) => (
                  <li key={i}><b>{b.tool}</b><code>{(() => { try { return JSON.stringify(JSON.parse(b.args)); } catch { return b.args; } })()}</code><span>{b.chain_error}</span><small>{timeAgo(b.created_at)}</small></li>))}
                </ul>
              )}
            </section>

            <section>
              <h3>Attempts and transactions</h3>
              {p.sessions.length === 0 ? <p className="muted">No attempts played through this server yet.</p> : (
                <table className="proof-table"><thead><tr><th>Attempt</th><th>Result</th><th>Turns</th><th>Release / close tx</th></tr></thead><tbody>
                  {p.sessions.map((s) => <tr key={s.id}><td>{timeAgo(s.started_at)}</td><td>{s.status === "won" ? "Pot released" : s.status === "failed" ? "Held" : s.status}</td><td>{s.turns}</td><td><TxLink tx={s.tx_release ?? s.tx_close} cfg={cfg} /></td></tr>)}
                </tbody></table>
              )}
            </section>

            <section>
              <h3>What is not proven here</h3>
              <p>{p.attestation.available
                ? <>This Guardian's model runs on NEAR AI Cloud, which signs its answers from inside a trusted hardware environment. {p.attestation.signed_exchanges} signed exchange(s) are recorded for it.</>
                : p.attestation.reason}</p>
              <p className="muted">Model: {p.guardian.provider === "mock" ? "scripted demo model" : p.guardian.model}. The operator runs the model and builds each request, so a dishonest operator could in principle instruct it to release. The vault still cannot be made to pay anyone except the player of that attempt.</p>
            </section>
            <footer className="drawer__foot muted">Vault account <AcctLink id={p.guardian.vault_account} cfg={cfg} /> · vault status {p.vault.status.toLowerCase()}</footer>
          </div>
        )}
      </aside>
    </>
  );
}
