import { Link } from "react-router-dom";
import { NFTCard } from "./NFTCard";
import { Skeleton } from "./States";
import { AcctLink } from "./TxLink";
import type { Guardian } from "../lib/api";
import { near, shortHash } from "../lib/format";
import { useConfig, useFetch } from "../lib/hooks";

/** Read-only examples shown above the sign-in prompt, so a visitor (or a screening agent) sees real content without an account. */

export function CreatePreview() {
  const gs = useFetch<Guardian[]>("/guardians", {});
  const cfg = useConfig();
  const g = (gs.data ?? []).find((x) => x.id === "warden") ?? (gs.data ?? [])[0];
  return (
    <section className="example" aria-label="Example Guardian">
      <small className="label">Example · what you would create</small>
      <div className="example__grid">
        <div className="example__card">{g ? <NFTCard g={g} size="lg" /> : <Skeleton h={420} r={24} />}</div>
        <div className="example__text">
          <h2 className="display display--sm">{g ? g.name : "A Guardian"}</h2>
          <p>This is a real Guardian from the arena. Creating one mints this: an NFT you own, plus a vault account with a pot of NEAR that only the Guardian's AI can release.</p>
          <ul className="steps">
            <li><b>1 · Write its secret instructions.</b> Only their hash goes on-chain now. The text is revealed after the Guardian falls, so players can check it never changed.</li>
            <li><b>2 · Seed a pot and set the entry fee.</b> Entry fees split 70% to the pot, 20% to you, 10% to operations. You can never take the pot out while the Guardian is armed.</li>
            <li><b>3 · Mint.</b> The vault gets one restricted key (it can call <code>release</code> and <code>close_session</code> only, never send money). Takes about 10 seconds.</li>
          </ul>
          {g && (
            <dl className="facts">
              <div><dt>Pot</dt><dd>{near(g.pot, 2)} NEAR</dd></div>
              <div><dt>Entry fee</dt><dd>{near(g.min_fee, 2)} NEAR</dd></div>
              <div><dt>Turns per attempt</dt><dd>{g.turns_max}</dd></div>
              <div><dt>Sealed prompt hash</dt><dd><code>{shortHash(g.prompt_hash, 8, 6)}</code></dd></div>
              <div><dt>Vault account</dt><dd><AcctLink id={g.vault_account} cfg={cfg.data} /></dd></div>
              {g.nft && <div><dt>NFT</dt><dd><AcctLink id={g.nft.registry} cfg={cfg.data} nft={g.nft.token_id} label={`#${g.nft.token_id}`} /></dd></div>}
            </dl>
          )}
          <p><Link className="linkish" to={g ? `/guardian/${g.id}` : "/arena"}>Open this Guardian</Link> to see it live.</p>
        </div>
      </div>
    </section>
  );
}

interface PoolRow { id: string; guardian_id: string; status: string; total_contributed: string; fees_spent: string; winnings: string; contributors: number }
interface Contribs { rows: { account: string; amount: string; display: string | null }[] }

export function SwarmsPreview() {
  const pools = useFetch<PoolRow[]>("/pools", { interval: 8000 });
  const gs = useFetch<Guardian[]>("/guardians", {});
  const list = (pools.data ?? []).slice().sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 6);
  const first = list[0];
  const contribs = useFetch<Contribs>(first ? `/pools/${first.id}/contributions` : null, {});
  const name = (id: string) => (gs.data ?? []).find((g) => g.id === id)?.name ?? id;
  const rows = first ? contribs.data?.rows ?? [] : [];
  const total = first ? BigInt(first.total_contributed) : 0n;
  return (
    <section className="example" aria-label="Existing pools">
      <small className="label">Read-only · pools on this network</small>
      <div className="example__grid example__grid--pools">
        <div className="example__text">
          <h2 className="display display--sm">How a swarm works</h2>
          <ul className="steps">
            <li><b>1 · Someone opens a pool</b> aimed at one Guardian. They become its controller.</li>
            <li><b>2 · Others contribute NEAR.</b> Contributions close at the first attack.</li>
            <li><b>3 · The controller attacks</b> with the shared money. The pool is a contract: it pays the entry fee from the pot of contributions.</li>
            <li><b>4 · If the Guardian releases,</b> the winnings are split pro rata by contribution. If not, unspent money is refunded pro rata.</li>
          </ul>
        </div>
        <div className="example__text">
          <h2 className="display display--sm">Pools right now</h2>
          {pools.loading && !pools.data ? <Skeleton h={120} r={18} /> : list.length === 0 ? <p className="muted">No pools yet. Sign in below and open the first one.</p> : (
            <ul className="plist">
              {list.map((p) => (
                <li key={p.id}><div className="plist__item">
                  <b>#{p.id} · {name(p.guardian_id)}</b>
                  <span>{p.status}</span>
                  <span>{near(p.total_contributed, 2)} NEAR · {p.contributors} {p.contributors === 1 ? "member" : "members"}{BigInt(p.winnings) > 0n ? ` · won ${near(p.winnings, 2)}` : ""}</span>
                </div></li>
              ))}
            </ul>
          )}
          {first && rows.length > 0 && (
            <div className="bars" aria-label={`Contributions to pool ${first.id}`}>
              {rows.map((r) => { const pct = total > 0n ? Number((BigInt(r.amount) * 10000n) / total) / 100 : 0; return (
                <div className="bar" key={r.account}><div className="bar__top"><b>{r.display ?? shortHash(r.account, 8, 6)}</b><span>{near(r.amount, 2)} NEAR · {pct.toFixed(1)}%</span></div><div className="bar__track"><i style={{ width: `${pct}%` }} /></div></div>
              ); })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function AgentsPreview() {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <section className="example" aria-label="How an agent key works">
      <small className="label">Example · how an agent uses a key</small>
      <div className="example__grid example__grid--pools">
        <div className="example__text">
          <h2 className="display display--sm">An agent plays with a spending limit</h2>
          <ul className="steps">
            <li><b>1 · You create a key</b> with a budget in NEAR. The key is shown once; it looks like <code>vbk_…</code>.</li>
            <li><b>2 · The agent sends it</b> as <code>X-API-Key</code>. Each entry fee bound to an API session is charged against the budget, and the SDK refuses <i>before</i> paying when the budget is gone.</li>
            <li><b>3 · You watch the spend</b> here, add budget (+1 NEAR) or revoke the key.</li>
          </ul>
          <p className="muted">Budgets are soft: the hard cap is a funded sub-account. The panel below explains why.</p>
        </div>
        <pre className="code" aria-label="Example agent code">{`import { VaultbreakClient } from "./sdk/src/index.ts";

const client = new VaultbreakClient("${origin}/api", agentAccount, fetch, { apiKey: "vbk_…shown-once…" });

// charged against the key's budget; throws before paying if it is exhausted
const { sessionId } = await client.startSession("warden", "<vault account>", entryFeeYocto);
const events = await client.send(sessionId, "hello");   // streamed reply, tool calls, blocked calls

// the same API serves the public data an agent needs
//   GET ${origin}/api/guardians     GET ${origin}/api/leaderboard     GET ${origin}/api/pools`}</pre>
      </div>
    </section>
  );
}
