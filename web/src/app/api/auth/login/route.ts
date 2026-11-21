import { NextResponse } from "next/server";
import { createSession, PASSWORD_MAX, verifyPassword } from "@/lib/server/auth";
import { findUserByEmail, normalizeEmail } from "@/lib/server/db";
import { badRequest, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { MINUTE, clientIp, limit, reset } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

// Dummy hash so unknown emails take similar time to known ones.
const DUMMY_HASH = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);

export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body.password === "string" ? body.password : "";
  const key = `${email}|${clientIp(req)}`;
  const limited = limit(
    [{ bucket: "login", key, limit: 10, windowMs: 15 * MINUTE }],
    "Too many sign-in attempts. Try again in 15 minutes.",
  );
  if (limited) return limited;
  const user = email ? findUserByEmail(email) : undefined;
  const ok = await verifyPassword(password.slice(0, PASSWORD_MAX), user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    return NextResponse.json({ error: "Incorrect email or password" }, { status: 401 });
  }
  reset("login", key);
  await createSession(user.id);
  return NextResponse.json({ user: { id: user.id, email: user.email, emailVerified: user.email_verified_at != null } });
}
