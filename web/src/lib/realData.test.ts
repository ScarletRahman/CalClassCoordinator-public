import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCourseIndex, evaluateGroup, toStudentCourses } from "./requirements";
import type { Course, CourseInsight, Major, RequirementGroup } from "./types";

// Runs only when the real dataset is present (repo-level data/ or CCC_DATA_DIR).
const DATA = process.env.CCC_DATA_DIR ?? path.resolve(process.cwd(), "..", "data");
const has = fs.existsSync(path.join(DATA, "requirements", "majors.json")) && fs.existsSync(path.join(DATA, "courses.json"));
const read = <T,>(rel: string) => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")) as T;

describe.skipIf(!has)("real requirements dataset", () => {
  const courses = has ? read<Course[]>("courses.json") : [];
  const majors = has ? read<Major[]>("requirements/majors.json") : [];
  const idx = buildCourseIndex(courses);
  const group = (id: string) => read<RequirementGroup>(`requirements/groups/${id}.json`);
  const ctx = { courseIndex: idx, manualChecks: {}, pins: {} };

  it("every major resolves to major, college and university groups that evaluate", () => {
    const student = toStudentCourses(["COMPSCI 61A", "MATH 54", "ENGLISH R1A", "HISTORY 7B"].map((course) => ({ course })), [], idx);
    for (const m of majors) {
      for (const id of [...m.requirementGroupIds, m.collegeGroupId!, m.universityGroupId ?? "university"]) {
        const g = group(id);
        expect(g.requirements.length, id).toBeGreaterThan(0);
        expect(() => evaluateGroup(g, student, ctx)).not.toThrow();
      }
    }
  });

  it("checks off CS BA lower division and treats cross-listed records as one course", () => {
    const cs = majors.find((m) => /^Computer Science$/.test(m.name) && m.degree === "BA")!;
    const g = group(cs.requirementGroupIds[0]);
    const none = evaluateGroup(g, [], ctx);
    const taken = ["COMPSCI 61A", "COMPSCI 61B", "COMPSCI 61C", "COMPSCI 70", "MATH 51", "MATH 52", "MATH 54"];
    const some = evaluateGroup(g, toStudentCourses(taken.map((course) => ({ course })), [], idx), ctx);
    expect(some.completed).toBeGreaterThan(none.completed);
    const a = courses.find((c) => (c.crossListed ?? []).length > 0)!;
    const one = { id: "g", title: "t", kind: "major", requirements: [{ id: "r", title: "r", rule: { type: "course" as const, course: a.id } }] };
    expect(evaluateGroup(one, toStudentCourses([{ course: a.crossListed![0] }], [], idx), ctx).completed).toBe(1);
  });

  it("College of Engineering H/SS conditions share the same six classes", () => {
    const hss = (taken: string[]) => {
      const res = evaluateGroup(group("college-COE"), toStudentCourses(taken.map((course) => ({ course })), [], idx), ctx);
      return res.requirements.find((r) => /Humanities and Social Sciences/.test(r.title))!.result.children!;
    };
    const five = hss(["ENGLISH R1A", "ENGLISH R1B", "ECON 1", "PHILOS 104", "ECON 100A"]);
    expect(five.slice(0, 4).map((c) => c.satisfied)).toEqual([true, true, false, true]);
    const six = hss(["ENGLISH R1A", "ENGLISH R1B", "ECON 1", "PSYCH 1", "PHILOS 104", "ECON 100A"]);
    expect(six.slice(0, 4).map((c) => c.satisfied)).toEqual([true, true, true, true]);
  });

  it("AP credit mapped to a Berkeley class counts as that class", () => {
    const ds = majors.find((m) => /^Data Science$/.test(m.name))!;
    const g = group(ds.requirementGroupIds[0]);
    const done = (taken: { course: string; source?: string; units?: number }[]) => evaluateGroup(g, toStudentCourses(taken, [], idx), ctx).completed;
    expect(done([{ course: "MATH 1A", source: "ap", units: 2.7 }])).toBe(done([{ course: "MATH 1A" }]));
    expect(done([{ course: "AP Calculus AB", source: "ap", units: 2.7 }])).toBe(done([]));
    expect(done([{ course: "MATH 1A" }])).toBeGreaterThan(done([]));
  });
});

const hasInsights = fs.existsSync(path.join(DATA, "insights", "insights.json"));

describe.skipIf(!has || !hasInsights)("real class insights", () => {
  const courses = has ? read<Course[]>("courses.json") : [];
  const lean = hasInsights ? read<CourseInsight[]>("insights/insights.json") : [];
  const ids = new Set(courses.map((c) => c.id));

  it("lean rows are small, in range and point at catalog classes", () => {
    expect(lean.length).toBeGreaterThan(1000);
    for (const i of lean) {
      expect(ids.has(i.course), i.course).toBe(true);
      expect(Object.keys(i).every((k) => ["course", "difficulty", "shouldTake", "confidence"].includes(k)), i.course).toBe(true);
      for (const v of [i.difficulty, i.shouldTake]) {
        if (v == null) continue;
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(5);
      }
    }
  });

  it("every rated class has a details entry that agrees with the lean row", () => {
    const bySubject = new Map<string, Record<string, CourseInsight>>();
    for (const i of lean) {
      const subject = i.course.slice(0, i.course.lastIndexOf(" "));
      if (!bySubject.has(subject)) bySubject.set(subject, read<Record<string, CourseInsight>>(`insights/details/${subject}.json`));
      const full = bySubject.get(subject)![i.course];
      expect(full, i.course).toBeTruthy();
      expect(full.difficulty).toBe(i.difficulty);
      expect(full.shouldTake).toBe(i.shouldTake);
      for (const p of full.byProfessor ?? []) expect(p.professor.length).toBeGreaterThan(1);
    }
  });
});
