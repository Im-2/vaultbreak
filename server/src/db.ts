import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS guardians(
      id TEXT PRIMARY KEY, vault_account TEXT UNIQUE NOT NULL, owner TEXT NOT NULL, ops TEXT,
      prompt_hash TEXT NOT NULL, prompt_ciphertext TEXT NOT NULL, revealed INTEGER NOT NULL DEFAULT 0,
      retired INTEGER NOT NULL DEFAULT 0, danger_mode INTEGER NOT NULL DEFAULT 1,
      model TEXT NOT NULL, key_ref TEXT NOT NULL, name TEXT, turns_max INTEGER NOT NULL DEFAULT 8,
      created_at INTEGER NOT NULL, state_json TEXT, last_synced_session INTEGER NOT NULL DEFAULT 0,
      registry TEXT, pending INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, guardian_id TEXT NOT NULL, onchain_session_id INTEGER NOT NULL, attacker TEXT NOT NULL,
      status TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, closed_at INTEGER,
      transcript_hash TEXT, tx_release TEXT, tx_close TEXT, controller TEXT, UNIQUE(guardian_id, onchain_session_id));
    CREATE TABLE IF NOT EXISTS turns(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, chat_id TEXT, signature TEXT, signing_address TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blocked_attempts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
      chain_error TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, owner TEXT NOT NULL, hash TEXT NOT NULL, budget_remaining TEXT NOT NULL, created_at INTEGER NOT NULL,
      agent_account TEXT, label TEXT, spent TEXT NOT NULL DEFAULT '0', revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, guardian_id TEXT, payload TEXT NOT NULL,
      block_height INTEGER, tx_hash TEXT, created_at INTEGER NOT NULL, UNIQUE(kind, guardian_id, payload));
    -- Layer 2: one row per model call. request is AES-encrypted (it contains the sealed system prompt) until the guardian is revealed.
    CREATE TABLE IF NOT EXISTS exchanges(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER NOT NULL, chat_id TEXT, model TEXT NOT NULL,
      request_ciphertext TEXT NOT NULL, request_hash TEXT NOT NULL, response_body TEXT NOT NULL, response_hash TEXT NOT NULL,
      signed_text TEXT, signature TEXT, signing_address TEXT, signing_algo TEXT, signature_error TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attestations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, guardian_id TEXT NOT NULL, model TEXT NOT NULL, nonce TEXT NOT NULL, report_json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    -- zero-wallet players: the server holds a custodial NEAR account per player (demo-grade: name + passphrase)
    CREATE TABLE IF NOT EXISTS custodial(
      name_key TEXT PRIMARY KEY, display_name TEXT NOT NULL, account_id TEXT UNIQUE NOT NULL, key_ref TEXT NOT NULL,
      salt TEXT NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS custodial_topups(account_id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
    -- NFT transfers (human and agent): every one is logged; agent requests may wait here for the owner's approval
    CREATE TABLE IF NOT EXISTS nft_transfers(
      id TEXT PRIMARY KEY, guardian_id TEXT NOT NULL, from_account TEXT NOT NULL, to_account TEXT NOT NULL, to_label TEXT,
      requested_by_key TEXT, status TEXT NOT NULL, tx TEXT, error TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
    CREATE TABLE IF NOT EXISTS usage(day TEXT PRIMARY KEY, model_calls INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS auth_tokens(token TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  for (const ddl of ["ALTER TABLE api_keys ADD COLUMN agent_account TEXT", "ALTER TABLE api_keys ADD COLUMN can_transfer INTEGER NOT NULL DEFAULT 0", "ALTER TABLE api_keys ADD COLUMN transfer_allowlist TEXT", "ALTER TABLE api_keys ADD COLUMN transfer_approval INTEGER NOT NULL DEFAULT 1", "ALTER TABLE api_keys ADD COLUMN label TEXT", "ALTER TABLE api_keys ADD COLUMN spent TEXT NOT NULL DEFAULT '0'", "ALTER TABLE api_keys ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0", "ALTER TABLE sessions ADD COLUMN controller TEXT", "ALTER TABLE guardians ADD COLUMN registry TEXT", "ALTER TABLE guardians ADD COLUMN pending INTEGER NOT NULL DEFAULT 0"]) {
    try { db.exec(ddl); } catch { /* column already exists */ }
  }
  return db;
}

export const now = () => Date.now();
