import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { closeDb, findSessionUser, findUserByEmail, getDb, insertSession, markEmailVerified, migrate } from "./db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-migrate-"));

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("schema migration", () => {
  it("upgrades a database created with the original users schema", () => {
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE plans (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, state_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO users (email, password_hash, created_at) VALUES ('old@berkeley.edu', 'scrypt$aa$bb', 1);
    `);
    old.close();

    process.env.DATABASE_PATH = file;
    const d = getDb();
    const cols = (d.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("email_verified_at");
    const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["email_tokens", "alert_subscriptions"]));

    const u = findUserByEmail("old@berkeley.edu")!;
    expect(u.email_verified_at).toBeNull();
    insertSession("h", u.id, Date.now() + 60_000);
    expect(findSessionUser("h")?.emailVerified).toBe(false);
    markEmailVerified(u.id);
    expect(findSessionUser("h")?.emailVerified).toBe(true);

    // idempotent
    expect(() => migrate(d)).not.toThrow();
    closeDb();
    expect(() => getDb()).not.toThrow();
    expect(findUserByEmail("old@berkeley.edu")?.email_verified_at).toBeTypeOf("number");
  });
});
