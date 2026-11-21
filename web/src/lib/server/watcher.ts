import { watcherApiToken, watcherUrl } from "./env";

/** Headers for calls to the seat watcher's HTTP API (adds the bearer token when configured). */
export function watcherHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = watcherApiToken();
  return { ...extra, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

export interface WatcherSub {
  email: string;
  classNumber: string;
  includeReserved?: boolean;
  term?: string | null;
  /** Catalog course id, e.g. "COMPSCI 61A". Berkeleytime cannot find a class by number alone. */
  course?: string | null;
}

/**
 * Forwards a subscription change to the watcher. Returns "skipped" when WATCHER_URL is unset,
 * otherwise whether the watcher accepted it. Never throws.
 */
export async function watcherSubscription(method: "POST" | "DELETE", sub: WatcherSub): Promise<"ok" | "failed" | "skipped"> {
  const base = watcherUrl();
  if (!base) return "skipped";
  const body =
    method === "POST"
      ? { email: sub.email, classNumber: sub.classNumber, includeReserved: !!sub.includeReserved, ...(sub.term ? { term: sub.term } : {}), ...(sub.course ? { course: sub.course } : {}) }
      : { email: sub.email, classNumber: sub.classNumber };
  try {
    const r = await fetch(`${base}/subscriptions`, {
      method,
      headers: watcherHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    // A DELETE for something the watcher no longer has is fine.
    if (r.ok || (method === "DELETE" && r.status === 404)) return "ok";
    console.error(`[watcher] ${method} /subscriptions -> ${r.status}`);
    return "failed";
  } catch (e) {
    console.error(`[watcher] ${method} /subscriptions failed:`, (e as Error).message);
    return "failed";
  }
}
