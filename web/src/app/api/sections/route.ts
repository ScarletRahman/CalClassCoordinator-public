import { NextResponse } from "next/server";
import { MINUTE, clientIp, limit } from "@/lib/server/rateLimit";
import { TERM_RE, getSections } from "@/lib/server/scheduleData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COURSE_RE = /^[A-Z0-9&,/ -]+ [A-Z]*\d+[A-Z0-9]*$/;

/** Class times and seats for one course in one term. Shape: docs/schedule.md. */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const live = params.get("live") === "1";
  const ip = clientIp(req);
  const limited = limit([
    { bucket: "sections-ip", key: ip, limit: 120, windowMs: MINUTE },
    ...(live ? [{ bucket: "sections-live-ip", key: ip, limit: 30, windowMs: MINUTE }] : []),
  ]);
  if (limited) return limited;
  const course = (params.get("course") ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  const term = (params.get("term") ?? "").trim();
  if (!course || course.length > 40 || !COURSE_RE.test(course)) return NextResponse.json({ error: "Missing or malformed course." }, { status: 400 });
  if (!TERM_RE.test(term)) return NextResponse.json({ error: "Missing or malformed term." }, { status: 400 });
  const answer = await getSections(course, term, { live });
  return NextResponse.json(answer, { headers: { "cache-control": live ? "no-store" : "private, max-age=60" } });
}
