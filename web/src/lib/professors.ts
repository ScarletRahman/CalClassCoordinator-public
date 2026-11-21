import type { Prediction, SectionSeats } from "./types";

/**
 * Classes like R1A/R1B are taught by a dozen or more instructors and each fills differently, so
 * "the class's forecast" does not exist until the student picks one. This file holds the
 * aggregation behind the instructor picker, the board card and the game plan. Pure, no React.
 */

/** 0 Phase 1, 1 Phase 2, 2 adjustment period, 3 does not fill. */
export type FillRank = 0 | 1 | 2 | 3;

export function fillRank(p: Pick<Prediction, "fillsInPhase" | "popularity">): FillRank {
  const phase = p.fillsInPhase ?? "";
  if (/not fill/i.test(phase)) return 3;
  if (/adj/i.test(phase)) return 2;
  if (/1/.test(phase)) return 0;
  if (/2/.test(phase)) return 1;
  // No phase given: fall back to popularity the same way the fill badge does.
  return p.popularity >= 0.85 ? 0 : p.popularity >= 0.6 ? 1 : 3;
}

const RANK_NAME = ["Phase 1", "Phase 2", "Adjustment", "rarely fills"] as const;
export const fillRankName = (r: FillRank): string => RANK_NAME[r];

/** Classes with at least this many named instructors get a search box in the picker. */
export const SEARCH_THRESHOLD = 8;

export interface InstructorSummary {
  /** Predictions with a named instructor, most in demand first. */
  named: Prediction[];
  /** Predictions with no instructor listed yet (at most one is expected). */
  unnamed: Prediction[];
  /** Number of named instructors. */
  count: number;
  /** Two or more named instructors: the student should pick one. */
  several: boolean;
  /** The student's choice, when it matches a prediction. */
  chosen?: Prediction;
  /** The student named an instructor we have no prediction for. */
  chosenUnknown: boolean;
  /**
   * The one forecast it is honest to show as the class's: the chosen instructor's, or the only
   * one there is. Undefined when there are several instructors and none is chosen.
   */
  headline?: Prediction;
  earliest?: FillRank;
  latest?: FillRank;
  /** "fills from Phase 1 to Adjustment depending on instructor", "fills in Phase 2 with every instructor". */
  rangeText?: string;
  /** How many named instructors are new (never seen in the data). */
  newCount: number;
  /** Highest popularity among all predictions, for ordering classes by urgency. */
  peakPopularity?: number;
}

export function sameInstructor(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  // Seat data may say "DeNero, J" or just a last name; match on last name plus first initial.
  const last = (s: string) => s.split(" ").pop()!;
  const xs = x.split(" ");
  const ys = y.split(" ");
  const [long, short] = xs.length >= ys.length ? [xs, ys] : [ys, xs];
  if (short.length === 1) return long.includes(short[0]) && short[0].length > 2;
  const viaComma = (raw: string, other: string[]) => {
    const m = /^\s*([^,]+),\s*(\S)/.exec(raw);
    return !!m && m[1].trim().toLowerCase() === last(other.join(" ")) && other[0][0] === m[2].toLowerCase();
  };
  return viaComma(a, ys) || viaComma(b, xs);
}

export function rangeText(earliest: FillRank, latest: FillRank, count: number): string {
  if (earliest === latest) {
    if (earliest === 3) return count > 1 ? "rarely fills with any instructor" : "rarely fills";
    return count > 1 ? `fills in ${RANK_NAME[earliest]} with every instructor` : `fills in ${RANK_NAME[earliest]}`;
  }
  if (latest === 3) return `fills as early as ${RANK_NAME[earliest]} or not at all depending on instructor`;
  return `fills from ${RANK_NAME[earliest]} to ${RANK_NAME[latest]} depending on instructor`;
}

export function summarizeInstructors(preds: Prediction[] | undefined, chosenName?: string | null): InstructorSummary {
  const all = preds ?? [];
  const named = sortInstructors(all.filter((p) => !!p.professor), "demand");
  const unnamed = all.filter((p) => !p.professor);
  const chosen = chosenName ? named.find((p) => p.professor === chosenName) ?? named.find((p) => sameInstructor(p.professor, chosenName)) : undefined;
  const several = named.length >= 2;
  const pool = named.length ? named : unnamed;
  const ranks = pool.map(fillRank);
  const earliest = ranks.length ? (Math.min(...ranks) as FillRank) : undefined;
  const latest = ranks.length ? (Math.max(...ranks) as FillRank) : undefined;
  return {
    named,
    unnamed,
    count: named.length,
    several,
    chosen,
    chosenUnknown: !!chosenName && !chosen,
    headline: chosen ?? (several ? undefined : (named[0] ?? unnamed[0])),
    earliest,
    latest,
    rangeText: earliest !== undefined && latest !== undefined ? rangeText(earliest, latest, pool.length) : undefined,
    newCount: named.filter((p) => !p.professorSeenBefore).length,
    peakPopularity: all.length ? Math.max(...all.map((p) => p.popularity)) : undefined,
  };
}

export type InstructorSort = "demand" | "easiest" | "name";

/** "demand": fills earliest first (then most popular). "easiest": the reverse. "name": by last name. */
export function sortInstructors(list: Prediction[], by: InstructorSort): Prediction[] {
  const lastName = (p: Prediction) => (p.professor ?? "").trim().split(/\s+/).pop()!.toLowerCase();
  const byName = (a: Prediction, b: Prediction) => lastName(a).localeCompare(lastName(b)) || (a.professor ?? "").localeCompare(b.professor ?? "");
  const demand = (a: Prediction, b: Prediction) => fillRank(a) - fillRank(b) || b.popularity - a.popularity || byName(a, b);
  const out = [...list];
  if (by === "name") out.sort(byName);
  else if (by === "easiest") out.sort((a, b) => -(fillRank(a) - fillRank(b) || b.popularity - a.popularity) || byName(a, b));
  else out.sort(demand);
  return out;
}

/** Case- and accent-insensitive match on any part of the name. */
export function filterInstructors(list: Prediction[], query: string): Prediction[] {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return list;
  return list.filter((p) => {
    const words = fold(p.professor ?? "").split(/[\s-]+/);
    return tokens.every((t) => words.some((w) => w.startsWith(t)));
  });
}

export interface InstructorSeats {
  sections: number;
  open: number;
  waitlisted: number;
  capacity: number;
}

/** Live seats in the sections this instructor teaches, or null when seat data names no such instructor. */
export function seatsForInstructor(sections: SectionSeats[] | undefined, professor?: string): InstructorSeats | null {
  const mine = (sections ?? []).filter((s) => sameInstructor(s.instructor, professor));
  if (!mine.length) return null;
  return {
    sections: mine.length,
    open: mine.reduce((a, s) => a + Math.max(0, s.capacity - s.enrolled), 0),
    waitlisted: mine.reduce((a, s) => a + (s.waitlisted ?? 0), 0),
    capacity: mine.reduce((a, s) => a + s.capacity, 0),
  };
}

/** One honest line for a board card or game plan row when no single forecast applies. */
export function instructorNudge(s: InstructorSummary): string | null {
  if (!s.several || s.chosen) return null;
  return `${s.count} instructors · ${s.rangeText} · pick one`;
}

export interface Teaching {
  /** Instructor names from live seat data for the term, when it lists any. */
  fromSeats: string[];
  /** Seat data names instructors and none of them is among the forecast's instructors. */
  mismatch: boolean;
}

/**
 * Seat data is live and says who actually teaches this term; the forecast's instructor list can
 * be stale. When they disagree, trust the seats for WHO and treat the forecast as class history.
 */
export function reconcileInstructors(preds: Prediction[] | undefined, sections: SectionSeats[] | undefined): Teaching {
  const fromSeats = [...new Set((sections ?? []).map((s) => s.instructor?.trim()).filter((x): x is string => !!x))];
  const named = (preds ?? []).filter((p) => p.professor);
  const mismatch = fromSeats.length > 0 && named.length > 0 && !named.some((p) => fromSeats.some((n) => sameInstructor(n, p.professor)));
  return { fromSeats, mismatch };
}
