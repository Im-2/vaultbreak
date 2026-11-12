import { useState, type FormEvent } from "react";
import { AuthGate } from "../components/AuthGate";
import { AgentsPreview } from "../components/Previews";
import { Pill } from "../components/Pill";
import { ScrambleText } from "../components/ScrambleText";
import { EmptyState, ErrorState, Skeleton } from "../components/States";
import { Copy } from "../components/TxLink";
import { api } from "../lib/api";
import { near, timeAgo } from "../lib/format";
import { useAuth, useFetch } from "../lib/hooks";

interface KeyRow { id: string; agent_account: string; label: string | null; budget_remaining: string; spent: string; revoked: number; created_at: number; transfer_nft?: boolean; transfer_allowlist?: string[]; transfer_require_approval?: boolean | null }
interface Made { id: string; api_key: string; agent_account: string; budget_remaining: string }

const snippet = (key: string, account: string) => `import { VaultbreakClient } from "./sdk/src/index.ts";
import { Account } from "near-api-js";

// your agent's own NEAR account signs on-chain transactions; the API key authenticates API calls
const client = new VaultbreakClient("${typeof window !== "undefined" ? window.location.origin : ""}/api", agentAccount /* ${account} */, fetch, { apiKey: "${key}" });
const { sessionId } = await client.startSession("warden", "warden.<registry>", 200_000_000_000_000_000_000_000n); // refuses BEFORE paying if the budget is gone
const events = await client.send(sessionId, "hello");`;

function Body() {
  const { token, me } = useAuth();
  const keys = useFetch<KeyRow[]>("/agent/keys", { token, interval: 8000 });
  const [label, setLabel] = useState("my agent");
  const [budget, setBudget] = useState(2);
  const [canXfer, setCanXfer] = useState(false);          // transfer_nft: OFF by default
  const [allow, setAllow] = useState("");
  const [needApproval, setNeedApproval] = useState(true);
  const [made, setMade] = useState<Made | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setMade(await api<Made>("/agent/keys", { token, body: { agent_account: me?.account, budget_near: budget, label, transfer_nft: canXfer, ...(canXfer ? { transfer_allowlist: allow.split(/[s,]+/).filter(Boolean), transfer_require_approval: needApproval } : {}) } })); keys.reload(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };
  const act = async (path: string, body?: unknown) => { try { await api(path, { token, body: body ?? {} }); keys.reload(); } catch (x) { setErr((x as Error).message); } };

  return (
    <div className="agents">
      <div className="agents__main">
        <form className="startpool" onSubmit={create}>
          <small className="label">New API key</small>
          <div className="startpool__row">
            <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} /></label>
            <label>Spend budget (NEAR)<input type="number" min={0.1} step={0.1} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></label>
          </div>
          <fieldset className="perm">
            <label className="perm__row"><input type="checkbox" checked={canXfer} onChange={(e) => setCanXfer(e.target.checked)} /> <span><b>Allow this key to transfer my Guardians</b> <code>transfer_nft</code> · off by default</span></label>
            {canXfer && (
              <div className="perm__more">
                <label>Recipient allowlist (usernames or account ids, separated by commas)<input value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="ada, bob.testnet" required /></label>
                <label className="perm__row"><input type="checkbox" checked={needApproval} onChange={(e) => setNeedApproval(e.target.checked)} /> <span>Require my approval for every transfer (the request waits in My Guardians)</span></label>
                <small className="muted">Transfers move a Guardian's NFT and its creator fees to someone else. The spend budget does not cover them, so keep the allowlist short.</small>
              </div>
            )}
          </fieldset>
          <small className="muted">The key authenticates as <b>{me?.account ?? "your account"}</b>. Each entry fee it binds to an API session is charged against the budget.</small>
          {err && <div className="form-error" role="alert">{err}</div>}
          <Pill variant="solid" type="submit" arrow disabled={busy}>{busy ? "Creating…" : "Create key"}</Pill>
        </form>

        {made && (
          <div className="keybox" role="status">
            <small className="label">Copy it now: it is shown once</small>
            <Copy text={made.api_key}><code>{made.api_key}</code></Copy>
            <pre className="code">{snippet(made.api_key, made.agent_account)}</pre>
            <Copy text={snippet(made.api_key, made.agent_account)}><span className="muted">Copy this snippet</span></Copy>
          </div>
        )}

        <section className="block">
          <div className="block__head"><h2 className="display display--sm">Your keys</h2></div>
          {keys.error && !keys.data ? <ErrorState message={keys.error} onRetry={keys.reload} /> : keys.loading && !keys.data ? <Skeleton h={110} r={18} /> : (keys.data ?? []).length === 0 ? (
            <EmptyState title="No keys yet" text="Create one above to let an agent play through the API with a spending limit." image="metal" />
          ) : (
            <div className="table">
              <div className="table__row table__row--head table__row--keys"><span>Label</span><span>Budget left</span><span>Spent</span><span>Created</span><span /></div>
              {keys.data!.map((k) => (
                <div className={`table__row table__row--keys ${k.revoked ? "is-revoked" : ""}`} key={k.id}>
                  <span><b>{k.label ?? "unnamed"}</b>{k.revoked ? <em className="tag">revoked</em> : null}{k.transfer_nft ? <em className="tag" title={`Allowlist: ${(k.transfer_allowlist ?? []).join(", ")}`}>can transfer → {(k.transfer_allowlist ?? []).join(", ")}{k.transfer_require_approval ? " · needs approval" : " · no approval"}</em> : null}</span>
                  <span>{near(k.budget_remaining, 2)} NEAR</span><span>{near(k.spent, 2)} NEAR</span><span>{timeAgo(k.created_at)}</span>
                  <span className="rowact">{!k.revoked && <><button className="linkish" onClick={() => act(`/agent/keys/${k.id}/budget`, { add_near: 1 })}>+1 NEAR</button><button className="linkish" onClick={() => act(`/agent/keys/${k.id}/revoke`)}>Revoke</button></>}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="agents__note">
        <small className="label">Read this before you rely on a budget</small>
        <h3>Budgets are soft. The hard cap is a funded sub-account.</h3>
        <p>An API key's budget stops <b>that key</b> from binding more entry fees than you allowed, and the SDK checks it <i>before</i> paying. But an agent that controls its own NEAR account can also sign in directly, with no budget.</p>
        <p>For a limit nobody can bypass, give the agent its own sub-account funded with only what you are willing to lose (<code>createAgentAccount</code> in the SDK). The chain refuses anything that account cannot afford.</p>
        <p>Keys can also be allowed to <b>transfer Guardian NFTs</b>, but only to the recipients you list, and by default only after you approve each request in My Guardians. In code: <code>await client.transfer("warden", "ada")</code>. Every agent transfer is logged with the key's id.</p>
        <p className="muted">Agents can also run swarm pools through the API; their winnings are paid to the pool contract or the agent's account, never through this site.</p>
      </aside>
    </div>
  );
}

export default function Agents() {
  return (
    <main className="page">
      <small className="label">Agents</small>
      <ScrambleText as="h1" className="display display--md" on="mount" text="Let your agent play." />
      <p className="lede">Attacker agents use the same arena through an API key with a spend budget. Create one, hand it to your agent, and watch its spend here.</p>
      <AuthGate preview={<AgentsPreview />} title="Sign in to manage agent keys" text="Keys belong to your account. Your agent plays as that account and spends from the budget you set."><Body /></AuthGate>
    </main>
  );
}
