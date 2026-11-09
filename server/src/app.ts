import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { KeyPair } from "near-api-js";
import { verifyMessage } from "near-api-js/nep413";
import type { Config } from "./config.ts";
import { now, type DB } from "./db.ts";
import { listKeys, provider, view } from "./chain.ts";
import { decrypt, sha256Hex } from "./crypto.ts";
import { GuardianRuntime, type GuardianRow, type SessionRow } from "./guardian.ts";
import { createGuardian, registerGuardian } from "./guardians.ts";
import { syncGuardian } from "./indexer.ts";
import type { Llm } from "./llm.ts";
import { fetchAttestation, newNonce, verifyAttestation, type QuoteVerifier } from "./privacy/attestation.ts";

const AUTH_RECIPIENT = "vaultbreak";
const AUTH_MESSAGE = "Log in to Vaultbreak";

export interface AppDeps { db: DB; cfg: Config; llm: Llm; pkey: Buffer; verifyQuote?: QuoteVerifier }

export function createApp({ db, cfg, llm, pkey, verifyQuote }: AppDeps) {
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
      id: g.id, name: g.name, vault_account: g.vault_account, owner: state.owner, status: state.status,
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

  app.get("/health", (c) => c.json({ ok: true }));
  return { app, runtime };
}
