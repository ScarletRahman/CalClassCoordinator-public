import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as resetRoute } from "@/app/api/auth/reset/route";
import { POST as verifyRoute } from "@/app/api/auth/verify/route";
import { hashPassword, hashToken, verifyPassword } from "./auth";
import { closeDb, findSessionUser, findUserById, insertSession, insertUser } from "./db";
import { consumeEmailToken, createEmailToken, RESET_TTL_MS, VERIFY_TTL_MS } from "./emailTokens";
import { _resetAll } from "./rateLimit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-tokens-"));
let n = 0;

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "test.db");
});
beforeEach(() => _resetAll());
afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function newUser(): Promise<number> {
  return insertUser(`student${++n}@berkeley.edu`, await hashPassword("old password 123"))!;
}

function post(url: string, body: unknown): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", host: "localhost:3000" },
    body: JSON.stringify(body),
  });
}

describe("email tokens", () => {
  it("verify: happy path, single use, stores only a hash", async () => {
    const id = await newUser();
    const token = createEmailToken(id, "verify");
    expect(token.length).toBeGreaterThan(40);
    const res = await verifyRoute(post("/api/auth/verify", { token }));
    expect(res.status).toBe(200);
    expect(findUserById(id)?.email_verified_at).toBeTypeOf("number");
    const again = await verifyRoute(post("/api/auth/verify", { token }));
    expect(again.status).toBe(400);
    expect(consumeEmailToken(token, "verify")).toBeNull();
  });

  it("expires", async () => {
    const id = await newUser();
    const now = Date.now();
    const v = createEmailToken(id, "verify", now - VERIFY_TTL_MS - 1);
    expect(consumeEmailToken(v, "verify", now)).toBeNull();
    const r = createEmailToken(id, "reset", now - RESET_TTL_MS - 1);
    expect(consumeEmailToken(r, "reset", now)).toBeNull();
    const fresh = createEmailToken(id, "verify", now);
    expect(consumeEmailToken(fresh, "verify", now + VERIFY_TTL_MS - 1000)).toBe(id);
  });

  it("is bound to its purpose and rejects junk", async () => {
    const id = await newUser();
    const v = createEmailToken(id, "verify");
    expect(consumeEmailToken(v, "reset")).toBeNull();
    expect(consumeEmailToken(v, "verify")).toBe(id);
    expect(consumeEmailToken("", "verify")).toBeNull();
    expect(consumeEmailToken("x".repeat(500), "verify")).toBeNull();
  });

  it("a new reset link replaces the old one", async () => {
    const id = await newUser();
    const first = createEmailToken(id, "reset");
    const second = createEmailToken(id, "reset");
    expect(consumeEmailToken(first, "reset")).toBeNull();
    expect(consumeEmailToken(second, "reset")).toBe(id);
  });

  it("reset: sets the password, signs out every session, verifies email, single use", async () => {
    const id = await newUser();
    insertSession(hashToken("s1"), id, Date.now() + 60_000);
    insertSession(hashToken("s2"), id, Date.now() + 60_000);
    expect(findSessionUser(hashToken("s1"))?.emailVerified).toBe(false);
    const token = createEmailToken(id, "reset");

    const weak = await resetRoute(post("/api/auth/reset", { token, password: "short" }));
    expect(weak.status).toBe(400); // and the link still works:

    const res = await resetRoute(post("/api/auth/reset", { token, password: "brand new password" }));
    expect(res.status).toBe(200);
    expect(findSessionUser(hashToken("s1"))).toBeUndefined();
    expect(findSessionUser(hashToken("s2"))).toBeUndefined();
    const u = findUserById(id)!;
    expect(await verifyPassword("brand new password", u.password_hash)).toBe(true);
    expect(u.email_verified_at).toBeTypeOf("number");

    const again = await resetRoute(post("/api/auth/reset", { token, password: "another password!" }));
    expect(again.status).toBe(400);
  });
});
