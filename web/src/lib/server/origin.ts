import { NextResponse } from "next/server";
import { appOrigin } from "./env";

/**
 * CSRF defence for state-changing API routes, on top of the SameSite=Lax session cookie.
 * Browsers send an Origin header on cross-site POST/PUT/DELETE; if it is present it must be this
 * site (the request's Host, or APP_URL's origin). Requests without Origin (curl, older clients)
 * are allowed, because a browser making a cross-site mutating fetch always sends one.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false; // includes "null"
  }
  if (originUrl.origin === appOrigin()) return true;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host");
  return !!host && originUrl.host.toLowerCase() === host.toLowerCase();
}

/** Returns a 403 response for a cross-site request, or null to continue. */
export function checkOrigin(req: Request): NextResponse | null {
  if (originAllowed(req)) return null;
  return NextResponse.json({ error: "Cross-site request blocked." }, { status: 403 });
}
