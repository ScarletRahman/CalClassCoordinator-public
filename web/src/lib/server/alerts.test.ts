import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./db";

let current: SessionUser | null = null;
vi.mock("@/lib/server/auth", () => ({ getSessionUser: async () => current }));

const { GET, POST, DELETE } = await import("@/app/api/alerts/route");
const { closeDb, insertUser, listAlerts, markEmailVerified, deleteUser } = await import("./db");
const { _resetAll } = await import("./rateLimit");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-alerts-"));
const req = (method: string, body?: unknown) =>
  new Request("http://localhost:3000/api/alerts", {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "test.db");
});
beforeEach(() => _resetAll());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WATCHER_URL;
  delete process.env.WATCHER_API_TOKEN;
});
afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/api/alerts", () => {
  it("requires sign-in and a verified email", async () => {
    current = null;
    expect((await POST(req("POST", { classNumber: "12345" }))).status).toBe(401);
    const id = insertUser("unverified@berkeley.edu", "x")!;
    current = { id, email: "unverified@berkeley.edu", emailVerified: false };
    expect((await POST(req("POST", { classNumber: "12345" }))).status).toBe(403);
    expect(listAlerts(id)).toHaveLength(0);
  });

  it("always uses the account email, forwards to the watcher with the token, lists and deletes", async () => {
    const id = insertUser("me@berkeley.edu", "x")!;
    markEmailVerified(id);
    current = { id, email: "me@berkeley.edu", emailVerified: true };
    process.env.WATCHER_URL = "http://watcher:8080/";
    process.env.WATCHER_API_TOKEN = "s3cret";
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 201 });
    });

    const res = await POST(req("POST", { email: "victim@example.com", classNumber: "31415", course: "COMPSCI 61A", term: "2026 Fall", includeReserved: true }));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, delivered: true });
    expect(calls[0].url).toBe("http://watcher:8080/subscriptions");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ email: "me@berkeley.edu", classNumber: "31415", includeReserved: true, term: "2026 Fall", course: "COMPSCI 61A" });

    const list = await (await GET()).json();
    expect(list.alerts).toEqual([expect.objectContaining({ classNumber: "31415", course: "COMPSCI 61A", term: "2026 Fall", includeReserved: true })]);

    expect((await DELETE(req("DELETE", { classNumber: "31415" }))).status).toBe(200);
    expect(calls[1].init.method).toBe("DELETE");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ email: "me@berkeley.edu", classNumber: "31415" });
    expect(listAlerts(id)).toHaveLength(0);
  });

  it("rejects non-numeric class numbers, caps at 25, and rolls back when the watcher fails", async () => {
    const id = insertUser("cap@berkeley.edu", "x")!;
    markEmailVerified(id);
    current = { id, email: "cap@berkeley.edu", emailVerified: true };
    expect((await POST(req("POST", { classNumber: "abc" }))).status).toBe(400);

    process.env.WATCHER_URL = "http://watcher:8080";
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    expect((await POST(req("POST", { classNumber: "999" }))).status).toBe(502);
    expect(listAlerts(id)).toHaveLength(0);
    delete process.env.WATCHER_URL;
    _resetAll(); // the attempts above count toward the hourly limit too

    for (let i = 0; i < 20; i++) expect((await POST(req("POST", { classNumber: String(1000 + i) }))).status).toBe(201);
    expect((await POST(req("POST", { classNumber: "2000" }))).status).toBe(429); // 20/hour per user
    _resetAll();
    for (let i = 20; i < 25; i++) expect((await POST(req("POST", { classNumber: String(1000 + i) }))).status).toBe(201);
    expect((await POST(req("POST", { classNumber: "2000" }))).status).toBe(409);
    expect((await POST(req("POST", { classNumber: "1000", includeReserved: true }))).status).toBe(200); // update is fine
    expect(listAlerts(id)).toHaveLength(25);

    deleteUser(id);
    expect(listAlerts(id)).toHaveLength(0);
  });
});
