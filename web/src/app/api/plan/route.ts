import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { getPlan, savePlanIfVersion, upsertPlan, type PlanRow } from "@/lib/server/db";
import { checkOrigin } from "@/lib/server/origin";
import { MINUTE, limit } from "@/lib/server/rateLimit";
import { sanitizeState } from "@/lib/sanitizeState";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 512 * 1024;
const NO_STORE = { "Cache-Control": "no-store" };

function unauthorized() {
  return NextResponse.json({ error: "Sign in to save your plan." }, { status: 401, headers: NO_STORE });
}

/** The saved plan as the client sees it. A row that no longer parses comes back as null state. */
function planBody(row: PlanRow | undefined) {
  let state = null;
  if (row) {
    try {
      state = sanitizeState(JSON.parse(row.state_json));
    } catch {
      state = null;
    }
  }
  return {
    state,
    updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    version: row ? row.version : null,
  };
}

/** GET: { state, updatedAt, version } (all null when nothing is saved yet). */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return unauthorized();
  return NextResponse.json(planBody(getPlan(user.id)), { headers: NO_STORE });
}

/**
 * PUT { state, baseVersion }: saves only if `baseVersion` (the version the client last saw; null
 * when it saw no saved plan) is still current. Otherwise 409 with the current { state, updatedAt,
 * version }, so a stale tab or device never overwrites newer data. A body without baseVersion
 * (older clients) saves unconditionally.
 */
export async function PUT(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const user = await getSessionUser();
  if (!user) return unauthorized();
  const limited = limit([{ bucket: "plan-user", key: String(user.id), limit: 120, windowMs: MINUTE }]);
  if (limited) return limited;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BYTES) {
    return NextResponse.json({ error: "Plan is too large to save." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const b = (body && typeof body === "object" ? body : {}) as { state?: unknown; baseVersion?: unknown };
  const given = b.state as { version?: unknown } | null | undefined;
  const state = given && given.version === 1 ? sanitizeState(given) : null;
  if (!state) return NextResponse.json({ error: "Invalid plan state." }, { status: 400 });
  const hasBase = "baseVersion" in b;
  const base = b.baseVersion;
  if (hasBase && base !== null && !(Number.isInteger(base) && (base as number) >= 0)) {
    return NextResponse.json({ error: "Invalid baseVersion." }, { status: 400 });
  }
  const json = JSON.stringify(state);
  if (!hasBase) {
    const updatedAt = upsertPlan(user.id, json);
    const row = getPlan(user.id);
    return NextResponse.json({ ok: true, updatedAt: new Date(updatedAt).toISOString(), version: row?.version ?? null });
  }
  const r = savePlanIfVersion(user.id, json, base as number | null);
  if (!r.ok) {
    return NextResponse.json(
      { error: "Your plan was changed somewhere else.", conflict: true, ...planBody(r.current) },
      { status: 409, headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, updatedAt: new Date(r.updatedAt).toISOString(), version: r.version });
}
