import { NextResponse } from "next/server";
import { createSession, getSessionUser, hashPassword, PASSWORD_MAX, passwordProblem, verifyPassword } from "@/lib/server/auth";
import { deleteUserSessions, findUserById, setPasswordHash } from "@/lib/server/db";
import { badRequest, notSignedIn, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { MINUTE, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

/** Change password while signed in. Signs out other sessions and starts a fresh one here. */
export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const user = await getSessionUser();
  if (!user) return notSignedIn();
  const limited = limit([{ bucket: "password-user", key: String(user.id), limit: 10, windowMs: 15 * MINUTE }]);
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  const row = findUserById(user.id);
  if (!row || !(await verifyPassword(current.slice(0, PASSWORD_MAX), row.password_hash))) {
    return NextResponse.json({ error: "Current password is incorrect." }, { status: 403 });
  }
  const problem = passwordProblem(next);
  if (problem) return badRequest(problem);
  setPasswordHash(user.id, await hashPassword(next));
  deleteUserSessions(user.id);
  await createSession(user.id);
  return NextResponse.json({ ok: true });
}
