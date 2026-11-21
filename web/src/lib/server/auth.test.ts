import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, hashToken, verifyPassword } from "./auth";
import {
  closeDb,
  deleteUser,
  findSessionUser,
  findUserByEmail,
  getPlan,
  insertSession,
  insertUser,
  upsertPlan,
} from "./db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-db-"));

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "test.db");
});

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password", h)).toBe(false);
  });

  it("uses a random salt", async () => {
    expect(await hashPassword("same-password")).not.toBe(await hashPassword("same-password"));
  });

  it("rejects malformed hashes", async () => {
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("db round-trip", () => {
  it("stores users, sessions, plans and deletes them all", async () => {
    const id = insertUser("Student@Berkeley.EDU ", await hashPassword("password123"));
    expect(id).toBeTypeOf("number");
    expect(insertUser("student@berkeley.edu", "x")).toBeNull();

    const u = findUserByEmail("STUDENT@berkeley.edu");
    expect(u?.email).toBe("student@berkeley.edu");
    expect(await verifyPassword("password123", u!.password_hash)).toBe(true);

    const th = hashToken("tok");
    insertSession(th, id!, Date.now() + 60_000);
    expect(findSessionUser(th)).toEqual({ id, email: "student@berkeley.edu", emailVerified: false });
    insertSession(hashToken("old"), id!, Date.now() - 1);
    expect(findSessionUser(hashToken("old"))).toBeUndefined();

    const state = { version: 1, majorIds: ["cs"], taken: [] };
    upsertPlan(id!, JSON.stringify(state), 1000);
    upsertPlan(id!, JSON.stringify({ ...state, majorIds: ["ds"] }), 2000);
    const p = getPlan(id!);
    expect(p?.updated_at).toBe(2000);
    expect(JSON.parse(p!.state_json).majorIds).toEqual(["ds"]);

    deleteUser(id!);
    expect(findUserByEmail("student@berkeley.edu")).toBeUndefined();
    expect(getPlan(id!)).toBeUndefined();
    expect(findSessionUser(th)).toBeUndefined();
  });
});
