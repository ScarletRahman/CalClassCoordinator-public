import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/server/auth";
import { findUserById, getPlan, listAlerts } from "@/lib/server/db";
import { notSignedIn } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Everything stored about the signed-in user, as a JSON download. */
export async function GET() {
  const session = await getSessionUser();
  if (!session) return notSignedIn();
  const user = findUserById(session.id);
  if (!user) return notSignedIn();
  const plan = getPlan(user.id);
  const data = {
    exportedAt: new Date().toISOString(),
    account: {
      email: user.email,
      createdAt: new Date(user.created_at).toISOString(),
      emailVerifiedAt: user.email_verified_at ? new Date(user.email_verified_at).toISOString() : null,
      note: "Your password is stored only as a salted scrypt hash and is not included.",
    },
    plan: plan ? { updatedAt: new Date(plan.updated_at).toISOString(), state: JSON.parse(plan.state_json) as unknown } : null,
    seatAlerts: listAlerts(user.id).map((a) => ({
      classNumber: a.class_number,
      course: a.course,
      term: a.term,
      includeReserved: !!a.include_reserved,
      createdAt: new Date(a.created_at).toISOString(),
    })),
  };
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="calclasscoordinator-data.json"',
      "Cache-Control": "no-store",
    },
  });
}
