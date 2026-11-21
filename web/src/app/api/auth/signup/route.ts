import { NextResponse } from "next/server";
import { createSession, hashPassword, passwordProblem } from "@/lib/server/auth";
import { insertUser, normalizeEmail } from "@/lib/server/db";
import { sendVerificationEmail } from "@/lib/server/emailTokens";
import { badRequest, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { HOUR, clientIp, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const limited = limit(
    [{ bucket: "signup-ip", key: clientIp(req), limit: 5, windowMs: HOUR }],
    "Too many accounts created from this network. Try again later.",
  );
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!EMAIL_RE.test(email) || email.length > 254) return badRequest("Enter a valid email address.");
  const problem = passwordProblem(password);
  if (problem) return badRequest(problem);
  const id = insertUser(email, await hashPassword(password));
  if (id === null) {
    return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });
  }
  await createSession(id);
  // The account exists either way; emailSent tells the UI whether to say "check your inbox" or
  // "we could not send it, try again later". (The 409 above already reveals existing addresses.)
  const emailSent = await sendVerificationEmail(id, email);
  return NextResponse.json({ user: { id, email, emailVerified: false }, emailSent }, { status: 201 });
}
