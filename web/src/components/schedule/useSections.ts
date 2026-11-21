"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SectionsResponse } from "@/lib/schedule";
import type { CourseId, Term } from "@/lib/types";

export interface SectionsEntry {
  data?: SectionsResponse;
  /** loading = first (file) answer on its way; checking = live lookup running. */
  phase: "loading" | "checking" | "done" | "error";
  /** The live lookup failed before the server could even answer (offline, rate limited). */
  liveFailed?: boolean;
}

const REFRESH_COOLDOWN_MS = 30_000;
const keyOf = (term: Term, course: CourseId) => `${term}|${course}`;

async function getSections(term: Term, course: CourseId, live: boolean, signal: AbortSignal): Promise<SectionsResponse> {
  const qs = `course=${encodeURIComponent(course)}&term=${encodeURIComponent(term)}${live ? "&live=1" : ""}`;
  const r = await fetch(`/api/sections?${qs}`, { signal });
  if (!r.ok) throw new Error(`sections ${r.status}`);
  return (await r.json()) as SectionsResponse;
}

/**
 * Times and seats for each class in a term. Every class is fetched once from the term file
 * (instant) and then once more live; answers are kept by term + course so switching terms or
 * re-rendering never refetches. Everything in flight is aborted on unmount.
 */
export function useSections(term: Term, courses: CourseId[]) {
  const [store, setStore] = useState<Record<string, SectionsEntry>>({});
  const started = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const [coolingDown, setCoolingDown] = useState(false);

  useEffect(() => {
    const c = new AbortController();
    const keys = started.current;
    controller.current = c;
    return () => {
      c.abort();
      keys.clear();
    };
  }, []);

  const load = useCallback(async (t: Term, course: CourseId, liveOnly: boolean) => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    const key = keyOf(t, course);
    const patch = (p: Partial<SectionsEntry>) => {
      if (!signal.aborted) setStore((prev) => ({ ...prev, [key]: { ...prev[key], ...p } as SectionsEntry }));
    };
    if (!liveOnly) {
      patch({ phase: "loading", liveFailed: false });
      try {
        const data = await getSections(t, course, false, signal);
        // Last year's times have no live version to ask for.
        if (data.tentative) return patch({ data, phase: "done" });
        patch({ data, phase: "checking" });
      } catch {
        return patch({ phase: "error" });
      }
    } else {
      patch({ phase: "checking", liveFailed: false });
    }
    try {
      const data = await getSections(t, course, true, signal);
      patch({ data, phase: "done", liveFailed: false });
    } catch {
      patch({ phase: "done", liveFailed: true });
    }
  }, []);

  const coursesKey = courses.join("|");
  useEffect(() => {
    for (const course of coursesKey ? coursesKey.split("|") : []) {
      const key = keyOf(term, course);
      if (started.current.has(key)) continue;
      started.current.add(key);
      void load(term, course, false);
    }
  }, [term, coursesKey, load]);

  useEffect(() => {
    if (!coolingDown) return;
    const t = setTimeout(() => setCoolingDown(false), REFRESH_COOLDOWN_MS);
    return () => clearTimeout(t);
  }, [coolingDown]);

  /** Re-runs the live lookup for every class of the term (or the first load, if that failed). */
  const refresh = useCallback(() => {
    if (coolingDown) return;
    setCoolingDown(true);
    for (const course of coursesKey ? coursesKey.split("|") : []) {
      const entry = store[keyOf(term, course)];
      if (!entry || entry.phase === "loading" || entry.phase === "checking") continue;
      if (entry.phase === "error" || !entry.data) void load(term, course, false);
      else if (!entry.data.tentative) void load(term, course, true);
    }
  }, [coolingDown, coursesKey, store, term, load]);

  /** Retry one class whose first load failed. */
  const retry = useCallback((course: CourseId) => void load(term, course, false), [term, load]);

  const entryFor = useCallback((course: CourseId): SectionsEntry => store[keyOf(term, course)] ?? { phase: "loading" }, [store, term]);

  return { entryFor, refresh, retry, coolingDown };
}

const SOURCE_NAMES: Record<string, string> = { berkeleytime: "Berkeleytime", "classes.berkeley.edu": "classes.berkeley.edu", file: "saved copy" };

function when(iso: string | null | undefined, now = new Date()): { time: string; date: string; today: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return {
    time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    date: d.toLocaleDateString([], { month: "short", day: "numeric" }),
    today: d.toDateString() === now.toDateString(),
  };
}

/** The small line under a card's title: how fresh the seat counts are. */
export function statusLine(entry: SectionsEntry): { text: string; tone: "muted" | "ok" | "warn"; busy?: boolean } | null {
  if (entry.phase === "loading") return { text: "Loading class times…", tone: "muted", busy: true };
  if (entry.phase === "error") return { text: "Couldn't load class times.", tone: "warn" };
  const data = entry.data;
  if (!data || data.tentative) return null;
  if (entry.phase === "checking") return { text: "Checking for the latest seats…", tone: "muted", busy: true };
  const at = when(data.asOf);
  if (data.live) {
    const source = SOURCE_NAMES[data.source] ?? data.source;
    const stamp = at ? (at.today ? at.time : `${at.date}, ${at.time}`) : "just now";
    return { text: `Seats checked ${stamp}${source && source !== "none" ? ` (${source})` : ""}`, tone: "ok" };
  }
  if (data.liveError || entry.liveFailed) {
    if (!at || !data.classes.length) return { text: "Could not check for the latest seats", tone: "warn" };
    return { text: `Seats as of ${at.today ? `${at.date}, ${at.time}` : at.date} (could not refresh)`, tone: "warn" };
  }
  return at ? { text: `Seats as of ${at.date}`, tone: "muted" } : null;
}
