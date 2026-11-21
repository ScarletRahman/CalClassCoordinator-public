import { NextResponse } from "next/server";
import type { SessionUser } from "./db";

/** Parses a JSON object body; returns null for anything else (bad JSON, arrays, too large). */
export async function readJsonObject(req: Request, maxBytes = 16 * 1024): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) return null;
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function badRequest(error = "Invalid request body."): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export function notSignedIn(error = "Not signed in."): NextResponse {
  return NextResponse.json({ error }, { status: 401 });
}

export function publicUser(u: SessionUser) {
  return { id: u.id, email: u.email, emailVerified: u.emailVerified };
}

export const NO_STORE = { "Cache-Control": "no-store" };
