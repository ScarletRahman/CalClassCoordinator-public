import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { countAlerts, deleteAlert, findAlert, listAlerts, upsertAlert, type AlertRow } from "@/lib/server/db";
import { watcherUrl } from "@/lib/server/env";
import { NO_STORE, badRequest, notSignedIn, readJsonObject } from "@/lib/server/http";
import { checkOrigin } from "@/lib/server/origin";
import { HOUR, limit } from "@/lib/server/rateLimit";
import { watcherSubscription } from "@/lib/server/watcher";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Seat alerts for the signed-in, email-verified user. Alerts always go to the account's own
 * email. The alert_subscriptions table is the source of truth; when WATCHER_URL is set, each
 * change is forwarded to the watcher, which sends the emails.
 */

const MAX_ALERTS = 25;

function view(a: AlertRow) {
  return { classNumber: a.class_number, course: a.course, term: a.term, includeReserved: !!a.include_reserved, createdAt: new Date(a.created_at).toISOString() };
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return notSignedIn("Sign in to see your seat alerts.");
  return NextResponse.json({ alerts: listAlerts(user.id).map(view), watcherConnected: !!watcherUrl() }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const user = await getSessionUser();
  if (!user) return notSignedIn("Sign in to get seat alerts.");
  if (!user.emailVerified) {
    return NextResponse.json({ error: "Verify your email first, then try again." }, { status: 403 });
  }
  const limited = limit([{ bucket: "alerts-user", key: String(user.id), limit: 20, windowMs: HOUR }]);
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const classNumber = String(body.classNumber ?? "").trim();
  if (!/^\d{1,10}$/.test(classNumber)) return badRequest("Missing or invalid class number.");
  const term = typeof body.term === "string" && /^[\w -]{1,20}$/.test(body.term.trim()) ? body.term.trim() : null;
  const course = typeof body.course === "string" ? body.course.trim().slice(0, 40) : "";
  const includeReserved = !!body.includeReserved;

  const existed = findAlert(user.id, classNumber);
  if (!existed && countAlerts(user.id) >= MAX_ALERTS) {
    return NextResponse.json(
      { error: `You can have up to ${MAX_ALERTS} seat alerts. Remove one from the account menu first.` },
      { status: 409 },
    );
  }
  upsertAlert({ user_id: user.id, class_number: classNumber, course, term, include_reserved: includeReserved ? 1 : 0 });

  const forwarded = await watcherSubscription("POST", { email: user.email, classNumber, includeReserved, term, course });
  if (forwarded === "failed") {
    // Keep the table and the watcher in step: undo a new row the watcher didn't accept.
    if (existed) upsertAlert(existed, existed.created_at);
    else deleteAlert(user.id, classNumber);
    return NextResponse.json({ error: "The seat alert service didn't respond. Please try again." }, { status: 502 });
  }
  return NextResponse.json({ ok: true, delivered: forwarded === "ok" }, { status: existed ? 200 : 201 });
}

export async function DELETE(req: Request) {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const user = await getSessionUser();
  if (!user) return notSignedIn();
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const classNumber = String(body.classNumber ?? "").trim();
  if (!/^\d{1,10}$/.test(classNumber)) return badRequest("Missing or invalid class number.");
  const removed = deleteAlert(user.id, classNumber);
  if (!removed) return NextResponse.json({ error: "No alert for that class." }, { status: 404 });
  await watcherSubscription("DELETE", { email: user.email, classNumber });
  return NextResponse.json({ ok: true });
}
