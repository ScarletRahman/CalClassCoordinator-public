import { fillRank, type FillRank } from "./professors";
import type { Phase, Prediction } from "./types";

/**
 * Time-aware forecast copy. A prediction says which enrollment phase a class fills in; what the
 * student should do about it depends on today's date. Every label and piece of advice the
 * planner shows about a forecast comes from here, so nothing says "Phase 1 priority" after
 * Phase 1 has closed. Live seat counts, when we have them, override the guess.
 */

export type ForecastState = "passed" | "open" | "upcoming" | "never";

export interface LiveSeats {
  open: number;
  waitlisted: number;
}

export interface ForecastAdvice {
  state: ForecastState;
  /** Short badge text. */
  label: string;
  /** Tailwind classes for the badge. */
  cls: string;
  /** One or two sentences: what to do today. */
  advice: string;
  /** Offer the seat alert action next to the advice. */
  suggestAlert: boolean;
  /** The label and advice come from live seat counts, not the forecast. */
  fromSeats: boolean;
}

const TONE = {
  rose: "bg-rose-50 text-rose-700 ring-rose-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  slate: "bg-slate-100 text-slate-700 ring-slate-300",
};
const RANK_TONE = [TONE.rose, TONE.amber, TONE.sky, TONE.emerald];
const SHORT = ["Phase 1", "Phase 2", "Adjustment", ""];

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const fmtDay = (iso: string, weekday = false) =>
  new Date(iso + "T12:00:00").toLocaleDateString("en-US", { ...(weekday ? { weekday: "short" } : {}), month: "short", day: "numeric" });

/** The phase table entry for a fill rank: 0 Phase 1, 1 Phase 2, 2 adjustment. */
export function phaseForRank(rank: FillRank, phases: Phase[]): Phase | undefined {
  if (rank === 3) return undefined;
  const test = [/1/, /2/, /adj/i][rank];
  return phases.find((p) => test.test(p.name));
}

/** Has this prediction's fill moment already gone by? */
export function forecastState(p: Pick<Prediction, "fillsInPhase" | "popularity" | "expectedFillDate">, phases: Phase[], today: string): ForecastState {
  const rank = fillRank(p);
  if (rank === 3) return "never";
  const phase = phaseForRank(rank, phases);
  if (p.expectedFillDate && p.expectedFillDate < today) return "passed";
  if (!phase) return "upcoming";
  if (phase.end < today) return "passed";
  return phase.start <= today ? "open" : "upcoming";
}

/**
 * What a full class means here: how much of its waitlist has ended up with a seat, and whether
 * seats are usually added. Empty when the predictions file has no waitlist history.
 */
export function waitlistNote(p: Pick<Prediction, "waitlist" | "capacityExpansion">): string {
  const clear = p.waitlist?.clearRate;
  if (clear == null) return "";
  const pct = `${Math.round(clear * 100)}%`;
  const grows = (p.capacityExpansion?.pExpands ?? 0) >= 0.5 ? " and seats are usually added" : "";
  if (clear >= 0.85) return ` In past terms about ${pct} of its waitlist got a seat${grows}, so waitlisting usually works.`;
  if (clear >= 0.6) return ` In past terms about ${pct} of its waitlist got a seat${grows}.`;
  return ` In past terms only about ${pct} of its waitlist got a seat${grows}, so line up a backup.`;
}

export function forecastAdvice(p: Prediction, phases: Phase[], today: string, seats?: LiveSeats | null): ForecastAdvice {
  const rank = fillRank(p);
  const state = forecastState(p, phases, today);
  const phase = phaseForRank(rank, phases);
  const name = SHORT[rank];
  const wl = waitlistNote(p);
  const around = p.expectedFillDate ? `usually full around ${fmtDay(p.expectedFillDate)}` : `usually full by the end of ${name}`;

  if (seats) {
    if (seats.open > 0) {
      const usual = state === "passed" ? ` It usually fills in ${name}, so do not wait.` : state === "never" ? "" : ` It is ${around}.`;
      return { state, label: `${seats.open} open now`, cls: TONE.emerald, advice: `${seats.open} open seat${seats.open === 1 ? "" : "s"} right now.${usual}`, suggestAlert: false, fromSeats: true };
    }
    return {
      state,
      label: seats.waitlisted ? `Full · ${seats.waitlisted} waitlisted` : "Full now",
      cls: TONE.slate,
      advice: `Full right now${seats.waitlisted ? ` with ${seats.waitlisted} on the waitlist` : ""}. Join the waitlist or set a seat alert.${wl}`,
      suggestAlert: true,
      fromSeats: true,
    };
  }
  if (state === "never") return { state, label: "Rarely fills", cls: TONE.emerald, advice: "Rarely fills. Any time through the adjustment period is fine.", suggestAlert: false, fromSeats: false };
  if (state === "passed")
    return {
      state,
      label: "Probably full",
      cls: TONE.slate,
      advice: `Probably full already (it usually fills in ${name}). Check for open seats, join the waitlist, or set a seat alert.${wl}`,
      suggestAlert: true,
      fromSeats: false,
    };
  if (state === "open") return { state, label: `Filling now (${name})`, cls: RANK_TONE[rank], advice: `Enroll now: ${around}.${wl}`, suggestAlert: false, fromSeats: false };
  const opens = phase && phase.start > today ? `Enroll as soon as ${phase.name} opens on ${fmtDay(phase.start)}` : `Enroll in ${name}`;
  return { state, label: `Fills in ${name}`, cls: RANK_TONE[rank], advice: `${opens}: ${around}.${wl}`, suggestAlert: false, fromSeats: false };
}

/** For a class with several instructors and none chosen: the honest spread, as of today. */
export function instructorRangeNow(named: Prediction[], phases: Phase[], today: string): string {
  if (!named.length) return "";
  const states = named.map((p) => forecastState(p, phases, today));
  const gone = states.filter((s) => s === "passed").length;
  const rest = named.filter((_, i) => states[i] !== "passed");
  const tail = (list: Prediction[]): string => {
    const ranks = list.map(fillRank);
    const lo = Math.min(...ranks) as FillRank;
    const hi = Math.max(...ranks) as FillRank;
    const nm = (r: FillRank) => (r === 3 ? "rarely fill" : `fill in ${SHORT[r]}`);
    return lo === hi ? nm(lo) : hi === 3 ? `${nm(lo)} or not at all` : `fill from ${SHORT[lo]} to ${SHORT[hi]}`;
  };
  if (gone === named.length) return "every instructor's sections have probably filled already";
  if (gone > 0) return `${gone} of ${named.length} instructors' sections have probably filled already; the rest ${tail(rest)}`;
  return `sections ${tail(named)} depending on instructor`;
}

/** What the game plan header says today. */
export function gamePlanToday(phases: Phase[], today: string, counts: { total: number; filled: number; needPick: number }): { badge: string | null; active: boolean; text: string } {
  const phase = phases.find((p) => today <= p.end);
  const active = !!phase && today >= phase.start;
  const badge = phase ? (active ? `${phase.name} is open until ${fmtDay(phase.end, true)}` : `${phase.name} opens ${fmtDay(phase.start, true)}`) : null;
  const parts: string[] = [];
  if (!phase) parts.push("Enrollment phases for this term are over.");
  if (counts.total === 0) return { badge, active, text: "" };
  const { filled, total } = counts;
  if (filled > 0) parts.push(`${filled === total ? (total === 1 ? "Your class has" : `All ${total} of your classes have`) : `${filled} of your ${total} classes ${filled === 1 ? "has" : "have"}`} probably filled: line up waitlists and seat alerts first.`);
  else if (active) parts.push("Enroll in this order; the classes that fill earliest come first.");
  else if (phase) parts.push(`Be ready when ${phase.name} opens; enroll in this order.`);
  if (counts.needPick > 0) parts.push(`${counts.needPick === 1 ? "One class depends" : `${counts.needPick} classes depend`} on which instructor you want.`);
  return { badge, active, text: parts.join(" ") };
}
