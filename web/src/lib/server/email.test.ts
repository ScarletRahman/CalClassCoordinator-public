import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./db";

let current: SessionUser | null = null;
vi.mock("@/lib/server/auth", async (orig) => ({
  ...(await orig<typeof import("./auth")>()),
  getSessionUser: async () => current,
  createSession: async () => "token",
}));

const signup = (await import("@/app/api/auth/signup/route")).POST;
const resend = (await import("@/app/api/auth/resend-verification/route")).POST;
const forgot = (await import("@/app/api/auth/forgot/route")).POST;
const { closeDb } = await import("./db");
const { _resetAll } = await import("./rateLimit");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-email-"));
const post = (url: string, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "test.db");
  delete process.env.SMTP_HOST;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
beforeEach(() => _resetAll());
afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("email honesty without SMTP", () => {
  it("signup succeeds but reports emailSent: false", async () => {
    const res = await signup(post("/api/auth/signup", { email: "new@berkeley.edu", password: "long enough pw" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.emailSent).toBe(false);
    expect(body.user.email).toBe("new@berkeley.edu");
  });

  it("resend answers 503 with a plain message instead of claiming it sent", async () => {
    current = { id: 1, email: "new@berkeley.edu", emailVerified: false };
    const res = await resend(post("/api/auth/resend-verification"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/could not send/i);
  });

  it("forgot password stays non-enumerating; in production without SMTP it says email is unavailable for everyone", async () => {
    const known = await forgot(post("/api/auth/forgot", { email: "new@berkeley.edu" }));
    const unknown = await forgot(post("/api/auth/forgot", { email: "nobody@berkeley.edu" }));
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await forgot(post("/api/auth/forgot", { email: "new@berkeley.edu" }));
    const b = await forgot(post("/api/auth/forgot", { email: "other@berkeley.edu" }));
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
    expect(await a.json()).toEqual(await b.json());
  });
});
