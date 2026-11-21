// Which planned classes to take in Phase 1 when the Phase 1 unit cap does not fit them all.
//
// Each class gets a "wait risk": the chance of ending up without a seat if it is left for
// Phase 2 (predictor field `waitRisk` = chance it is full when you get to it x chance the
// waitlist does not get you in). Phase 1 goes to the set of classes that fits under the cap
// and removes the most risk. Ties are broken, in order, by: earlier expected fill date,
// higher demand, fewer units (leaves room for another class), then course id.
import type { Prediction } from "./types";

export const DEFAULT_PHASE1_CAP = 13.5;
export const PHASE2_CAP = 17.5;
/** Above this, leaving the class for Phase 2 is a real gamble. */
export const HIGH_RISK = 0.2;
const EXACT_LIMIT = 16; // 2^16 subsets is instant; more planned classes than that fall back to greedy
const EPS = 1e-9;
/** Small bonus per class so spare Phase 1 units are used rather than left empty. */
const USE_IT = 0.001;

export interface PlanInput {
  course: string;
  units: number;
  prediction?: Prediction;
}

export interface PlanItem extends PlanInput {
  /** 0..1, see waitRiskOf. */
  risk: number;
  phase: 1 | 2;
  /** Short reason shown next to the class. */
  reason: string;
  /** In Phase 2 only because the cap ran out, although the risk is high. */
  squeezedOut: boolean;
}

export interface EnrollPlan {
  cap: number;
  phase1: PlanItem[];
  phase2: PlanItem[];
  phase1Units: number;
  totalUnits: number;
  /** Planned units beyond what Phase 2 allows in total. */
  overPhase2Cap: boolean;
}

function pFull(p: Prediction | undefined, phase: RegExp): number | undefined {
  const hit = Object.entries(p?.pFullByPhase ?? {}).find(([k]) => phase.test(k));
  return hit?.[1];
}

/** Chance of losing the class by waiting for Phase 2. Falls back to fill odds when the
 *  predictions file predates waitlist modeling (then a typical 80% waitlist clear rate is assumed). */
export function waitRiskOf(p: Prediction | undefined): number {
  if (!p) return 0;
  if (typeof p.waitRisk === "number") return p.waitRisk;
  const p1 = pFull(p, /phase 1/i);
  if (p1 == null) return p.popularity >= 0.85 ? 0.15 : p.popularity >= 0.6 ? 0.08 : 0.02;
  const p2 = Math.max(p1, pFull(p, /phase 2/i) ?? p1);
  return (p1 + 0.5 * (p2 - p1)) * 0.2;
}

/** Ranking order, strongest claim on Phase 1 first. This is the tiebreaker chain. */
export function compareForPhase1(a: PlanInput, b: PlanInput): number {
  const dr = waitRiskOf(b.prediction) - waitRiskOf(a.prediction);
  if (Math.abs(dr) > 0.005) return dr;
  const da = a.prediction?.expectedFillDate ?? "9999";
  const db = b.prediction?.expectedFillDate ?? "9999";
  if (da !== db) return da < db ? -1 : 1;
  const dp = (b.prediction?.popularity ?? -1) - (a.prediction?.popularity ?? -1);
  if (Math.abs(dp) > EPS) return dp;
  if (a.units !== b.units) return a.units - b.units;
  return a.course < b.course ? -1 : a.course > b.course ? 1 : 0;
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function reasonFor(item: PlanInput, risk: number, phase: 1 | 2, squeezedOut: boolean): string {
  const p = item.prediction;
  if (!p) return "No enrollment history yet";
  const p1 = pFull(p, /phase 1/i) ?? 0;
  const p2 = Math.max(p1, pFull(p, /phase 2/i) ?? p1);
  const clear = p.waitlist?.clearRate;
  const grows = p.capacityExpansion && p.capacityExpansion.pExpands >= 0.5 ? ", and seats are usually added" : "";
  if (squeezedOut) return `${pct(risk)} risk if you wait, but it does not fit under the Phase 1 cap. Enroll the moment Phase 2 opens.`;
  if (phase === 1) {
    if (risk >= HIGH_RISK) return `${pct(risk)} chance of missing it if you wait: ${pct(p1)} full by the end of Phase 1${clear != null ? `, and only about ${pct(clear)} of its waitlist gets in` : ""}`;
    if (risk >= 0.05) return `${pct(risk)} chance of missing it if you wait`;
    return "Low risk, but you have Phase 1 units to spare";
  }
  if (p2 >= 0.5 && clear != null && clear >= 0.6) return `Likely full by then, but about ${pct(clear)} of its waitlist gets a seat${grows}`;
  if (p2 >= 0.5) return `Likely full by then (${pct(risk)} risk). Join the waitlist as soon as Phase 2 opens`;
  return /adj|not fill/i.test(p.fillsInPhase ?? "") ? "Rarely fills before classes start" : "Usually still open in Phase 2";
}

/** Best set of indexes (into `ranked`) that fits under `cap`. */
function choose(ranked: { units: number; risk: number }[], cap: number): Set<number> {
  const n = ranked.length;
  const picked = new Set<number>();
  if (n > EXACT_LIMIT) {
    let used = 0;
    ranked.forEach((r, i) => {
      if (used + r.units <= cap + EPS) {
        picked.add(i);
        used += r.units;
      }
    });
    return picked;
  }
  let best = 0;
  let bestValue = -1;
  let bestTie = -1;
  for (let mask = 0; mask < 1 << n; mask++) {
    let units = 0;
    let value = 0;
    let tie = 0; // higher-ranked classes weigh more, so equal-value sets prefer the ranking order
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        units += ranked[i].units;
        value += ranked[i].risk + USE_IT;
        tie += 2 ** (n - 1 - i);
      }
    }
    if (units > cap + EPS) continue;
    if (value > bestValue + EPS || (Math.abs(value - bestValue) <= EPS && tie > bestTie)) {
      best = mask;
      bestValue = value;
      bestTie = tie;
    }
  }
  for (let i = 0; i < n; i++) if (best & (1 << i)) picked.add(i);
  return picked;
}

export function planEnrollment(items: PlanInput[], cap: number = DEFAULT_PHASE1_CAP): EnrollPlan {
  const ranked = [...items].sort(compareForPhase1).map((it) => ({ ...it, risk: waitRiskOf(it.prediction) }));
  const picked = choose(ranked, cap);
  const out: PlanItem[] = ranked.map((it, i) => {
    const phase: 1 | 2 = picked.has(i) ? 1 : 2;
    const squeezedOut = phase === 2 && it.risk >= HIGH_RISK;
    return { ...it, phase, squeezedOut, reason: reasonFor(it, it.risk, phase, squeezedOut) };
  });
  const phase1 = out.filter((x) => x.phase === 1);
  const totalUnits = out.reduce((a, x) => a + x.units, 0);
  return {
    cap,
    phase1,
    phase2: out.filter((x) => x.phase === 2),
    phase1Units: phase1.reduce((a, x) => a + x.units, 0),
    totalUnits,
    overPhase2Cap: totalUnits > PHASE2_CAP + EPS,
  };
}
