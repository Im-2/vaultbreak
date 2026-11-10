import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import type { Config } from "./config.ts";
import { now, type DB } from "./db.ts";
import { accountFrom, isTransportError, listKeys, NEAR, provider, retryTransport, view } from "./chain.ts";
import { decrypt, sha256Hex } from "./crypto.ts";
import { GuardianRuntime, type GuardianRow, type SessionRow } from "./guardian.ts";
import { createGuardian, registerGuardian } from "./guardians.ts";
import { syncGuardian } from "./indexer.ts";
import { formatResults, verifySession } from "./privacy/verify.ts";
import type { Llm } from "./llm.ts";
import { fetchAttestation, newNonce, verifyAttestation, type QuoteVerifier } from "./privacy/attestation.ts";

const AUTH_RECIPIENT = "vaultbreak";
const AUTH_MESSAGE = "Log in to Vaultbreak";

/** Operator account that creates + funds custodial player accounts (zero-wallet play). */
export interface CustodialCfg { funderId: string; funderSecret: string; fundNear: number }
export interface UiInfo { network?: string; explorer?: string; demo?: boolean }

export function createApp({ db, cfg, llm, pkey, verifyQuote, custodial, ui }: AppDeps & { custodial?: CustodialCfg; ui?: UiInfo }) {
  const app = new Hono();
  // CORS: only the public website origin and local development. (The website normally reaches us through its own /api rewrite.)
  const corsOk = (o: string | undefined) => !!o && (o === cfg.publicBaseUrl || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o));
  app.use("*", cors({ origin: (o) => (corsOk(o) ? o : ""), allowHeaders: ["content-type", "authorization", "x-api-key", "x-admin-token"], allowMethods: ["GET", "POST", "OPTIONS"] }));
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "request too large" }, 413) }));

  // Per-IP rate limits (client IP from the proxy chain: Vercel -> tunnel -> here). Direct local requests carry no proxy headers and are exempt.
  const hitsMap = new Map<string, number[]>();
  const clientIp = (c: any): string | null => (c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || c.req.header("cf-connecting-ip") || null);
  const allow = (key: string, n: number, windowMs: number): boolean => {
    const t = Date.now(); const arr = (hitsMap.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length >= n) { hitsMap.set(key, arr); return false; }
    arr.push(t); hitsMap.set(key, arr); return true;
  };
  setInterval(() => { const t = Date.now(); for (const [k, v] of hitsMap) if (!v.length || t - v[v.length - 1] > 86_400_000) hitsMap.delete(k); }, 600_000).unref?.();
  const RULES: { re: RegExp; key: string; n: number; ms: number }[] = [
    { re: /^\/sessions\/[^/]+\/messages$/, key: "chat", n: cfg.limits.chatPerMinute, ms: 60_000 },
    { re: /^\/sessions\/[^/]+\/messages$/, key: "chatday", n: cfg.limits.chatPerDay, ms: 86_400_000 },
    { re: /^\/custodial\/signin$/, key: "signin", n: cfg.limits.signinPerHour, ms: 3_600_000 },
    { re: /^\/guardians\/[^/]+\/play$/, key: "play", n: 40, ms: 3_600_000 },
    { re: /^\/me\/guardians$/, key: "mint", n: 10, ms: 86_400_000 },
    { re: /^\/me\/pools/, key: "pool", n: 60, ms: 3_600_000 },
    { re: /^\/custodial\/topup$/, key: "topup", n: 10, ms: 3_600_000 },
  ];
  app.use("*", async (c, next) => {
    const ip = clientIp(c);
    c.set("ip" as any, ip);
    if (!ip || cfg.limits.disabled) return next();
    if (!allow(`all:${ip}`, cfg.limits.perMinute, 60_000)) return c.json({ error: "too many requests, slow down" }, 429);
    if (c.req.method === "POST") {
      const path = new URL(c.req.url).pathname;
      for (const r of RULES) if (r.re.test(path) && !allow(`${r.key}:${ip}`, r.n, r.ms)) return c.json({ error: "rate limit reached for this action. Try again later." }, 429);
    }
    return next();
  });
  // ---- protect the free model quota: a daily cap on model calls, persisted so a restart cannot reset it
  const today = () => new Date().toISOString().slice(0, 10);
  const modelCallsToday = () => ((db.prepare("SELECT model_calls AS n FROM usage WHERE day=?").get(today()) as any)?.n ?? 0) as number;
  const cappedLlm: Llm = cfg.llm.provider === "mock" ? llm : {
    complete: async (req) => {
      if (modelCallsToday() >= cfg.limits.modelDailyCap) throw new Error("The demo's daily AI budget is used up. It resets tomorrow (UTC). You can also run Vaultbreak locally with your own model key.");
      db.prepare("INSERT INTO usage(day, model_calls) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET model_calls = model_calls + 1").run(today());
      return llm.complete(req);
    },
  };
  const runtime = new GuardianRuntime(db, cfg, cappedLlm, pkey);
  const p = provider(cfg.rpcUrl);
  const getG = (id: string) => db.prepare("SELECT * FROM guardians WHERE id=?").get(id) as any as GuardianRow & Record<string, any> | undefined;
  const getS = (id: string) => db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as any as SessionRow & Record<string, any> | undefined;

  /** The API key row for this request, or null (also null for an unknown/revoked key: a bad key never falls back to Bearer). */
  const keyRow = (c: any): any | null => {
    const k = c.req.header("x-api-key"); if (!k) return null;
    return (db.prepare("SELECT * FROM api_keys WHERE hash=? AND revoked=0").get(sha256Hex(k)) as any) ?? null;
  };
  const account = (c: any): string | null => {
    if (c.req.header("x-api-key")) return keyRow(c)?.agent_account ?? null;
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return null;
    const row = db.prepare("SELECT account_id, expires_at FROM auth_tokens WHERE token=?").get(m[1]) as any;
    return row && row.expires_at > now() ? row.account_id : null;
  };
  /** Charges an API key's budget for a session fee. Returns an error Response if the budget is exhausted, else null. */
  const chargeBudget = (c: any, feeYocto: string) => {
    const key = keyRow(c); if (!key) return null; // direct NEP-413 login: no API-level budget
    const fee = BigInt(feeYocto), left = BigInt(key.budget_remaining);
    if (left < fee) return c.json({ error: "agent budget exhausted", budget_remaining: left.toString(), fee: fee.toString() }, 402);
    db.prepare("UPDATE api_keys SET budget_remaining=?, spent=? WHERE id=?").run((left - fee).toString(), (BigInt(key.spent) + fee).toString(), key.id);
    return null;
  };
  const isAdmin = (c: any) => !!cfg.adminToken && c.req.header("x-admin-token") === cfg.adminToken;

  /** Reads the vault straight from chain (so NFT metadata is always live); falls back to the indexer's cache if RPC fails. */
  async function liveOrCached(g: any): Promise<{ state: any; stats: any; params: any }> {
    try {
      const [state, stats, params] = await Promise.all([view(p, g.vault_account, "get_state"), view(p, g.vault_account, "get_stats"), view(p, g.vault_account, "get_params")]) as any[];
      return { state, stats, params };
    } catch (e) {
      let cached = g.state_json ? JSON.parse(g.state_json) : null;
      if (!cached) { await syncGuardian(db, cfg, g); cached = JSON.parse((getG(g.id) as any).state_json); }
      return cached;
    }
  }

  async function publicGuardian(g: any, full = false) {
    const { state, stats, params } = await liveOrCached(g);
    return {
      id: g.id, name: g.name, vault_account: g.vault_account, owner: state.owner, status: state.status, created_at: g.created_at,
      art: state.status === "Defeated" ? "defeated" : stats.streak >= 5 ? "veteran" : "armed",
      pot: state.pot, min_fee: params.min_fee, turns_max: params.turns_max, session_ttl_ms: params.session_ttl_ms,
      stats, prompt_hash: g.prompt_hash, revealed: !!g.revealed, model: g.model, danger_mode: !!g.danger_mode,
      ...(g.registry ? { nft: { registry: g.registry, token_id: g.id, owner: state.owner } } : {}),
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
      // verifyMessage reads the account's keys from RPC: retry network blips, and never report them as a bad signature
      await retryTransport(() => verifyMessage({
        signerAccountId: b.account_id, signerPublicKey: b.public_key,
        payload: { message: AUTH_MESSAGE, recipient: AUTH_RECIPIENT, nonce: Buffer.from(b.nonce, "base64") },
        signature: Buffer.from(b.signature, "base64"), provider: p,
      }));
    } catch (e: any) {
      if (isTransportError(e)) { db.prepare("INSERT OR IGNORE INTO auth_nonces(nonce, expires_at) VALUES (?,?)").run(b.nonce, now() + 5 * 60_000); return c.json({ error: "NEAR RPC unreachable, retry" }, 503); }
      return c.json({ error: `signature check failed: ${e.message}` }, 401);
    }
    const token = randomBytes(24).toString("hex");
    db.prepare("INSERT INTO auth_tokens(token, account_id, expires_at) VALUES (?,?,?)").run(token, b.account_id, now() + 24 * 3600_000);
    return c.json({ token, account_id: b.account_id });
  });

  // ---- guardians ----
  app.get("/guardians", async (c) => {
    const gs = db.prepare("SELECT * FROM guardians WHERE pending=0 ORDER BY created_at").all() as any[];
    return c.json(await Promise.all(gs.map((g) => publicGuardian(g))));
  });
  app.get("/guardians/:id", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    return c.json(await publicGuardian(g, true));
  });
  app.get("/guardians/:id/metadata.json", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    if (g.pending) return c.json({ error: "not found" }, 404);
    const pg = await publicGuardian(g); // read from chain on every request: always live
    const potNear = Number(BigInt(pg.pot) / 10n ** 20n) / 1e4;
    return c.json({
      title: `Guardian ${pg.name}`,
      image: `${cfg.publicBaseUrl}/assets/emblem-${pg.art}.webp`, external_url: `${cfg.publicBaseUrl}/guardian/${pg.id}`,
      description: `A Vaultbreak AI guardian. Status ${pg.status}, pot ${potNear} NEAR, ${pg.stats.attempts} attempts, ${pg.stats.wins} wins, streak ${pg.stats.streak}.`,
      attributes: [
        { trait_type: "status", value: pg.status }, { trait_type: "pot_near", value: potNear },
        { trait_type: "attempts", value: pg.stats.attempts }, { trait_type: "wins", value: pg.stats.wins },
        { trait_type: "survival_streak", value: pg.stats.streak }, { trait_type: "blocked_reported", value: pg.stats.blocked_reported },
      ],
      extra: { status: pg.status, pot: pg.pot, attempts: pg.stats.attempts, wins: pg.stats.wins, streak: pg.stats.streak, blocked_reported: pg.stats.blocked_reported, total_fees: pg.stats.total_fees, vault_account: pg.vault_account, owner: pg.owner, nft: (pg as any).nft ?? null, prompt_hash: pg.prompt_hash, revealed: pg.revealed },
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
  // ---- Layer 3: creator-signed NFT mint ----
  // 1) prepare: the server makes the guardian key and stores the sealed prompt, and returns an UNSIGNED mint transaction.
  // 2) the creator signs + sends it (registry.mint_guardian creates the NFT-account vault).  3) confirm: the server checks chain.
  app.post("/guardians/prepare", async (c) => {
    const creator = account(c); if (!creator) return c.json({ error: "login required" }, 401);
    if (!cfg.registry) return c.json({ error: "REGISTRY_ACCOUNT_ID is not configured" }, 500);
    const b = await c.req.json();
    const id = String(b.guardian_id ?? "");
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) return c.json({ error: "guardian_id must be 1-32 chars of [a-z0-9_-]" }, 400);
    if (typeof b.prompt !== "string" || b.prompt.length < 10 || b.prompt.length > 20000) return c.json({ error: "prompt required (10-20000 chars)" }, 400);
    const royalty = Number(b.royalty_bps ?? 500);
    if (!Number.isInteger(royalty) || royalty < 0 || royalty > 2000) return c.json({ error: "royalty_bps must be an integer 0-2000" }, 400);
    const existing = getG(id);
    if (existing && !(existing.pending && existing.owner === creator)) return c.json({ error: "guardian_id already taken" }, 409);
    const vault = `${id}.${cfg.registry}`;
    const kp = KeyPair.fromRandom("ed25519");
    const keyRef = `guardian-${vault}`;
    mkdirSync(cfg.keysDir, { recursive: true });
    writeFileSync(`${cfg.keysDir}/${keyRef}.json`, JSON.stringify({ vault, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
    const near = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
    const promptHash = sha256Hex(b.prompt);
    const params = { min_fee: near(Number(b.fee_near ?? 0.1)).toString(), turns_max: Number(b.turns ?? 8), session_ttl_ms: String(Number(b.ttl_min ?? 10) * 60_000), max_open_per_attacker: 1 };
    const required = BigInt((await view(p, cfg.registry, "mint_requirements", {})) as string);
    const deposit = required - near(0.5) + near(Number(b.seed_near ?? 2)); // mint_requirements already includes the 0.5 NEAR minimum pot
    registerGuardian(db, pkey, { vault_account: vault, owner: creator, ops: b.ops_account ?? creator, prompt: b.prompt, prompt_hash: promptHash, key_ref: keyRef, name: b.name ?? id, model: b.model ?? cfg.llm.model, danger_mode: b.danger_mode, turns_max: params.turns_max, registry: cfg.registry, pending: true });
    return c.json({
      guardian_id: id, vault_account: vault, prompt_hash: promptHash, guardian_public_key: kp.getPublicKey().toString(),
      mint_transaction: {
        signerId: creator, receiverId: cfg.registry,
        actions: [{ type: "FunctionCall", params: { methodName: "mint_guardian", gas: "300000000000000", deposit: deposit.toString(),
          args: { args: { guardian_id: id, ops_account: b.ops_account ?? creator, guardian_pk: kp.getPublicKey().toString(), prompt_hash: promptHash, params, royalty_bps: royalty, allowance: null } } } }],
      },
      next: `sign and send mint_transaction, then POST /guardians/${id}/confirm`,
    });
  });

  app.post("/guardians/:id/confirm", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const g = getG(c.req.param("id")); if (!g || !g.registry) return c.json({ error: "not found" }, 404);
    if (g.owner !== acct) return c.json({ error: "only the creator who prepared this guardian can confirm it" }, 403);
    if (!g.pending) return c.json(await publicGuardian(g, true));
    const tok: any = await view(p, g.registry, "nft_token", { token_id: g.id });
    if (!tok) return c.json({ error: "NFT not minted yet: send the mint transaction first" }, 409);
    const st: any = await view(p, g.vault_account, "get_state");
    const keys = await listKeys(p, g.vault_account);
    const myKey = JSON.parse(readFileSync(`${cfg.keysDir}/${g.key_ref}.json`, "utf8")).public_key;
    const problems: string[] = [];
    if (st.registry !== g.registry) problems.push("vault is not bound to the registry");
    if (st.prompt_hash !== g.prompt_hash) problems.push("on-chain prompt_hash differs from the prepared prompt");
    if (keys.length !== 1 || keys[0].kind !== "FunctionCall" || keys[0].publicKey !== myKey) problems.push("vault keys are not exactly the prepared guardian function-call key");
    if (problems.length) return c.json({ error: "mint does not match what was prepared", problems }, 409);
    db.prepare("UPDATE guardians SET pending=0 WHERE id=?").run(g.id);
    return c.json(await publicGuardian(getG(g.id), true));
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
    const g = getG(c.req.param("id")); if (!g || g.pending) return c.json({ error: "not found" }, 404);
    const { onchain_session_id } = await c.req.json();
    const s: any = await view(p, g.vault_account, "get_session", { session_id: String(onchain_session_id) });
    if (!s) return c.json({ error: "no such on-chain session" }, 404);
    if (s.attacker !== acct) return c.json({ error: "on-chain attacker is not you" }, 403);
    if (s.status !== "Open") return c.json({ error: `on-chain session is ${s.status}` }, 409);
    const existing = db.prepare("SELECT id FROM sessions WHERE guardian_id=? AND onchain_session_id=?").get(g.id, onchain_session_id) as any;
    if (existing) return c.json({ session_id: existing.id, turns_max: g.turns_max });
    const over = chargeBudget(c, s.fee); if (over) return over;
    const id = randomUUID();
    db.prepare("INSERT INTO sessions(id, guardian_id, onchain_session_id, attacker, status, started_at, controller) VALUES (?,?,?,?, 'open', ?, ?)").run(id, g.id, onchain_session_id, acct, now(), acct);
    return c.json({ session_id: id, turns_max: g.turns_max, expires_at: s.expires_at });
  });

  app.post("/sessions/:id/messages", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const s = getS(c.req.param("id")); if (!s) return c.json({ error: "not found" }, 404);
    if ((s.controller ?? s.attacker) !== acct) return c.json({ error: "not your session" }, 403);
    const g = getG(s.guardian_id)!;
    const { text } = await c.req.json();
    if (typeof text !== "string" || !text.trim() || text.length > cfg.limits.messageMaxChars) return c.json({ error: `text required (max ${cfg.limits.messageMaxChars} chars)` }, 400);
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
    if ((s.controller ?? s.attacker) !== acct) return c.json({ error: "not your session" }, 403);
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
    const attackers = (db.prepare("SELECT s.controller AS attacker, COUNT(*) AS wins, c.display_name AS display FROM sessions s LEFT JOIN custodial c ON c.account_id = s.controller WHERE s.status='won' GROUP BY s.controller ORDER BY wins DESC LIMIT 50").all() as any[]).map((r) => ({ attacker: r.attacker ?? "unknown", wins: r.wins, display: r.display ?? null }));
    return c.json({ guardians, attackers });
  });

  // ---- Layer 2: privacy / verification ----
  app.post("/guardians/:id/retire", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    if (!isAdmin(c)) {
      const acct = account(c); if (!acct) return c.json({ error: "login required (owner) or admin token" }, 401);
      const st: any = await view(p, g.vault_account, "get_state");
      if (st.owner !== acct) return c.json({ error: "only the current owner (NFT holder) can retire this guardian" }, 403);
    }
    db.prepare("UPDATE guardians SET retired=1 WHERE id=?").run(g.id);
    return c.json({ id: g.id, retired: true });
  });

  // Fresh attestation of the model that serves this guardian. ?model= overrides (any NEAR AI Cloud model id).
  // Needs no API key / credits: the attestation endpoint is public.
  app.get("/guardians/:id/attestation", async (c) => {
    const g = getG(c.req.param("id")); if (!g) return c.json({ error: "not found" }, 404);
    const model = c.req.query("model") ?? g.model;
    if (!c.req.query("model") && cfg.llm.provider !== "nearai") {
      return c.json({ available: false, model, reason: `this guardian's model runs on provider "${cfg.llm.provider}", which has no TEE attestation. Set MODEL_PROVIDER=nearai, or pass ?model=<a NEAR AI Cloud model id> to attest that model.` }, 409);
    }
    const nonce = c.req.query("nonce") ?? newNonce();
    if (!/^[0-9a-f]{64}$/i.test(nonce)) return c.json({ error: "nonce must be 32 bytes of hex" }, 400);
    try {
      const report = await fetchAttestation(cfg.nearai.baseUrl, model, nonce);
      const verification = await verifyAttestation(report, { nonce, model, verifyQuote });
      db.prepare("INSERT INTO attestations(guardian_id, model, nonce, report_json, fetched_at) VALUES (?,?,?,?,?)").run(g.id, model, nonce, JSON.stringify(report), now());
      return c.json({ available: true, model, nonce, verification, report });
    } catch (e: any) { return c.json({ available: false, model, error: String(e?.message ?? e) }, 502); }
  });

  // Everything a third party needs to re-verify a session (see docs/attestation.md and scripts/verify-session.ts).
  app.get("/proofs/:session_id", (c) => {
    const s = getS(c.req.param("session_id")); if (!s) return c.json({ error: "not found" }, 404);
    const g = getG(s.guardian_id)!;
    const revealed = !!g.revealed;
    const turns = db.prepare("SELECT idx, role, content, chat_id, created_at FROM turns WHERE session_id=? ORDER BY idx").all(s.id);
    const exchanges = (db.prepare("SELECT * FROM exchanges WHERE session_id=? ORDER BY id").all(s.id) as any[]).map((e) => ({
      idx: e.idx, chat_id: e.chat_id, model: e.model, request_hash: e.request_hash, response_hash: e.response_hash, response_body: e.response_body,
      signed_text: e.signed_text, signature: e.signature, signing_address: e.signing_address, signing_algo: e.signing_algo, signature_error: e.signature_error,
      // the request contains the sealed system prompt: only released once the guardian is revealed
      ...(revealed ? { request_body: decrypt(e.request_ciphertext, pkey) } : {}),
    }));
    return c.json({
      session: { id: s.id, status: s.status, onchain_session_id: s.onchain_session_id, attacker: s.attacker, transcript_hash: s.transcript_hash, tx_release: s.tx_release, tx_close: s.tx_close },
      guardian: { id: g.id, vault_account: g.vault_account, model: g.model, prompt_hash: g.prompt_hash, retired: !!g.retired },
      revealed, ...(revealed ? { prompt: decrypt(g.prompt_ciphertext, pkey) } : {}),
      turns, exchanges, transcript_hash_recomputed: runtime.transcriptHash(s.id),
    });
  });

  // ================= Layer 4: agents + swarms =================
  const near = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
  const unsigned = (signer: string, receiver: string, methodName: string, args: unknown, deposit = "0", gas = "150000000000000") =>
    ({ signerId: signer, receiverId: receiver, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] });

  // API keys with spend budgets. The key authenticates as the agent's NEAR account; its budget caps the entry fees that
  // can be bound to API sessions through it. (Direct NEP-413 login has no budget: for a HARD cap, fund the agent's own
  // sub-account with only the budget: see sdk createAgentAccount.)
  app.post("/agent/keys", async (c) => {
    if (c.req.header("x-api-key")) return c.json({ error: "create keys with a NEP-413 login, not with another key" }, 403);
    const owner = account(c); if (!owner) return c.json({ error: "login required" }, 401);
    const b = await c.req.json();
    const agent = String(b.agent_account ?? owner);
    if (agent !== owner && !agent.endsWith(`.${owner}`)) return c.json({ error: "agent_account must be your own account or one of its sub-accounts" }, 403);
    const budget = Number(b.budget_near);
    if (!(budget > 0) || budget > 1_000_000) return c.json({ error: "budget_near must be > 0" }, 400);
    const secret = `vbk_${randomBytes(24).toString("hex")}`;
    const id = randomUUID();
    db.prepare("INSERT INTO api_keys(id, owner, hash, budget_remaining, created_at, agent_account, label) VALUES (?,?,?,?,?,?,?)").run(id, owner, sha256Hex(secret), near(budget).toString(), now(), agent, b.label ?? null);
    return c.json({ id, api_key: secret, agent_account: agent, budget_remaining: near(budget).toString(), note: "the key is shown once" });
  });
  app.get("/agent/keys", (c) => {
    const owner = account(c); if (!owner || c.req.header("x-api-key")) return c.json({ error: "login required" }, 401);
    return c.json(db.prepare("SELECT id, agent_account, label, budget_remaining, spent, revoked, created_at FROM api_keys WHERE owner=? ORDER BY created_at").all(owner));
  });
  app.post("/agent/keys/:id/revoke", (c) => {
    const owner = account(c); if (!owner || c.req.header("x-api-key")) return c.json({ error: "login required" }, 401);
    const r = db.prepare("UPDATE api_keys SET revoked=1 WHERE id=? AND owner=?").run(c.req.param("id"), owner);
    return r.changes ? c.json({ revoked: true }) : c.json({ error: "not found" }, 404);
  });
  app.post("/agent/keys/:id/budget", async (c) => {
    const owner = account(c); if (!owner || c.req.header("x-api-key")) return c.json({ error: "login required" }, 401);
    const add = Number((await c.req.json()).add_near);
    if (!(add > 0)) return c.json({ error: "add_near must be > 0" }, 400);
    const row = db.prepare("SELECT budget_remaining FROM api_keys WHERE id=? AND owner=?").get(c.req.param("id"), owner) as any;
    if (!row) return c.json({ error: "not found" }, 404);
    db.prepare("UPDATE api_keys SET budget_remaining=? WHERE id=?").run((BigInt(row.budget_remaining) + near(add)).toString(), c.req.param("id"));
    return c.json({ budget_remaining: (BigInt(row.budget_remaining) + near(add)).toString() });
  });
  app.get("/agent/me", (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login or API key required" }, 401);
    const key = keyRow(c);
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM sessions WHERE controller=? GROUP BY status").all(acct) as any[];
    const n = (st: string) => rows.find((r) => r.status === st)?.n ?? 0;
    return c.json({ account: acct, key: key ? { id: key.id, label: key.label, budget_remaining: key.budget_remaining, spent: key.spent } : null,
      sessions: rows.reduce((a, r) => a + r.n, 0), wins: n("won"), failed: n("failed"), open: n("open") });
  });

  // ---- swarm pools (the contract is the source of truth; these endpoints read it and build UNSIGNED transactions)
  const poolId = (c: any) => String(c.req.param("id"));
  const needPool = (c: any) => (cfg.pool ? null : c.json({ error: "POOL_ACCOUNT_ID is not configured" }, 500));
  app.get("/pools", async (c) => {
    const e = needPool(c); if (e) return e;
    const all: any[] = (await view(p, cfg.pool!, "list_pools", {})) as any[];
    const gid = c.req.query("guardian");
    return c.json(gid ? all.filter((x) => x.guardian_id === gid) : all);
  });
  app.get("/pools/:id", async (c) => {
    const e = needPool(c); if (e) return e;
    const pv: any = await view(p, cfg.pool!, "get_pool", { pool_id: poolId(c) });
    return pv ? c.json(pv) : c.json({ error: "not found" }, 404);
  });
  app.post("/pools", async (c) => {
    const e = needPool(c); if (e) return e;
    const who = account(c); if (!who) return c.json({ error: "login or API key required" }, 401);
    const b = await c.req.json();
    const g = getG(String(b.guardian_id ?? "")); if (!g || g.pending) return c.json({ error: "unknown guardian" }, 404);
    if (g.vault_account !== `${g.id}.${cfg.registry}`) return c.json({ error: "pools only work with registry-minted (NFT) guardians" }, 409);
    return c.json({ mint: false, transaction: unsigned(who, cfg.pool!, "create_pool", { guardian_id: g.id, target_fee_budget: near(Number(b.target_fee_near ?? 1)).toString(), controller: b.controller ?? null, deadline_ms: String(Math.round(Number(b.deadline_min ?? 60) * 60_000)) }) });
  });
  app.post("/pools/:id/contribute", async (c) => {
    const e = needPool(c); if (e) return e;
    const who = account(c); if (!who) return c.json({ error: "login or API key required" }, 401);
    const amount = Number((await c.req.json()).amount_near);
    if (!(amount > 0)) return c.json({ error: "amount_near must be > 0" }, 400);
    return c.json({ transaction: unsigned(who, cfg.pool!, "contribute", { pool_id: poolId(c) }, near(amount).toString()) });
  });
  app.post("/pools/:id/attack", async (c) => {
    const e = needPool(c); if (e) return e;
    const who = account(c); if (!who) return c.json({ error: "login or API key required" }, 401);
    const pv: any = await view(p, cfg.pool!, "get_pool", { pool_id: poolId(c) }); if (!pv) return c.json({ error: "not found" }, 404);
    if (pv.controller !== who) return c.json({ error: "only the pool controller can attack" }, 403);
    const g = getG(pv.guardian_id)!;
    const params: any = (await liveOrCached(g)).params;
    const fee = (await c.req.json().catch(() => ({}))).fee_near != null ? near(Number((await c.req.json().catch(() => ({}))).fee_near)) : BigInt(params.min_fee);
    return c.json({ fee: fee.toString(), transaction: unsigned(who, cfg.pool!, "attack_with_pool", { pool_id: poolId(c), fee: fee.toString() }) });
  });
  // Bind the pool's on-chain session (attacker = the pool contract) to an API session controlled by the pool controller.
  app.post("/pools/:id/sessions/verify", async (c) => {
    const e = needPool(c); if (e) return e;
    const who = account(c); if (!who) return c.json({ error: "login or API key required" }, 401);
    const pv: any = await view(p, cfg.pool!, "get_pool", { pool_id: poolId(c) }); if (!pv) return c.json({ error: "not found" }, 404);
    if (pv.controller !== who) return c.json({ error: "only the pool controller can drive pool sessions" }, 403);
    const { onchain_session_id } = await c.req.json();
    if (pv.open_session !== String(onchain_session_id)) return c.json({ error: "that is not the pool's open session" }, 409);
    const g = getG(pv.guardian_id); if (!g || g.pending) return c.json({ error: "unknown guardian" }, 404);
    const s: any = await view(p, g.vault_account, "get_session", { session_id: String(onchain_session_id) });
    if (!s || s.attacker !== cfg.pool || s.status !== "Open") return c.json({ error: "vault session is not an open pool session" }, 409);
    const existing = db.prepare("SELECT id FROM sessions WHERE guardian_id=? AND onchain_session_id=?").get(g.id, onchain_session_id) as any;
    if (existing) return c.json({ session_id: existing.id, turns_max: g.turns_max });
    const over = chargeBudget(c, s.fee); if (over) return over;
    const id = randomUUID();
    db.prepare("INSERT INTO sessions(id, guardian_id, onchain_session_id, attacker, status, started_at, controller) VALUES (?,?,?,?, 'open', ?, ?)").run(id, g.id, onchain_session_id, cfg.pool, now(), who);
    return c.json({ session_id: id, turns_max: g.turns_max, expires_at: s.expires_at, pool: poolId(c) });
  });

  // ================= web UI support =================
  const netLabel = ui?.network ?? (/127\.0\.0\.1|localhost/.test(cfg.rpcUrl) ? "local sandbox" : /testnet/.test(cfg.rpcUrl + (cfg.registry ?? "")) ? "testnet" : "custom");
  const explorer = ui?.explorer ?? (netLabel === "testnet" ? "https://testnet.nearblocks.io" : "");
  const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

  app.get("/config", (c) => c.json({
    network: netLabel, explorer, demo: !!ui?.demo, provider: cfg.llm.provider, model: cfg.llm.model,
    registry: cfg.registry ?? null, pool: cfg.pool ?? null, custodial: !!custodial,
    attestation: cfg.llm.provider === "nearai" ? "near-ai-tee" : "none",
    model_calls_today: cfg.llm.provider === "mock" ? null : modelCallsToday(), model_daily_cap: cfg.llm.provider === "mock" ? null : cfg.limits.modelDailyCap, public_base_url: cfg.publicBaseUrl,
  }));

  // Live aggregates (guardian state read from chain; counters from the API database).
  app.get("/stats", async (c) => {
    const gs = db.prepare("SELECT * FROM guardians WHERE pending=0").all() as any[];
    const live = await Promise.all(gs.map((g) => liveOrCached(g).catch(() => null)));
    let potArmed = 0n, attempts = 0, wins = 0, alive = 0, blockedOnChain = 0;
    for (const l of live) {
      if (!l) continue;
      attempts += Number(l.stats.attempts); wins += Number(l.stats.wins); blockedOnChain += Number(l.stats.blocked_reported);
      if (l.state.status === "Armed") { alive++; potArmed += BigInt(l.state.pot); }
    }
    const open = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE status='open'").get() as any).n;
    const blockedToday = (db.prepare("SELECT COUNT(*) AS n FROM blocked_attempts WHERE created_at >= ?").get(dayStart()) as any).n;
    return c.json({ guardians: gs.length, alive, total_pot: potArmed.toString(), attempts, wins, open_sessions: open, blocked_today: blockedToday, blocked_reported: blockedOnChain });
  });

  // ---- custodial (zero-wallet) players: name + passphrase. DEMO-GRADE: the server holds the keys; never use for real funds.
  let fundQueue: Promise<unknown> = Promise.resolve();
  const funder = custodial ? accountFrom(custodial.funderId, cfg.rpcUrl, custodial.funderSecret) : null;
  const queueFund = <T,>(fn: () => Promise<T>): Promise<T> => { const r = fundQueue.then(fn, fn); fundQueue = r.catch(() => {}); return r; };
  const hashSecret = (secret: string, salt: string) => scryptSync(secret, salt, 32).toString("hex");
  const issueToken = (account_id: string) => {
    const token = randomBytes(24).toString("hex");
    db.prepare("INSERT INTO auth_tokens(token, account_id, expires_at) VALUES (?,?,?)").run(token, account_id, now() + 7 * 24 * 3600_000);
    return token;
  };
  const custodialRow = (acct: string | null) => (acct ? (db.prepare("SELECT * FROM custodial WHERE account_id=?").get(acct) as any) : null);
  const creditsOf = async (acct: string) => BigInt((await retryTransport(() => p.viewAccount({ accountId: acct }))).amount);

  app.post("/custodial/signin", async (c) => {
    if (!custodial || !funder) return c.json({ error: "custodial play is not enabled on this server" }, 501);
    const b = await c.req.json().catch(() => ({}));
    const display = String(b.name ?? "").trim();
    const secret = String(b.secret ?? "");
    if (display.length < 2 || display.length > 32) return c.json({ error: "name must be 2-32 characters" }, 400);
    if (secret.length < 6 || secret.length > 128) return c.json({ error: "passphrase must be 6-128 characters" }, 400);
    const nameKey = display.toLowerCase();
    const existing = db.prepare("SELECT * FROM custodial WHERE name_key=?").get(nameKey) as any;
    if (existing) {
      const ok = timingSafeEqual(Buffer.from(hashSecret(secret, existing.salt), "hex"), Buffer.from(existing.hash, "hex"));
      if (!ok) return c.json({ error: "wrong passphrase for that name" }, 401);
      return c.json({ token: issueToken(existing.account_id), account_id: existing.account_id, name: existing.display_name, created: false });
    }
    const ipNow = (c.get("ip" as any) as string | null);
    if (ipNow && !cfg.limits.disabled && !allow(`newacct:${ipNow}`, cfg.limits.accountsPerIpPerHour, 3_600_000)) return c.json({ error: "too many new play accounts from your network this hour" }, 429);
    const slug = nameKey.replace(/[^a-z0-9]/g, "").slice(0, 12) || "player";
    const accountId = `${slug}${randomBytes(3).toString("hex")}.${custodial.funderId}`;
    const kp = KeyPair.fromRandom("ed25519");
    const keyRef = `custodial-${accountId}`;
    mkdirSync(cfg.keysDir, { recursive: true });
    writeFileSync(`${cfg.keysDir}/${keyRef}.json`, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }));
    const fund = BigInt(Math.round(custodial.fundNear * 1e6)) * 10n ** 18n;
    try {
      await queueFund(() => retryTransport(() => funder.createAccount({ newAccountId: accountId, publicKey: kp.getPublicKey().toString(), nearToTransfer: fund })));
    } catch (e: any) { return c.json({ error: `could not create your play account: ${String(e?.message ?? e).slice(0, 120)}` }, 502); }
    const salt = randomBytes(16).toString("hex");
    db.prepare("INSERT INTO custodial(name_key, display_name, account_id, key_ref, salt, hash, created_at) VALUES (?,?,?,?,?,?,?)").run(nameKey, display, accountId, keyRef, salt, hashSecret(secret, salt), now());
    return c.json({ token: issueToken(accountId), account_id: accountId, name: display, created: true }, 201);
  });

  app.get("/me", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const cu = custodialRow(acct);
    const rows = db.prepare("SELECT status, COUNT(*) AS n FROM sessions WHERE controller=? GROUP BY status").all(acct) as any[];
    const n = (st: string) => rows.find((r) => r.status === st)?.n ?? 0;
    const recent = db.prepare("SELECT id, guardian_id, status, turns, started_at, tx_release FROM sessions WHERE controller=? ORDER BY started_at DESC LIMIT 20").all(acct);
    let credits: string | null = null; try { credits = (await creditsOf(acct)).toString(); } catch { /* shown as unavailable */ }
    return c.json({ account: acct, name: cu?.display_name ?? null, custodial: !!cu, credits, wins: n("won"), failed: n("failed"), open: n("open"), recent });
  });

  // Demo faucet for play credits (custodial players only; capped).
  app.post("/custodial/topup", async (c) => {
    const acct = account(c); const cu = custodialRow(acct);
    if (!custodial || !funder || !cu) return c.json({ error: "custodial players only" }, 403);
    const have = await creditsOf(cu.account_id);
    if (have > BigInt(Math.round(custodial.fundNear)) * NEAR) return c.json({ error: "you already have plenty of credits" }, 409);
    await queueFund(() => retryTransport(() => funder.transfer({ receiverId: cu.account_id, amount: BigInt(Math.round(custodial.fundNear * 1e6)) * 10n ** 18n })));
    return c.json({ credits: (await creditsOf(cu.account_id)).toString() });
  });

  // One click: the server pays the entry fee from the player's custodial account and opens the session (no wallet, no gas UI).
  app.post("/guardians/:id/play", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "sign in to play" }, 401);
    const cu = custodialRow(acct); if (!cu) return c.json({ error: "this endpoint is for custodial players; use the SDK with your own account" }, 403);
    const g = getG(c.req.param("id")); if (!g || g.pending) return c.json({ error: "not found" }, 404);
    const live = await liveOrCached(g);
    if (live.state.status !== "Armed") return c.json({ error: "this guardian has been defeated" }, 409);
    // resume an attempt that is still open instead of paying twice
    const open = db.prepare("SELECT id, onchain_session_id FROM sessions WHERE guardian_id=? AND controller=? AND status='open' ORDER BY started_at DESC LIMIT 1").get(g.id, acct) as any;
    if (open) {
      const s: any = await view(p, g.vault_account, "get_session", { session_id: String(open.onchain_session_id) });
      if (s?.status === "Open") return c.json({ session_id: open.id, onchain_session_id: open.onchain_session_id, resumed: true, via_pool: s.attacker !== acct, turns_max: g.turns_max, fee: s.fee, expires_at: s.expires_at });
      db.prepare("UPDATE sessions SET status=? WHERE id=?").run(String(s?.status ?? "failed").toLowerCase(), open.id);
    }
    const fee = BigInt(live.params.min_fee);
    if ((await creditsOf(acct)) < fee + NEAR / 20n) return c.json({ error: "not enough credits for the entry fee", fee: fee.toString() }, 402);
    const key = JSON.parse(readFileSync(`${cfg.keysDir}/${cu.key_ref}.json`, "utf8"));
    let onchainId: string;
    try {
      onchainId = String(await retryTransport(() => accountFrom(acct, cfg.rpcUrl, key.private_key).callFunction({ contractId: g.vault_account, methodName: "start_session", args: {}, deposit: fee })));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      return c.json({ error: /too many open/.test(msg) ? "you already have an open attempt on this guardian" : /defeated/.test(msg) ? "this guardian has been defeated" : `could not start the attempt: ${msg.slice(0, 120)}` }, 409);
    }
    const s: any = await view(p, g.vault_account, "get_session", { session_id: onchainId });
    const id = randomUUID();
    db.prepare("INSERT INTO sessions(id, guardian_id, onchain_session_id, attacker, status, started_at, controller) VALUES (?,?,?,?, 'open', ?, ?)").run(id, g.id, Number(onchainId), acct, now(), acct);
    return c.json({ session_id: id, onchain_session_id: Number(onchainId), resumed: false, turns_max: g.turns_max, fee: s.fee, expires_at: s.expires_at });
  });

  // Everything the "Prove it" drawer shows, in one call.
  app.get("/guardians/:id/prove", async (c) => {
    const g = getG(c.req.param("id")); if (!g || g.pending) return c.json({ error: "not found" }, 404);
    const [{ state, stats }, keys] = await Promise.all([liveOrCached(g), listKeys(p, g.vault_account).catch(() => null)]);
    const blocked = db.prepare("SELECT b.tool, b.args, b.chain_error, b.created_at, s.id AS session_id FROM blocked_attempts b JOIN sessions s ON s.id = b.session_id WHERE s.guardian_id=? ORDER BY b.id DESC LIMIT 20").all(g.id);
    const sessions = db.prepare("SELECT id, status, turns, started_at, closed_at, tx_release, tx_close, transcript_hash FROM sessions WHERE guardian_id=? ORDER BY started_at DESC LIMIT 20").all(g.id);
    const signed = (db.prepare("SELECT COUNT(*) AS n FROM exchanges e JOIN sessions s ON s.id = e.session_id WHERE s.guardian_id=? AND e.signature IS NOT NULL").get(g.id) as any).n;
    return c.json({
      guardian: { id: g.id, name: g.name, vault_account: g.vault_account, model: g.model, provider: cfg.llm.provider },
      vault: { owner: state.owner, status: state.status, prompt_hash: state.prompt_hash, revealed: !!g.revealed,
        keys: keys && keys.map((k) => ({ kind: k.kind, methods: k.methodNames ?? null, receiver: k.receiverId ?? null })),
        no_full_access_key: keys ? keys.every((k) => k.kind === "FunctionCall") : null },
      stats, blocked, sessions,
      attestation: cfg.llm.provider === "nearai"
        ? { available: true, signed_exchanges: signed, link: `/guardians/${g.id}/attestation` }
        : { available: false, signed_exchanges: 0, reason: `This guardian's model runs on ${cfg.llm.provider === "mock" ? "a scripted demo model" : cfg.llm.provider}, which gives no TEE attestation. The vault guarantees below are enforced by the chain; the model's answers are not attested.` },
    });
  });

  // ================= UI: create / my guardians / swarms / proofs =================
  const cleanErr = (e: any) => String(e?.message ?? e).replace(/^Smart contract panicked: /, "").slice(0, 200);
  const signerOf = (acct: string | null) => {
    const cu = custodialRow(acct); if (!cu) return null;
    const key = JSON.parse(readFileSync(`${cfg.keysDir}/${cu.key_ref}.json`, "utf8"));
    return accountFrom(cu.account_id, cfg.rpcUrl, key.private_key);
  };
  const nearYocto = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
  const authHeader = (c: any) => ({ authorization: c.req.header("authorization") ?? "", "content-type": "application/json" });

  app.get("/create/quote", async (c) => {
    if (!cfg.registry) return c.json({ error: "no registry configured" }, 501);
    const seed = Number(c.req.query("seed_near") ?? 1);
    if (!(seed >= 0.5 && seed <= 100000)) return c.json({ error: "seed_near must be at least 0.5" }, 400);
    const required = BigInt((await view(p, cfg.registry, "mint_requirements", {})) as string);
    const total = required - nearYocto(0.5) + nearYocto(seed);
    return c.json({ seed: nearYocto(seed).toString(), overhead: (total - nearYocto(seed)).toString(), total: total.toString(), min_seed: nearYocto(0.5).toString() });
  });

  // Guardians I own (vault owner == me), with the creator fees I can claim.
  app.get("/me/guardians", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "login required" }, 401);
    const gs = db.prepare("SELECT * FROM guardians WHERE pending=0").all() as any[];
    const out: any[] = [];
    await Promise.all(gs.map(async (g) => {
      try { const l = await liveOrCached(g); if (l.state.owner === acct) out.push({ ...(await publicGuardian(g)), creator_balance: l.state.creator_balance }); } catch { /* skip unreadable */ }
    }));
    return c.json(out.sort((a, b) => b.created_at - a.created_at));
  });

  // Zero-wallet creation: the server prepares the mint and signs it with the player's custodial account.
  app.post("/me/guardians", async (c) => {
    const acct = account(c); if (!acct) return c.json({ error: "sign in to create a Guardian" }, 401);
    const signer = signerOf(acct); if (!signer) return c.json({ error: "custodial players only" }, 403);
    const mine = (db.prepare("SELECT COUNT(*) AS n FROM guardians WHERE owner=? AND created_at > ?").get(acct, now() - 24 * 3600_000) as any).n;
    if (mine >= 5) return c.json({ error: "daily limit: 5 new Guardians per player" }, 429);
    const body = await c.req.json().catch(() => ({}));
    const prep = await app.request("/guardians/prepare", { method: "POST", headers: authHeader(c), body: JSON.stringify(body) });
    const pj: any = await prep.json();
    if (!prep.ok) return c.json(pj, prep.status as any);
    const a = pj.mint_transaction.actions[0].params;
    try {
      const have = BigInt((await retryTransport(() => p.viewAccount({ accountId: acct }))).amount);
      if (have < BigInt(a.deposit) + (NEAR * 4n) / 10n) { db.prepare("DELETE FROM guardians WHERE id=? AND pending=1").run(pj.guardian_id); return c.json({ error: `Not enough credits: this Guardian needs about ${(Number((BigInt(a.deposit) + (NEAR * 4n) / 10n) / 10n ** 22n) / 100).toFixed(1)} NEAR and you have ${(Number(have / 10n ** 22n) / 100).toFixed(1)}. Lower the starting pot or add credits.` }, 402); }
      await retryTransport(() => signer.callFunction({ contractId: pj.mint_transaction.receiverId, methodName: a.methodName, args: a.args, deposit: BigInt(a.deposit), gas: BigInt(a.gas) }));
    } catch (e) { db.prepare("DELETE FROM guardians WHERE id=? AND pending=1").run(pj.guardian_id); return c.json({ error: /balance/i.test(cleanErr(e)) ? "Not enough credits to pay for this Guardian. Lower the starting pot or add credits." : `mint failed: ${cleanErr(e)}` }, 409); }
    const conf = await app.request(`/guardians/${pj.guardian_id}/confirm`, { method: "POST", headers: authHeader(c) });
    return c.json(await conf.json(), conf.status as any);
  });

  app.post("/me/guardians/:id/claim", async (c) => {
    const acct = account(c); const signer = signerOf(acct); if (!acct || !signer) return c.json({ error: "custodial players only" }, 403);
    const g = getG(c.req.param("id")); if (!g || g.pending) return c.json({ error: "not found" }, 404);
    const before = (await liveOrCached(g)).state;
    if (before.owner !== acct) return c.json({ error: "you do not own this Guardian" }, 403);
    if (BigInt(before.creator_balance) === 0n) return c.json({ error: "no creator fees to claim yet" }, 409);
    try { await retryTransport(() => signer.callFunction({ contractId: g.vault_account, methodName: "claim_creator_fees", args: {}, gas: 100_000_000_000_000n })); }
    catch (e) { return c.json({ error: cleanErr(e) }, 409); }
    return c.json({ claimed: before.creator_balance });
  });

  // ---- swarm pools for custodial players (the contract is the source of truth)
  const needPoolC = () => (cfg.pool ? null : ({ error: "swarm pools are not configured on this server" }));
  const poolCall = async (c: any, method: string, args: Record<string, unknown>, depositYocto = 0n, gas = 150_000_000_000_000n) => {
    const acct = account(c); const signer = signerOf(acct);
    if (!acct) return { status: 401, body: { error: "sign in first" } };
    if (!signer) return { status: 403, body: { error: "custodial players only" } };
    try { return { status: 200, body: { result: await retryTransport(() => signer.callFunction({ contractId: cfg.pool!, methodName: method, args, deposit: depositYocto, gas })) } }; }
    catch (e) { return { status: 409, body: { error: cleanErr(e) } }; }
  };
  app.get("/pools/:id/contributions", async (c) => {
    if (needPoolC()) return c.json(needPoolC(), 501);
    try {
      const rows: any[] = (await view(p, cfg.pool!, "list_contributions", { pool_id: String(c.req.param("id")) })) as any[];
      return c.json({ supported: true, rows: rows.map((r) => ({ ...r, display: (db.prepare("SELECT display_name FROM custodial WHERE account_id=?").get(r.account) as any)?.display_name ?? null })) });
    } catch { return c.json({ supported: false, rows: [] }); }
  });
  app.post("/me/pools", async (c) => {
    if (needPoolC()) return c.json(needPoolC(), 501);
    const b = await c.req.json().catch(() => ({}));
    const g = getG(String(b.guardian_id ?? "")); if (!g || g.pending || g.vault_account !== `${g.id}.${cfg.registry}`) return c.json({ error: "pick a registry-minted Guardian" }, 404);
    const r = await poolCall(c, "create_pool", { guardian_id: g.id, target_fee_budget: nearYocto(Number(b.target_fee_near ?? 1)).toString(), controller: null, deadline_ms: String(Math.round(Number(b.deadline_min ?? 60) * 60_000)) });
    return c.json(r.status === 200 ? { pool_id: String((r.body as any).result) } : r.body, r.status as any);
  });
  app.post("/me/pools/:id/contribute", async (c) => {
    if (needPoolC()) return c.json(needPoolC(), 501);
    const amount = Number((await c.req.json().catch(() => ({}))).amount_near);
    if (!(amount >= 0.01)) return c.json({ error: "minimum contribution is 0.01" }, 400);
    const r = await poolCall(c, "contribute", { pool_id: String(c.req.param("id")) }, nearYocto(amount));
    return c.json(r.status === 200 ? { ok: true } : r.body, r.status as any);
  });
  app.post("/me/pools/:id/attack", async (c) => {
    if (needPoolC()) return c.json(needPoolC(), 501);
    const id = String(c.req.param("id"));
    const pv: any = await view(p, cfg.pool!, "get_pool", { pool_id: id }); if (!pv) return c.json({ error: "not found" }, 404);
    const g = getG(pv.guardian_id)!;
    const fee = (await c.req.json().catch(() => ({}))).fee_near != null ? nearYocto(Number((await c.req.json()).fee_near)) : BigInt((await liveOrCached(g)).params.min_fee);
    const r = await poolCall(c, "attack_with_pool", { pool_id: id, fee: fee.toString() });
    if (r.status !== 200) return c.json(r.body, r.status as any);
    const after: any = await view(p, cfg.pool!, "get_pool", { pool_id: id });
    if (!after.open_session) return c.json({ error: "the vault refused the pool's attack (defeated, or another pool's attempt is open)" }, 409);
    const bind = await app.request(`/pools/${id}/sessions/verify`, { method: "POST", headers: authHeader(c), body: JSON.stringify({ onchain_session_id: Number(after.open_session) }) });
    const bj: any = await bind.json();
    return c.json(bind.ok ? { ...bj, guardian_id: g.id } : bj, bind.status as any);
  });
  for (const m of ["settle", "withdraw", "refund", "close_pool"] as const) {
    app.post(`/me/pools/:id/${m}`, async (c) => {
      if (needPoolC()) return c.json(needPoolC(), 501);
      const r = await poolCall(c, m, { pool_id: String(c.req.param("id")) }, 0n, 100_000_000_000_000n);
      return c.json(r.status === 200 ? { result: (r.body as any).result ?? null } : r.body, r.status as any);
    });
  }

  // ---- proofs: recent sessions + the verifier (same code as scripts/verify-session.ts)
  app.get("/sessions", (c) => {
    const rows = db.prepare("SELECT s.id, s.guardian_id, g.name AS guardian_name, s.status, s.turns, s.started_at, s.tx_release FROM sessions s JOIN guardians g ON g.id = s.guardian_id WHERE g.pending=0 ORDER BY s.started_at DESC LIMIT 60").all();
    return c.json(rows);
  });
  app.get("/proofs/:session_id/verify", async (c) => {
    const s = getS(c.req.param("session_id")); if (!s) return c.json({ error: "not found" }, 404);
    const g = getG(s.guardian_id)!;
    const exs = db.prepare("SELECT * FROM exchanges WHERE session_id=? ORDER BY id").all(s.id) as any[];
    const revealed = !!g.revealed;
    const proofs: any = {
      session: { id: s.id }, guardian: { id: g.id, vault_account: g.vault_account, model: g.model, prompt_hash: g.prompt_hash }, revealed,
      ...(revealed ? { prompt: decrypt(g.prompt_ciphertext, pkey) } : {}),
      turns: db.prepare("SELECT idx, role, content, chat_id FROM turns WHERE session_id=? ORDER BY idx").all(s.id),
      exchanges: exs.map((e) => ({ idx: e.idx, chat_id: e.chat_id, model: e.model, request_hash: e.request_hash, response_hash: e.response_hash, response_body: e.response_body, signed_text: e.signed_text, signature: e.signature, signing_address: e.signing_address, signing_algo: e.signing_algo, signature_error: e.signature_error, ...(revealed ? { request_body: decrypt(e.request_ciphertext, pkey) } : {}) })),
    };
    const results = await verifySession(proofs, {
      fetchAttestation: (model, nonce) => fetchAttestation(cfg.nearai.baseUrl, model, nonce),
      onchainPromptHash: async (v) => ((await view(p, v, "get_state")) as any).prompt_hash,
      verifyQuote,
    });
    return c.json({ session: { id: s.id, status: s.status, guardian_id: g.id, guardian_name: g.name, turns: s.turns, started_at: s.started_at, tx_release: s.tx_release, tx_close: s.tx_close, transcript_hash: s.transcript_hash, onchain_session_id: s.onchain_session_id }, vault_account: g.vault_account, provider: cfg.llm.provider, model: g.model, results, text: formatResults(results) });
  });

  app.get("/health", (c) => c.json({ ok: true }));
  return { app, runtime };
}
