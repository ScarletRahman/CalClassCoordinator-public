import { describe, expect, it } from "vitest";
import { alreadyMetBy, buildCourseIndex, computeOverlap, creditHints, dedupeStudentCourses, evaluateGroup, matchesFilter, sameCourse, toStudentCourses } from "./requirements";
import { siblingsOf, siblingText } from "./crossList";
import { reducer, EMPTY_STATE } from "./store";
import { normalizeCourseId } from "./courseId";
import type { Course, RequirementGroup } from "./types";

const courses: Course[] = [
  { id: "COMPSCI 61A", subject: "COMPSCI", number: "61A", title: "SICP", units: 4 },
  { id: "COMPSCI 61B", subject: "COMPSCI", number: "61B", title: "DS", units: 4 },
  { id: "COMPSCI 70", subject: "COMPSCI", number: "70", title: "Discrete", units: 4 },
  { id: "MATH 55", subject: "MATH", number: "55", title: "Discrete", units: 4 },
  { id: "DATA C100", subject: "DATA", number: "C100", title: "DS100", units: 4, crossListed: ["STAT C100", "COMPSCI C100"] },
  { id: "COMPSCI 170", subject: "COMPSCI", number: "170", title: "Algo", units: 4 },
  { id: "COMPSCI 188", subject: "COMPSCI", number: "188", title: "AI", units: 4 },
  { id: "HISTORY 7B", subject: "HISTORY", number: "7B", title: "US", units: 4, breadths: ["Historical Studies"], attributes: ["AC", "AH&I"] },
  { id: "PHILOS 3", subject: "PHILOS", number: "3", title: "Ethics", units: 4, breadths: ["Philosophy & Values"] },
];
const idx = buildCourseIndex(courses);
const ctx = (manual: Record<string, boolean> = {}) => ({ courseIndex: idx, manualChecks: manual, pins: {} });

const group: RequirementGroup = {
  id: "g",
  title: "Test",
  kind: "major",
  requirements: [
    { id: "ud", title: "Upper div", rule: { type: "filter", count: 2, filter: { subjects: ["COMPSCI"], minNumber: 100, maxNumber: 199 } } },
    { id: "61a", title: "61A", rule: { type: "course", course: "COMPSCI 61A" } },
    { id: "discrete", title: "Discrete", rule: { type: "anyOf", rules: [{ type: "course", course: "COMPSCI 70" }, { type: "course", course: "MATH 55" }] } },
    { id: "ds", title: "DS100", rule: { type: "course", course: "COMPSCI C100" } },
    { id: "hist", title: "Historical", rule: { type: "filter", count: 1, filter: { breadth: "Historical Studies" } } },
    { id: "units", title: "8 units", rule: { type: "units", minUnits: 8 } },
    { id: "res", title: "Residence", rule: { type: "manual", text: "Senior residence" } },
  ],
};

const evalWith = (taken: string[], planned: string[] = [], manual = {}) =>
  evaluateGroup(group, toStudentCourses(taken.map((course) => ({ course })), planned.map((course) => ({ course, term: "2027 Spring" })), idx), ctx(manual));
const byId = (r: ReturnType<typeof evalWith>, id: string) => r.requirements.find((x) => x.key === `g/${id}`)!.result;

describe("requirement engine", () => {
  it("is empty with no courses", () => {
    const r = evalWith([]);
    expect(r.satisfied).toBe(0);
    expect(r.total).toBe(7);
  });

  it("distinguishes taken (completed) from planned (satisfied)", () => {
    const r = evalWith(["COMPSCI 61A"], ["MATH 55"]);
    expect(byId(r, "61a").completed).toBe(true);
    expect(byId(r, "discrete").satisfied).toBe(true);
    expect(byId(r, "discrete").completed).toBe(false);
  });

  it("matches cross-listed courses", () => {
    expect(byId(evalWith(["DATA C100"]), "ds").completed).toBe(true);
    expect(byId(evalWith(["STAT C100"]), "ds").completed).toBe(true);
  });

  it("tracks partial progress on count filters and doesn't double count within a group", () => {
    const r = evalWith(["COMPSCI 170"]);
    expect(byId(r, "ud").progress).toBe(0.5);
    expect(byId(r, "ud").satisfied).toBe(false);
    const r2 = evalWith(["COMPSCI 170", "COMPSCI 188"]);
    expect(byId(r2, "ud").completed).toBe(true);
  });

  it("a specific course requirement wins over a broad filter listed earlier", () => {
    // DATA C100 is cross-listed as COMPSCI C100 (upper div CS) but must go to the 'ds' requirement.
    const r = evalWith(["DATA C100", "COMPSCI 170"]);
    expect(byId(r, "ds").completed).toBe(true);
    expect(byId(r, "ud").progress).toBe(0.5);
  });

  it("handles breadth filters, unit totals and manual checks", () => {
    const r = evalWith(["HISTORY 7B", "PHILOS 3"], [], { "g/res": true });
    expect(byId(r, "hist").completed).toBe(true);
    expect(byId(r, "units").completed).toBe(true);
    expect(byId(r, "res").completed).toBe(true);
  });
});

describe("planner state", () => {
  it("sets up semesters, adds, moves and completes classes", () => {
    let s = reducer(EMPTY_STATE, { type: "setProfile", majorIds: ["m"], year: "Junior" });
    expect(s.semesters.length).toBeGreaterThan(0);
    const [a, b] = [s.semesters[0].term, s.semesters[1]?.term ?? "2099 Fall"];
    s = reducer(s, { type: "addSemester", term: b });
    s = reducer(s, { type: "addPlanned", term: a, course: "COMPSCI 170" });
    s = reducer(s, { type: "addPlanned", term: b, course: "COMPSCI 170" }); // moves, never duplicates
    expect(s.semesters.flatMap((x) => x.courses).length).toBe(1);
    s = reducer(s, { type: "movePlanned", from: b, to: a, course: "COMPSCI 170" });
    expect(s.semesters.find((x) => x.term === a)!.courses[0].course).toBe("COMPSCI 170");
    s = reducer(s, { type: "addTaken", courses: [{ course: "COMPSCI 170", source: "transcript" }] });
    expect(s.semesters.flatMap((x) => x.courses).length).toBe(0);
    expect(s.taken.length).toBe(1);
    s = reducer(s, { type: "addPlanned", term: a, course: "COMPSCI 170" }); // already taken
    expect(s.semesters.flatMap((x) => x.courses).length).toBe(0);
  });
});

describe("course ids", () => {
  it("normalizes loose input", () => {
    expect(normalizeCourseId("cs 61a")).toBe("COMPSCI 61A");
    expect(normalizeCourseId("Comp Sci 61A")).toBe("COMPSCI 61A");
    expect(normalizeCourseId("data c100")).toBe("DATA C100");
    expect(normalizeCourseId("L & S C70T")).toBe("LS C70T");
    expect(normalizeCourseId("hello")).toBeNull();
  });
});

// ---- cross-listed classes, choices and overlap ----

describe("cross-listed classes count once", () => {
  const more: Course[] = [
    ...courses,
    { id: "STAT C100", subject: "STAT", number: "C100", title: "DS100", units: 4, crossListed: ["DATA C100", "COMPSCI C100"] },
    { id: "STAT 134", subject: "STAT", number: "134", title: "Prob", units: 4 },
    { id: "STAT 135", subject: "STAT", number: "135", title: "Stats", units: 4 },
  ];
  const i2 = buildCourseIndex(more);
  const c2 = { courseIndex: i2, manualChecks: {}, pins: {} };
  const take = (ids: string[], planned: string[] = []) =>
    toStudentCourses(ids.map((course) => ({ course })), planned.map((course) => ({ course, term: "2027 Spring" })), i2);
  const g = (requirements: RequirementGroup["requirements"]): RequirementGroup => ({ id: "x", title: "X", kind: "major", requirements });

  it("a class and its sibling never fill two slots of a count filter", () => {
    const grp = g([{ id: "two", title: "Two upper division", rule: { type: "filter", count: 2, filter: { minNumber: 100, maxNumber: 199 } } }]);
    const r = evaluateGroup(grp, take(["DATA C100", "STAT C100"]), c2);
    expect(r.requirements[0].result.used.map((u) => u.id)).toEqual(["DATA C100"]);
    expect(r.requirements[0].result.satisfied).toBe(false);
    expect(r.requirements[0].result).toMatchObject({ have: 1, need: 2, unit: "classes" });
    expect(evaluateGroup(grp, take(["DATA C100", "STAT C100", "STAT 134"]), c2).requirements[0].result.completed).toBe(true);
  });

  it("a sibling cannot be reused by another requirement in the same group", () => {
    const grp = g([
      { id: "a", title: "DS", rule: { type: "course", course: "DATA C100" } },
      { id: "b", title: "One STAT upper", rule: { type: "filter", count: 1, filter: { subjects: ["STAT"], minNumber: 100 } } },
    ]);
    const r = evaluateGroup(grp, take(["DATA C100", "STAT C100"]), c2);
    expect(r.satisfied).toBe(1);
    expect(r.requirements[1].result.used).toEqual([]);
  });

  it("unit totals count a cross-listed pair once, and dedupe prefers the taken one", () => {
    const grp = g([{ id: "u", title: "8 units", rule: { type: "units", minUnits: 8 } }]);
    expect(evaluateGroup(grp, take(["DATA C100", "STAT C100"]), c2).requirements[0].result).toMatchObject({ satisfied: false, have: 4, need: 8, unit: "units" });
    const d = dedupeStudentCourses(take(["STAT C100"], ["DATA C100"]).reverse(), i2);
    expect(d.map((s) => `${s.id}:${s.status}`)).toEqual(["STAT C100:taken"]);
    expect(sameCourse("COMPSCI C100", "STAT C100", i2)).toBe(true);
  });

  it("anyOf picks the best option, first listed on ties, and options never share a class", () => {
    const rule = { type: "anyOf" as const, rules: [{ type: "course" as const, course: "COMPSCI 70" }, { type: "course" as const, course: "MATH 55" }] };
    const grp = g([{ id: "d", title: "Discrete", rule }]);
    const both = evaluateGroup(grp, take(["MATH 55", "COMPSCI 70"]), c2).requirements[0].result;
    expect(both.used.map((u) => u.id)).toEqual(["COMPSCI 70"]);
    expect(both.children!.map((c) => c.chosen)).toEqual([true, false]);
    // taken beats planned even when the planned one is listed first
    const mixed = evaluateGroup(grp, take(["MATH 55"], ["COMPSCI 70"]), c2).requirements[0].result;
    expect(mixed.used.map((u) => u.id)).toEqual(["MATH 55"]);
    expect(mixed.completed).toBe(true);

    const two = g([
      {
        id: "n",
        title: "Two of",
        rule: {
          type: "nOf",
          n: 2,
          rules: [
            { type: "course", course: "DATA C100" },
            { type: "course", course: "STAT C100" },
            { type: "course", course: "STAT 134" },
          ],
        },
      },
    ]);
    const one = evaluateGroup(two, take(["DATA C100", "STAT C100"]), c2).requirements[0].result;
    expect(one.satisfied).toBe(false);
    expect(one).toMatchObject({ have: 1, need: 2, progress: 0.5 });
    expect(evaluateGroup(two, take(["STAT C100", "STAT 134"]), c2).requirements[0].result.completed).toBe(true);
  });

  it("AP credit ids are just ordinary unknown ids to the engine (the caller leaves them out)", () => {
    const grp = g([{ id: "u", title: "4 units", rule: { type: "units", minUnits: 4 } }]);
    expect(evaluateGroup(grp, [], c2).requirements[0].result.satisfied).toBe(false);
  });
});

describe("choices (emphasis, concentration)", () => {
  const withChoice: RequirementGroup = {
    id: "ds",
    title: "Data Science BA",
    kind: "major",
    choices: [
      {
        id: "domain-emphasis",
        title: "Domain Emphasis",
        pick: 1,
        options: [
          { id: "aero", title: "Aerospace" },
          { id: "cognition", title: "Cognition" },
          { id: "ethics", title: "Ethics" },
        ],
      },
    ],
    requirements: [
      { id: "61a", title: " Program Structures ", section: "Lower Division", rule: { type: "course", course: "COMPSCI 61A" } },
      { id: "aero-ld", title: "Lower Division", section: "Aerospace", choice: "domain-emphasis", option: "aero", rule: { type: "course", course: "COMPSCI 61B" } },
      { id: "cog-ld", title: "Lower Division", section: "Cognition", choice: "domain-emphasis", option: "cognition", rule: { type: "course", course: "COMPSCI 70" } },
      { id: "cog-ud", title: "Upper Division", section: "Cognition", choice: "domain-emphasis", option: "cognition", rule: { type: "filter", count: 2, filter: { courses: ["COMPSCI 170", "COMPSCI 188"] } } },
      { id: "eth-ld", title: "Lower Division", section: "Ethics", choice: "domain-emphasis", option: "ethics", rule: { type: "course", course: "PHILOS 3" } },
      { id: "cap", title: "Capstone", section: "Upper Division", rule: { type: "manual", text: "Capstone" } },
    ],
  };
  const run = (taken: string[], choices?: Record<string, Record<string, string[]>>) =>
    evaluateGroup(withChoice, toStudentCourses(taken.map((course) => ({ course })), [], idx), { ...ctx(), choices });

  it("hides every option until one is chosen and counts the open choice as one unmet requirement", () => {
    const r = run(["COMPSCI 61A", "COMPSCI 70", "COMPSCI 170"]);
    expect(r.requirements.map((x) => x.key)).toEqual(["ds/61a", "ds/cap"]);
    expect(r.requirements[0].title).toBe("Program Structures");
    expect(r.total).toBe(3);
    expect(r.satisfied).toBe(1);
    const c = r.choices[0];
    expect(c).toMatchObject({ key: "ds/choice:domain-emphasis", pending: true, chosen: [], insertAt: 1, suggested: "cognition" });
    expect(c.options.map((o) => [o.id, o.satisfied, o.total])).toEqual([["aero", 0, 1], ["cognition", 1, 2], ["ethics", 0, 1]]);
    expect(c.options[1].progress).toBe(0.75);
  });

  it("shows and counts only the chosen option", () => {
    const r = run(["COMPSCI 61A", "COMPSCI 70", "COMPSCI 170", "COMPSCI 61B"], { ds: { "domain-emphasis": ["cognition"] } });
    expect(r.requirements.map((x) => x.key)).toEqual(["ds/61a", "ds/cog-ld", "ds/cog-ud", "ds/cap"]);
    expect(r.requirements[1]).toMatchObject({ choice: "domain-emphasis", option: "cognition" });
    expect(r.total).toBe(4);
    expect(r.satisfied).toBe(2);
    expect(r.choices[0]).toMatchObject({ pending: false, chosen: ["cognition"], insertAt: 3, suggested: undefined });
    // the unchosen Aerospace option is previewed (61B taken) but never counted
    expect(r.choices[0].options[0]).toMatchObject({ satisfied: 1, total: 1 });
  });

  it("ignores unknown option ids and malformed saved state", () => {
    expect(run([], { ds: { "domain-emphasis": ["nope"] } }).choices[0].pending).toBe(true);
    expect(run([], { ds: { "domain-emphasis": "cognition" as unknown as string[] } }).choices[0].pending).toBe(true);
    expect(run([], { ds: { "domain-emphasis": ["cognition", "aero"] } }).choices[0].chosen).toEqual(["cognition"]);
  });

  it("no suggestion when no class counts toward any option; groups without choices are unchanged", () => {
    expect(run([]).choices[0].suggested).toBeUndefined();
    expect(evalWith([]).choices).toEqual([]);
  });

  it("the store saves, replaces and clears a choice, and old plans without the field load", () => {
    let s = reducer(EMPTY_STATE, { type: "setChoice", groupId: "ds", choiceId: "domain-emphasis", optionIds: ["cognition"] });
    expect(s.choices).toEqual({ ds: { "domain-emphasis": ["cognition"] } });
    s = reducer(s, { type: "setChoice", groupId: "ds", choiceId: "domain-emphasis", optionIds: ["aero"] });
    expect(s.choices!.ds["domain-emphasis"]).toEqual(["aero"]);
    const roundTrip = reducer(EMPTY_STATE, { type: "replace", state: JSON.parse(JSON.stringify(s)) });
    expect(roundTrip.choices).toEqual({ ds: { "domain-emphasis": ["aero"] } });
    s = reducer(s, { type: "setChoice", groupId: "ds", choiceId: "domain-emphasis", optionIds: [] });
    expect(s.choices).toEqual({ ds: {} });
    const old = JSON.parse(JSON.stringify(EMPTY_STATE));
    delete old.choices;
    const loaded = reducer(EMPTY_STATE, { type: "replace", state: old });
    expect(loaded.choices).toBeUndefined();
    expect(() => evaluateGroup(withChoice, [], { ...ctx(), choices: loaded.choices })).not.toThrow();
  });
});

describe("classes that count for more than one program", () => {
  const more: Course[] = [
    ...courses,
    { id: "STAT C100", subject: "STAT", number: "C100", title: "DS100", units: 4, crossListed: ["DATA C100", "COMPSCI C100"] },
    { id: "COGSCI 131", subject: "COGSCI", number: "131", title: "Comp models", units: 4, crossListed: ["PSYCH 123"], breadths: ["Social & Behavioral Sciences"] },
    { id: "PSYCH 123", subject: "PSYCH", number: "123", title: "Comp models", units: 4, crossListed: ["COGSCI 131"], breadths: ["Social & Behavioral Sciences"] },
    { id: "LINGUIS 100", subject: "LINGUIS", number: "100", title: "Ling", units: 4 },
  ];
  const i3 = buildCourseIndex(more);
  const c3 = { courseIndex: i3, manualChecks: {}, pins: {} };
  const cog: RequirementGroup = {
    id: "cog",
    title: "Cognitive Science BA",
    kind: "major",
    requirements: [
      { id: "cs", title: "Computer Science", rule: { type: "course", course: "COMPSCI 61A" } },
      { id: "quant", title: "Quantitative", rule: { type: "anyOf", rules: [{ type: "course", course: "COMPSCI 70" }, { type: "course", course: "MATH 55" }] } },
      { id: "model", title: "Computational Modeling", rule: { type: "anyOf", rules: [{ type: "course", course: "COGSCI 131" }, { type: "course", course: "COMPSCI 188" }] } },
      { id: "ling", title: "Linguistics", rule: { type: "course", course: "LINGUIS 100" } },
      { id: "elective", title: "Electives", rule: { type: "manual", text: "Three of ...", mentionedCourses: ["COMPSCI 170"] } },
    ],
  };
  const ds: RequirementGroup = {
    id: "ds",
    title: "Data Science BA",
    kind: "major",
    requirements: [
      { id: "ps", title: "Program Structures", rule: { type: "course", course: "COMPSCI 61A" } },
      { id: "pds", title: "Principles of Data Science", rule: { type: "course", course: "STAT C100" } },
      { id: "mld", title: "Modeling", rule: { type: "filter", count: 1, filter: { courses: ["COMPSCI 188", "PSYCH 123", "COMPSCI 170"] } } },
      { id: "anycs", title: "CS upper division", rule: { type: "filter", count: 1, filter: { subjects: ["COMPSCI"], minNumber: 100 } } },
      { id: "total", title: "Units", rule: { type: "units", minUnits: 120 } },
    ],
  };
  const college: RequirementGroup = {
    id: "college-LS",
    title: "L&S",
    kind: "college",
    requirements: [
      { id: "sbs", title: "Social & Behavioral Sciences", rule: { type: "filter", count: 1, filter: { breadth: "Social & Behavioral Sciences" } } },
      { id: "u", title: "120 units", rule: { type: "units", minUnits: 120 } },
    ],
  };
  const overlap = (taken: string[], planned: string[] = [], groups = [cog, ds, college]) => {
    const st = toStudentCourses(taken.map((course) => ({ course })), planned.map((course) => ({ course, term: "2027 Spring" })), i3);
    return computeOverlap(groups.map((g) => evaluateGroup(g, st, c3)), st, c3, { cog: "CogSci", ds: "DS" });
  };

  it("lists taken and planned classes both programs are counting", () => {
    const o = overlap(["COMPSCI 61A"], ["COMPSCI 188"]);
    expect(o.programs.map((p) => p.label)).toEqual(["CogSci", "DS"]);
    expect(o.counting.map((e) => [e.id, e.status, e.programs])).toEqual([
      ["COMPSCI 61A", "taken", ["cog", "ds"]],
      ["COMPSCI 188", "planned", ["cog", "ds"]],
    ]);
    expect(o.counting[0].requirements.map((r) => r.title)).toEqual(["Computer Science", "Program Structures"]);
    expect(o.counting[0].closes).toBe(0);
  });

  it("ranks classes that could count twice, with cross-listed families as one class", () => {
    const o = overlap([]);
    expect(o.could.map((e) => e.id)).toEqual(["COMPSCI 188", "COGSCI 131", "COMPSCI 61A", "COMPSCI 170"]);
    const fam = o.could[1];
    expect(fam.also).toEqual(["PSYCH 123"]);
    expect(fam.programs).toEqual(["cog", "ds"]);
    expect(fam.breadth).toEqual(["Social & Behavioral Sciences"]);
    // COMPSCI 188 is listed by CogSci and DS and also fits the open "any upper-division CS" rule
    expect(o.could[0].requirements.map((r) => r.key)).toEqual(["cog/model", "ds/mld", "ds/anycs"]);
    expect(o.could[0].closes).toBe(3);
    // every member of the family carries the same badge
    expect(o.byCourse.get("PSYCH 123")).toBe(o.byCourse.get("COGSCI 131"));
  });

  it("leaves out single-program classes, self-check hints, unit totals and college groups", () => {
    const o = overlap([]);
    const ids = [...o.could, ...o.counting].map((e) => e.id);
    expect(ids).not.toContain("LINGUIS 100"); // CogSci only
    // COMPSCI 170 is on a Data Science list and named in CogSci's self-check prose: shown, flagged
    const prose = o.could.find((e) => e.id === "COMPSCI 170")!;
    expect(prose.requirements.map((r) => [r.key, !!r.selfCheck])).toEqual([["cog/elective", true], ["ds/mld", false], ["ds/anycs", false]]);
    expect(prose.closes).toBe(2);
    expect(ids).not.toContain("MATH 55");
    expect(o.programs.map((p) => p.groupId)).not.toContain("college-LS");
    expect(o.byCourse.has("LINGUIS 100")).toBe(false);
  });

  it("a class in the plan is no longer a candidate, and closed requirements drop out", () => {
    const o = overlap(["COMPSCI 61A", "PSYCH 123"]);
    expect(o.counting.map((e) => e.id)).toEqual(["COMPSCI 61A", "PSYCH 123"]);
    expect(o.counting[1].breadth).toEqual(["Social & Behavioral Sciences"]);
    // CogSci modeling is closed by PSYCH 123 (= COGSCI 131), so 188 now helps Data Science only
    expect(o.could.map((e) => e.id)).toEqual(["COMPSCI 170"]);
    expect(o.byCourse.get("COGSCI 131")!.status).toBe("taken");
  });

  it("flags a major class that also meets a breadth without calling it a double count", () => {
    const o = overlap([], [], [cog, college]);
    expect(o.could).toEqual([]);
    expect(o.byCourse.get("COGSCI 131")).toMatchObject({ programs: ["cog"], breadth: ["Social & Behavioral Sciences"] });
  });
});

describe("reading and composition fallback", () => {
  it("counts an R1A/R1B class that is missing from the course list by its number", () => {
    expect(matchesFilter("ENGLISH R1A", { attribute: "RCA" }, idx)).toBe(true);
    expect(matchesFilter("ENGLISH R1A", { attribute: "RCB" }, idx)).toBe(false);
    expect(matchesFilter("COMLIT R1B", { attribute: "RCB" }, idx)).toBe(true);
    expect(matchesFilter("COMPSCI 61A", { attribute: "RCA" }, idx)).toBe(false);
  });
});

describe("round 2: renumbered classes, independent college rows, labels, credit", () => {
  const cs: Course[] = [
    { id: "MATH 51", subject: "MATH", number: "51", title: "Calculus I", units: 4, sameAs: ["MATH 1A"] },
    { id: "MATH 1A", subject: "MATH", number: "1A", title: "Calculus", units: 4, retired: true },
    { id: "DATA C100", subject: "DATA", number: "C100", title: "DS100", units: 4, crossListed: ["STAT C100"] },
    { id: "HISTORY 7B", subject: "HISTORY", number: "7B", title: "US", units: 4, breadths: ["Historical Studies"], attributes: ["AC", "AH&I", "HSS"] },
    { id: "ENGLISH R1B", subject: "ENGLISH", number: "R1B", title: "R&C", units: 4, attributes: ["RCB", "HSS"] },
    { id: "COMLIT R1B", subject: "COMLIT", number: "R1B", title: "R&C", units: 4, attributes: ["RCB", "HSS"] },
  ];
  const i = buildCourseIndex(cs);
  const c = { courseIndex: i, manualChecks: {}, pins: {} };
  const st = (taken: string[], planned: { course: string; term: string }[] = []) => toStudentCourses(taken.map((course) => ({ course })), planned, i, "2026 Fall");
  const grp = (kind: string, requirements: RequirementGroup["requirements"]): RequirementGroup => ({ id: "g2", title: "G", kind, requirements });

  it("an old number satisfies a rule naming the new one, and holding both counts once", () => {
    const g = grp("major", [
      { id: "calc", title: "Calculus", rule: { type: "course", course: "MATH 51" } },
      { id: "u", title: "Units", rule: { type: "units", minUnits: 8 } },
    ]);
    const r = evaluateGroup(g, st(["MATH 1A", "MATH 51"]), c);
    expect(r.requirements[0].result.completed).toBe(true);
    expect(r.requirements[1].result).toMatchObject({ have: 4, satisfied: false });
    expect(dedupeStudentCourses(st(["MATH 1A", "MATH 51"]), i)).toHaveLength(1);
    expect(siblingsOf("MATH 51", i)).toEqual([{ id: "MATH 1A", relation: "formerly" }]);
    expect(siblingsOf("MATH 1A", i)).toEqual([{ id: "MATH 51", relation: "now" }]);
    expect(siblingText("DATA C100", i)).toBe("Also listed as STAT C100");
    expect(siblingText("MATH 51", i)).toBe("Formerly MATH 1A");
  });

  const reqs: RequirementGroup["requirements"] = [
    { id: "ac", title: "American Cultures", rule: { type: "filter", count: 1, filter: { attribute: "AC" } } },
    { id: "ahi", title: "American History and Institutions", rule: { type: "filter", count: 1, filter: { attribute: "AH&I" } } },
    { id: "hss", title: "Two H/SS", rule: { type: "filter", count: 2, filter: { attribute: "HSS" } } },
    { id: "rcb", title: "R&C B", rule: { type: "filter", count: 1, filter: { attribute: "RCB" } } },
  ];
  it("college and university rows are independent; majors still count a class once", () => {
    const college = evaluateGroup(grp("college", reqs), st(["HISTORY 7B", "ENGLISH R1B"]), c);
    expect(college.requirements.map((r) => r.result.satisfied)).toEqual([true, true, true, true]);
    // inside one requirement a class still cannot repeat
    expect(college.requirements[2].result.used.map((u) => u.id)).toEqual(["HISTORY 7B", "ENGLISH R1B"]);
    const major = evaluateGroup(grp("major", reqs), st(["HISTORY 7B", "ENGLISH R1B"]), c);
    expect(major.requirements.filter((r) => r.result.satisfied)).toHaveLength(1);
  });

  it("carries the catalog's label for each alternative", () => {
    const g = grp("major", [
      {
        id: "bins",
        title: "Bins",
        rule: { type: "nOf", n: 1, rules: [{ type: "anyOf", label: " Language and Mind ", rules: [{ type: "course", course: "DATA C100" }, { type: "course", course: "MATH 51" }] }, { type: "course", course: "HISTORY 7B", label: "History" }] },
      },
    ]);
    expect(evaluateGroup(g, [], c).requirements[0].result.children!.map((k) => k.name)).toEqual(["Language and Mind", "History"]);
  });

  it("marks current-term classes in progress and splits done from planned units", () => {
    const s = st(["HISTORY 7B"], [{ course: "DATA C100", term: "2026 Fall" }, { course: "MATH 51", term: "2027 Spring" }]);
    expect(s.map((x) => !!x.inProgress)).toEqual([false, true, false]);
    const r = evaluateGroup(grp("university", [{ id: "u", title: "Units", rule: { type: "units", minUnits: 120 } }]), s, c).requirements[0].result;
    expect(r).toMatchObject({ have: 12, haveDone: 4, need: 120, unit: "units" });
  });

  it("test credit adds units but never fills a class rule; optional rows are not counted", () => {
    const s = toStudentCourses([{ course: "AP CALC BC", units: 5.3, source: "ap" }, { course: "IB HISTORY", units: 5 }], [], i);
    expect(s.every((x) => x.credit)).toBe(true);
    const g = grp("university", [
      { id: "u", title: "Units", rule: { type: "units", minUnits: 10 } },
      { id: "any", title: "Any class", rule: { type: "filter", count: 1, filter: {} } },
      { id: "honors", title: "Honors", optional: true, rule: { type: "manual", text: "Thesis" } },
    ]);
    const r = evaluateGroup(g, s, c);
    expect(r.requirements[0].result).toMatchObject({ satisfied: true, have: 10.3 });
    expect(r.requirements[1].result.used).toEqual([]);
    expect(r.total).toBe(2);
    expect(r.requirements[2].optional).toBe(true);
  });

  it("previews an emphasis the same way before and after one is chosen", () => {
    const g: RequirementGroup = {
      ...grp("major", [
        { id: "core", title: "Core", rule: { type: "course", course: "MATH 51" } },
        { id: "a1", title: "A", choice: "e", option: "a", rule: { type: "filter", count: 2, filter: { courses: ["HISTORY 7B", "DATA C100"] } } },
        { id: "b1", title: "B", choice: "e", option: "b", rule: { type: "filter", count: 2, filter: { courses: ["HISTORY 7B", "ENGLISH R1B"] } } },
      ]),
      choices: [{ id: "e", title: "Emphasis", pick: 1, options: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "none", title: "No emphasis" }] }],
    };
    const s = st(["MATH 51", "HISTORY 7B"]);
    const before = evaluateGroup(g, s, c).choices[0].options;
    const after = evaluateGroup(g, s, { ...c, choices: { g2: { e: ["a"] } } }).choices[0].options;
    expect(after).toEqual(before);
    expect(before.map((o) => o.progress)).toEqual([0.5, 0.5, 0]);
    expect(before[2].total).toBe(0);
  });

  it("only counts a class twice when both programs really use it, and says when a row is partly filled", () => {
    const a: RequirementGroup = { id: "a", title: "A", kind: "major", requirements: [{ id: "m", title: "Methods", rule: { type: "anyOf", rules: [{ type: "course", course: "HISTORY 7B" }, { type: "allOf", rules: [{ type: "course", course: "DATA C100" }] }] } }] };
    const b: RequirementGroup = { id: "b", title: "B", kind: "major", requirements: [{ id: "two", title: "Core", rule: { type: "filter", count: 2, filter: { courses: ["DATA C100", "MATH 51"] } } }] };
    const d: RequirementGroup = { id: "d", title: "D", kind: "major", requirements: [{ id: "one", title: "Intro", rule: { type: "course", course: "DATA C100" } }] };
    const s = st(["HISTORY 7B", "DATA C100"]);
    const ev = (gs: RequirementGroup[]) => computeOverlap(gs.map((x) => evaluateGroup(x, s, c)), s, c);
    // A's Methods is met by HISTORY 7B, so DATA C100 is not "counting" for A
    expect(ev([a, b]).counting).toEqual([]);
    const o = ev([b, d]);
    expect(o.counting.map((e) => e.id)).toEqual(["DATA C100"]);
    expect(o.counting[0].requirements).toEqual([
      { groupId: "b", key: "b/two", title: "Core", have: 1, need: 2 },
      { groupId: "d", key: "d/one", title: "Intro" },
    ]);
  });

  it("says when a class would only repeat a requirement that is already met", () => {
    const g = [evaluateGroup(grp("college", reqs), st(["COMLIT R1B"]), c)];
    expect(alreadyMetBy("ENGLISH R1B", g, i)).toEqual([]); // still helps the two H/SS row
    const only = [evaluateGroup(grp("college", [reqs[3]]), st(["COMLIT R1B"]), c)];
    expect(alreadyMetBy("ENGLISH R1B", only, i)).toEqual([{ groupId: "g2", requirement: "R&C B", by: ["COMLIT R1B"] }]);
    expect(alreadyMetBy("COMLIT R1B", only, i)).toEqual([]);
    expect(alreadyMetBy("MATH 51", only, i)).toEqual([]);
  });

  it("suggests test credit that plausibly covers a self-check requirement", () => {
    const credits = [{ course: "AP USH", label: "AP US History" }, { course: "AP STAT", label: "AP Statistics" }, { course: "AP SPAN", label: "AP Spanish Language and Culture" }];
    expect(creditHints({ title: "American History and Institutions" }, credits)).toEqual(["AP US History"]);
    expect(creditHints({ title: "Statistical Thinking", notes: "Also satisfied by: AP: Statistics, score 3+" }, credits)).toEqual(["AP Statistics"]);
    expect(creditHints({ title: "L&S Language Requirement" }, credits)).toEqual(["AP Spanish Language and Culture"]);
    expect(creditHints({ title: "Senior Residence" }, credits)).toEqual([]);
  });
});

describe("units for classes outside the catalog", () => {
  it("uses the student's number, then the catalog, then zero", () => {
    const s = toStudentCourses([{ course: "XYZ 1" }, { course: "XYZ 2", units: 3 }, { course: "COMPSCI 61A" }], [{ course: "XYZ 3", term: "2027 Spring", units: 2 }, { course: "XYZ 4", term: "2027 Spring" }], idx);
    expect(s.map((x) => x.units)).toEqual([0, 3, 4, 2, 0]);
  });
});
