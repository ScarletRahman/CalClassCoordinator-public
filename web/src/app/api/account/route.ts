import { NextResponse } from "next/server";
import { destroySession, getSessionUser } from "@/lib/server/auth";
import { deleteUser, listAlerts } from "@/lib/server/db";
import { notSignedIn } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { HOUR, limit } from "@/lib/server/rateLimit";
import { watcherSubscription } from "@/lib/server/watcher";

export const runtime = "nodejs";

/** Deletes the signed-in user's account, sessions, saved plan and seat alerts. */
export async function DELETE(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const user = await getSessionUser();
  if (!user) return notSignedIn();
  const limited = limit([{ bucket: "delete-user", key: String(user.id), limit: 10, windowMs: HOUR }]);
  if (limited) return limited;
  const alerts = listAlerts(user.id);
  deleteUser(user.id);
  await destroySession();
  // Best effort: stop the watcher emailing this address. Failures are logged by watcherSubscription.
  await Promise.allSettled(alerts.map((a) => watcherSubscription("DELETE", { email: user.email, classNumber: a.class_number })));
  return NextResponse.json({ ok: true });
}
