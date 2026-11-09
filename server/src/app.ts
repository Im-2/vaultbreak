import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyMessage } from "near-api-js/nep413";
import type { Config } from "./config.ts";
import { now, type DB } from "./db.ts";
import { provider, view } from "./chain.ts";
import { decrypt, sha256Hex } from "./crypto.ts";
import { GuardianRuntime, type GuardianRow, type SessionRow } from "./guardian.ts";
import { createGuardian } from "./guardians.ts";
import { syncGuardian } from "./indexer.ts";
import type { Llm } from "./llm.ts";

const AUTH_RECIPIENT = "vaultbreak";
const AUTH_MESSAGE = "Log in to Vaultbreak";

export interface AppDeps { db: DB; cfg: Config; llm: Llm; pkey: Buffer }

export function createApp({ db, cfg, llm, pkey }: AppDeps) {
  const app = new Hono();
  const runtime = new GuardianRuntime(db, cfg, llm, pkey);
  const p = provider(cfg.rpcUrl);
  const getG = (id: string) => db.prepare("SELECT * FROM guardians WHERE id=?").get(id) as any as GuardianRow & Record<string, any> | undefined;
  const getS = (id: string) => db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as any as SessionRow & Record<string, any> | undefined;

  const account = (c: any): string | null => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return null;
    const row = db.prepare("SELECT account_id, expires_at FROM auth_tokens WHERE token=?").get(m[1]) as any;
    return row && row.expires_at > now() ? row.account_id : null;
  };
  const isAdmin = (c: any) => !!cfg.adminToken && c.req.header("x-admin-token") === cfg.adminToken;

  async function publicGuardian(g: any, full = false) {
    let cached = g.state_json ? JSON.parse(g.state_json) : null;
    if (!cached) { await syncGuardian(db, cfg, g); cached = JSON.parse((getG(g.id) as any).state_json); }
    const { state, stats, params } = cached;
    return {
      id: g.id, name: g.name, vault_account: g.vault_account, owner: state.owner, status: state.status,
      pot: state.pot, min_fee: params.min_fee, turns_max: params.turns_max, session_ttl_ms: params.session_ttl_ms,
      stats, prompt_hash: g.prompt_hash, revealed: !!g.revealed, model: g.model, danger_mode: !!g.danger_mode,
      ...(full ? { attestation: `/guardians/${g.id}/attestation`, metadata: `/guardians/${g.id}/metadata.json`, guardian_public_key: state.guardian_pk } : {}),
    };
  }

  // ---- auth (NEP-413) ----
  app.post("/auth/nonce", (c) => {
    const nonce = randomBytes(32).toString("base64");
    db.prepare("INSERT INTO auth_nonces(nonce, expires_at) VALUES (?,?)").run(nonce, now() + 5 * 60_000);
    return c.json({ nonce, message: AUTH_MESSAGE, recipient: AUTH_RECIPIENT });
  });
  app.post("/auth/verify", async (c) => {
    const b = await c.req.json();
    const row = db.prepare("SELECT expires_at FROM auth_nonces WHERE nonce=?").get(b.nonce) as any;
    if (!row || row.expires_at < now()) return c.json({ error: "unknown or expired nonce" }, 400);
    db.prepare("DELETE FROM auth_nonces WHERE nonce=?").run(b.nonce); // single use
    try {
      await verifyMessage({
        signerAccountId: b.account_id, signerPublicKey: b.public_key,
        payload: { message: AUTH_MESSAGE, recipient: AUTH_RECIPIENT, nonce: Buffer.from(b.nonce, "base64") },
        signature: Buffer.from(b.signature, "base64"), provider: p,
      });
    } catch (e: any) { return c.json({ error: `signature check failed: ${e.message}` }, 401); }
    const token = randomBytes(24).toString("hex");
    db.prepare("INSERT INTO auth_tokens(token, account_id, expires_at) VALUES (?,?,?)").run(token, b.account_id, now() + 24 * 3600_000);
    return c.json({ token, account_id: b.account_id });
  });

  // ---- guardians ----
  app.get("/guardians", async (c) => {
    const gs = db.prepare("SELECT * FROM guardians ORDER BY created_at").all() as any[];
    return c.json(await Promise.all(gs.map((g) => publicGuardian(g))));
  });
  app.get("/guardians/:id", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    return c.json(await publicGuardian(g, true));
  });
  app.get("/guardians/:id/metadata.json", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    const pg = await publicGuardian(g);
    return c.json({
      title: `Guardian ${pg.name}`, description: "A Vaultbreak AI guardian holding a pot of NEAR.",
      extra: { status: pg.status, pot: pg.pot, attempts: pg.stats.attempts, wins: pg.stats.wins, streak: pg.stats.streak, vault_account: pg.vault_account },
    });
  });
  app.post("/guardians", async (c) => {
    if (!isAdmin(c)) return c.json({ error: "admin only in Layer 1 (house-signed guardians)" }, 403);
    const b = await c.req.json();
    const funderId = process.env.OPERATOR_ACCOUNT_ID;
    if (!funderId) return c.json({ error: "OPERATOR_ACCOUNT_ID not configured" }, 500);
    const wasm = readFileSync("contracts/vault/out/vault.wasm");
    const id = await createGuardian(db, cfg, pkey, { name: b.name, prompt: b.prompt, owner: b.owner, ops: b.ops ?? funderId, seedNear: b.seed_near, feeNear: b.fee_near, turns: b.turns, ttlMin: b.ttl_min, dangerMode: b.danger_mode, model: b.model, funderId, wasm });
    return c.json({ id });
  });
  app.post("/guardians/:id/reveal", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    const st: any = await view(p, g.vault_account, "get_state");
    if (st.status !== "Defeated" && !g.retired) return c.json({ error: "prompt can only be revealed once the guardian is Defeated or retired" }, 403);
    const prompt = decrypt(g.prompt_ciphertext, pkey);
    db.prepare("UPDATE guardians SET revealed=1 WHERE id=?").run(g.id);
    return c.json({ prompt, sha256: sha256Hex(prompt), onchain_prompt_hash: st.prompt_hash, matches: sha256Hex(prompt) === st.prompt_hash });
  });

  // ---- sessions ----
  app.post("/guardians/:id/sessions/verify", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    const { onchain_session_id } = await c.req.json();
    const s: any = await view(p, g.vault_account, "get_session", { session_id: String(onchain_session_id) });
    if (!s) return c.json({ error: "no such on-chain session" }, 404);
    if (s.attacker !== acct) return c.json({ error: "on-chain attacker is not you" }, 403);
    if (s.status !== "Open") return c.json({ error: `on-chain session is ${s.status}` }, 409);
    const existing = db.prepare("SELECT id FROM sessions WHERE guardian_id=? AND onchain_session_id=?").get(g.id, onchain_session_id) as any;
    if (existing) return c.json({ session_id: existing.id, turns_max: g.turns_max });
    const id = randomUUID();
    db.prepare("INSERT INTO sessions(id, guardian_id, onchain_session_id, attacker, status, started_at) VALUES (?,?,?,?, 'open', ?)").run(id, g.id, onchain_session_id, acct, now());
    return c.json({ session_id: id, turns_max: g.turns_max, expires_at: s.expires_at });
  });

  app.post("/sessions/:id/messages", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const s = getS(c.req.param("id")); if (!s) return c.json({ error: "not found" }, 404);
    if (s.attacker !== acct) return c.json({ error: "not your session" }, 403);
    const g = getG(s.guardian_id)!;
    const { text } = await c.req.json();
    if (typeof text !== "string" || !text.trim() || text.length > 2000) return c.json({ error: "text required (max 2000 chars)" }, 400);
    return streamSSE(c, async (stream) => {
      let chainP = Promise.resolve();
      const emit = (e: { event: string; data: unknown }) => { chainP = chainP.then(() => stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) })); };
      await runtime.runTurn(g, s, text, emit as any);
      await chainP;
    });
  });

  app.post("/sessions/:id/close", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const s = getS(c.req.param("id")); if (!s) return c.json({ error: "not found" }, 404);
    if (s.attacker !== acct) return c.json({ error: "not your session" }, 403);
    const events: any[] = [];
    await runtime.close(getG(s.guardian_id)!, s, (e) => events.push(e));
    return c.json({ status: getS(s.id)!.status, events });
  });

  app.get("/sessions/:id", (c) => {
    const s = getS(c.req.param("id")); if (!s) return c.json({ error: "not found" }, 404);
    const turns = db.prepare("SELECT idx, role, content, chat_id, created_at FROM turns WHERE session_id=? ORDER BY idx").all(s.id);
    const blocked = db.prepare("SELECT tool, args, chain_error, created_at FROM blocked_attempts WHERE session_id=?").all(s.id);
    return c.json({ session: s, turns, blocked_attempts: blocked });
  });

  app.get("/leaderboard", async (c) => {
    const gs = db.prepare("SELECT id, name, state_json FROM guardians").all() as any[];
    const guardians = gs.filter((g) => g.state_json).map((g) => { const j = JSON.parse(g.state_json); return { id: g.id, name: g.name, streak: j.stats.streak, attempts: j.stats.attempts, wins: j.stats.wins, status: j.state.status, pot: j.state.pot }; }).sort((a, b) => b.streak - a.streak);
    const attackers = db.prepare("SELECT attacker, COUNT(*) AS wins FROM sessions WHERE status='won' GROUP BY attacker ORDER BY wins DESC LIMIT 50").all();
    return c.json({ guardians, attackers });
  });

  app.get("/health", (c) => c.json({ ok: true }));
  return { app, runtime };
}
