import { NextResponse } from "next/server";
import { findUserByEmail, normalizeEmail } from "@/lib/server/db";
import { sendResetEmail } from "@/lib/server/emailTokens";
import { isProduction } from "@/lib/server/env";
import { mailConfigured } from "@/lib/server/mail";
import { badRequest, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { HOUR, clientIp, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

const SAME_ANSWER = { ok: true, message: "If an account exists for that email, we've sent a link to reset the password." };

/** Starts a password reset. Answers the same whether or not the email has an account. */
export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const email = typeof body.email === "string" ? normalizeEmail(body.email).slice(0, 254) : "";
  const limited = limit(
    [
      { bucket: "forgot-ip", key: clientIp(req), limit: 5, windowMs: HOUR },
      { bucket: "forgot-email", key: email, limit: 3, windowMs: HOUR },
    ],
    "Too many reset requests. Try again in an hour.",
  );
  if (limited) return limited;
  // Whether this server can send email at all is the same for every address, so saying so
  // reveals nothing about accounts. Per-address delivery failures stay silent (below). In
  // development the link is printed to the server log instead, so the flow still works there.
  if (!mailConfigured() && isProduction()) {
    return NextResponse.json(
      { error: "We can't send password reset emails right now. Try again later.", sent: false },
      { status: 503, headers: { "Retry-After": "300" } },
    );
  }
  const user = email ? findUserByEmail(email) : undefined;
  // Not awaited, so response time doesn't reveal whether the account exists.
  if (user) void sendResetEmail(user.id, user.email);
  return NextResponse.json(SAME_ANSWER);
}
