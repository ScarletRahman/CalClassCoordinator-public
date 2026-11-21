import fs from "node:fs";
import path from "node:path";
import { dataDir, watcherUrl } from "./env";
import { watcherHeaders } from "./watcher";
import { compareTerms, parseTerm } from "../terms";
import type { LookupResponse, ScheduleClass, ScheduleIndex, ScheduleSection, ScheduleTermFile, SectionsResponse } from "../schedule";
import type { CourseId, Term } from "../types";

/**
 * Class times for /api/sections (docs/schedule.md). Term files come from data/schedule/, or
 * web/stub-data/schedule/ until the real import has run. They are 2-4 MB each, so each is parsed
 * once and kept in memory until its mtime changes.
 */

// ---- pure parts ----

export const TERM_RE = /^\d{4} (Spring|Summer|Fall)$/;

/** "2027 Spring" -> "2027-spring.json" */
export function termFileName(term: Term): string {
  const { year, season } = parseTerm(term);
  return `${year}-${season.toLowerCase()}.json`;
}

/** "2027-spring.json" -> "2027 Spring", or null for any other file name. */
export function termOfFileName(name: string): Term | null {
  const m = /^(\d{4})-(spring|summer|fall)\.json$/.exec(name);
  return m ? `${m[1]} ${m[2][0].toUpperCase()}${m[2].slice(1)}` : null;
}

/**
 * The term whose file answers a request: the term itself when it is published, otherwise the
 * most recent earlier term of the same season (its times are then only tentative). Null when
 * neither exists.
 */
export function chooseBasisTerm(term: Term, published: readonly Term[]): Term | null {
  if (published.includes(term)) return term;
  const { season } = parseTerm(term);
  const earlier = published.filter((t) => parseTerm(t).season === season && compareTerms(t, term) < 0).sort(compareTerms);
  return earlier.at(-1) ?? null;
}

const SEAT_FIELDS = ["enrolled", "capacity", "waitlisted", "waitlistCapacity", "status", "open", "reserved"] as const;

function stripSection(s: ScheduleSection): ScheduleSection {
  const out: ScheduleSection = { ...s };
  for (const f of SEAT_FIELDS) delete out[f];
  return out;
}

/**
 * Drops seat counts, which belong to the old term. Class numbers stay: the builder keys its
 * selections on them, and a stale number is simply ignored once the real term is published.
 * Exam dates go too, since they carry the old year.
 */
export function stripSeats(classes: ScheduleClass[]): ScheduleClass[] {
  return classes.map((c) => {
    const { exams: _exams, ...rest } = c;
    void _exams;
    return { ...rest, primary: stripSection(c.primary), sections: (c.sections ?? []).map(stripSection) };
  });
}

/** The answer from files alone. `file` is the basis term's file, or null when there is none. */
export function fileAnswer(course: CourseId, term: Term, file: ScheduleTermFile | null, published: readonly Term[]): SectionsResponse {
  const publishedTerms = [...published].sort(compareTerms);
  if (!file) {
    return { course, term, basisTerm: null, tentative: false, classes: [], source: "none", asOf: null, live: false, publishedTerms };
  }
  const tentative = file.term !== term;
  const classes = file.courses?.[course] ?? [];
  return {
    course,
    term,
    basisTerm: file.term,
    tentative,
    classes: tentative ? stripSeats(classes) : classes,
    source: "file",
    asOf: file.generatedAt ?? null,
    live: false,
    publishedTerms,
  };
}

/** Swaps a successful watcher lookup into the file answer. */
export function mergeLive(base: SectionsResponse, lookup: Pick<LookupResponse, "classes" | "source" | "fetchedAt">, now = new Date()): SectionsResponse {
  return {
    ...base,
    basisTerm: base.term,
    tentative: false,
    classes: Array.isArray(lookup.classes) ? lookup.classes : [],
    source: typeof lookup.source === "string" && lookup.source ? lookup.source : "none",
    asOf: typeof lookup.fetchedAt === "string" && lookup.fetchedAt ? lookup.fetchedAt : now.toISOString(),
    live: true,
  };
}

/** The watcher said 404: the course has no classes in that term. */
export function mergeNotOffered(base: SectionsResponse, body: unknown, now = new Date()): SectionsResponse {
  const b = (body ?? {}) as { source?: unknown; fetchedAt?: unknown };
  return mergeLive(base, { classes: [], source: typeof b.source === "string" ? b.source : "none", fetchedAt: typeof b.fetchedAt === "string" ? b.fetchedAt : "" }, now);
}

export function withLiveError(base: SectionsResponse, message: string): SectionsResponse {
  return { ...base, liveError: message };
}

// ---- files ----

const STUB_DIR = () => path.resolve(process.cwd(), "stub-data");

function listTermFiles(dir: string): Map<Term, string> {
  const out = new Map<Term, string>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  const have = new Set(names);
  // index.json is the contract; the folder listing covers a missing or broken index.
  try {
    if (have.has("index.json")) {
      const index = readCached<ScheduleIndex>(path.join(dir, "index.json"));
      for (const t of index?.terms ?? []) {
        if (typeof t?.term === "string" && TERM_RE.test(t.term) && typeof t.file === "string" && have.has(t.file) && path.basename(t.file) === t.file) {
          out.set(t.term, path.join(dir, t.file));
        }
      }
    }
  } catch {
    /* fall through to the listing */
  }
  for (const name of names) {
    const term = termOfFileName(name);
    if (term && !out.has(term)) out.set(term, path.join(dir, name));
  }
  return out;
}

const parsed = new Map<string, { mtimeMs: number; value: unknown }>();

/** Parses a JSON file once and reuses it until the file changes on disk. Null when unreadable. */
function readCached<T>(file: string): T | null {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    parsed.delete(file);
    return null;
  }
  const hit = parsed.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    parsed.set(file, { mtimeMs, value });
    return value;
  } catch (e) {
    console.error(`[schedule] failed to read ${file}:`, (e as Error).message);
    return null;
  }
}

/** Test helper. */
export function _clearScheduleCache(): void {
  parsed.clear();
}

/** Term files on disk: data/schedule when it has any, otherwise the stub folder. */
export function scheduleFiles(dirs: string[] = [path.join(dataDir(), "schedule"), path.join(STUB_DIR(), "schedule")]): Map<Term, string> {
  for (const dir of dirs) {
    const files = listTermFiles(dir);
    if (files.size) return files;
  }
  return new Map();
}

export function loadFileAnswer(course: CourseId, term: Term, dirs?: string[]): SectionsResponse {
  const files = scheduleFiles(dirs);
  const published = [...files.keys()];
  const basis = chooseBasisTerm(term, published);
  const raw = basis ? readCached<ScheduleTermFile>(files.get(basis)!) : null;
  // Trust the file name over a missing or odd "term" inside the file.
  const file = raw && basis ? { ...raw, term: basis } : null;
  return fileAnswer(course, term, file, published);
}

// ---- live lookup ----

const LIVE_TIMEOUT_MS = 25_000;

export interface SectionsOptions {
  live?: boolean;
  dirs?: string[];
  fetchImpl?: typeof fetch;
}

/** The whole /api/sections answer. Never throws. */
export async function getSections(course: CourseId, term: Term, opts: SectionsOptions = {}): Promise<SectionsResponse> {
  const base = loadFileAnswer(course, term, opts.dirs);
  if (!opts.live || base.tentative) return base;
  const url = watcherUrl();
  if (!url) return withLiveError(base, "Live lookups are not set up on this server.");
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const r = await doFetch(`${url}/lookup?course=${encodeURIComponent(course)}&term=${encodeURIComponent(term)}`, {
      cache: "no-store",
      headers: watcherHeaders(),
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    });
    if (r.status === 404) {
      const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
      // Only the watcher's own "not offered" empties the list; any other 404 (an older watcher
      // without /lookup) keeps the saved times.
      if (body?.error === "not offered") return mergeNotOffered(base, body);
      return withLiveError(base, "Live lookups are not available on this server.");
    }
    if (!r.ok) {
      console.error(`[schedule] GET /lookup ${course} ${term} -> ${r.status}`);
      return withLiveError(base, "The live lookup did not answer.");
    }
    const body = (await r.json()) as LookupResponse;
    if (!body || !Array.isArray(body.classes)) return withLiveError(base, "The live lookup sent an answer we could not read.");
    return mergeLive(base, body);
  } catch (e) {
    console.error(`[schedule] GET /lookup ${course} ${term} failed:`, (e as Error).message);
    return withLiveError(base, "The live lookup could not be reached.");
  }
}
