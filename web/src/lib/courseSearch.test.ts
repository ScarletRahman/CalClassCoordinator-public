import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerSubjectAliases } from "./courseId";
import { familyMembers } from "./courseFamily";
import { buildSearchIndex, highlightParts, searchCourses } from "./courseSearch";
import type { Course } from "./types";

const mini: Course[] = [
  { id: "DATA C100", subject: "DATA", number: "C100", title: "Principles & Techniques of Data Science", units: 4, crossListed: ["COMPSCI C100", "STAT C100"] },
  { id: "STAT C100", subject: "STAT", number: "C100", title: "Principles & Techniques of Data Science", units: 4, crossListed: ["COMPSCI C100", "DATA C100"] },
  { id: "COMPSCI C100", subject: "COMPSCI", number: "C100", title: "Principles & Techniques of Data Science", units: 4, crossListed: ["DATA C100", "STAT C100"] },
  { id: "COMPSCI 61A", subject: "COMPSCI", number: "61A", title: "The Structure and Interpretation of Computer Programs", units: 4 },
  { id: "COMPSCI 61B", subject: "COMPSCI", number: "61B", title: "Data Structures", units: 4 },
  { id: "COMPSCI 161", subject: "COMPSCI", number: "161", title: "Computer Security", units: 4 },
  { id: "ENGLISH R1A", subject: "ENGLISH", number: "R1A", title: "Reading and Composition", units: 4 },
  { id: "COLWRIT R1A", subject: "COLWRIT", number: "R1A", title: "Accelerated Reading and Composition", units: 6 },
  { id: "MATH 54", subject: "MATH", number: "54", title: "Linear Algebra and Differential Equations", units: 4 },
  { id: "MATH 110", subject: "MATH", number: "110", title: "Abstract Linear Algebra", units: 4 },
  { id: "ELENG 16A", subject: "ELENG", number: "16A", title: "Designing Information Devices and Systems I", units: 4 },
];

describe("searchCourses (small catalog)", () => {
  registerSubjectAliases([{ code: "COMPSCI", aliases: ["CS"] }, { code: "ELENG", aliases: ["EE", "EL ENG"] }, { code: "DATA" }, { code: "STAT" }, { code: "MATH" }, { code: "ENGLISH" }, { code: "COLWRIT" }]);
  const idx = buildSearchIndex(mini);
  const ids = (q: string) => searchCourses(q, idx).hits.map((h) => h.id);

  it("lists a cross-listed class once, under the code that was typed", () => {
    const r = searchCourses("data 100", idx);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ id: "DATA C100", also: ["COMPSCI C100", "STAT C100"], tier: 1 });
    expect(ids("stat c100")).toEqual(["STAT C100"]);
    expect(ids("cs c100")).toEqual(["COMPSCI C100"]);
    expect(ids("c100")).toEqual(["DATA C100"]);
    expect(ids("principles")).toEqual(["DATA C100"]);
  });

  it("hides the whole family when any member is excluded", () => {
    expect(searchCourses("data 100", idx, { exclude: new Set(["STAT C100"]) }).hits).toEqual([]);
  });

  it("ranks exact over loose over prefix over title", () => {
    expect(ids("cs 61a")[0]).toBe("COMPSCI 61A");
    expect(ids("cs 61")).toEqual(["COMPSCI 61A", "COMPSCI 61B"]);
    expect(ids("cs 16")).toEqual(["COMPSCI 161"]);
    expect(ids("r1a")).toEqual(["COLWRIT R1A", "ENGLISH R1A"]);
    expect(ids("english 1a")).toEqual(["ENGLISH R1A"]);
    expect(ids("linear algebra")).toEqual(["MATH 54", "MATH 110"]);
  });

  it("offers a custom add only when nothing matches exactly", () => {
    expect(searchCourses("cs 61a", idx).custom).toBeNull();
    expect(searchCourses("data 100", idx).custom).toBeNull();
    expect(searchCourses("cs 61c", idx).custom).toBe("COMPSCI 61C");
    expect(searchCourses("linear algebra", idx).custom).toBeNull();
    expect(searchCourses("61a", idx).custom).toBeNull();
  });

  it("returns highlight ranges for the matched part", () => {
    const h = searchCourses("cs 61", idx).hits[0];
    expect(highlightParts(h.id, h.idRanges).filter((p) => p.hit).map((p) => p.text)).toEqual(["COMPSCI", "61"]);
    const t = searchCourses("structure and interp", idx).hits[0];
    expect(highlightParts(t.title, t.titleRanges).filter((p) => p.hit).map((p) => p.text)).toEqual(["Structure and Interp"]);
    const loose = searchCourses("data 100", idx).hits[0];
    expect(highlightParts(loose.id, loose.idRanges).filter((p) => p.hit).map((p) => p.text)).toEqual(["DATA", "100"]);
  });

  it("a recognised subject never falls back to other departments by number", () => {
    const r = searchCourses("math 161", idx);
    expect(r.missing).toBe("MATH 161");
    expect(r.exact).toBe(false);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.suggestion && h.id.startsWith("MATH "))).toBe(true);
    expect(r.hits[0].id).toBe("MATH 110"); // closest number
    expect(searchCourses("cs 61", idx).missing).toBeNull();
    expect(searchCourses("cs 61a", idx).hits[0].suggestion).toBe(false);
  });

  it("an unknown subject suggests the number elsewhere, but only as suggestions", () => {
    const r = searchCourses("zz r1a", idx);
    expect(r.hits.map((h) => h.id)).toEqual(["COLWRIT R1A", "ENGLISH R1A"]);
    expect(r.hits.every((h) => h.suggestion)).toBe(true);
  });

  it("orders a bare number by popularity when the catalog has it", () => {
    const pop = buildSearchIndex(mini.map((c) => (c.id === "ENGLISH R1A" ? { ...c, popularity: 9 } : c.id === "COLWRIT R1A" ? { ...c, popularity: 5 } : c)));
    expect(searchCourses("r1a", pop).hits.map((h) => h.id)).toEqual(["ENGLISH R1A", "COLWRIT R1A"]);
  });

  it("limits results and reports the total", () => {
    const r = searchCourses("c", idx, { limit: 2 });
    expect(r.hits.length).toBeLessThanOrEqual(2);
    expect(searchCourses("", idx)).toMatchObject({ hits: [], total: 0 });
  });
});

// Renumbered classes (Course.sameAs): needs crossList.familyOf to follow sameAs links.
const renum: Course[] = [
  { id: "MATH 52", subject: "MATH", number: "52", title: "Calculus II", units: 4, sameAs: ["MATH 1B"] },
  { id: "MATH 1B", subject: "MATH", number: "1B", title: "Calculus", units: 4, sameAs: ["MATH 52"], retired: true },
  { id: "EECS 16A", subject: "EECS", number: "16A", title: "Devices", units: 4, sameAs: ["ELENG 16A"], retired: true },
  { id: "ELENG 16A", subject: "ELENG", number: "16A", title: "Devices", units: 4, sameAs: ["EECS 16A"] },
];
const followsSameAs = familyMembers("MATH 52", new Map(renum.map((c) => [c.id, c]))).includes("MATH 1B");
describe.skipIf(!followsSameAs)("renumbered classes", () => {
  registerSubjectAliases([{ code: "MATH" }, { code: "EECS" }, { code: "ELENG" }]);
  const idx = buildSearchIndex(renum);
  it("finds the class once by either number and says which is which", () => {
    const old = searchCourses("math 1b", idx);
    expect(old.hits).toHaveLength(1);
    expect(old.hits[0]).toMatchObject({ id: "MATH 52", also: [], formerly: ["MATH 1B"] });
    const cur = searchCourses("math 52", idx);
    expect(cur.hits).toHaveLength(1);
    expect(cur.hits[0]).toMatchObject({ id: "MATH 52", formerly: ["MATH 1B"], also: [] });
    expect(searchCourses("calculus", idx).hits.map((h) => h.id)).toEqual(["MATH 52"]);
    // two current numbers of one class: listed once, the other code visible
    const both = buildSearchIndex([renum[0], { ...renum[1], retired: false }]);
    expect(searchCourses("math 1b", both).hits).toHaveLength(1);
    expect(searchCourses("math 1b", both).hits[0]).toMatchObject({ id: "MATH 1B", sameAs: ["MATH 52"], formerly: [], also: [] });
    expect(searchCourses("eecs 16a", idx).hits[0]).toMatchObject({ id: "ELENG 16A", formerly: ["EECS 16A"] });
  });
});

// The real catalog, when present (repo-level data/ or CCC_DATA_DIR), the way realData.test.ts reads it.
const DATA = process.env.CCC_DATA_DIR ?? path.resolve(process.cwd(), "..", "data");
const has = fs.existsSync(path.join(DATA, "courses.json")) && fs.existsSync(path.join(DATA, "subjects.json"));
const read = <T,>(rel: string) => JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")) as T;

describe.skipIf(!has)("searchCourses (real catalog)", () => {
  const courses = has ? read<Course[]>("courses.json") : [];
  if (has) registerSubjectAliases(read<{ code: string; aliases?: string[] }[]>("subjects.json"));
  const idx = buildSearchIndex(courses);
  const known = new Set(courses.map((c) => c.id));

  /** Query -> the id that must come first. */
  const first: [string, string][] = [
    ["data 100", "DATA C100"],
    ["Data 100", "DATA C100"],
    ["data c100", "DATA C100"],
    ["data sci 100", "DATA C100"],
    ["stat c100", "STAT C100"],
    ["cs c100", "COMPSCI C100"],
    ["cs 61a", "COMPSCI 61A"],
    ["cs61a", "COMPSCI 61A"],
    ["CS 61A", "COMPSCI 61A"],
    ["comp sci 61a", "COMPSCI 61A"],
    ["compsci61b", "COMPSCI 61B"],
    ["61a", "COMPSCI 61A"],
    ["ee 16a", "ELENG 16A"],
    ["el eng 16a", "ELENG 16A"],
    ["eecs16a", "EECS 16A"],
    ["eecs 16b", "EECS 16B"],
    ["stat 20", "STAT 20"],
    ["mcb 102", "MCELLBI 102"],
    ["ib 131", "INTEGBI 131"],
    ["ib131", "INTEGBI 131"],
    ["math 54", "MATH 54"],
    ["math54", "MATH 54"],
    ["math 1a", "MATH 1A"],
    ["data 8", "DATA C8"],
    ["c8", "DATA C8"],
    ["cs 70", "COMPSCI 70"],
    ["cs 189", "COMPSCI 189"],
    ["l&s 1", "LS 1"],
    ["colwrit r1a", "COLWRIT R1A"],
    ["college writing r1a", "COLWRIT R1A"],
    ["chem 3al", "CHEM 3AL"],
    ["anthro 2ac", "ANTHRO 2AC"],
    ["structure and interpretation", "COMPSCI 61A"],
    ["structure and interp", "COMPSCI 61A"],
    ["linear algebra", "MATH 54"],
    ["general human anatomy", "INTEGBI 131"],
  ];
  it.each(first.filter(([, id]) => !has || known.has(id)))("%s -> %s first", (q, id) => {
    expect(searchCourses(q, idx).hits[0]?.id).toBe(id);
  });

  it("covers at least 30 first-result cases", () => {
    expect(first.filter(([, id]) => known.has(id)).length).toBeGreaterThanOrEqual(30);
  });

  it("finds English R1A once the catalog has it, and offers to add it until then", () => {
    const r = searchCourses("english r1a", idx);
    if (known.has("ENGLISH R1A")) {
      expect(r.hits[0].id).toBe("ENGLISH R1A");
      expect(r.custom).toBeNull();
    } else {
      expect(r.custom).toBe("ENGLISH R1A");
      expect(r.missing).toBe("ENGLISH R1A");
      expect(r.hits.every((h) => h.suggestion && h.id.startsWith("ENGLISH "))).toBe(true);
    }
  });

  it("'r1a' lists the R1A classes across departments, regular departments before extension", () => {
    const r = searchCourses("r1a", idx, { limit: 50 });
    const exact = r.hits.filter((h) => h.tier === 2).map((h) => h.id);
    expect(exact.length).toBeGreaterThan(8);
    expect(exact.every((id) => id.endsWith(" R1A"))).toBe(true);
    expect(exact).toContain("COLWRIT R1A");
    const firstX = exact.findIndex((id) => /^X/.test(id));
    if (firstX >= 0) expect(exact.slice(firstX).every((id) => /^X/.test(id))).toBe(true);
    expect(searchCourses("r1a", idx).total).toBeGreaterThan(searchCourses("r1a", idx).hits.length);
  });

  it("never lists two codes of one cross-listed class", () => {
    for (const q of ["data", "stat c", "c100", "data science", "c8", "eecs", "principles"]) {
      const hits = searchCourses(q, idx, { limit: 200 }).hits;
      const seen = new Set<string>();
      for (const h of hits) {
        for (const id of [h.id, ...h.also]) {
          expect(seen.has(id), `${q}: ${id}`).toBe(false);
          seen.add(id);
        }
      }
    }
  });

  it("orders numbers numerically inside a subject", () => {
    const got = searchCourses("cs 61", idx).hits.map((h) => h.id);
    expect(got.slice(0, 3)).toEqual(["COMPSCI 61A", "COMPSCI 61B", "COMPSCI 61BL"]);
    const math = searchCourses("math 1", idx, { limit: 6 }).hits.map((h) => h.id);
    expect(math[0]).toBe("MATH 1");
    expect(math.indexOf("MATH 1A")).toBeLessThan(math.indexOf("MATH 10A"));
    const stat = searchCourses("stat", idx, { limit: 200 }).hits.map((h) => h.id);
    expect(stat.indexOf("STAT 20")).toBeLessThan(stat.indexOf("STAT 134"));
  });

  it("'mcb 160' and 'mcb 160l' never offer another department's 160", () => {
    for (const q of ["mcb 160", "mcb 160l"]) {
      const r = searchCourses(q, idx);
      if (r.exact) continue; // the catalog gained the class
      expect(r.hits.every((h) => h.id.startsWith("MCELLBI ")), q).toBe(true);
      expect(r.hits.filter((h) => !h.id.startsWith("MCELLBI 160")).every((h) => h.suggestion), q).toBe(true);
    }
    expect(searchCourses("mcb 160", idx).hits.some((h) => h.id === "ANTHRO 160")).toBe(false);
  });

  it("'ed 1' finds ENVDES 1", () => {
    if (known.has("ENVDES 1")) expect(searchCourses("ed 1", idx).hits[0].id).toBe("ENVDES 1");
  });

  it("does not offer a custom add for nonsense or for title searches", () => {
    expect(searchCourses("zzzz", idx)).toMatchObject({ hits: [], custom: null });
    expect(searchCourses("organic chem", idx).custom).toBeNull();
    expect(searchCourses("eecs16a", idx).custom).toBeNull();
    expect(searchCourses("foo 99", idx).custom).toBe("FOO 99");
  });

  it("is fast enough to run on every keystroke", () => {
    const t0 = performance.now();
    for (const q of ["d", "da", "dat", "data", "data 1", "data 10", "data 100", "linear algebra"]) searchCourses(q, idx);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});
