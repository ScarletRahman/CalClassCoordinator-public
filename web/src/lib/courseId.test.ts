import { describe, it, expect } from "vitest";
import { normalizeCourseId, registerSubjectAliases, resolveCourseId } from "./courseId";

const KNOWN = new Set([
  "COMPSCI 61A", "COMPSCI 189", "COMPSCI C100", "COMPSCI C8", "COMPSCI 70", "DATA C100", "DATA C8", "DATA C140", "STAT C100", "STAT C8",
  "STAT 20", "STAT 134", "ELENG 16A", "ELENG 16B", "ELENG 120", "ENGLISH R1A", "ENGLISH R1B", "ENGLISH N1B", "MATH 1B", "MATH H1B", "MATH 53",
  "MATH N53", "COGSCI 1", "MCELLBI 102", "INTEGBI 131", "LS C70T", "PBHLTH 142", "GWS W10", "ESPM 50AC", "HISTORY 7B", "PHYSICS 7A", "ENGIN 7",
]);

describe("normalizeCourseId", () => {
  it.each([
    ["data 100", "DATA 100"],
    ["cs 61a", "COMPSCI 61A"],
    ["cs61a", "COMPSCI 61A"],
    ["CS-61A", "COMPSCI 61A"],
    ["ee16a", "ELENG 16A"],
    ["eecs 16a", "EECS 16A"],
    ["eecs16a", "EECS 16A"],
    ["EECS16B", "EECS 16B"],
    ["eecs127", "EECS 127"],
    ["compsci61a", "COMPSCI 61A"],
    ["eleng16a", "ELENG 16A"],
    ["ugba10", "UGBA 10"],
    ["chem3al", "CHEM 3AL"],
    ["pbhlth142", "PBHLTH 142"],
    ["english r1a", "ENGLISH R1A"],
    ["stat 20", "STAT 20"],
    ["math1b", "MATH 1B"],
    ["mathh1b", "MATH H1B"],
    ["cogsci 1", "COGSCI 1"],
    ["cog sci 1", "COGSCI 1"],
    ["cogsci1", "COGSCI 1"],
    ["mcb 102", "MCELLBI 102"],
    ["mcb102", "MCELLBI 102"],
    ["ib 131", "INTEGBI 131"],
    ["ls c70t", "LS C70T"],
    ["L & S C70T", "LS C70T"],
    ["l&s c70t", "LS C70T"],
    ["data c100", "DATA C100"],
    ["datac100", "DATA C100"],
    ["PB HLTH 142", "PBHLTH 142"],
    ["EL ENG 16A", "ELENG 16A"],
    ["ETH STD 21AC", "ETHSTD 21AC"],
    ["e7", "ENGIN 7"],
    ["physics 7a", "PHYSICS 7A"],
    ["  Comp Sci   61A ", "COMPSCI 61A"],
    ["XMATH 1A", "XMATH 1A"],
    ["FAKE 100", "FAKE 100"],
  ])("%s -> %s", (raw, id) => expect(normalizeCourseId(raw)).toBe(id));

  it.each(["r1a", "61a", "", "hello", "data", "100", "the quick brown fox"])("%s is not a course", (raw) => expect(normalizeCourseId(raw)).toBeNull());

  it("uses aliases registered from the catalog, with official codes winning", () => {
    registerSubjectAliases([{ code: "NEWSUBJ", aliases: ["NEW SUBJ", "NS"] }, { code: "MATH", aliases: [] }]);
    expect(normalizeCourseId("new subj 10")).toBe("NEWSUBJ 10");
    expect(normalizeCourseId("ns10")).toBe("NEWSUBJ 10");
  });
});

describe("no-space forms once the catalog's subjects are registered", () => {
  it("splits at the digits, taking the longest subject (EECS, not EE + CS16A)", () => {
    // the real catalog has ELENG (alias EE) and COMPSCI (alias CS) but no EECS subject
    registerSubjectAliases([{ code: "ELENG", aliases: ["EE", "EL ENG"] }, { code: "COMPSCI", aliases: ["CS"] }, { code: "DATA", aliases: [] }]);
    expect(normalizeCourseId("eecs16a")).toBe("EECS 16A");
    expect(normalizeCourseId("ee16a")).toBe("ELENG 16A");
    expect(normalizeCourseId("cs16a")).toBe("COMPSCI 16A");
    expect(normalizeCourseId("datac8")).toBe("DATA C8");
    expect(resolveCourseId("eecs16a", new Set(["ELENG 16A"]))).toBe("ELENG 16A");
  });
  it("never rewrites an id the catalog already has", () => {
    // MATH 1A and MATH 51 can be the same class under an old and a new number: both stay as typed
    const known = new Set(["MATH 1A", "MATH 51", "MATH C51"]);
    expect(resolveCourseId("math 1a", known)).toBe("MATH 1A");
    expect(resolveCourseId("math51", known)).toBe("MATH 51");
  });
});

describe("resolveCourseId", () => {
  it.each([
    ["data 100", "DATA C100"],
    ["DATA 100", "DATA C100"],
    ["cs 100", "COMPSCI C100"],
    ["stat 100", "STAT C100"],
    ["Data 8", "DATA C8"],
    ["cs 8", "COMPSCI C8"],
    ["data 140", "DATA C140"],
    ["COMPSCI 189", "COMPSCI 189"],
    ["cs61a", "COMPSCI 61A"],
    ["english 1a", "ENGLISH R1A"],
    ["english r1a", "ENGLISH R1A"],
    ["gws 10", "GWS W10"],
    ["eecs 16a", "ELENG 16A"],
    ["ee16b", "ELENG 16B"],
    ["math1b", "MATH 1B"],
    ["math h1b", "MATH H1B"],
    ["mcb 102", "MCELLBI 102"],
    ["ib 131", "INTEGBI 131"],
    ["ls c70t", "LS C70T"],
    ["cogsci 1", "COGSCI 1"],
    ["stat 20", "STAT 20"],
  ])("%s -> %s", (raw, id) => expect(resolveCourseId(raw, KNOWN)).toBe(id));

  it("prefers an exact id over adding a prefix", () => {
    expect(resolveCourseId("math 53", KNOWN)).toBe("MATH 53");
    expect(resolveCourseId("math 1b", KNOWN)).toBe("MATH 1B");
  });
  it("prefers C, then R, N, W, H when several prefixes fit", () => {
    expect(resolveCourseId("english 1b", KNOWN)).toBe("ENGLISH R1B");
    expect(resolveCourseId("x 5", new Set(["X N5", "X H5"]))).toBeNull(); // one-letter subject is not a course
    expect(resolveCourseId("zz 5", new Set(["ZZ N5", "ZZ H5"]))).toBe("ZZ N5");
    expect(resolveCourseId("zz 5", new Set(["ZZ W5", "ZZ C5"]))).toBe("ZZ C5");
  });
  it("returns null when nothing in the catalog fits", () => {
    for (const raw of ["english r5b", "compsci 24", "cs 24", "data 20", "data c999", "r1a", "", "not a course"]) expect(resolveCourseId(raw, KNOWN), raw).toBeNull();
  });
  it("never moves a class to another department", () => {
    expect(resolveCourseId("cs 16a", KNOWN)).toBeNull();
    expect(resolveCourseId("eleng 189", KNOWN)).toBeNull();
  });
  it("takes any object with has()", () => {
    expect(resolveCourseId("data 100", new Map([["DATA C100", 1]]))).toBe("DATA C100");
  });
});
