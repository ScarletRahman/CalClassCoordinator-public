import { NextResponse } from "next/server";
import { getDb } from "@/lib/server/db";
import { NO_STORE } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness/readiness probe: the process is up and the database answers. No auth. */
export function GET() {
  try {
    getDb().prepare("SELECT 1").get();
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.error("[health] database check failed:", (e as Error).message);
    return NextResponse.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
}
