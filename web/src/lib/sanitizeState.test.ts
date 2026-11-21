import { describe, expect, it } from "vitest";
import { canonicalPlan, sanitizeState, sanitizeStateReport } from "./sanitizeState";

describe("sanitizeState", () => {
  it("returns null only for non-objects", () => {
    for (const v of [null, undefined, 3, "x", [], true]) expect(sanitizeState(v)).toBeNull();
    expect(sanitizeState({})).toMatchObject({ version: 1, majorIds: [], semesters: [], taken: [], manualChecks: {}, pins: {}, choices: {} });
  });

  it("survives semesters: null and other wrong types (used to crash the page)", () => {
    const s = sanitizeState({ version: 1, semesters: null, taken: "nope", majorIds: "cs", manualChecks: [], pins: 5, choices: "x" })!;
    expect(s.semesters).toEqual([]);
    expect(s.taken).toEqual([]);
    expect(s.majorIds).toEqual([]);
    expect(s.manualChecks).toEqual({});
    expect(s.pins).toEqual({});
  });

  it("drops malformed entries and keeps good ones", () => {
    const r = sanitizeStateReport({
      version: 1,
      majorIds: ["cs", 4, null, "ds"],
      minorGroupIds: [{}],
      year: 3,
      startTerm: "2025 Fall",
      taken: [{ course: "COMPSCI 61A", term: "2025 Fall", grade: "A", units: 4, source: "transcript" }, { course: 7 }, "MATH 1A", { course: "MATH 1B", units: "4", source: "weird" }],
      semesters: [
        { term: "2026 Spring", courses: [{ course: "COMPSCI 61B", professor: 3 }, null, "DATA C8"] },
        { term: "2026 Spring", courses: [] },
        { courses: [] },
        { term: "2026 Fall", courses: null },
      ],
      manualChecks: { a: true, b: "yes" },
      pins: { "COMPSCI 61A": "req1", x: 1 },
      choices: { g: { c: ["o1", 2] }, bad: 1 },
    });
    const s = r.state!;
    expect(s.majorIds).toEqual(["cs", "ds"]);
    expect(s.minorGroupIds).toEqual([]);
    expect(s.year).toBeNull();
    expect(s.startTerm).toBe("2025 Fall");
    expect(s.taken).toEqual([
      { course: "COMPSCI 61A", term: "2025 Fall", grade: "A", units: 4, source: "transcript" },
      { course: "MATH 1B", source: "manual" },
    ]);
    expect(s.semesters).toEqual([
      { term: "2026 Spring", courses: [{ course: "COMPSCI 61B" }, { course: "DATA C8" }] },
      { term: "2026 Fall", courses: [] },
    ]);
    expect(s.manualChecks).toEqual({ a: true });
    expect(s.pins).toEqual({ "COMPSCI 61A": "req1" });
    expect(s.choices).toEqual({ g: { c: ["o1"] } });
    expect(r.dropped).toBeGreaterThan(5);
  });

  it("reports nothing dropped for a clean plan, and keeps unknown fields from newer code", () => {
    const clean = { version: 1, majorIds: ["cs"], minorGroupIds: [], year: "Junior", startTerm: null, taken: [], semesters: [{ term: "2026 Fall", courses: [] }], manualChecks: {}, pins: {}, choices: {}, extra: { keep: true } };
    const r = sanitizeStateReport(clean);
    expect(r.dropped).toBe(0);
    expect((r.state as unknown as { extra: unknown }).extra).toEqual({ keep: true });
  });

  it("ignores __proto__ keys", () => {
    const s = sanitizeState(JSON.parse('{"version":1,"__proto__":{"polluted":1},"pins":{"__proto__":"x"}}'))!;
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
    expect(Object.keys(s.pins!)).toEqual([]);
  });

  it("canonicalPlan ignores key order of the top level", () => {
    expect(canonicalPlan({ majorIds: ["a"], version: 1 })).toBe(canonicalPlan({ version: 1, majorIds: ["a"] }));
  });
});
