import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "./db";

let current: SessionUser | null = null;
vi.mock("@/lib/server/auth", () => ({ getSessionUser: async () => current }));

const { GET, PUT } = await import("@/app/api/plan/route");
const { closeDb, getDb, insertUser } = await import("./db");
const { _resetAll } = await import("./rateLimit");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-plan-"));
const put = (body: unknown) =>
  PUT(
    new Request("http://localhost:3000/api/plan", {
      method: "PUT",
      headers: { "content-type": "application/json", host: "localhost:3000" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const plan = (majorIds: string[]) => ({ version: 1, majorIds, minorGroupIds: [], year: null, startTerm: null, taken: [], semesters: [], manualChecks: {} });

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "test.db");
});
beforeEach(() => _resetAll());
afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/api/plan", () => {
  it("requires sign-in", async () => {
    current = null;
    expect((await GET()).status).toBe(401);
    expect((await put({ state: plan([]), baseVersion: null })).status).toBe(401);
  });

  it("returns a version and refuses stale writes with 409 and the current plan", async () => {
    const id = insertUser("plan@berkeley.edu", "x")!;
    current = { id, email: "plan@berkeley.edu", emailVerified: true };
    let r = await (await GET()).json();
    expect(r).toEqual({ state: null, updatedAt: null, version: null });

    // First save: the client saw no plan.
    let res = await put({ state: plan(["cs"]), baseVersion: null });
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(1);

    // Tab A saves on top of version 1.
    res = await put({ state: plan(["cs", "ds"]), baseVersion: 1 });
    expect((await res.json()).version).toBe(2);

    // Tab B still thinks version 1: refused, and gets A's plan back.
    res = await put({ state: plan(["econ"]), baseVersion: 1 });
    expect(res.status).toBe(409);
    const conflict = await res.json();
    expect(conflict.version).toBe(2);
    expect(conflict.state.majorIds).toEqual(["cs", "ds"]);

    // A client that believes nothing is saved can't clobber an existing plan either.
    expect((await put({ state: plan([]), baseVersion: null })).status).toBe(409);

    r = await (await GET()).json();
    expect(r.version).toBe(2);
    expect(r.state.majorIds).toEqual(["cs", "ds"]);
    expect(typeof r.updatedAt).toBe("string");
  });

  it("validates the shape like the client does", async () => {
    const id = insertUser("shape@berkeley.edu", "x")!;
    current = { id, email: "shape@berkeley.edu", emailVerified: true };
    expect((await put("{nope")).status).toBe(400);
    expect((await put({ state: [] })).status).toBe(400);
    expect((await put({ state: { ...plan([]), version: 2 }, baseVersion: null })).status).toBe(400);
    expect((await put({ state: plan([]), baseVersion: "1" })).status).toBe(400);
    const res = await put({ state: { ...plan(["cs"]), majorIds: ["cs", 7], semesters: null, taken: [{ course: "COMPSCI 61A", source: "manual" }, { nope: 1 }] }, baseVersion: null });
    expect(res.status).toBe(200);
    const saved = await (await GET()).json();
    expect(saved.state.majorIds).toEqual(["cs"]);
    expect(saved.state.semesters).toEqual([]);
    expect(saved.state.taken).toEqual([{ course: "COMPSCI 61A", source: "manual" }]);
  });

  it("keeps saving for older clients that send no baseVersion", async () => {
    const id = insertUser("legacy@berkeley.edu", "x")!;
    current = { id, email: "legacy@berkeley.edu", emailVerified: true };
    expect((await put({ state: plan(["a"]) })).status).toBe(200);
    const res = await put({ state: plan(["b"]) });
    expect((await res.json()).version).toBe(2);
  });

  it("adds the version column to an existing plans table", () => {
    const cols = (getDb().prepare("PRAGMA table_info(plans)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("version");
  });
});
