import { NextResponse } from "next/server";
import { loadCourseDetails, loadCourseInsight } from "@/lib/catalog";
import { MINUTE, clientIp, limit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";

export function GET(req: Request) {
  const limited = limit([{ bucket: "course-ip", key: clientIp(req), limit: 120, windowMs: MINUTE }]);
  if (limited) return limited;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id || id.length > 40) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  return NextResponse.json({ details: loadCourseDetails(id), insight: loadCourseInsight(id) }, { headers: { "cache-control": "private, max-age=3600" } });
}
