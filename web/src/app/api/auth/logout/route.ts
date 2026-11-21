import { NextResponse } from "next/server";
import { destroySession } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/origin";
import { MINUTE, clientIp, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const limited = limit([{ bucket: "logout-ip", key: clientIp(req), limit: 60, windowMs: MINUTE }]);
  if (limited) return limited;
  await destroySession();
  return NextResponse.json({ ok: true });
}
