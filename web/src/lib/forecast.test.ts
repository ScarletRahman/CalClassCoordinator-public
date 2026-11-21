import { describe, expect, it } from "vitest";
import { forecastAdvice, forecastState, gamePlanToday, instructorRangeNow, isoDay, waitlistNote } from "./forecast";
import type { Phase, Prediction } from "./types";

const phases: Phase[] = [
  { name: "Phase 1", start: "2026-10-26", end: "2026-11-15" },
  { name: "Phase 2", start: "2026-11-23", end: "2027-01-10" },
  { name: "Adjustment Period", start: "2027-01-11", end: "2027-02-10" },
];
const p = (fillsInPhase: string, expectedFillDate?: string, professor = "A B"): Prediction => ({ course: "X 1", professor, professorSeenBefore: true, popularity: 0.9, fillsInPhase, expectedFillDate, recommendation: "Phase 1 priority" });
const TODAY = "2026-11-20";

describe("forecastAdvice", () => {
  it("after the fill phase has closed it says probably full and offers an alert, never 'Phase 1 priority'", () => {
    const a = forecastAdvice(p("Phase 1", "2026-11-01"), phases, TODAY);
    expect(a).toMatchObject({ state: "passed", label: "Probably full", suggestAlert: true, fromSeats: false });
    expect(a.advice).toBe("Probably full already (it usually fills in Phase 1). Check for open seats, join the waitlist, or set a seat alert.");
    expect(a.advice).not.toMatch(/priority|Nov 1\b/);
  });
  it("a fill date that has passed inside a still-open phase also counts as passed", () => {
    expect(forecastState(p("Phase 2", "2026-11-25"), phases, "2026-12-05")).toBe("passed");
  });
  it("while the phase is open: enroll now", () => {
    const a = forecastAdvice(p("Phase 2", "2026-11-30"), phases, "2026-11-24");
    expect(a).toMatchObject({ state: "open", label: "Filling now (Phase 2)", suggestAlert: false });
    expect(a.advice).toBe("Enroll now: usually full around Nov 30.");
  });
  it("before the phase opens: says when it opens", () => {
    const a = forecastAdvice(p("Phase 2", "2026-12-02"), phases, TODAY);
    expect(a).toMatchObject({ state: "upcoming", label: "Fills in Phase 2" });
    expect(a.advice).toBe("Enroll as soon as Phase 2 opens on Nov 23: usually full around Dec 2.");
    expect(forecastAdvice(p("Phase 1", "2026-11-01"), phases, "2026-10-01").advice).toBe("Enroll as soon as Phase 1 opens on Oct 26: usually full around Nov 1.");
    expect(forecastAdvice(p("Adjustment Period"), phases, TODAY).advice).toBe("Enroll as soon as Adjustment Period opens on Jan 11: usually full by the end of Adjustment.");
  });
  it("classes that do not fill", () => {
    expect(forecastAdvice(p("Does not fill"), phases, TODAY)).toMatchObject({ state: "never", label: "Rarely fills", suggestAlert: false });
  });
  it("live seats override the guess", () => {
    const open = forecastAdvice(p("Phase 1", "2026-11-01"), phases, TODAY, { open: 12, waitlisted: 0 });
    expect(open).toMatchObject({ label: "12 open now", fromSeats: true, suggestAlert: false });
    expect(open.advice).toBe("12 open seats right now. It usually fills in Phase 1, so do not wait.");
    const full = forecastAdvice(p("Does not fill"), phases, TODAY, { open: 0, waitlisted: 7 });
    expect(full).toMatchObject({ label: "Full · 7 waitlisted", suggestAlert: true, fromSeats: true });
    expect(forecastAdvice(p("Phase 2", "2026-12-02"), phases, TODAY, { open: 1, waitlisted: 0 }).advice).toBe("1 open seat right now. It is usually full around Dec 2.");
  });
  it("works with no phase table", () => {
    expect(forecastAdvice(p("Phase 1"), [], TODAY)).toMatchObject({ state: "upcoming", label: "Fills in Phase 1" });
  });
});

describe("instructorRangeNow", () => {
  const list = [p("Phase 1", "2026-11-05", "A"), p("Phase 1", "2026-11-09", "B"), p("Phase 2", "2026-12-01", "C"), p("Adjustment Period", undefined, "D")];
  it("says how many have probably filled and what is left", () => {
    expect(instructorRangeNow(list, phases, TODAY)).toBe("2 of 4 instructors' sections have probably filled already; the rest fill from Phase 2 to Adjustment");
    expect(instructorRangeNow(list, phases, "2026-10-01")).toBe("sections fill from Phase 1 to Adjustment depending on instructor");
    expect(instructorRangeNow(list.slice(0, 2), phases, TODAY)).toBe("every instructor's sections have probably filled already");
    expect(instructorRangeNow([list[0], p("Does not fill", undefined, "E")], phases, TODAY)).toBe("1 of 2 instructors' sections have probably filled already; the rest rarely fill");
    expect(instructorRangeNow([], phases, TODAY)).toBe("");
  });
});

describe("gamePlanToday", () => {
  it("between phases it names the next one and leads with what has filled", () => {
    const g = gamePlanToday(phases, TODAY, { total: 5, filled: 3, needPick: 1 });
    expect(g.badge).toBe("Phase 2 opens Mon, Nov 23");
    expect(g.active).toBe(false);
    expect(g.text).toBe("3 of your 5 classes have probably filled: line up waitlists and seat alerts first. One class depends on which instructor you want.");
  });
  it("during a phase and after all phases", () => {
    expect(gamePlanToday(phases, "2026-11-24", { total: 2, filled: 0, needPick: 0 })).toMatchObject({ active: true, text: "Enroll in this order; the classes that fill earliest come first." });
    expect(gamePlanToday(phases, "2027-03-01", { total: 1, filled: 1, needPick: 0 }).badge).toBeNull();
    expect(gamePlanToday(phases, TODAY, { total: 0, filled: 0, needPick: 0 }).text).toBe("");
  });
  it("isoDay uses the local date", () => {
    expect(isoDay(new Date(2026, 10, 20, 23, 30))).toBe("2026-11-20");
  });
});

describe("waitlistNote", () => {
  const wl = (clearRate: number) => ({ pWaitlist: 0.9, clearRate, pastTerms: 9, pastTermsWithWaitlist: 9 });
  it("says whether waitlisting usually works, and stays silent without history", () => {
    expect(waitlistNote({})).toBe("");
    const grows = { pExpands: 0.74, expectedGrowth: 0.39, pastTerms: 9, pastTermsExpanded: 7 };
    expect(waitlistNote({ waitlist: wl(0.93), capacityExpansion: grows })).toBe(" In past terms about 93% of its waitlist got a seat and seats are usually added, so waitlisting usually works.");
    expect(waitlistNote({ waitlist: wl(0.4) })).toMatch(/only about 40%.*backup/);
  });
  it("is added to the advice for a class that has probably filled", () => {
    const a = forecastAdvice({ ...p("Phase 1", "2026-11-01"), waitlist: wl(0.93) }, phases, "2026-11-20");
    expect(a.advice).toMatch(/Probably full already.*about 93% of its waitlist got a seat/);
  });
});
