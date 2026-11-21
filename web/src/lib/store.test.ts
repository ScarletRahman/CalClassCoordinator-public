import { describe, expect, it } from "vitest";
import { EMPTY_STATE, reducer } from "./store";
import type { PlannerState } from "./types";

const base: PlannerState = {
  ...EMPTY_STATE,
  majorIds: ["cs"],
  semesters: [
    { term: "2027 Spring", courses: [{ course: "COMPSCI 61A", professor: "Kay Ousterhout" }, { course: "MATH 53" }] },
    { term: "2027 Fall", courses: [] },
  ],
};

describe("section picks on the plan", () => {
  it("setSections stores the chosen class numbers on one planned course", () => {
    const s = reducer(base, { type: "setSections", term: "2027 Spring", course: "COMPSCI 61A", sections: ["28320", "28338"] });
    expect(s.semesters[0].courses).toEqual([{ course: "COMPSCI 61A", professor: "Kay Ousterhout", sections: ["28320", "28338"] }, { course: "MATH 53" }]);
    expect(s.semesters[1].courses).toEqual([]);
    expect(base.semesters[0].courses[0].sections).toBeUndefined();
  });
  it("ignores a course or term that is not on the plan", () => {
    expect(reducer(base, { type: "setSections", term: "2027 Spring", course: "DATA C8", sections: ["1"] }).semesters).toEqual(base.semesters);
    expect(reducer(base, { type: "setSections", term: "2028 Spring", course: "MATH 53", sections: ["1"] }).semesters).toEqual(base.semesters);
  });
  it("drops the picks when a class moves to another term, keeping the professor", () => {
    const picked = reducer(base, { type: "setSections", term: "2027 Spring", course: "COMPSCI 61A", sections: ["28320"] });
    const moved = reducer(picked, { type: "movePlanned", from: "2027 Spring", to: "2027 Fall", course: "COMPSCI 61A" });
    expect(moved.semesters[1].courses).toEqual([{ course: "COMPSCI 61A", professor: "Kay Ousterhout" }]);
  });
  it("survives a save and load round trip", () => {
    const picked = reducer(base, { type: "setSections", term: "2027 Spring", course: "MATH 53", sections: ["21816", "21820"] });
    const loaded = reducer(EMPTY_STATE, { type: "replace", state: JSON.parse(JSON.stringify(picked)) });
    expect(loaded.semesters[0].courses[1].sections).toEqual(["21816", "21820"]);
  });
});
