import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildCourseIndex, evaluateGroup, toStudentCourses, type EvalContext } from "./requirements";
import type { College, Course, Major, PredictionsFile, RequirementGroup, Rule, SeatsFile, CourseInsight } from "./types";

const STUB = path.join(process.cwd(), "stub-data");
const read = <T,>(rel: string): T => JSON.parse(fs.readFileSync(path.join(STUB, rel), "utf8")) as T;

const courses = read<Course[]>("courses.json");
const colleges = read<College[]>("requirements/colleges.json");
const majors = read<Major[]>("requirements/majors.json");
const groupDir = path.join(STUB, "requirements/groups");
const groups: RequirementGroup[] = fs
  .readdirSync(groupDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => read<RequirementGroup>(`requirements/groups/${f}`));
const groupIds = new Set(groups.map((g) => g.id));
const idx = buildCourseIndex(courses);
const ctx: EvalContext = { courseIndex: idx, manualChecks: {}, pins: {} };

const RULE_TYPES = new Set(["course", "allOf", "anyOf", "nOf", "filter", "units", "manual"]);

function collectCourseRefs(rule: Rule, out: string[]): void {
  expect(RULE_TYPES.has(rule.type)).toBe(true);
  switch (rule.type) {
    case "course":
      out.push(rule.course);
      break;
    case "allOf":
    case "anyOf":
    case "nOf":
      expect(Array.isArray(rule.rules) && rule.rules.length > 0).toBe(true);
      if (rule.type === "nOf") expect(rule.n).toBeLessThanOrEqual(rule.rules.length);
      rule.rules.forEach((r) => collectCourseRefs(r, out));
      break;
    case "filter":
    case "units":
      out.push(...(rule.filter?.courses ?? []), ...(rule.filter?.exclude ?? []));
      break;
    case "manual":
      expect(rule.text.length).toBeGreaterThan(0);
  }
}

const sampleCs = toStudentCourses(
  ["COMPSCI 61A", "COMPSCI 61B", "COMPSCI 61C", "COMPSCI 70", "MATH 51", "MATH 52", "MATH 54"].map((c) => ({ course: c })),
  [
    { course: "COMPSCI 170", term: "2027 Spring" },
    { course: "COMPSCI 188", term: "2027 Spring" },
  ],
  idx,
);

describe("stub courses", () => {
  it("has unique, well-formed ids", () => {
    expect(courses.length).toBeGreaterThanOrEqual(250);
    const ids = courses.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of courses) {
      expect(c.id).toBe(`${c.subject} ${c.number}`);
      expect(c.id).toBe(c.id.toUpperCase());
    }
  });

  it("uses only the official breadth names", () => {
    const allowed = new Set([
      "Arts & Literature",
      "Biological Science",
      "Historical Studies",
      "International Studies",
      "Philosophy & Values",
      "Physical Science",
      "Social & Behavioral Sciences",
    ]);
    for (const c of courses) for (const b of c.breadths ?? []) expect(allowed.has(b), `${c.id}: ${b}`).toBe(true);
  });
});

describe("stub requirements", () => {
  it("every course referenced by a rule exists (directly or cross-listed)", () => {
    const missing: string[] = [];
    for (const g of groups) {
      for (const r of g.requirements) {
        const refs: string[] = [];
        collectCourseRefs(r.rule, refs);
        for (const id of refs) if (!idx.has(id)) missing.push(`${g.id}/${r.id}: ${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every college and major points at existing groups", () => {
    const collegeIds = new Set(colleges.map((c) => c.id));
    for (const id of ["LS", "CDSS", "COE", "HAAS", "CED", "CNR", "CHEM"]) expect(collegeIds.has(id)).toBe(true);
    for (const c of colleges) expect(groupIds.has(c.requirementGroupId), c.requirementGroupId).toBe(true);
    expect(majors.length).toBeGreaterThanOrEqual(20);
    expect(new Set(majors.map((m) => m.id)).size).toBe(majors.length);
    for (const m of majors) {
      expect(collegeIds.has(m.college), `${m.id} college ${m.college}`).toBe(true);
      expect(m.requirementGroupIds.length).toBeGreaterThan(0);
      for (const gid of m.requirementGroupIds) expect(groupIds.has(gid), `${m.id} -> ${gid}`).toBe(true);
    }
    expect(groupIds.has("university")).toBe(true);
  });

  it("every group parses and evaluates on empty and sample course lists", () => {
    for (const g of groups) {
      expect(g.id && g.title && g.kind).toBeTruthy();
      const reqIds = g.requirements.map((r) => r.id);
      expect(new Set(reqIds).size, g.id).toBe(reqIds.length);
      const empty = evaluateGroup(g, [], ctx);
      expect(empty.total).toBe(g.requirements.length);
      expect(empty.satisfied).toBe(0);
      const sample = evaluateGroup(g, sampleCs, ctx);
      expect(sample.total).toBe(g.requirements.length);
    }
  });

  it("a CS BA student with the lower-division core satisfies the lower-division requirements", () => {
    const g = groups.find((x) => x.id === "major-computer-science-ba")!;
    const res = evaluateGroup(g, sampleCs, ctx);
    const byId = Object.fromEntries(res.requirements.map((r) => [r.key.split("/")[1], r.result]));
    for (const id of ["cs-61a", "cs-61b", "cs-61c", "cs-70", "calculus-1", "calculus-2", "linear-algebra"]) {
      expect(byId[id]?.completed, id).toBe(true);
    }
    // Planned 170 + 188 count toward upper-division CS units but are not completed yet.
    expect(byId["ud-cs"].satisfied).toBe(true);
    expect(byId["ud-cs"].completed).toBe(false);
    expect(byId["ud-design"].satisfied).toBe(false);
  });

  it("cross-listed courses resolve (STAT C100 counts as DATA C100)", () => {
    const g = groups.find((x) => x.id === "major-data-science-ba")!;
    const res = evaluateGroup(g, toStudentCourses([{ course: "STAT C100" }], [], idx), ctx);
    expect(res.requirements.find((r) => r.key.endsWith("/data-100"))!.result.completed).toBe(true);
  });

  it("LS breadth and university AC pick up attribute data", () => {
    const ls = groups.find((x) => x.id === "college-LS")!;
    const st = toStudentCourses(
      ["ENGLISH R1A", "COLWRIT R4B", "ASTRON C10", "PSYCH 1", "HISTORY 7B", "PHILOS 2"].map((c) => ({ course: c })),
      [],
      idx,
    );
    const r = evaluateGroup(ls, st, ctx);
    const get = (id: string) => r.requirements.find((x) => x.key === `college-LS/${id}`)!.result;
    expect(get("reading-composition-a").completed).toBe(true);
    expect(get("reading-composition-b").completed).toBe(true);
    expect(get("breadth-physical-science").completed).toBe(true);
    expect(get("breadth-social-behavioral-sciences").completed).toBe(true);
    expect(get("breadth-historical-studies").completed).toBe(true);
    expect(get("breadth-philosophy-values").completed).toBe(true);
    const uni = evaluateGroup(groups.find((x) => x.id === "university")!, toStudentCourses([{ course: "ETHSTD 21AC" }], [], idx), ctx);
    expect(uni.requirements.find((x) => x.key === "university/american-cultures")!.result.completed).toBe(true);
  });
});

describe("stub predictions, seats, insights", () => {
  const preds = read<PredictionsFile & { stub?: boolean }>("predictions/predictions.json");
  const seats = read<SeatsFile & { stub?: boolean }>("seats/latest.json");
  const insights = read<CourseInsight[]>("insights/insights.json");
  const RECS = new Set(["Phase 1 priority", "Phase 1 or early Phase 2", "Phase 2 is fine", "Adjustment period is fine"]);

  it("predictions are well formed and include first-time professor warnings", () => {
    expect(preds.stub).toBe(true);
    expect(preds.term).toBe("2027 Spring");
    expect(preds.phases.map((p) => p.name)).toEqual(["Phase 1", "Phase 2", "Adjustment"]);
    expect(preds.predictions.length).toBeGreaterThanOrEqual(40);
    for (const p of preds.predictions) {
      expect(idx.has(p.course), p.course).toBe(true);
      expect(p.popularity).toBeGreaterThanOrEqual(0);
      expect(p.popularity).toBeLessThanOrEqual(1);
      expect(["high", "medium", "low"]).toContain(p.confidence);
      expect(RECS.has(p.recommendation!), p.recommendation).toBe(true);
      if (!p.professorSeenBefore) expect(p.warning).toBeTruthy();
    }
    expect(preds.predictions.filter((p) => !p.professorSeenBefore).length).toBeGreaterThanOrEqual(3);
  });

  it("seats are consistent and include reserved and full sections", () => {
    expect(seats.stub).toBe(true);
    for (const s of seats.sections) {
      expect(idx.has(s.course), s.course).toBe(true);
      expect(s.enrolled).toBeLessThanOrEqual(s.capacity);
      expect(s.open).toBe(s.enrolled < s.capacity);
      for (const r of s.reserved ?? []) expect(r.enrolled).toBeLessThanOrEqual(r.capacity);
    }
    expect(seats.sections.some((s) => !s.open && (s.waitlisted ?? 0) > 0)).toBe(true);
    expect(seats.sections.some((s) => (s.reserved ?? []).length > 0)).toBe(true);
  });

  it("insights have ratings in range", () => {
    for (const i of insights) {
      expect(idx.has(i.course), i.course).toBe(true);
      for (const v of [i.difficulty!, i.shouldTake!]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(5);
      }
      expect(i.byProfessor!.length).toBeGreaterThan(0);
    }
  });
});
