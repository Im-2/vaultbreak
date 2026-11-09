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
      created_at INTEGER NOT NULL, state_json TEXT, last_synced_session INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY, guardian_id TEXT NOT NULL, onchain_session_id INTEGER NOT NULL, attacker TEXT NOT NULL,
      status TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, closed_at INTEGER,
      transcript_hash TEXT, tx_release TEXT, tx_close TEXT, UNIQUE(guardian_id, onchain_session_id));
    CREATE TABLE IF NOT EXISTS turns(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, idx INTEGER NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, chat_id TEXT, signature TEXT, signing_address TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blocked_attempts(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL,
      chain_error TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, owner TEXT NOT NULL, hash TEXT NOT NULL, budget_remaining TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, guardian_id TEXT, payload TEXT NOT NULL,
      block_height INTEGER, tx_hash TEXT, created_at INTEGER NOT NULL, UNIQUE(kind, guardian_id, payload));
    CREATE TABLE IF NOT EXISTS auth_nonces(nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_tokens(token TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  return db;
}

export const now = () => Date.now();
