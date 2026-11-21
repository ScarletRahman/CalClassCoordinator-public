import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { NO_STORE, publicUser } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  return NextResponse.json({ user: user ? publicUser(user) : null }, { headers: NO_STORE });
}
