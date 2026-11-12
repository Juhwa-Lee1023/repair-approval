import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, ref TEXT NOT NULL, customer_name TEXT NOT NULL, vehicle TEXT NOT NULL,
  shop_name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('base','addon')), title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','sent')), current_version INTEGER NOT NULL,
  sent_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quote_versions (
  quote_id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL,
  note TEXT NOT NULL, items_json TEXT NOT NULL, total_cents INTEGER NOT NULL,
  hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, PRIMARY KEY (quote_id, version));
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), version INTEGER NOT NULL,
  version_hash TEXT NOT NULL, decision TEXT NOT NULL CHECK (decision IN ('approved','declined','deferred')),
  selected_json TEXT NOT NULL, total_cents INTEGER NOT NULL, ai_suggestion_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('current','replaced','stale','cancelled')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, approval_id TEXT NOT NULL UNIQUE REFERENCES approvals(id),
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL,
  state TEXT NOT NULL, order_id TEXT, approve_url TEXT, authorization_id TEXT,
  auth_expires_at TEXT, capture_id TEXT, capture_status TEXT, work_done_at TEXT,
  last_error TEXT, buyer_closed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT NOT NULL REFERENCES payments(id),
  kind TEXT NOT NULL CHECK (kind IN ('create_order','authorize','capture','void')),
  attempt INTEGER NOT NULL, request_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('sending','succeeded','failed','unknown')),
  http_status INTEGER, debug_id TEXT, remote_id TEXT, error TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, UNIQUE (payment_id, kind, attempt));
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('customer','shop_session','shop_key')),
  job_id TEXT, expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, version_hash TEXT NOT NULL, question TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT, ok INTEGER NOT NULL, output_json TEXT, error TEXT,
  latency_ms INTEGER, cost_usd REAL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, quote_id TEXT, at TEXT NOT NULL,
  actor TEXT NOT NULL, type TEXT NOT NULL, detail_json TEXT NOT NULL);
`;

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'repair.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// Synchronous, so nothing else in this process runs between BEGIN and COMMIT.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
