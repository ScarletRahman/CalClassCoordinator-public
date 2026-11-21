import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkOrigin, originAllowed } from "./origin";

const req = (h: Record<string, string>) => new Request("http://localhost:3000/api/x", { method: "POST", headers: h });

afterEach(() => {
  delete process.env.APP_URL;
});

describe("origin check", () => {
  it("allows requests without an Origin header", () => {
    expect(originAllowed(req({ host: "localhost:3000" }))).toBe(true);
  });

  it("allows same-host and APP_URL origins", () => {
    expect(originAllowed(req({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true);
    expect(originAllowed(req({ host: "planner.example.org", origin: "https://planner.example.org" }))).toBe(true);
    process.env.APP_URL = "https://planner.example.org/";
    expect(originAllowed(req({ host: "internal:3000", origin: "https://planner.example.org" }))).toBe(true);
  });

  it("blocks other origins and the opaque 'null' origin with 403", async () => {
    expect(originAllowed(req({ host: "localhost:3000", origin: "https://evil.example" }))).toBe(false);
    expect(originAllowed(req({ host: "localhost:3000", origin: "http://localhost:3000.evil.example" }))).toBe(false);
    expect(originAllowed(req({ host: "localhost:3000", origin: "null" }))).toBe(false);
    const res = checkOrigin(req({ host: "localhost:3000", origin: "https://evil.example" }));
    expect(res?.status).toBe(403);
  });

  it("is called by every mutating API route", () => {
    const root = path.resolve(__dirname, "../../app/api");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "route.ts") files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const mutating = (src.match(/export (async )?function (POST|PUT|DELETE|PATCH)\b/g) ?? []).length;
      const checks = (src.match(/checkOrigin\(req\)/g) ?? []).length;
      expect(checks, `${path.relative(root, f)} must call checkOrigin in each mutating handler`).toBe(mutating);
    }
  });
});
