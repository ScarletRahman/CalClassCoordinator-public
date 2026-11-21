import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fillRank, filterInstructors, instructorNudge, rangeText, reconcileInstructors, sameInstructor, seatsForInstructor, sortInstructors, summarizeInstructors } from "./professors";
import type { Prediction, SectionSeats } from "./types";

const p = (professor: string | undefined, fillsInPhase: string, popularity: number, seen = true): Prediction => ({
  course: "ENGLISH R1A",
  professor,
  professorSeenBefore: seen,
  popularity,
  fillsInPhase,
});

const many = [
  p("Ana Zeta", "Phase 2", 0.7),
  p("Bo Young", "Phase 1", 0.95),
  p("Cy Abel", "Adjustment Period", 0.5, false),
  p("Di Moss", "Phase 1", 0.9),
];

describe("fillRank", () => {
  it("orders the phases", () => {
    expect(["Phase 1", "Phase 2", "Adjustment Period", "Does not fill"].map((f) => fillRank(p("x", f, 0.5)))).toEqual([0, 1, 2, 3]);
  });
  it("falls back to popularity when no phase is given", () => {
    expect(fillRank({ popularity: 0.9 })).toBe(0);
    expect(fillRank({ popularity: 0.7 })).toBe(1);
    expect(fillRank({ popularity: 0.2 })).toBe(3);
  });
});

describe("summarizeInstructors", () => {
  it("has no headline for a many-instructor class until one is chosen", () => {
    const s = summarizeInstructors(many);
    expect(s).toMatchObject({ count: 4, several: true, headline: undefined, earliest: 0, latest: 2, newCount: 1, peakPopularity: 0.95 });
    expect(s.rangeText).toBe("fills from Phase 1 to Adjustment depending on instructor");
    expect(instructorNudge(s)).toBe("4 instructors · fills from Phase 1 to Adjustment depending on instructor · pick one");
    expect(s.named.map((x) => x.professor)).toEqual(["Bo Young", "Di Moss", "Ana Zeta", "Cy Abel"]);
  });

  it("uses the chosen instructor's forecast as the headline", () => {
    const s = summarizeInstructors(many, "Cy Abel");
    expect(s.headline?.professor).toBe("Cy Abel");
    expect(s.chosenUnknown).toBe(false);
    expect(instructorNudge(s)).toBeNull();
  });

  it("flags a chosen instructor we have no forecast for and invents nothing", () => {
    const s = summarizeInstructors(many, "Someone Else");
    expect(s.chosen).toBeUndefined();
    expect(s.chosenUnknown).toBe(true);
    expect(s.headline).toBeUndefined();
  });

  it("keeps single-instructor classes simple", () => {
    const s = summarizeInstructors([p("Solo Prof", "Phase 2", 0.7)]);
    expect(s).toMatchObject({ count: 1, several: false, rangeText: "fills in Phase 2" });
    expect(s.headline?.professor).toBe("Solo Prof");
    expect(instructorNudge(s)).toBeNull();
  });

  it("handles a class with no instructor listed and a class with no predictions", () => {
    const s = summarizeInstructors([p(undefined, "Does not fill", 0.2)]);
    expect(s).toMatchObject({ count: 0, several: false, rangeText: "rarely fills" });
    expect(s.headline).toBeDefined();
    const none = summarizeInstructors(undefined);
    expect(none).toMatchObject({ count: 0, several: false, headline: undefined, rangeText: undefined, peakPopularity: undefined });
  });

  it("an unnamed entry does not hide the named ones", () => {
    const s = summarizeInstructors([p(undefined, "Phase 1", 0.9), p("A B", "Phase 2", 0.7), p("C D", "Phase 2", 0.6)]);
    expect(s).toMatchObject({ count: 2, several: true });
    expect(s.rangeText).toBe("fills in Phase 2 with every instructor");
  });
});

describe("rangeText", () => {
  it("covers every shape", () => {
    expect(rangeText(0, 0, 5)).toBe("fills in Phase 1 with every instructor");
    expect(rangeText(3, 3, 5)).toBe("rarely fills with any instructor");
    expect(rangeText(0, 3, 5)).toBe("fills as early as Phase 1 or not at all depending on instructor");
    expect(rangeText(1, 2, 5)).toBe("fills from Phase 2 to Adjustment depending on instructor");
  });
});

describe("sorting and filtering", () => {
  it("sorts by demand, by ease and by last name", () => {
    expect(sortInstructors(many, "demand").map((x) => x.professor)).toEqual(["Bo Young", "Di Moss", "Ana Zeta", "Cy Abel"]);
    expect(sortInstructors(many, "easiest").map((x) => x.professor)).toEqual(["Cy Abel", "Ana Zeta", "Di Moss", "Bo Young"]);
    expect(sortInstructors(many, "name").map((x) => x.professor)).toEqual(["Cy Abel", "Di Moss", "Bo Young", "Ana Zeta"]);
    expect(many[0].professor).toBe("Ana Zeta"); // input untouched
  });
  it("filters on any name part, ignoring case and accents", () => {
    expect(filterInstructors(many, "mo").map((x) => x.professor)).toEqual(["Di Moss"]);
    expect(filterInstructors(many, "  ").length).toBe(4);
    expect(filterInstructors([p("José Núñez-Ortiz", "Phase 1", 1)], "nunez").length).toBe(1);
    expect(filterInstructors([p("José Núñez-Ortiz", "Phase 1", 1)], "ortiz jo").length).toBe(1);
    expect(filterInstructors(many, "zz")).toEqual([]);
  });
});

describe("seats by instructor", () => {
  const sec = (instructor: string | undefined, enrolled: number, capacity: number, waitlisted = 0): SectionSeats => ({
    course: "ENGLISH R1A",
    classNumber: "1",
    section: "001",
    instructor,
    enrolled,
    capacity,
    waitlisted,
    open: enrolled < capacity,
  });
  it("matches names loosely and adds up that instructor's sections", () => {
    expect(sameInstructor("John DeNero", "john denero")).toBe(true);
    expect(sameInstructor("John DeNero", "DeNero, J")).toBe(true);
    expect(sameInstructor("John DeNero", "DeNero")).toBe(true);
    expect(sameInstructor("John DeNero", "Jane Doe")).toBe(false);
    expect(sameInstructor("John DeNero", undefined)).toBe(false);
    const s = seatsForInstructor([sec("Bo Young", 15, 17), sec("Bo Young", 17, 17, 3), sec("Di Moss", 1, 17)], "Bo Young");
    expect(s).toEqual({ sections: 2, open: 2, waitlisted: 3, capacity: 34 });
    expect(seatsForInstructor([sec(undefined, 1, 2)], "Bo Young")).toBeNull();
    expect(seatsForInstructor(undefined, "Bo Young")).toBeNull();
  });
  it("trusts live seat data for who teaches when it disagrees with the forecast", () => {
    const preds = [p("Manuel Sabin", "Phase 1", 0.9)];
    expect(reconcileInstructors(preds, [sec("Josh Hug", 1, 2)])).toEqual({ fromSeats: ["Josh Hug"], mismatch: true });
    expect(reconcileInstructors(preds, [sec("Sabin, M", 1, 2), sec("Josh Hug", 1, 2)]).mismatch).toBe(false);
    expect(reconcileInstructors(preds, [sec(undefined, 1, 2)])).toEqual({ fromSeats: [], mismatch: false });
    expect(reconcileInstructors(preds, undefined).mismatch).toBe(false);
    expect(reconcileInstructors([p(undefined, "Phase 1", 0.9)], [sec("Josh Hug", 1, 2)]).mismatch).toBe(false);
  });
});

// The predictor's real output: the classes the owner called out must come through as many-instructor classes.
const file = path.join(process.env.CCC_DATA_DIR ?? path.resolve(process.cwd(), "..", "data"), "predictions", "predictions.json");
describe.skipIf(!fs.existsSync(file))("real predictions", () => {
  const all = (JSON.parse(fs.readFileSync(file, "utf8")) as { predictions: (Prediction & { professor: string | null })[] }).predictions.map((x) => ({ ...x, professor: x.professor ?? undefined }));
  const of = (course: string) => all.filter((x) => x.course === course);
  it("R1A/R1B classes have several instructors and a truthful range", () => {
    for (const course of ["ENGLISH R1A", "COLWRIT R1A", "COMLIT R1B"]) {
      const preds = of(course);
      if (!preds.length) continue;
      const s = summarizeInstructors(preds);
      expect(s.count, course).toBe(new Set(preds.filter((x) => x.professor).map((x) => x.professor)).size);
      expect(s.several, course).toBe(true);
      expect(s.headline, course).toBeUndefined();
      const ranks = s.named.map(fillRank);
      expect(s.earliest).toBe(Math.min(...ranks));
      expect(s.latest).toBe(Math.max(...ranks));
      expect(instructorNudge(s)).toMatch(/^\d+ instructors · .+ · pick one$/);
      const pick = s.named[s.named.length - 1].professor!;
      expect(summarizeInstructors(preds, pick).headline?.professor).toBe(pick);
    }
  });
  it("every course summarises without throwing", () => {
    const by = new Map<string, Prediction[]>();
    for (const x of all) by.set(x.course, [...(by.get(x.course) ?? []), x]);
    for (const [, preds] of by) {
      const s = summarizeInstructors(preds);
      expect(s.rangeText).toBeTruthy();
      if (!s.several) expect(s.headline).toBeDefined();
    }
  });
});
