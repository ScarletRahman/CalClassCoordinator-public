import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { sendVerificationEmail } from "@/lib/server/emailTokens";
import { notSignedIn } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { HOUR, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const user = await getSessionUser();
  if (!user) return notSignedIn();
  if (user.emailVerified) return NextResponse.json({ ok: true, alreadyVerified: true });
  const limited = limit(
    [{ bucket: "resend-user", key: String(user.id), limit: 3, windowMs: HOUR }],
    "We've sent a few emails already. Check your inbox (and spam), or try again in an hour.",
  );
  if (limited) return limited;
  const sent = await sendVerificationEmail(user.id, user.email);
  if (!sent) {
    return NextResponse.json(
      { error: "We could not send the verification email right now. Try again later.", sent: false },
      { status: 503, headers: { "Retry-After": "300" } },
    );
  }
  return NextResponse.json({ ok: true, sent: true });
}
