import { NextResponse } from "next/server";
import { markEmailVerified } from "@/lib/server/db";
import { consumeEmailToken } from "@/lib/server/emailTokens";
import { badRequest, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { MINUTE, clientIp, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

/** Consumes an email verification token from the link in the signup email. */
export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const limited = limit([{ bucket: "verify-ip", key: clientIp(req), limit: 30, windowMs: 15 * MINUTE }]);
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const userId = consumeEmailToken(typeof body.token === "string" ? body.token : "", "verify");
  if (userId === null) {
    return NextResponse.json({ error: "This link is invalid, expired, or already used." }, { status: 400 });
  }
  markEmailVerified(userId);
  return NextResponse.json({ ok: true });
}
