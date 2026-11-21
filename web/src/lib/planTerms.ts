import { courseUnits } from "./courseId";
import { familyMembers } from "./courseFamily";
import { compareTerms, currentTerm, isTerm, termLabel, termPhase, type TermPhase } from "./terms";
import type { Action } from "./store";
import type { Course, CourseId, PlannedCourse, PlannerState, TakenCourse, Term } from "./types";

/** Key of the bucket for AP, transfer and undated classes in the term bar. */
export const CREDIT = "credit";
export type TermKey = Term | typeof CREDIT;
export const CREDIT_LABEL = "Test & transfer credit";

export interface TermRow {
  course: CourseId;
  status: "taken" | "planned";
  /** 0 while unknown (see unitsKnown). */
  units: number;
  /** False for a class the catalog does not list and the student has not given units for. */
  unitsKnown: boolean;
  grade?: string;
  professor?: string;
  /** AP exam name or transfer label, when the class is credit rather than a Berkeley class. */
  label?: string;
  source?: TakenCourse["source"];
}

export interface TermEntry {
  key: TermKey;
  label: string;
  /** "credit" for the test and transfer bucket. */
  phase: TermPhase | "credit";
  rows: TermRow[];
  units: number;
  takenCount: number;
  plannedCount: number;
  /** A past term whose classes are all marked taken (and it has some). */
  done: boolean;
  /** A past term that still holds classes not marked taken. */
  needsReview: boolean;
  /** A past term with nothing in it yet: waiting for the student's history, not an error. */
  emptyPast: boolean;
}

/**
 * Which bucket a taken class is shown in. AP and transfer credit always sits in the credit
 * bucket (a transfer student's block of credit stays together even when the transcript dates
 * it); other classes sit in their term, or in the credit bucket while they have none.
 */
export function takenBucket(t: TakenCourse): TermKey {
  if (t.source === "ap" || t.source === "transfer") return CREDIT;
  return isTerm(t.term) ? t.term : CREDIT;
}

/** AP and transfer credit is not tied to a Berkeley term, so it cannot be moved into one. */
export function isFixedCredit(source?: TakenCourse["source"]): boolean {
  return source === "ap" || source === "transfer";
}

export function termKeyLabel(key: TermKey): string {
  return key === CREDIT ? CREDIT_LABEL : termLabel(key);
}

/**
 * Every term the student has anything in (taken classes, planned classes, or an empty semester
 * they added), oldest first, with the credit bucket in front when it has anything.
 */
export function buildTermEntries(
  state: Pick<PlannerState, "taken" | "semesters">,
  idx: Map<CourseId, Course>,
  now = new Date(),
  enrollingTerm?: Term | null,
): TermEntry[] {
  const rows = new Map<TermKey, TermRow[]>();
  const push = (k: TermKey, r?: TermRow) => {
    if (!rows.has(k)) rows.set(k, []);
    if (r) rows.get(k)!.push(r);
  };
  for (const t of state.taken) {
    push(takenBucket(t), {
      course: t.course,
      status: "taken",
      ...unitsOf(t, idx),
      grade: t.grade,
      label: t.label,
      source: t.source,
    });
  }
  for (const s of state.semesters) {
    push(s.term);
    for (const c of s.courses) push(s.term, { course: c.course, status: "planned", ...unitsOf(c, idx), professor: c.professor });
  }
  const keys = [...rows.keys()].sort((a, b) => (a === CREDIT ? -1 : b === CREDIT ? 1 : compareTerms(a, b)));
  return keys.map((key) => {
    const list = rows.get(key)!;
    const phase = key === CREDIT ? "credit" : termPhase(key, now, enrollingTerm);
    const takenCount = list.filter((r) => r.status === "taken").length;
    const plannedCount = list.length - takenCount;
    return {
      key,
      label: termKeyLabel(key),
      phase,
      rows: list,
      units: round(list.reduce((a, r) => a + r.units, 0)),
      takenCount,
      plannedCount,
      done: phase === "past" && list.length > 0 && plannedCount === 0,
      needsReview: phase === "past" && plannedCount > 0,
      emptyPast: phase === "past" && list.length === 0,
    };
  });
}

const round = (n: number) => Math.round(n * 10) / 10;

/** Units for a row: what the student or transcript says, else the catalog, else unknown (0). */
function unitsOf(c: { course: CourseId; units?: number }, idx: Map<CourseId, Course>): { units: number; unitsKnown: boolean } {
  if (c.units !== undefined) return { units: c.units, unitsKnown: true };
  const rec = idx.get(c.course);
  return rec ? { units: courseUnits(rec), unitsKnown: true } : { units: 0, unitsKnown: false };
}

export interface UnitsOutlook {
  toGo: number;
  termsLeft: number;
  /** More units still needed than the remaining terms hold at the usual cap. */
  short: boolean;
}

/** Can the units still needed fit in the terms that are left, at 20.5 units a term? */
export function unitsOutlook(entries: TermEntry[], target = 120, cap = 20.5): UnitsOutlook {
  const done = entries.reduce((a, e) => a + e.rows.filter((r) => r.status === "taken").reduce((b, r) => b + r.units, 0), 0);
  const termsLeft = entries.filter((e) => e.phase === "current" || e.phase === "enrolling" || e.phase === "future").length;
  const toGo = Math.max(0, round(target - done));
  return { toGo, termsLeft, short: toGo > 0 && toGo > termsLeft * cap };
}

/** The term to open first: the one being enrolled in, else the current one, else the next ahead. */
export function defaultTermKey(entries: TermEntry[], now = new Date(), enrollingTerm?: Term | null): TermKey | null {
  const terms = entries.filter((e) => e.key !== CREDIT);
  if (enrollingTerm && terms.some((e) => e.key === enrollingTerm) && compareTerms(enrollingTerm, currentTerm(now)) >= 0) return enrollingTerm;
  const cur = currentTerm(now);
  const upcoming = terms.find((e) => compareTerms(e.key, cur) >= 0);
  return (upcoming ?? terms[terms.length - 1] ?? entries[0])?.key ?? null;
}

export interface PlanSpot {
  taken?: TakenCourse;
  planned?: { term: Term; course: PlannedCourse };
  /** Where the class sits in the term bar. */
  key?: TermKey;
}

/** Where a class (under any of its cross-listed codes) already sits in the plan. */
export function findInPlan(state: Pick<PlannerState, "taken" | "semesters">, course: CourseId, idx: Map<CourseId, Course>): PlanSpot {
  const fam = new Set(familyMembers(course, idx));
  const taken = state.taken.find((t) => fam.has(t.course));
  if (taken) return { taken, key: takenBucket(taken) };
  for (const s of state.semesters) {
    const pc = s.courses.find((c) => fam.has(c.course));
    if (pc) return { planned: { term: s.term, course: pc }, key: s.term };
  }
  return {};
}

/**
 * Actions that put a class into a term. A past term's classes default to taken, the current and
 * later terms' to planned (the current term reads as "in progress"). The credit bucket holds
 * taken classes with no term.
 */
export function addClassActions(key: TermKey, course: CourseId, now = new Date()): Action[] {
  // A Berkeley class recorded in the credit tab is transfer credit for that class.
  if (key === CREDIT) return [{ type: "addTaken", courses: [{ course, source: "transfer" }] }];
  if (compareTerms(key, currentTerm(now)) < 0) return [{ type: "addTaken", courses: [{ course, term: key, source: "manual" }] }];
  return [{ type: "addPlanned", term: key, course }];
}

/**
 * Actions that move a class, taken or planned, to another term. Status follows the destination:
 * moving into a past term or the credit bucket makes it taken, moving a taken class into a
 * future term makes it planned again, and the current term keeps whatever status it had.
 */
export function moveClassActions(
  state: Pick<PlannerState, "taken" | "semesters">,
  course: CourseId,
  to: TermKey,
  idx: Map<CourseId, Course>,
  now = new Date(),
): Action[] {
  const spot = findInPlan(state, course, idx);
  if (!spot.key || spot.key === to) return [];
  const cmp = to === CREDIT ? -1 : compareTerms(to, currentTerm(now));
  if (spot.taken) {
    if (isFixedCredit(spot.taken.source)) return [];
    const id = spot.taken.course;
    if (to === CREDIT) return [{ type: "setTakenTerm", course: id, term: undefined }];
    if (cmp > 0) return [{ type: "unmarkTaken", course: id, term: to }];
    return [{ type: "setTakenTerm", course: id, term: to }];
  }
  const { term: from, course: pc } = spot.planned!;
  if (to === CREDIT) return [{ type: "addTaken", courses: [{ course: pc.course, source: "manual" }] }];
  if (cmp < 0) return [{ type: "addTaken", courses: [{ course: pc.course, term: to, source: "manual" }] }];
  return [{ type: "movePlanned", from, to, course: pc.course }];
}

export interface PlanLocation {
  taken: boolean;
  /** Term key, or CREDIT. */
  key: TermKey;
}

/** Ids already in the plan and where, for search to explain instead of adding twice. */
export function planLocations(state: Pick<PlannerState, "taken" | "semesters">): Map<CourseId, PlanLocation> {
  const m = new Map<CourseId, PlanLocation>();
  for (const t of state.taken) m.set(t.course, { taken: true, key: takenBucket(t) });
  for (const s of state.semesters) for (const c of s.courses) m.set(c.course, { taken: false, key: s.term });
  return m;
}

/**
 * What search says about a class already in the plan. `typed` is the code in the result row,
 * `held` the code it is in the plan under (they differ for cross-listed or renumbered classes).
 */
export function locationText(typed: CourseId, held: CourseId, loc: PlanLocation): string {
  const where = loc.key === CREDIT ? (loc.taken ? "as credit" : "") : `in ${termLabel(loc.key)}`;
  if (typed !== held) return loc.taken ? `You took this as ${held} ${where}`.trim() : `Planned as ${held} ${where}`.trim();
  return loc.taken ? (loc.key === CREDIT ? "Taken (credit)" : `Taken ${termLabel(loc.key)}`) : `In ${termLabel(loc.key)}`;
}

/** Synthetic id for credit that is not a Berkeley class: "AP Calculus AB", "IB Physics HL", "TR Intro to Film". */
export function creditId(kind: "ap" | "ib" | "transfer" | "other", name: string): CourseId {
  const clean = name.trim().replace(/\s+/g, " ");
  if (kind === "ap") return /^AP\b/i.test(clean) ? `AP ${clean.replace(/^AP\s*/i, "")}` : `AP ${clean}`;
  if (kind === "ib") return /^IB\b/i.test(clean) ? `IB ${clean.replace(/^IB\s*/i, "")}` : `IB ${clean}`;
  return `TR ${clean}`;
}

export const COMMON_EXAMS: Record<"ap" | "ib", string[]> = {
  ap: ["Calculus AB", "Calculus BC", "Statistics", "Computer Science A", "Computer Science Principles", "English Language", "English Literature", "US History", "World History", "European History", "US Government", "Macroeconomics", "Microeconomics", "Psychology", "Biology", "Chemistry", "Physics 1", "Physics 2", "Physics C Mechanics", "Physics C E&M", "Environmental Science", "Spanish Language", "Chinese Language", "French Language", "Human Geography", "Art History"],
  ib: ["English A HL", "Mathematics AA HL", "Mathematics AI HL", "Physics HL", "Chemistry HL", "Biology HL", "History HL", "Economics HL", "Psychology HL", "Computer Science HL", "Spanish B HL"],
};
