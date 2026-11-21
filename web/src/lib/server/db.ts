import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { databasePath } from "./env";
import { decryptPlan, encryptPlan } from "./planCrypto";

export type DB = Database.Database;

let db: DB | null = null;

export function dbPath(): string {
  return databasePath();
}

export function getDb(): DB {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS plans (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  migrate(d);
  db = d;
  return d;
}

/**
 * Additive, idempotent schema changes for databases created by older versions.
 * SQLite has no ADD COLUMN IF NOT EXISTS, so check PRAGMA table_info first.
 */
export function migrate(d: DB): void {
  const cols = (d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("email_verified_at")) d.exec("ALTER TABLE users ADD COLUMN email_verified_at INTEGER");
  // Optimistic concurrency for saved plans: bumped on every write, checked by PUT /api/plan.
  const planCols = (d.prepare("PRAGMA table_info(plans)").all() as { name: string }[]).map((c) => c.name);
  if (!planCols.includes("version")) d.exec("ALTER TABLE plans ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
  d.exec(`
    CREATE TABLE IF NOT EXISTS email_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
      expires_at INTEGER NOT NULL,
      used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id);
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_number TEXT NOT NULL,
      course TEXT NOT NULL DEFAULT '',
      term TEXT,
      include_reserved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, class_number)
    );
  `);
}

/** Close and forget the singleton (tests). */
export function closeDb(): void {
  db?.close();
  db = null;
}

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  created_at: number;
  email_verified_at: number | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function findUserByEmail(email: string): UserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(normalizeEmail(email)) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

/** Returns the new user id, or null if the email is taken. */
export function insertUser(email: string, passwordHash: string): number | null {
  try {
    const r = getDb()
      .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
      .run(normalizeEmail(email), passwordHash, Date.now());
    return Number(r.lastInsertRowid);
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return null;
    throw e;
  }
}

export function deleteUser(userId: number): void {
  const d = getDb();
  d.transaction(() => {
    d.prepare("DELETE FROM plans WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM alert_subscriptions WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM email_tokens WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM users WHERE id = ?").run(userId);
  })();
}

export function insertSession(tokenHash: string, userId: number, expiresAt: number): void {
  getDb()
    .prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(tokenHash, userId, expiresAt);
}

export interface SessionUser {
  id: number;
  email: string;
  emailVerified: boolean;
}

export function findSessionUser(tokenHash: string, now = Date.now()): SessionUser | undefined {
  const row = getDb()
    .prepare(
      `SELECT u.id AS id, u.email AS email, u.email_verified_at AS verified FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(tokenHash, now) as { id: number; email: string; verified: number | null } | undefined;
  return row ? { id: row.id, email: row.email, emailVerified: row.verified != null } : undefined;
}

export function deleteUserSessions(userId: number): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function setPasswordHash(userId: number, passwordHash: string): void {
  getDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
}

export function markEmailVerified(userId: number, at = Date.now()): void {
  getDb().prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(at, userId);
}

// ---------- one-time email tokens (only SHA-256 hashes are stored) ----------

export type TokenPurpose = "verify" | "reset";

export function insertEmailToken(tokenHash: string, userId: number, purpose: TokenPurpose, expiresAt: number): void {
  const d = getDb();
  d.prepare("DELETE FROM email_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(Date.now());
  d.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)").run(
    tokenHash,
    userId,
    purpose,
    expiresAt,
  );
}

export function deleteEmailTokens(userId: number, purpose: TokenPurpose): void {
  getDb().prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?").run(userId, purpose);
}

/** Marks an unused, unexpired token used and returns its user id, atomically. */
export function claimEmailToken(tokenHash: string, purpose: TokenPurpose, now = Date.now()): number | null {
  const row = getDb()
    .prepare(
      `UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .get(now, tokenHash, purpose, now) as { user_id: number } | undefined;
  return row?.user_id ?? null;
}

// ---------- seat alert subscriptions ----------

export interface AlertRow {
  user_id: number;
  class_number: string;
  course: string;
  term: string | null;
  include_reserved: number;
  created_at: number;
}

export function listAlerts(userId: number): AlertRow[] {
  return getDb()
    .prepare("SELECT * FROM alert_subscriptions WHERE user_id = ? ORDER BY created_at")
    .all(userId) as AlertRow[];
}

export function countAlerts(userId: number): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM alert_subscriptions WHERE user_id = ?").get(userId) as { n: number }).n;
}

export function findAlert(userId: number, classNumber: string): AlertRow | undefined {
  return getDb()
    .prepare("SELECT * FROM alert_subscriptions WHERE user_id = ? AND class_number = ?")
    .get(userId, classNumber) as AlertRow | undefined;
}

export function upsertAlert(a: Omit<AlertRow, "created_at">, createdAt = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO alert_subscriptions (user_id, class_number, course, term, include_reserved, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, class_number) DO UPDATE SET course = excluded.course, term = excluded.term,
         include_reserved = excluded.include_reserved`,
    )
    .run(a.user_id, a.class_number, a.course, a.term, a.include_reserved, createdAt);
}

export function deleteAlert(userId: number, classNumber: string): boolean {
  return getDb().prepare("DELETE FROM alert_subscriptions WHERE user_id = ? AND class_number = ?").run(userId, classNumber).changes > 0;
}

export function deleteSession(tokenHash: string): void {
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function purgeExpiredSessions(now = Date.now()): void {
  getDb().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
}

export interface PlanRow {
  state_json: string;
  updated_at: number;
  /** Starts at 1 and goes up by one on every save. */
  version: number;
}

/** Returns the plan with state_json decrypted (when PLAN_ENCRYPTION_KEY is set and the row is encrypted). */
export function getPlan(userId: number): PlanRow | undefined {
  const row = getDb()
    .prepare("SELECT state_json, updated_at, version FROM plans WHERE user_id = ?")
    .get(userId) as PlanRow | undefined;
  return row ? { ...row, state_json: decryptPlan(row.state_json, userId) } : undefined;
}

/** Unconditional write (bumps the version). Returns updatedAt. */
export function upsertPlan(userId: number, stateJson: string, updatedAt = Date.now()): number {
  getDb()
    .prepare(
      `INSERT INTO plans (user_id, state_json, updated_at, version) VALUES (?, ?, ?, 1)
       ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at,
         version = plans.version + 1`,
    )
    .run(userId, encryptPlan(stateJson, userId), updatedAt);
  return updatedAt;
}

export type SavePlanResult = { ok: true; version: number; updatedAt: number } | { ok: false; current: PlanRow | undefined };

/**
 * Compare-and-swap save. `baseVersion` is the version the client last saw: null means "I saw no
 * saved plan". The write happens only when that still matches; otherwise the current row is
 * returned so the client can show it instead of overwriting newer data.
 */
export function savePlanIfVersion(userId: number, stateJson: string, baseVersion: number | null, updatedAt = Date.now()): SavePlanResult {
  const d = getDb();
  return d.transaction((): SavePlanResult => {
    const cur = d.prepare("SELECT version FROM plans WHERE user_id = ?").get(userId) as { version: number } | undefined;
    if ((cur?.version ?? null) !== baseVersion) return { ok: false, current: getPlan(userId) };
    const version = (cur?.version ?? 0) + 1;
    d.prepare(
      `INSERT INTO plans (user_id, state_json, updated_at, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at, version = excluded.version`,
    ).run(userId, encryptPlan(stateJson, userId), updatedAt, version);
    return { ok: true, version, updatedAt };
  }).immediate();
}
