"use client";

import { useMemo } from "react";
import { programShortName } from "./majorSearch";
import {
  buildCourseIndex,
  computeOverlap,
  dedupeStudentCourses,
  evaluateGroup,
  isProgramKind,
  isTestCredit,
  toStudentCourses,
  type GroupResult,
  type OverlapResult,
  type StudentCourse,
} from "./requirements";
import { currentTerm } from "./terms";
import type { Catalog, CourseInsight, PlannerState, Prediction, SectionSeats } from "./types";

export interface PlanData {
  courseIndex: ReturnType<typeof buildCourseIndex>;
  groupResults: GroupResult[];
  predictionsByCourse: Map<string, Prediction[]>;
  seatsByCourse: Map<string, SectionSeats[]>;
  insightByCourse: Map<string, CourseInsight>;
  totals: { satisfied: number; completed: number; total: number; unitsTaken: number; unitsPlanned: number };
  /** Taken and planned classes, one per cross-listed family (AP credit left out). */
  students: StudentCourse[];
  /** Classes that count for two or more of the student's majors/minors; null with one program. */
  overlap: OverlapResult | null;
  /** Requirement group id -> short program name for badges ("CogSci", "DS", "Stats minor"). */
  programLabels: Record<string, string>;
  /** The student's majors then minors, in the order they picked them. */
  programs: PlanProgram[];
  /** Test and transfer credit entries on record (for "tick this if it covers it" hints). */
  credits: { course: string; label?: string }[];
}

export interface PlanProgram {
  id: string;
  name: string;
  degree?: string;
  kind: "major" | "minor";
  /** Short name for badges ("CogSci"). */
  label: string;
  groupIds: string[];
}

// Lets a component that only receives `groupResults` (the checklist) reach the rest of the
// plan data without every parent having to pass it down.
const planDataByGroups = new WeakMap<GroupResult[], PlanData>();

/** The PlanData a `groupResults` array came from, if it came from `usePlanData`. */
export function planDataFor(groups: GroupResult[]): PlanData | undefined {
  return planDataByGroups.get(groups);
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function usePlanData(catalog: Catalog, state: PlannerState): PlanData {
  const courseIndex = useMemo(() => buildCourseIndex(catalog.courses), [catalog.courses]);
  const predictionsByCourse = useMemo(
    () => groupBy(catalog.predictions?.predictions ?? [], (p) => p.course),
    [catalog.predictions],
  );
  const seatsByCourse = useMemo(() => groupBy(catalog.seats?.sections ?? [], (s) => s.course), [catalog.seats]);
  const insightByCourse = useMemo(() => new Map(catalog.insights.map((i) => [i.course, i])), [catalog.insights]);

  const computed = useMemo(() => {
    // Keep the student's own order (first major first), not the catalog's alphabetical one.
    const pick = <T extends { id: string }>(ids: string[], from: T[]) => [...new Set(ids)].map((id) => from.find((x) => x.id === id)).filter((x): x is T => !!x);
    const majors = pick(state.majorIds ?? [], catalog.majors);
    const minors = pick(state.minorGroupIds ?? [], catalog.minors);
    const programs: PlanProgram[] = [
      ...majors.map((m) => ({ id: m.id, name: m.name, degree: m.degree, kind: "major" as const, label: programShortName(m.name), groupIds: m.requirementGroupIds })),
      ...minors.map((m) => ({ id: m.id, name: m.name, kind: "minor" as const, label: programShortName(m.name, { minor: true }), groupIds: m.requirementGroupIds })),
    ];
    const byId = new Map(catalog.groups.map((g) => [g.id, g]));
    const ids: string[] = [];
    const programLabels: Record<string, string> = {};
    const push = (id?: string) => {
      if (id && byId.has(id) && !ids.includes(id)) ids.push(id);
    };
    for (const m of majors) {
      m.requirementGroupIds.forEach(push);
      for (const id of m.requirementGroupIds) programLabels[id] ??= programShortName(m.name);
    }
    for (const m of minors) {
      m.requirementGroupIds.forEach(push);
      for (const id of m.requirementGroupIds) programLabels[id] ??= programShortName(m.name, { minor: true });
    }
    for (const m of majors) push(m.collegeGroupId ?? catalog.colleges.find((c) => c.id === m.college)?.requirementGroupId);
    for (const m of majors) push(m.universityGroupId ?? "university");

    const planned = state.semesters.flatMap((s) => s.courses.map((c) => ({ course: c.course, term: s.term, units: (c as { units?: number }).units })));
    // A class and its cross-listed twin (DATA C100 / STAT C100) are one class everywhere below.
    // Test credit (AP, IB) stays in: it adds units, but the evaluator never counts it as a class.
    const students = dedupeStudentCourses(toStudentCourses(state.taken, planned, courseIndex, currentTerm()), courseIndex);
    const credits = state.taken.filter((t) => isTestCredit(t) || t.source === "transfer").map((t) => ({ course: t.course, label: t.label }));
    const choices = state.choices && typeof state.choices === "object" ? state.choices : {};
    const ctx = { courseIndex, manualChecks: state.manualChecks ?? {}, pins: state.pins ?? {}, choices };
    const groupResults = ids.map((id) => evaluateGroup(byId.get(id)!, students, ctx));
    const totals = {
      satisfied: groupResults.reduce((a, g) => a + g.satisfied, 0),
      completed: groupResults.reduce((a, g) => a + g.completed, 0),
      total: groupResults.reduce((a, g) => a + g.total, 0),
      unitsTaken: students.filter((s) => s.status === "taken").reduce((a, s) => a + s.units, 0),
      unitsPlanned: students.filter((s) => s.status === "planned").reduce((a, s) => a + s.units, 0),
    };
    const programCount = groupResults.filter((g) => isProgramKind(g.group.kind)).length;
    const overlap = programCount >= 2 ? computeOverlap(groupResults, students, ctx, programLabels) : null;
    return { groupResults, totals, students, overlap, programLabels, programs, credits };
  }, [catalog, state, courseIndex]);

  return useMemo(() => {
    const data: PlanData = { courseIndex, predictionsByCourse, seatsByCourse, insightByCourse, ...computed };
    planDataByGroups.set(computed.groupResults, data);
    return data;
  }, [courseIndex, predictionsByCourse, seatsByCourse, insightByCourse, computed]);
}

/** Headline prediction for a course: the chosen professor's if we have it, else the most popular. */
export function pickPrediction(preds: Prediction[] | undefined, professor?: string): Prediction | undefined {
  if (!preds?.length) return undefined;
  if (professor) {
    const hit = preds.find((p) => p.professor === professor);
    if (hit) return hit;
  }
  return [...preds].sort((a, b) => b.popularity - a.popularity)[0];
}

export function fillTone(p: Prediction | undefined): { label: string; cls: string } | null {
  if (!p) return null;
  const phase = p.fillsInPhase ?? "";
  if (/not fill/i.test(phase)) return { label: "Rarely fills", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
  if (/adj/i.test(phase)) return { label: "Fills in Adjustment", cls: "bg-sky-50 text-sky-700 ring-sky-200" };
  if (/1/.test(phase) || (!phase && p.popularity >= 0.85)) return { label: "Fills in Phase 1", cls: "bg-rose-50 text-rose-700 ring-rose-200" };
  if (/2/.test(phase) || (!phase && p.popularity >= 0.6)) return { label: "Fills in Phase 2", cls: "bg-amber-50 text-amber-800 ring-amber-200" };
  if (/adj/i.test(phase)) return { label: "Fills in Adjustment", cls: "bg-sky-50 text-sky-700 ring-sky-200" };
  return { label: "Rarely fills", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200" };
}

export function seatSummary(sections: SectionSeats[] | undefined) {
  if (!sections?.length) return null;
  // Primary sections (lectures) decide whether you can get in.
  const primary = sections.filter((s) => /LEC|SEM|001/.test(s.section));
  const list = primary.length ? primary : sections;
  const open = list.reduce((a, s) => a + Math.max(0, s.capacity - s.enrolled), 0);
  const reservedOpen = list.reduce(
    (a, s) => a + (s.reserved ?? []).reduce((b, r) => b + Math.max(0, r.capacity - r.enrolled), 0),
    0,
  );
  const waitlisted = list.reduce((a, s) => a + (s.waitlisted ?? 0), 0);
  return { open, reservedOpen, unreservedOpen: Math.max(0, open - reservedOpen), waitlisted, anyOpen: list.some((s) => s.open) };
}
