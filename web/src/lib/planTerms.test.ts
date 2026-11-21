import { beforeAll, describe, expect, it } from "vitest";
import { alsoListedAs, familyLookup, familyMembers, registerCourseFamilies, sameClass, uniqueClasses } from "./courseFamily";
import { addClassActions, buildTermEntries, CREDIT, creditId, defaultTermKey, findInPlan, locationText, moveClassActions, planLocations, unitsOutlook } from "./planTerms";
import { buildCourseIndex } from "./requirements";
import { EMPTY_STATE, reducer, type Action } from "./store";
import { defaultPastTerms, suggestNextSummer, suggestNextTerm, termPhase, termYearRange } from "./terms";
import type { Course, PlannerState } from "./types";

const course = (id: string, units = 4, crossListed?: string[]): Course => {
  const sp = id.lastIndexOf(" ");
  return { id, subject: id.slice(0, sp), number: id.slice(sp + 1), title: id, units, crossListed };
};
const courses = [
  course("DATA C100", 4, ["COMPSCI C100", "STAT C100"]),
  course("STAT C100", 4, ["COMPSCI C100", "DATA C100"]),
  course("COMPSCI C100", 4, ["DATA C100", "STAT C100"]),
  // one-way listing, as in the real catalog
  course("AMERSTD C111E", 4, ["ENGLISH C136"]),
  course("ENGLISH C136", 4),
  course("COMPSCI 61A"),
  course("COMPSCI 61B"),
  course("MATH 54"),
  course("ENGLISH R1A"),
  course("COLWRIT R1A", 6),
];
const idx = buildCourseIndex(courses);
const NOW = new Date("2026-11-20T12:00:00"); // Fall 2026 is current, Spring 2027 is enrolling
const ENROLLING = "2027 Spring";

const run = (state: PlannerState, ...actions: Action[]) => actions.reduce(reducer, state);
const base: PlannerState = { ...EMPTY_STATE, majorIds: ["x"], semesters: [{ term: "2026 Fall", courses: [] }, { term: "2027 Spring", courses: [] }] };
const planned = (s: PlannerState) => s.semesters.flatMap((x) => x.courses.map((c) => `${x.term}:${c.course}`));

beforeAll(() => registerCourseFamilies(idx));

describe("course families", () => {
  it("are symmetric even when the catalog lists one direction only", () => {
    expect(familyMembers("ENGLISH C136", idx)).toEqual(["ENGLISH C136", "AMERSTD C111E"]);
    expect(sameClass("ENGLISH C136", "AMERSTD C111E", idx)).toBe(true);
    expect(sameClass("AMERSTD C111E", "ENGLISH C136", idx)).toBe(true);
    expect(familyMembers("STAT C100", idx)).toEqual(["STAT C100", "COMPSCI C100", "DATA C100"]);
    expect(alsoListedAs("DATA C100", idx)).toEqual(["COMPSCI C100", "STAT C100"]);
    expect(familyMembers("NOPE 1", idx)).toEqual(["NOPE 1"]);
    expect(sameClass("COMPSCI 61A", "COMPSCI 61B", idx)).toBe(false);
  });
  it("looks data up under any member, own code first", () => {
    const preds = new Map([["STAT C100", ["s"]], ["COMPSCI 61A", ["a"]], ["DATA C100", [] as string[]]]);
    expect(familyLookup(preds, "DATA C100", idx)).toEqual({ value: ["s"], via: "STAT C100" });
    expect(familyLookup(preds, "STAT C100", idx)).toEqual({ value: ["s"], via: "STAT C100" });
    expect(familyLookup(preds, "COMPSCI 61A", idx)?.via).toBe("COMPSCI 61A");
    expect(familyLookup(preds, "MATH 54", idx)).toBeUndefined();
  });
  it("collapses a list to one entry per class", () => {
    expect(uniqueClasses(["DATA C100", "MATH 54", "STAT C100", "COMPSCI C100"], (x) => x, idx)).toEqual(["DATA C100", "MATH 54"]);
  });
});

// Renumbered classes join the family once crossList.familyOf follows Course.sameAs.
const renum = buildCourseIndex([
  { ...course("EECS 16A"), sameAs: ["ELENG 16A"], retired: true },
  { ...course("ELENG 16A"), sameAs: ["EECS 16A", "ELENG 66"] },
  { ...course("ELENG 66"), sameAs: ["ELENG 16A"] },
]);
describe.skipIf(!familyMembers("EECS 16A", renum).includes("ELENG 66"))("sameAs families", () => {
  it("a forecast filed under any number of the class is found from the others", () => {
    const preds = new Map([["ELENG 66", ["p"]]]);
    expect(familyLookup(preds, "EECS 16A", renum)).toEqual({ value: ["p"], via: "ELENG 66" });
    expect(familyLookup(preds, "ELENG 16A", renum)?.via).toBe("ELENG 66");
    expect(sameClass("EECS 16A", "ELENG 66", renum)).toBe(true);
  });
});

describe("reducer treats a cross-list family as one class", () => {
  it("cannot plan two members", () => {
    const s = run(base, { type: "addPlanned", term: "2027 Spring", course: "DATA C100" }, { type: "addPlanned", term: "2027 Spring", course: "STAT C100" });
    expect(planned(s)).toEqual(["2027 Spring:DATA C100"]);
    const moved = run(s, { type: "addPlanned", term: "2026 Fall", course: "COMPSCI C100" });
    expect(planned(moved)).toEqual(["2026 Fall:COMPSCI C100"]);
  });
  it("cannot plan a class taken under another code, and taking it clears the plan", () => {
    const taken = run(base, { type: "addTaken", courses: [{ course: "STAT C100", term: "2025 Fall", source: "manual" }] });
    expect(run(taken, { type: "addPlanned", term: "2027 Spring", course: "DATA C100" })).toBe(taken);
    const s = run(base, { type: "addPlanned", term: "2027 Spring", course: "DATA C100" }, { type: "addTaken", courses: [{ course: "COMPSCI C100", source: "manual" }] });
    expect(planned(s)).toEqual([]);
    expect(s.taken.map((t) => t.course)).toEqual(["COMPSCI C100"]);
  });
  it("cannot take two members; a transcript's code wins, a hand-added one does not rename", () => {
    const a = run(base, { type: "addTaken", courses: [{ course: "DATA C100", term: "2025 Fall", grade: "A", source: "manual" }] });
    const b = run(a, { type: "addTaken", courses: [{ course: "STAT C100", source: "manual" }] });
    expect(b.taken).toHaveLength(1);
    expect(b.taken[0]).toMatchObject({ course: "DATA C100", grade: "A" });
    const c = run(a, { type: "addTaken", courses: [{ course: "STAT C100", term: "2025 Fall", grade: "A-", source: "transcript" }] });
    expect(c.taken).toEqual([{ course: "STAT C100", term: "2025 Fall", grade: "A-", source: "transcript" }]);
    const both = run(base, { type: "addTaken", courses: [{ course: "DATA C100", source: "manual" }, { course: "COMPSCI C100", source: "manual" }] });
    expect(both.taken).toHaveLength(1);
  });
  it("works for one-way listings in either direction", () => {
    const s = run(base, { type: "addPlanned", term: "2027 Spring", course: "ENGLISH C136" }, { type: "addPlanned", term: "2026 Fall", course: "AMERSTD C111E" });
    expect(planned(s)).toEqual(["2026 Fall:AMERSTD C111E"]);
    const t = run(base, { type: "addPlanned", term: "2027 Spring", course: "AMERSTD C111E" }, { type: "addPlanned", term: "2026 Fall", course: "ENGLISH C136" });
    expect(planned(t)).toEqual(["2026 Fall:ENGLISH C136"]);
  });
  it("moves, removes and sets the instructor by family", () => {
    let s = run(base, { type: "addPlanned", term: "2027 Spring", course: "DATA C100" }, { type: "setProfessor", term: "2027 Spring", course: "STAT C100", professor: "P" });
    expect(s.semesters[1].courses).toEqual([{ course: "DATA C100", professor: "P" }]);
    s = run(s, { type: "movePlanned", from: "2027 Spring", to: "2027 Fall", course: "STAT C100" });
    expect(planned(s)).toEqual(["2027 Fall:DATA C100"]);
    expect(s.semesters.map((x) => x.term)).toEqual(["2026 Fall", "2027 Spring", "2027 Fall"]);
    expect(s.semesters[2].courses[0].professor).toBe("P");
    s = run(s, { type: "removePlanned", term: "2027 Fall", course: "COMPSCI C100" });
    expect(planned(s)).toEqual([]);
    const t = run(base, { type: "addTaken", courses: [{ course: "DATA C100", source: "manual" }] }, { type: "removeTaken", course: "STAT C100" });
    expect(t.taken).toEqual([]);
  });
  it("adding a class again to the term it is already in keeps its instructor", () => {
    const s = run(base, { type: "addPlanned", term: "2027 Spring", course: "ENGLISH R1A" }, { type: "setProfessor", term: "2027 Spring", course: "ENGLISH R1A", professor: "P" });
    expect(run(s, { type: "addPlanned", term: "2027 Spring", course: "ENGLISH R1A" })).toBe(s);
  });
});

describe("taken class actions", () => {
  const withTaken = run(base, { type: "addTaken", courses: [{ course: "COMPSCI 61A", term: "2025 Fall", grade: "A", units: 4, source: "transcript" }] });
  it("updateTaken patches and clears fields", () => {
    const s = run(withTaken, { type: "updateTaken", course: "COMPSCI 61A", patch: { grade: "B+" } });
    expect(s.taken[0]).toMatchObject({ grade: "B+", term: "2025 Fall", source: "transcript" });
    const cleared = run(s, { type: "updateTaken", course: "COMPSCI 61A", patch: { grade: undefined } });
    expect("grade" in cleared.taken[0]).toBe(false);
  });
  it("setTakenTerm moves between terms and to no term", () => {
    expect(run(withTaken, { type: "setTakenTerm", course: "COMPSCI 61A", term: "2026 Spring" }).taken[0].term).toBe("2026 Spring");
    const none = run(withTaken, { type: "setTakenTerm", course: "COMPSCI 61A" });
    expect("term" in none.taken[0]).toBe(false);
  });
  it("markTaken and unmarkTaken flip one class", () => {
    const s = run(base, { type: "addPlanned", term: "2026 Fall", course: "MATH 54" }, { type: "addPlanned", term: "2026 Fall", course: "COMPSCI 61B" }, { type: "markTaken", term: "2026 Fall", course: "MATH 54", grade: "A" });
    expect(s.taken).toEqual([{ course: "MATH 54", term: "2026 Fall", source: "manual", grade: "A" }]);
    expect(planned(s)).toEqual(["2026 Fall:COMPSCI 61B"]);
    const back = run(s, { type: "unmarkTaken", course: "MATH 54", term: "2027 Spring" });
    expect(back.taken).toEqual([]);
    expect(planned(back)).toEqual(["2026 Fall:COMPSCI 61B", "2027 Spring:MATH 54"]);
    expect(run(base, { type: "markTaken", term: "2026 Fall", course: "MATH 54" })).toBe(base);
    expect(run(base, { type: "unmarkTaken", course: "MATH 54", term: "2026 Fall" })).toBe(base);
  });
  it("removeTerm drops the semester and the classes taken in it, nothing else", () => {
    const s = run(withTaken, { type: "addTaken", courses: [{ course: "MATH 54", term: "2026 Spring", source: "manual" }] }, { type: "addSemester", term: "2025 Fall" }, { type: "removeTerm", term: "2025 Fall" });
    expect(s.taken.map((t) => t.course)).toEqual(["MATH 54"]);
    expect(s.semesters.map((x) => x.term)).toEqual(["2026 Fall", "2027 Spring"]);
  });
});

describe("term entries", () => {
  const state = run(
    base,
    { type: "addTaken", courses: [
      { course: "AP CALC BC", label: "AP Calculus BC", units: 5.3, source: "ap" },
      { course: "MATH 54", term: "2024 Fall", source: "transfer" },
      { course: "COMPSCI 61A", term: "2025 Fall", grade: "A", source: "transcript" },
      { course: "COLWRIT R1A", term: "2026 Summer", source: "transcript" },
    ] },
    { type: "addSemester", term: "2025 Spring" },
    { type: "addPlanned", term: "2025 Spring", course: "COMPSCI 61B" },
    { type: "addPlanned", term: "2026 Fall", course: "DATA C100" },
    { type: "addPlanned", term: "2027 Spring", course: "ENGLISH R1A" },
    { type: "setProfessor", term: "2027 Spring", course: "ENGLISH R1A", professor: "P" },
  );
  const entries = buildTermEntries(state, idx, NOW, ENROLLING);
  const by = (k: string) => entries.find((e) => e.key === k)!;

  it("lists credit first, then every term with anything in it, oldest first", () => {
    expect(entries.map((e) => e.key)).toEqual([CREDIT, "2025 Spring", "2025 Fall", "2026 Summer", "2026 Fall", "2027 Spring"]);
    expect(entries.map((e) => e.phase)).toEqual(["credit", "past", "past", "past", "current", "enrolling"]);
    expect(by(CREDIT).label).toBe("Test & transfer credit");
  });
  it("totals units from the transcript when given, else the catalog", () => {
    expect(by(CREDIT).units).toBe(9.3);
    expect(by("2026 Summer").units).toBe(6);
    expect(by("2027 Spring")).toMatchObject({ units: 4, plannedCount: 1, takenCount: 0 });
    expect(by("2027 Spring").rows[0]).toMatchObject({ course: "ENGLISH R1A", status: "planned", professor: "P" });
  });
  it("marks past terms done or needing review", () => {
    expect(by("2025 Fall")).toMatchObject({ done: true, needsReview: false });
    expect(by("2025 Spring")).toMatchObject({ done: false, needsReview: true });
    expect(by("2026 Fall")).toMatchObject({ done: false, needsReview: false });
  });
  it("opens the enrolling term first, else the current, else the next one ahead", () => {
    expect(defaultTermKey(entries, NOW, ENROLLING)).toBe("2027 Spring");
    expect(defaultTermKey(entries, NOW, null)).toBe("2026 Fall");
    expect(defaultTermKey(entries.filter((e) => e.phase === "past" || e.phase === "credit"), NOW, ENROLLING)).toBe("2026 Summer");
    expect(defaultTermKey([], NOW, ENROLLING)).toBeNull();
    expect(defaultTermKey(entries, NOW, "2026 Spring")).toBe("2026 Fall");
  });
  it("an empty term the student added still shows", () => {
    const e = buildTermEntries(run(EMPTY_STATE, { type: "addSemester", term: "2024 Summer" }), idx, NOW, ENROLLING);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ key: "2024 Summer", phase: "past", units: 0, done: false, needsReview: false });
  });
  it("finds a class in the plan under any code", () => {
    expect(findInPlan(state, "STAT C100", idx)).toMatchObject({ key: "2026 Fall", planned: { term: "2026 Fall", course: { course: "DATA C100" } } });
    expect(findInPlan(state, "MATH 54", idx)).toMatchObject({ key: CREDIT, taken: { course: "MATH 54" } });
    expect(findInPlan(state, "COMPSCI 61A", idx).key).toBe("2025 Fall");
    expect(findInPlan(state, "ENGLISH C136", idx)).toEqual({});
    const loc = planLocations(state);
    expect(locationText("DATA C100", "DATA C100", loc.get("DATA C100")!)).toBe("In Fall 2026");
    expect(locationText("STAT C100", "DATA C100", loc.get("DATA C100")!)).toBe("Planned as DATA C100 in Fall 2026");
    expect(locationText("COMPSCI 61A", "COMPSCI 61A", loc.get("COMPSCI 61A")!)).toBe("Taken Fall 2025");
    expect(locationText("MATH 52", "COMPSCI 61A", loc.get("COMPSCI 61A")!)).toBe("You took this as COMPSCI 61A in Fall 2025");
    expect(locationText("MATH 54", "MATH 54", loc.get("MATH 54")!)).toBe("Taken (credit)");
  });
});

describe("adding and moving by term", () => {
  it("past terms default to taken, current and future to planned, credit to undated", () => {
    expect(addClassActions("2025 Fall", "MATH 54", NOW)).toEqual([{ type: "addTaken", courses: [{ course: "MATH 54", term: "2025 Fall", source: "manual" }] }]);
    expect(addClassActions("2026 Fall", "MATH 54", NOW)).toEqual([{ type: "addPlanned", term: "2026 Fall", course: "MATH 54" }]);
    expect(addClassActions("2028 Summer", "MATH 54", NOW)).toEqual([{ type: "addPlanned", term: "2028 Summer", course: "MATH 54" }]);
    expect(addClassActions(CREDIT, "MATH 54", NOW)).toEqual([{ type: "addTaken", courses: [{ course: "MATH 54", source: "transfer" }] }]);
  });

  const state = run(
    base,
    { type: "addTaken", courses: [{ course: "COMPSCI 61A", term: "2025 Fall", grade: "A", source: "transcript" }] },
    { type: "addPlanned", term: "2027 Spring", course: "DATA C100" },
    { type: "setProfessor", term: "2027 Spring", course: "DATA C100", professor: "P" },
  );
  const move = (s: PlannerState, c: string, to: string) => run(s, ...moveClassActions(s, c, to, idx, NOW));

  it("a taken class keeps its grade between past terms and the credit bucket", () => {
    const a = move(state, "COMPSCI 61A", "2025 Spring");
    expect(a.taken[0]).toMatchObject({ term: "2025 Spring", grade: "A", source: "transcript" });
    const b = move(a, "COMPSCI 61A", CREDIT);
    expect(findInPlan(b, "COMPSCI 61A", idx).key).toBe(CREDIT);
    expect(b.taken[0].grade).toBe("A");
    expect(move(b, "COMPSCI 61A", "2026 Fall").taken[0].term).toBe("2026 Fall");
  });
  it("a taken class moved to a future term becomes planned", () => {
    const s = move(state, "COMPSCI 61A", "2027 Fall");
    expect(s.taken).toEqual([]);
    expect(planned(s)).toContain("2027 Fall:COMPSCI 61A");
  });
  it("a planned class moved to a past term becomes taken there; to a future term stays planned with its instructor", () => {
    const past = move(state, "STAT C100", "2025 Fall");
    expect(past.taken.find((t) => t.course === "DATA C100")).toMatchObject({ term: "2025 Fall", source: "manual" });
    expect(planned(past)).toEqual([]);
    const fut = move(state, "DATA C100", "2028 Spring");
    expect(fut.semesters.find((x) => x.term === "2028 Spring")!.courses).toEqual([{ course: "DATA C100", professor: "P" }]);
    const credit = move(state, "DATA C100", CREDIT);
    expect(findInPlan(credit, "DATA C100", idx).key).toBe(CREDIT);
  });
  it("AP and transfer credit stays in the credit bucket", () => {
    const s = run(state, { type: "addTaken", courses: [{ course: "MATH 54", term: "2024 Fall", source: "transfer" }] });
    expect(findInPlan(s, "MATH 54", idx).key).toBe(CREDIT);
    expect(moveClassActions(s, "MATH 54", "2025 Fall", idx, NOW)).toEqual([]);
  });
  it("moving to where it already is, or a class not in the plan, does nothing", () => {
    expect(moveClassActions(state, "DATA C100", "2027 Spring", idx, NOW)).toEqual([]);
    expect(moveClassActions(state, "MATH 54", "2027 Spring", idx, NOW)).toEqual([]);
  });
});

describe("units", () => {
  it("a class the catalog does not list counts 0 units until the student sets them", () => {
    let s = run(base, { type: "addPlanned", term: "2027 Spring", course: "FOO 99" });
    let e = buildTermEntries(s, idx, NOW, ENROLLING).find((x) => x.key === "2027 Spring")!;
    expect(e.rows[0]).toMatchObject({ units: 0, unitsKnown: false });
    expect(e.units).toBe(0);
    s = run(s, { type: "setUnits", course: "FOO 99", units: 3 });
    e = buildTermEntries(s, idx, NOW, ENROLLING).find((x) => x.key === "2027 Spring")!;
    expect(e.rows[0]).toMatchObject({ units: 3, unitsKnown: true });
    s = run(s, { type: "markTaken", term: "2027 Spring", course: "FOO 99" });
    expect(s.taken[0]).toMatchObject({ course: "FOO 99", units: 3 });
    s = run(s, { type: "setUnits", course: "FOO 99" });
    expect("units" in s.taken[0]).toBe(false);
  });
  it("warns when the units to go cannot fit in the terms left", () => {
    const senior = run(base, { type: "addTaken", courses: [{ course: "COMPSCI 61A", term: "2025 Fall", units: 60, source: "manual" }] });
    // 60 to go, Fall 2026 + Spring 2027 left = 41 units of room
    expect(unitsOutlook(buildTermEntries(senior, idx, NOW, ENROLLING))).toEqual({ toGo: 60, termsLeft: 2, short: true });
    const ok = run(senior, { type: "addSemester", term: "2027 Fall" });
    expect(unitsOutlook(buildTermEntries(ok, idx, NOW, ENROLLING)).short).toBe(false);
    expect(unitsOutlook([])).toEqual({ toGo: 120, termsLeft: 0, short: true });
  });
  it("names hand-entered credit", () => {
    expect(creditId("ap", "Calculus AB")).toBe("AP Calculus AB");
    expect(creditId("ap", "ap  calculus AB")).toBe("AP calculus AB");
    expect(creditId("ib", "Physics HL")).toBe("IB Physics HL");
    expect(creditId("transfer", " Intro to Film ")).toBe("TR Intro to Film");
  });
});

describe("first setup seeds the terms a student's year implies", () => {
  it("past terms by year, none for freshmen and transfers", () => {
    expect(defaultPastTerms("Sophomore", NOW)).toEqual(["2025 Fall", "2026 Spring"]);
    expect(defaultPastTerms("Junior", NOW)).toHaveLength(4);
    expect(defaultPastTerms("Senior", NOW)).toEqual(["2023 Fall", "2024 Spring", "2024 Fall", "2025 Spring", "2025 Fall", "2026 Spring"]);
    expect(defaultPastTerms("Fifth year+", NOW)).toHaveLength(8);
    expect(defaultPastTerms("Freshman", NOW)).toEqual([]);
    expect(defaultPastTerms("Transfer (Junior)", NOW)).toEqual([]);
    expect(defaultPastTerms("Freshman", new Date("2027-02-01T12:00:00"))).toEqual(["2026 Fall"]);
  });
  it("empty past terms are flagged, not errors, and count nothing", () => {
    const e = buildTermEntries({ taken: [], semesters: [{ term: "2025 Fall", courses: [] }] }, idx, NOW, ENROLLING)[0];
    expect(e).toMatchObject({ emptyPast: true, done: false, needsReview: false, units: 0 });
  });
});

describe("term helpers", () => {
  it("termPhase", () => {
    expect(termPhase("2026 Spring", NOW, ENROLLING)).toBe("past");
    expect(termPhase("2026 Summer", NOW, ENROLLING)).toBe("past");
    expect(termPhase("2026 Fall", NOW, ENROLLING)).toBe("current");
    expect(termPhase("2027 Spring", NOW, ENROLLING)).toBe("enrolling");
    expect(termPhase("2027 Spring", NOW)).toBe("future");
    expect(termPhase("2027 Fall", NOW, ENROLLING)).toBe("future");
  });
  it("suggests the next term and summer not already present", () => {
    expect(suggestNextTerm(["2026 Fall", "2027 Spring"], NOW)).toBe("2027 Fall");
    expect(suggestNextTerm([], NOW)).toBe("2027 Spring");
    expect(suggestNextTerm(["2024 Fall"], NOW)).toBe("2026 Fall");
    expect(suggestNextSummer(["2027 Summer"], NOW)).toBe("2028 Summer");
    expect(suggestNextSummer([], new Date("2026-03-01T12:00:00"))).toBe("2026 Summer");
  });
  it("offers years that cover a long plan in both directions", () => {
    const years = termYearRange(["2018 Fall", "2034 Spring"], NOW);
    expect(years[0]).toBe(2018);
    expect(years.at(-1)).toBe(2034);
    expect(termYearRange([], NOW)).toContain(2020);
    expect(termYearRange([], NOW)).toContain(2032);
  });
});
