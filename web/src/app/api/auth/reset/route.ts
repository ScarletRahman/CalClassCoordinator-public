import { NextResponse } from "next/server";
import { hashPassword, passwordProblem } from "@/lib/server/auth";
import { deleteEmailTokens, deleteUserSessions, markEmailVerified, setPasswordHash } from "@/lib/server/db";
import { consumeEmailToken } from "@/lib/server/emailTokens";
import { badRequest, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { HOUR, clientIp, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

/** Sets a new password from a reset link. Signs the account out everywhere. */
export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const limited = limit([{ bucket: "reset-ip", key: clientIp(req), limit: 10, windowMs: HOUR }]);
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const password = typeof body.password === "string" ? body.password : "";
  const problem = passwordProblem(password);
  if (problem) return badRequest(problem); // checked first so a weak password doesn't burn the link
  const hash = await hashPassword(password);
  const userId = consumeEmailToken(typeof body.token === "string" ? body.token : "", "reset");
  if (userId === null) {
    return NextResponse.json({ error: "This reset link is invalid, expired, or already used." }, { status: 400 });
  }
  setPasswordHash(userId, hash);
  deleteUserSessions(userId);
  deleteEmailTokens(userId, "reset");
  markEmailVerified(userId); // they proved they read mail at this address
  return NextResponse.json({ ok: true });
}
