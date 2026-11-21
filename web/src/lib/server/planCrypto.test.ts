import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb, getPlan, insertUser, upsertPlan } from "./db";
import { planEncryptionKey } from "./env";
import { decryptPlan, encryptPlan, isEncrypted } from "./planCrypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccc-crypto-"));
const key = randomBytes(32);

beforeAll(() => {
  process.env.DATABASE_PATH = path.join(dir, "test.db");
});
afterEach(() => {
  delete process.env.PLAN_ENCRYPTION_KEY;
});
afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("plan encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const json = JSON.stringify({ version: 1, taken: [{ course: "COMPSCI 61A", grade: "A" }] });
    const a = encryptPlan(json, 7, key);
    expect(a.startsWith("enc:v1:")).toBe(true);
    expect(a).not.toContain("COMPSCI");
    expect(encryptPlan(json, 7, key)).not.toBe(a);
    expect(decryptPlan(a, 7, key)).toBe(json);
  });

  it("rejects a wrong key, a different user, or tampering", () => {
    const enc = encryptPlan("{}", 1, key);
    expect(() => decryptPlan(enc, 1, randomBytes(32))).toThrow();
    expect(() => decryptPlan(enc, 2, key)).toThrow();
    const parts = enc.split(":");
    parts[4] = Buffer.from("tampered").toString("base64");
    expect(() => decryptPlan(parts.join(":"), 1, key)).toThrow();
    expect(() => decryptPlan(enc, 1, null)).toThrow(/PLAN_ENCRYPTION_KEY/);
  });

  it("passes plaintext through when no key is set", () => {
    expect(encryptPlan("{}", 1, null)).toBe("{}");
    expect(decryptPlan('{"a":1}', 1, key)).toBe('{"a":1}');
  });

  it("parses hex and base64 keys and rejects bad ones", () => {
    process.env.PLAN_ENCRYPTION_KEY = key.toString("hex");
    expect(planEncryptionKey()?.equals(key)).toBe(true);
    process.env.PLAN_ENCRYPTION_KEY = key.toString("base64");
    expect(planEncryptionKey()?.equals(key)).toBe(true);
    process.env.PLAN_ENCRYPTION_KEY = "too-short";
    expect(() => planEncryptionKey()).toThrow();
  });

  it("encrypts at rest via the db layer and still reads legacy plaintext rows", () => {
    const id = insertUser("crypto@berkeley.edu", "x")!;
    // legacy row written before a key existed
    getDb().prepare("INSERT INTO plans (user_id, state_json, updated_at) VALUES (?, ?, ?)").run(id, '{"version":1,"majorIds":["cs"]}', 1);
    process.env.PLAN_ENCRYPTION_KEY = key.toString("base64");
    expect(JSON.parse(getPlan(id)!.state_json).majorIds).toEqual(["cs"]);

    upsertPlan(id, '{"version":1,"majorIds":["ds"]}');
    const raw = getDb().prepare("SELECT state_json FROM plans WHERE user_id = ?").get(id) as { state_json: string };
    expect(isEncrypted(raw.state_json)).toBe(true);
    expect(raw.state_json).not.toContain("ds");
    expect(JSON.parse(getPlan(id)!.state_json).majorIds).toEqual(["ds"]);
  });
});
