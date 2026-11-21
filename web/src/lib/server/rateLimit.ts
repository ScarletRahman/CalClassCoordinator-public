import { NextResponse } from "next/server";

/**
 * Fixed-window, in-memory rate limiter. The app runs as one long-lived Node process, so a Map is
 * enough. The map is bounded: when it grows past MAX_KEYS, expired windows are dropped first and
 * then the oldest entries, so a flood of distinct keys can't exhaust memory.
 */

const MAX_KEYS = 50_000;
const windows = new Map<string, { count: number; resetAt: number }>();

export interface LimitResult {
  ok: boolean;
  /** Seconds until the window resets (only meaningful when !ok). */
  retryAfter: number;
}

export function hit(bucket: string, key: string, limit: number, windowMs: number, now = Date.now()): LimitResult {
  const k = `${bucket}\u0000${key}`;
  let entry = windows.get(k);
  if (!entry || entry.resetAt <= now) {
    if (windows.size >= MAX_KEYS) prune(now);
    entry = { count: 0, resetAt: now + windowMs };
    windows.set(k, entry);
  }
  entry.count += 1;
  return { ok: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}

/** Forget a key (e.g. after a successful login). */
export function reset(bucket: string, key: string): void {
  windows.delete(`${bucket}\u0000${key}`);
}

function prune(now: number): void {
  for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
  // Still full: drop the oldest quarter (Map iterates in insertion order).
  if (windows.size >= MAX_KEYS) {
    let drop = Math.ceil(MAX_KEYS / 4);
    for (const k of windows.keys()) {
      if (drop-- <= 0) break;
      windows.delete(k);
    }
  }
}

/** Test helper. */
export function _resetAll(): void {
  windows.clear();
}

export function _size(): number {
  return windows.size;
}

/**
 * Best guess at the client's IP behind the proxy. Prefers the platform's own header
 * (fly-client-ip), then the first X-Forwarded-For entry, then X-Real-IP.
 * These headers are only trustworthy because the app is only reachable through the proxy.
 */
export function clientIp(req: Request): string {
  const h = req.headers;
  const fly = h.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const xff = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (xff) return xff;
  return h.get("x-real-ip")?.trim() || "unknown";
}

export function tooManyRequests(retryAfter: number, message = "Too many requests. Please try again later."): NextResponse {
  return NextResponse.json({ error: message }, { status: 429, headers: { "Retry-After": String(retryAfter) } });
}

/**
 * Checks several limits at once (all are counted). Returns a 429 response for the first one
 * exceeded, or null when the request may go ahead.
 */
export function limit(
  checks: { bucket: string; key: string; limit: number; windowMs: number }[],
  message?: string,
): NextResponse | null {
  let worst: LimitResult | null = null;
  for (const c of checks) {
    const r = hit(c.bucket, c.key, c.limit, c.windowMs);
    if (!r.ok && (!worst || r.retryAfter > worst.retryAfter)) worst = r;
  }
  return worst ? tooManyRequests(worst.retryAfter, message) : null;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
