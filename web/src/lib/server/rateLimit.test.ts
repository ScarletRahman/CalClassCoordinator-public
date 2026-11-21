import { beforeEach, describe, expect, it } from "vitest";
import { _resetAll, _size, clientIp, hit, limit, reset } from "./rateLimit";

beforeEach(() => _resetAll());

describe("fixed-window rate limiter", () => {
  it("allows up to the limit, then blocks until the window ends", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(hit("b", "k", 3, 60_000, t + i).ok).toBe(true);
    const blocked = hit("b", "k", 3, 60_000, t + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBe(60);
    expect(hit("b", "other", 3, 60_000, t + 10).ok).toBe(true);
    expect(hit("other-bucket", "k", 3, 60_000, t + 10).ok).toBe(true);
    expect(hit("b", "k", 3, 60_000, t + 60_000).ok).toBe(true);
  });

  it("reset forgets a key", () => {
    for (let i = 0; i < 5; i++) hit("b", "k", 1, 60_000);
    reset("b", "k");
    expect(hit("b", "k", 1, 60_000).ok).toBe(true);
  });

  it("stays bounded", () => {
    for (let i = 0; i < 60_000; i++) hit("flood", String(i), 1, 60_000);
    expect(_size()).toBeLessThanOrEqual(50_000);
  });

  it("limit() returns 429 with Retry-After for the tightest exceeded check", async () => {
    const checks = [
      { bucket: "a", key: "x", limit: 1, windowMs: 60_000 },
      { bucket: "c", key: "x", limit: 5, windowMs: 3_600_000 },
    ];
    expect(limit(checks)).toBeNull();
    const res = limit(checks, "slow down")!;
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await res.json()).error).toBe("slow down");
  });
});

describe("clientIp", () => {
  const req = (h: Record<string, string>) => new Request("http://x/", { headers: h });
  it("prefers fly-client-ip, then first x-forwarded-for, then x-real-ip", () => {
    expect(clientIp(req({ "fly-client-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2", "x-real-ip": "3.3.3.3" }))).toBe("1.1.1.1");
    expect(clientIp(req({ "x-forwarded-for": " 2.2.2.2 , 9.9.9.9", "x-real-ip": "3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIp(req({ "x-real-ip": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(req({}))).toBe("unknown");
  });
});
