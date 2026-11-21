import { describe, expect, it } from "vitest";
import { compareForPhase1, planEnrollment, waitRiskOf, type PlanInput } from "./enrollPlan";
import type { Prediction } from "./types";

function pred(course: string, over: Partial<Prediction> = {}): Prediction {
  return { course, professorSeenBefore: true, popularity: 0.5, ...over };
}
function item(course: string, units: number, over: Partial<Prediction> = {}): PlanInput {
  return { course, units, prediction: pred(course, over) };
}

describe("planEnrollment", () => {
  it("puts the riskiest classes in Phase 1 and stays under the unit cap", () => {
    const plan = planEnrollment(
      [item("A 1", 4, { waitRisk: 0.05 }), item("B 1", 4, { waitRisk: 0.4 }), item("C 1", 4, { waitRisk: 0.3 }), item("D 1", 4, { waitRisk: 0.25 })],
      13.5,
    );
    expect(plan.phase1.map((x) => x.course)).toEqual(["B 1", "C 1", "D 1"]);
    expect(plan.phase2.map((x) => x.course)).toEqual(["A 1"]);
    expect(plan.phase1Units).toBe(12);
    expect(plan.phase1Units).toBeLessThanOrEqual(plan.cap);
  });

  it("respects a lower cap such as 12 units", () => {
    const plan = planEnrollment([item("A 1", 5, { waitRisk: 0.3 }), item("B 1", 4, { waitRisk: 0.3 }), item("C 1", 4, { waitRisk: 0.3 })], 12);
    expect(plan.phase1Units).toBeLessThanOrEqual(12);
    expect(plan.phase1).toHaveLength(2);
  });

  it("prefers the set that removes the most risk, not just the single riskiest class", () => {
    // One 8-unit class at 0.30 or two 4-unit classes at 0.25 each alongside a 5-unit one.
    const plan = planEnrollment(
      [item("BIG 1", 8, { waitRisk: 0.3 }), item("X 1", 4, { waitRisk: 0.25 }), item("Y 1", 4, { waitRisk: 0.25 }), item("Z 1", 5, { waitRisk: 0.28 })],
      13.5,
    );
    expect(plan.phase1.map((x) => x.course).sort()).toEqual(["X 1", "Y 1", "Z 1"]);
    expect(plan.phase2[0].course).toBe("BIG 1");
    expect(plan.phase2[0].squeezedOut).toBe(true);
  });

  it("breaks ties by earlier fill date, then demand, then fewer units", () => {
    const early = item("EARLY 1", 4, { waitRisk: 0.2, expectedFillDate: "2026-10-28" });
    const late = item("LATE 1", 4, { waitRisk: 0.2, expectedFillDate: "2026-11-10" });
    expect(compareForPhase1(early, late)).toBeLessThan(0);
    const hot = item("HOT 1", 4, { waitRisk: 0.2, popularity: 0.9 });
    const mild = item("MILD 1", 4, { waitRisk: 0.2, popularity: 0.4 });
    expect(compareForPhase1(hot, mild)).toBeLessThan(0);
    const small = item("SMALL 1", 3, { waitRisk: 0.2 });
    const large = item("LARGE 1", 4, { waitRisk: 0.2 });
    expect(compareForPhase1(small, large)).toBeLessThan(0);
    // Only one of two equal-risk classes fits: the earlier-filling one gets Phase 1.
    const plan = planEnrollment([late, early, item("KEEP 1", 8, { waitRisk: 0.5 })], 13.5);
    expect(plan.phase1.map((x) => x.course)).toEqual(["KEEP 1", "EARLY 1"]);
  });

  it("does not treat a class that fills but clears its waitlist as a priority", () => {
    const expands = item("COMPSCI 61A", 4, {
      waitRisk: 0.06,
      pFullByPhase: { "Phase 1": 0.8, "Phase 2": 0.95 },
      waitlist: { pWaitlist: 0.97, clearRate: 0.93, pastTerms: 9, pastTermsWithWaitlist: 9 },
      capacityExpansion: { pExpands: 0.74, expectedGrowth: 0.39, pastTerms: 9, pastTermsExpanded: 7 },
    });
    const stuck = item("HISTORY 190", 4, {
      waitRisk: 0.35,
      pFullByPhase: { "Phase 1": 0.6, "Phase 2": 0.8 },
      waitlist: { pWaitlist: 0.9, clearRate: 0.45, pastTerms: 4, pastTermsWithWaitlist: 4 },
    });
    const plan = planEnrollment([expands, stuck, item("F 1", 4, { waitRisk: 0.3 }), item("G 1", 4, { waitRisk: 0.3 })], 13.5);
    expect(plan.phase2.map((x) => x.course)).toEqual(["COMPSCI 61A"]);
    expect(plan.phase2[0].reason).toMatch(/93% of its waitlist/);
    expect(plan.phase2[0].reason).toMatch(/seats are usually added/);
    expect(plan.phase2[0].squeezedOut).toBe(false);
  });

  it("uses spare Phase 1 units for low-risk classes and handles classes without predictions", () => {
    const plan = planEnrollment([item("A 1", 4, { waitRisk: 0.01 }), { course: "NEW 1", units: 3 }], 13.5);
    expect(plan.phase1).toHaveLength(2);
    expect(plan.phase2).toHaveLength(0);
    expect(plan.overPhase2Cap).toBe(false);
  });

  it("falls back to fill odds for predictions without waitRisk", () => {
    const old = pred("OLD 1", { pFullByPhase: { "Phase 1": 0.9, "Phase 2": 1 } });
    expect(waitRiskOf(old)).toBeCloseTo(0.19, 2);
    expect(waitRiskOf(undefined)).toBe(0);
  });

  it("flags plans over the Phase 2 total and stays fast with many classes", () => {
    const many = Array.from({ length: 20 }, (_, i) => item(`M ${i}`, 4, { waitRisk: i / 100 }));
    const plan = planEnrollment(many, 13.5);
    expect(plan.phase1Units).toBeLessThanOrEqual(13.5);
    expect(plan.overPhase2Cap).toBe(true);
    expect(plan.phase1[0].course).toBe("M 19");
  });
});
