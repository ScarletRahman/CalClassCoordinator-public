import type { PlannedCourse, PlannerState, SemesterPlan, TakenCourse } from "./types";

/**
 * Coerces anything read from outside the app (localStorage, another tab, the server, a PUT body)
 * into a PlannerState the UI can render. Malformed entries are dropped and counted; unknown keys
 * are kept so fields added later by newer code survive a round trip. Pure, no React, so the
 * server can use it too. Re-exported from store.tsx.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const SOURCES = new Set(["transcript", "manual", "ap", "transfer"]);

export interface SanitizeReport {
  state: PlannerState | null;
  /** How many entries (or whole fields) were malformed and dropped or reset. */
  dropped: number;
}

export function sanitizeStateReport(raw: unknown): SanitizeReport {
  if (!isObj(raw)) return { state: null, dropped: 0 };
  let dropped = 0;

  const strings = (v: unknown): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return dropped++, [];
    const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
    dropped += v.length - out.length;
    return out;
  };
  const optString = (v: unknown): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v;
    dropped++;
    return null;
  };
  const record = <T,>(v: unknown, ok: (x: unknown) => x is T): Record<string, T> => {
    const out: Record<string, T> = {};
    if (v === undefined || v === null) return out;
    if (!isObj(v)) return dropped++, out;
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__") continue;
      if (ok(x)) out[k] = x;
      else dropped++;
    }
    return out;
  };

  const taken: TakenCourse[] = [];
  const rawTaken = raw.taken;
  if (Array.isArray(rawTaken)) {
    for (const t of rawTaken) {
      if (!isObj(t) || typeof t.course !== "string" || !t.course) {
        dropped++;
        continue;
      }
      const e = { ...t } as Obj;
      if (!SOURCES.has(e.source as string)) e.source = "manual";
      if (e.term !== undefined && typeof e.term !== "string") delete e.term;
      if (e.grade !== undefined && typeof e.grade !== "string") delete e.grade;
      if (e.label !== undefined && typeof e.label !== "string") delete e.label;
      if (e.units !== undefined && !(typeof e.units === "number" && Number.isFinite(e.units))) delete e.units;
      taken.push(e as unknown as TakenCourse);
    }
  } else if (rawTaken !== undefined && rawTaken !== null) dropped++;

  const semesters: SemesterPlan[] = [];
  const rawSem = raw.semesters;
  if (Array.isArray(rawSem)) {
    const seen = new Set<string>();
    for (const s of rawSem) {
      if (!isObj(s) || typeof s.term !== "string" || !s.term || seen.has(s.term)) {
        dropped++;
        continue;
      }
      seen.add(s.term);
      const courses: PlannedCourse[] = [];
      if (Array.isArray(s.courses)) {
        for (const c of s.courses) {
          if (typeof c === "string" && c) courses.push({ course: c });
          else if (isObj(c) && typeof c.course === "string" && c.course) {
            const e = { ...c } as Obj;
            if (e.professor !== undefined && typeof e.professor !== "string") delete e.professor;
            courses.push(e as unknown as PlannedCourse);
          } else dropped++;
        }
      } else if (s.courses !== undefined && s.courses !== null) dropped++;
      semesters.push({ ...s, term: s.term, courses });
    }
  } else if (rawSem !== undefined && rawSem !== null) dropped++;

  const choices: Record<string, Record<string, string[]>> = {};
  if (isObj(raw.choices)) {
    for (const [g, byChoice] of Object.entries(raw.choices)) {
      if (g === "__proto__") continue;
      if (!isObj(byChoice)) {
        dropped++;
        continue;
      }
      const inner: Record<string, string[]> = {};
      for (const [c, ids] of Object.entries(byChoice)) {
        if (c === "__proto__") continue;
        const list = strings(ids);
        if (list.length) inner[c] = list;
      }
      choices[g] = inner;
    }
  } else if (raw.choices !== undefined && raw.choices !== null) dropped++;

  const state: PlannerState = {
    version: 1,
    majorIds: strings(raw.majorIds),
    minorGroupIds: strings(raw.minorGroupIds),
    year: optString(raw.year) as PlannerState["year"],
    startTerm: optString(raw.startTerm),
    taken,
    semesters,
    manualChecks: record(raw.manualChecks, (x): x is boolean => typeof x === "boolean"),
    pins: record(raw.pins, (x): x is string => typeof x === "string"),
    choices,
  };
  // Fields added by newer code (or by other features) ride along untouched, after the known ones.
  for (const [k, v] of Object.entries(raw)) if (k !== "__proto__" && !(k in state)) (state as unknown as Obj)[k] = v;
  return { state, dropped };
}

/** The planner state in `raw`, cleaned up; null only when `raw` is not an object at all. */
export function sanitizeState(raw: unknown): PlannerState | null {
  return sanitizeStateReport(raw).state;
}

/** Stable serialisation for comparing two plans (sanitised, so key order and junk don't matter). */
export function canonicalPlan(raw: unknown): string {
  return JSON.stringify(sanitizeState(raw));
}
