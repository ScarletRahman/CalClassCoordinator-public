import "server-only";
import fs from "node:fs";
import path from "node:path";
import { dataDir, watcherUrl } from "./server/env";
import { watcherHeaders } from "./server/watcher";
import { normalizeTerm } from "./terms";
import type { Catalog, College, Course, CourseDetails, CourseInsight, Major, Minor, SubjectInfo, PredictionsFile, RequirementGroup, SeatsFile } from "./types";

/**
 * Real data from the other parts of the project lives in the repo-level data/ folder
 * (see docs/data-contracts.md). Until a part lands, we fall back to web/stub-data/.
 */
const DATA_DIR = dataDir();
const STUB_DIR = path.resolve(process.cwd(), "stub-data");

/**
 * `live` files describe the real world right now (seats, forecasts, ratings). Made-up sample
 * values for those must never reach students, so in production they have no stub fallback.
 */
function readJson<T>(rel: string, live = false): { value: T; source: "data" | "stub" } | null {
  const dirs = [
    [DATA_DIR, "data"],
    [STUB_DIR, "stub"],
  ] as const;
  for (const [dir, source] of live && process.env.NODE_ENV === "production" ? dirs.slice(0, 1) : dirs) {
    const p = path.join(dir, rel);
    try {
      if (fs.existsSync(p)) return { value: JSON.parse(fs.readFileSync(p, "utf8")) as T, source };
    } catch (e) {
      console.error(`[catalog] failed to read ${p}:`, e);
    }
  }
  return null;
}

function readGroups(): { groups: RequirementGroup[]; source: "data" | "stub" | "none" } {
  for (const [dir, source] of [
    [DATA_DIR, "data"],
    [STUB_DIR, "stub"],
  ] as const) {
    const g = path.join(dir, "requirements", "groups");
    if (!fs.existsSync(g)) continue;
    const groups: RequirementGroup[] = [];
    for (const f of fs.readdirSync(g)) {
      if (!f.endsWith(".json")) continue;
      try {
        groups.push(JSON.parse(fs.readFileSync(path.join(g, f), "utf8")));
      } catch (e) {
        console.error(`[catalog] bad group file ${f}:`, e);
      }
    }
    if (groups.length) return { groups, source };
  }
  return { groups: [], source: "none" };
}

async function fetchSeats(): Promise<{ value: SeatsFile; source: "data" } | null> {
  const url = watcherUrl();
  if (!url) return null;
  try {
    const r = await fetch(`${url}/seats`, { cache: "no-store", headers: watcherHeaders(), signal: AbortSignal.timeout(3000) });
    if (r.ok) return { value: (await r.json()) as SeatsFile, source: "data" };
  } catch {
    /* fall back to file */
  }
  return null;
}

/** The watcher may send null where classes.berkeley.edu omits a number. */
function normalizeSeats(f: SeatsFile): SeatsFile {
  const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
  return {
    ...f,
    sections: (f.sections ?? []).map((s) => ({
      ...s,
      classNumber: String(s.classNumber),
      enrolled: n(s.enrolled),
      capacity: n(s.capacity),
      waitlisted: n(s.waitlisted),
      waitlistCapacity: n(s.waitlistCapacity),
      open: !!s.open,
      reserved: (s.reserved ?? []).map((r) => ({ ...r, enrolled: n(r.enrolled), capacity: n(r.capacity) })),
    })),
  };
}

/** The predictor writes "Spring 2027" and null professors; the planner uses "2027 Spring" and undefined. */
export function normalizePredictions(f: PredictionsFile): PredictionsFile {
  return {
    ...f,
    term: normalizeTerm(f.term),
    predictions: (f.predictions ?? []).map((p) => ({ ...p, professor: p.professor ?? undefined })),
  };
}

let cache: { at: number; catalog: Catalog } | null = null;
const TTL_MS = 60_000;

export async function loadCatalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.catalog;
  const courses = readJson<Course[]>("courses.json");
  const colleges = readJson<College[]>("requirements/colleges.json");
  const majors = readJson<Major[]>("requirements/majors.json");
  const minors = readJson<Minor[]>("requirements/minors.json");
  const subjects = readJson<SubjectInfo[]>("subjects.json");
  const predictions = readJson<PredictionsFile>("predictions/predictions.json", true);
  const seats = (await fetchSeats()) ?? readJson<SeatsFile>("seats/latest.json", true);
  const insights = readJson<CourseInsight[]>("insights/insights.json", true);
  const { groups, source: groupSource } = readGroups();
  const catalog: Catalog = {
    courses: courses?.value ?? [],
    colleges: colleges?.value ?? [],
    majors: (majors?.value ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    minors: (minors?.value ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
    subjects: (subjects?.value ?? []).map((s) => ({ code: s.code, aliases: s.aliases ?? [] })),
    groups,
    predictions: predictions?.value ? normalizePredictions(predictions.value) : null,
    seats: seats?.value ? normalizeSeats(seats.value) : null,
    insights: insights?.value ?? [],
    sources: {
      courses: courses?.source ?? "none",
      requirements: majors?.source ?? "none",
      groups: groupSource,
      predictions: predictions?.source ?? "none",
      seats: seats?.source ?? "none",
      insights: insights?.source ?? "none",
    },
  };
  cache = { at: Date.now(), catalog };
  return catalog;
}

let detailsCache: { at: number; details: Record<string, CourseDetails> } | null = null;

/** Descriptions and prerequisites are kept out of the main catalog to keep the page small. */
export function loadCourseDetails(id: string): CourseDetails | null {
  if (!detailsCache || Date.now() - detailsCache.at > 10 * TTL_MS) {
    detailsCache = { at: Date.now(), details: readJson<Record<string, CourseDetails>>("course_details.json")?.value ?? {} };
  }
  return detailsCache.details[id] ?? null;
}

const insightCache = new Map<string, { at: number; bySubject: Record<string, CourseInsight> }>();

/**
 * Full class insight (grades, professors, reviews). Kept out of the main catalog, which only
 * carries the two ratings, and read one subject file at a time.
 */
export function loadCourseInsight(id: string): CourseInsight | null {
  const subject = id.slice(0, id.lastIndexOf(" "));
  if (!/^[A-Z0-9]+$/.test(subject)) return null;
  let hit = insightCache.get(subject);
  if (!hit || Date.now() - hit.at > 10 * TTL_MS) {
    const file = path.join(DATA_DIR, "insights", "details", `${subject}.json`);
    let bySubject: Record<string, CourseInsight> = {};
    try {
      if (fs.existsSync(file)) bySubject = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CourseInsight>;
    } catch (e) {
      console.error(`[catalog] failed to read ${file}:`, e);
    }
    hit = { at: Date.now(), bySubject };
    insightCache.set(subject, hit);
  }
  return hit.bySubject[id] ?? null;
}
