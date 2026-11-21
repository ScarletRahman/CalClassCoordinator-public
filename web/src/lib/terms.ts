import type { Term, Year } from "./types";

const ORDER = { Spring: 0, Summer: 1, Fall: 2 } as const;
export type Season = keyof typeof ORDER;

export function parseTerm(t: Term): { year: number; season: Season } {
  const [y, s] = t.split(" ");
  return { year: parseInt(y, 10), season: (s as Season) ?? "Fall" };
}

/** Accepts "2027 Spring" (planner, watcher) or "Spring 2027" (predictor) and returns "2027 Spring". */
export function normalizeTerm(t: string): Term {
  const m = /^\s*(Spring|Summer|Fall)\s+(\d{4})\s*$/i.exec(t ?? "");
  if (!m) return (t ?? "").trim();
  return `${m[2]} ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`;
}

export function termIndex(t: Term): number {
  const { year, season } = parseTerm(t);
  return year * 3 + (ORDER[season] ?? 0);
}

export const compareTerms = (a: Term, b: Term) => termIndex(a) - termIndex(b);

export function currentTerm(now = new Date()): Term {
  const m = now.getMonth(); // 0-based
  const y = now.getFullYear();
  if (m <= 4) return `${y} Spring`;
  if (m <= 7) return `${y} Summer`;
  return `${y} Fall`;
}

export function nextTerm(t: Term, includeSummer = false): Term {
  const { year, season } = parseTerm(t);
  if (season === "Spring") return includeSummer ? `${year} Summer` : `${year} Fall`;
  if (season === "Summer") return `${year} Fall`;
  return `${year + 1} Spring`;
}

/** Fall/Spring semesters a student in this year still has after the current one. */
export function remainingSemesters(year: Year | null, now = new Date()): number {
  const inFall = parseTerm(currentTerm(now)).season !== "Spring";
  const base: Record<Year, number> = {
    Freshman: 7,
    Sophomore: 5,
    Junior: 3,
    Senior: 1,
    "Transfer (Junior)": 3,
    "Fifth year+": 1,
  };
  const n = year ? base[year] : 4;
  return Math.max(1, inFall ? n : n - 1);
}

export function defaultFutureTerms(year: Year | null, now = new Date()): Term[] {
  const out: Term[] = [];
  let t = currentTerm(now);
  for (let i = 0; i < remainingSemesters(year, now); i++) {
    t = nextTerm(t);
    out.push(t);
  }
  return out;
}

export function termLabel(t: Term): string {
  const { year, season } = parseTerm(t);
  return `${season} ${year}`;
}

export type TermPhase = "past" | "current" | "enrolling" | "future";

/**
 * Where a term sits relative to today. "enrolling" is the upcoming term students are signing up
 * for right now (the predictions term), when it is still ahead of the current one.
 */
export function termPhase(t: Term, now = new Date(), enrollingTerm?: Term | null): TermPhase {
  const d = compareTerms(t, currentTerm(now));
  if (d < 0) return "past";
  if (d === 0) return "current";
  return enrollingTerm && t === enrollingTerm ? "enrolling" : "future";
}

export const SEASONS: Season[] = ["Spring", "Summer", "Fall"];

export function isTerm(t: unknown): t is Term {
  return typeof t === "string" && /^\d{4} (Spring|Summer|Fall)$/.test(t);
}

/**
 * Years to offer in an "add term" picker: far enough back for a fifth-year or transfer student's
 * first term and far enough ahead for a freshman's last, always covering what is already there.
 */
export function termYearRange(existing: Term[], now = new Date()): number[] {
  const y = now.getFullYear();
  const years = existing.filter(isTerm).map((t) => parseTerm(t).year);
  const lo = Math.min(y - 6, ...years);
  const hi = Math.max(y + 6, ...years);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** The next Fall/Spring term after the latest one present (or after the current term). */
export function suggestNextTerm(existing: Term[], now = new Date()): Term {
  const cur = currentTerm(now);
  const sorted = existing.filter(isTerm).sort(compareTerms);
  const last = sorted.length ? sorted[sorted.length - 1] : cur;
  let t = compareTerms(last, cur) < 0 ? cur : nextTerm(last);
  while (existing.includes(t)) t = nextTerm(t);
  return t;
}

/** The first summer from now on that is not in the list yet. */
export function suggestNextSummer(existing: Term[], now = new Date()): Term {
  let y = now.getFullYear();
  if (compareTerms(`${y} Summer`, currentTerm(now)) < 0) y++;
  while (existing.includes(`${y} Summer`)) y++;
  return `${y} Summer`;
}

/**
 * Fall/Spring terms a student in this year has already finished, oldest first, for seeding an
 * empty history to fill in. Transfers start with none: their history is the credit tab.
 */
export function defaultPastTerms(year: Year | null, now = new Date()): Term[] {
  const base: Record<Year, number> = { Freshman: 0, Sophomore: 2, Junior: 4, Senior: 6, "Transfer (Junior)": 0, "Fifth year+": 8 };
  let n = year ? base[year] : 0;
  const cur = currentTerm(now);
  // In spring one more term (last fall) is behind them; freshmen and transfers included.
  if (year && parseTerm(cur).season === "Spring") n += 1;
  const out: Term[] = [];
  let { year: y, season } = parseTerm(cur);
  while (out.length < n) {
    if (season === "Spring") {
      y -= 1;
      season = "Fall";
    } else {
      season = "Spring";
    }
    out.unshift(`${y} ${season}`);
  }
  return out;
}
