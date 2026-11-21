import { describe, it, expect } from "vitest";
import { parseTranscriptText, type ParsedTranscript } from "./parse";

const ids = (r: ParsedTranscript) => r.courses.map((c) => c.course).sort();
const ipIds = (r: ParsedTranscript) => r.inProgress.map((c) => c.course).sort();
const find = (r: ParsedTranscript, id: string) => r.courses.find((c) => c.course === id);

describe("CalCentral unofficial transcript (PDF text)", () => {
  const text = `
University of California, Berkeley
Unofficial Transcript                                   Page 1 of 2
Name:   Bear, Oski          Student ID:  3031234567
Print Date: 11/20/2026

Test Credits
Advanced Placement
AP CALCULUS BC          5          8.00
AP ENGLISH LANGUAGE     4          4.00
AP PHYSICS C MECHANICS  5          4.00
AP COMPUTER SCIENCE A   5          2.00
Test Credit Total                  18.00

Beginning of Undergraduate Record
Fall 2023
Course        Description                    Attempted   Earned   Grade   Points
COMPSCI 61A   THE STRUCTURE & INTERP         4.00        4.00     A       16.000
MATH 1B       CALCULUS                       4.00        4.00     B+      13.200
L & S C70T    THE ORIGINS OF MODERN ...      3.00        3.00     P       0.000
COLWRIT R4B   READING CLOSELY                4.00        4.00     A-      14.800
Term GPA   3.81       Term Totals   15.00   15.00   43.000

2024 Spring
COMP SCI 61B  DATA STRUCTURES                4.00        4.00     A-      14.800
DATA C8       FOUNDATIONS OF DATA SCI        4.00        4.00     A       16.000
COMPSCI 70    DISCRETE MATH & PROB           4.00        0.00     W        0.000
EL ENG 16A    DESIGNING INFO DEVICES I       4.00        4.00     B        12.000
                                                                  Page 2 of 2
Fall 2024
COMPSCI 70    DISCRETE MATH & PROB           4.00        4.00     B+      13.200
DATA C100     PRINCIPLES & TECHNIQUES        4.00        4.00     A       16.000
MEC ENG 40    THERMODYNAMICS                 3.00        0.00     F       0.000
ECON 1        INTRO ECONOMICS                4.00        4.00     NP      0.000

Spring 2025
COMPSCI 161   COMPUTER SECURITY              4.00        0.00     IP      0.000
STAT 134      CONCEPTS OF PROBABILITY        4.00
Cum GPA    3.70     Cum Totals    62.00   58.00   156.400
`;
  const r = parseTranscriptText(text, { currentTerm: "2025 Spring" });

  it("reads courses with spaced subjects and cross-listings", () => {
    expect(ids(r)).toEqual(
      [
        "COMPSCI 61A", "MATH 1B", "LS C70T", "COLWRIT R4B", "COMPSCI 61B", "DATA C8", "ELENG 16A",
        "COMPSCI 70", "DATA C100", "MATH 1A", "AP ENGLISH LANGUAGE", "AP PHYSICS C: MECHANICS",
        "AP COMPUTER SCIENCE A",
      ].sort(),
    );
  });

  it("keeps the passing attempt of a repeated course", () => {
    const c = find(r, "COMPSCI 70")!;
    expect(c.grade).toBe("B+");
    expect(c.term).toBe("2024 Fall");
    expect(r.warnings.some((w) => w.includes("COMPSCI 70 appears 2 times"))).toBe(true);
  });

  it("does not count F / NP and warns", () => {
    expect(find(r, "MECENG 40")).toBeUndefined();
    expect(find(r, "ECON 1")).toBeUndefined();
    expect(r.warnings.some((w) => w.startsWith("MECENG 40"))).toBe(true);
  });

  it("puts IP and ungraded current-term courses in progress", () => {
    expect(ipIds(r)).toEqual(["COMPSCI 161", "STAT 134"]);
  });

  it("normalizes terms, units, grades, titles", () => {
    expect(r.terms).toEqual(["2023 Fall", "2024 Spring", "2024 Fall", "2025 Spring"]);
    const a = find(r, "COMPSCI 61A")!;
    expect(a).toMatchObject({ term: "2023 Fall", grade: "A", units: 4, source: "transcript", title: "THE STRUCTURE & INTERP" });
    expect(find(r, "LS C70T")).toMatchObject({ grade: "P", units: 3 });
    expect(r.studentName).toBe("Oski Bear");
    expect(r.totalUnits).toBe(58);
  });

  it("maps AP credit", () => {
    expect(find(r, "MATH 1A")).toMatchObject({ source: "ap", label: "AP Calculus BC (5)" });
    // Real Berkeley MATH 1B attempt wins over the AP mapping
    expect(find(r, "MATH 1B")).toMatchObject({ source: "transcript", grade: "B+" });
    expect(find(r, "AP ENGLISH LANGUAGE")!.label).toContain("Reading & Composition Part A");
    expect(find(r, "AP PHYSICS C: MECHANICS")).toMatchObject({ source: "ap", label: "AP Physics C: Mechanics (5)", units: 4 });
  });

  it("skips header/footer junk", () => {
    expect(r.courses.some((c) => /PAGE|TERM|CUM|PRINT/.test(c.course))).toBe(false);
  });
});

describe("Academic Progress Report style", () => {
  const text = `
Academic Progress Report
Requirement: Reading and Composition     Satisfied
Course        Description                                  Units   Grade   Term
COLWRIT R1A   Accelerated Reading and Composition          4.00    A       Fall 2022
ENGLISH R1B   Reading and Composition                      4.00    B+      Spring 2023
Requirement: Lower Division Math         Not Satisfied
MATH 54       Linear Algebra & Differential Equations      4.00    B       2023 Fall
MATH 54       Linear Algebra & Differential Equations      4.00    B       2023 Fall
STAT 20       Introduction to Probability and Statistics   4.00    IP      2024 Spring
2023 Fall  PSYCH 1  General Psychology  3.00  A-
INTEGBI C32   Bioinspired Design                           3.00    P       FA23
CHEM 1A       General Chemistry                            3.00    In Progress   2024 Spring
`;
  const r = parseTranscriptText(text);
  it("reads course rows with trailing terms", () => {
    expect(ids(r)).toEqual(["COLWRIT R1A", "ENGLISH R1B", "INTEGBI C32", "MATH 54", "PSYCH 1"]);
    expect(find(r, "COLWRIT R1A")).toMatchObject({ term: "2022 Fall", grade: "A", units: 4, title: "Accelerated Reading and Composition" });
    expect(find(r, "PSYCH 1")).toMatchObject({ term: "2023 Fall", grade: "A-", units: 3 });
    expect(find(r, "INTEGBI C32")).toMatchObject({ term: "2023 Fall", grade: "P" });
  });
  it("dedupes identical rows without a warning", () => {
    expect(r.courses.filter((c) => c.course === "MATH 54")).toHaveLength(1);
    expect(r.warnings.some((w) => w.includes("MATH 54"))).toBe(false);
  });
  it("marks IP / In Progress rows", () => {
    expect(ipIds(r)).toEqual(["CHEM 1A", "STAT 20"]);
  });
  it("does not read requirement lines as courses", () => {
    expect(r.courses.some((c) => c.course.startsWith("REQUIREMENT"))).toBe(false);
  });
});

describe("CalCentral My Academics paste and simple lists", () => {
  it("parses My Academics rows", () => {
    const r = parseTranscriptText(`
Fall 2025
COMPSCI 61A   Lecture   4.0   A-
MATH 1A       Lecture   4.0   B
PHYSED 11     Lab       1.0   P
Spring 2026
COMPSCI 61B   Lecture   4.0
EECS 16A      Lecture   4.0
`, { currentTerm: "2026 Spring" });
    expect(ids(r)).toEqual(["COMPSCI 61A", "MATH 1A", "PHYSED 11"]);
    expect(find(r, "COMPSCI 61A")).toMatchObject({ grade: "A-", units: 4, term: "2025 Fall" });
    expect(find(r, "COMPSCI 61A")!.title).toBeUndefined();
    expect(ipIds(r)).toEqual(["COMPSCI 61B", "EECS 16A"]);
  });

  it("parses a hand-typed list", () => {
    const r = parseTranscriptText(`
CS 61A - A
cs61b: B+
Math 1A Fall 2023 B+
Data 8
• Stat 20 (P)
compsci 70 - W
Econ 1, Spring 2024, A
AP Calculus AB 4
AP US History 5
AP Statistics 5
`);
    expect(ids(r)).toEqual(
      ["COMPSCI 61A", "COMPSCI 61B", "MATH 1A", "DATA 8", "STAT 20", "ECON 1", "AP US HISTORY", "AP STATISTICS"].sort(),
    );
    expect(find(r, "COMPSCI 61A")!.grade).toBe("A");
    expect(find(r, "COMPSCI 61B")!.grade).toBe("B+");
    expect(find(r, "MATH 1A")).toMatchObject({ term: "2023 Fall", grade: "B+", source: "transcript" });
    expect(find(r, "DATA 8")!.grade).toBeUndefined();
    expect(find(r, "STAT 20")!.grade).toBe("P");
    expect(find(r, "ECON 1")).toMatchObject({ term: "2024 Spring", grade: "A" });
    expect(find(r, "AP US HISTORY")!.label).toBe("AP US History (5): American History (AH&I)");
    expect(find(r, "AP STATISTICS")!.label).toBe("AP Statistics (5)");
    expect(r.inProgress).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes("COMPSCI 70") && w.includes("W"))).toBe(true);
  });

  it("does not map low or missing AP scores", () => {
    const r = parseTranscriptText("AP Calculus BC 3\nAP Calculus AB\nAP English Literature 3");
    expect(find(r, "MATH 1A")).toBeUndefined();
    expect(find(r, "AP CALCULUS BC")!.label).toBe("AP Calculus BC (3)");
    expect(find(r, "AP CALCULUS AB")!.label).toBe("AP Calculus AB");
    expect(find(r, "AP ENGLISH LITERATURE")!.label).toBe("AP English Literature (3): Entry Level Writing");
    expect(r.warnings.some((w) => w.includes("no score"))).toBe(true);
  });

  it("returns a helpful warning for empty / garbage text", () => {
    const r = parseTranscriptText("Page 1 of 1\n\nThis document is not a transcript.\n");
    expect(r.courses).toHaveLength(0);
    expect(r.warnings[0]).toMatch(/No classes were recognized/);
  });
});

describe("Transfer credit and test sections", () => {
  const text = `
Transfer Credit
De Anza College
MATH 1A    CALCULUS              5.00   A
ENGL 1A    COMPOSITION           5.00   A-
Total Transfer Units  10.00

Beginning of Undergraduate Record
Fall 2024
MATH 53    MULTIVARIABLE CALC    4.00   4.00   B   12.000
Test Credits
AP Chemistry  Score: 4   5.00
IB HL Mathematics 6
`;
  const r = parseTranscriptText(text);
  it("tags transfer rows", () => {
    expect(find(r, "MATH 1A")).toMatchObject({ source: "transfer", grade: "A", units: 5 });
    expect(find(r, "ENGL 1A")).toMatchObject({ source: "transfer" });
  });
  it("resumes the Berkeley record after the transfer section", () => {
    expect(find(r, "MATH 53")).toMatchObject({ source: "transcript", term: "2024 Fall" });
  });
  it("handles explicit score labels and IB", () => {
    expect(find(r, "AP CHEMISTRY")).toMatchObject({ source: "ap", label: "AP Chemistry (4)", units: 5 });
    expect(find(r, "IB MATHEMATICS")).toMatchObject({ source: "ap", label: "IB Mathematics HL (6)" });
  });
});

// ---------------------------------------------------------------------------------------------
// CalCentral "My Academics > Academic Summary". The line structure, spacing, headings and columns
// below follow CalCentral's page; every class, grade and detail is made up.
// ---------------------------------------------------------------------------------------------

const KNOWN = new Set([
  "PBHLTH 126", "ASTRON C10", "ESPM 98", "COGSCI 1", "DATA C8", "MATH 51", "SOCIOL 3AC", "COMPSCI 61A", "RHETOR R1A",
  "MATH 55", "STAT 98", "ECON 199", "COMLIT R1B", "MATH 54", "SOCIOL 1", "COMPSCI 61B", "DATA C100", "STAT C100",
  "COMPSCI C100", "STAT 133", "COGSCI 131", "PHILOS 3", "COMPSCI 70", "COMPSCI 189", "MATH 1A", "MATH 1B",
  "ELENG 16A", "LS C70T", "ECON 1", "MCELLBI 102", "HISTORY 7B", "ESPM 50AC", "ETHSTD 21AC", "RHETOR R1B",
]);
const TITLES: Record<string, string> = {
  "MATH 51": "Calculus I",
  "MATH 54": "Linear Algebra and Differential Equations",
  "MATH 55": "Discrete Mathematics",
  "COGSCI 1": "Introduction to Cognitive Science",
  "COGSCI 131": "Computational Models of Cognition",
  "COMPSCI 61A": "The Structure and Interpretation of Computer Programs",
  "COMPSCI 61B": "Data Structures",
  "ASTRON C10": "Introduction to General Astronomy",
};
const all = (r: ParsedTranscript) => [...r.courses, ...r.inProgress, ...r.skipped];

/** What the layout step produces for the page, whether from a text PDF or from OCR. */
const ACADEMIC_SUMMARY = `
1/5/27, 10:14 AM    calcentral.berkeley.edu/academics/academic_summary
My Academics » Academic Summary
Academic Summary    Print
Student Profile
Name    Oski Golden Bear
Student ID    3030000000
Major    Undergrad Letters & Science
Undeclared
Academic Career    Undergraduate
Level    Sophomore
Terms Information    Terms in Attendance
4
Expected Graduation
Spring 2029
Consult your college advisor with questions or concerns.
Cumulative Units    Total Units    53
P/NP Total    10
P/NP Passed    10
Cumulative GPA    3.607
Enrollment
Summer 2025
Class    Title    Un.    Gr.    Pts.
PBHLTH 126 (Session A)    Health Economics    4    B+    13.2
Fall 2025
Class    Title    Un.    Gr.    Pts.
ASTRON C10    Introduction to General Astronomy    4    P    0.0
ESPM 98    Directed Group Study    1    P    0.0
COGSCI 1    Introduction to Cognitive Science    4    A    16
https://calcentral.berkeley.edu/academics/academic_summary    1/2
1/5/27, 10:14 AM    calcentral.berkeley.edu/academics/academic_summary
Class    Title    Un.    Gr.    Pts.
DATA C8    Foundations of Data Science    4    B    12
MATH 51    Calculus I    4    A-    14.8
Spring 2026
Class    Title    Un.    Gr.    Pts.
SOCIOL 3AC    Principles of Sociology: American Society    4    B+    13.2
COMPSCI 61A    The Structure and Interpretation of Computer Programs    4    A    16
RHETOR R1A    Writing Argumentative and Persuasive Texts    4    A    16
MATH 55    Discrete Mathematics    4    B+    13.2
STAT 98    Supervised Group Study    2    P    0.0
ECON 199    Supervised Independent Study and Research    3    P    0.0
Summer 2026
Class    Title    Un.    Gr.    Pts.
COMLIT R1B (Session D)    English Composition in Connection with the Reading of World Literature    4    A-    14.8
MATH 54 (Session C)    Linear Algebra and Differential Equations    4    A    16
SOCIOL 1 (Session D)    Introduction to Sociology    3    B+    9.9
Fall 2026
Class    Title    Un.    Gr.    Pts.
COMPSCI 61B    Data Structures    4    —    —
DATA C100    Principles & Techniques of Data Science    4    —    —
STAT 133    Concepts in Computing with Data    3    —    —
Spring 2027
Class    Title    Un.    Gr.    Pts.
COGSCI 131    Computational Models of Cognition    3    —    —
PHILOS 3    The Nature of Mind    3    —    —
For accessibility-related access issues with CalCentral, Contact IT Support for help.
© 2026 UC Regents
https://calcentral.berkeley.edu/academics/academic_summary    2/2
`;

const SUMMARY_DONE = [
  "PBHLTH 126", "ASTRON C10", "ESPM 98", "COGSCI 1", "DATA C8", "MATH 51", "SOCIOL 3AC", "COMPSCI 61A", "RHETOR R1A",
  "MATH 55", "STAT 98", "ECON 199", "COMLIT R1B", "MATH 54", "SOCIOL 1",
].sort();
const SUMMARY_IP = ["COMPSCI 61B", "DATA C100", "STAT 133", "COGSCI 131", "PHILOS 3"].sort();

describe("CalCentral Academic Summary (real layout)", () => {
  const r = parseTranscriptText(ACADEMIC_SUMMARY, { knownCourseIds: KNOWN });

  it("reads every class, none extra", () => {
    expect(ids(r)).toEqual(SUMMARY_DONE);
    expect(ipIds(r)).toEqual(SUMMARY_IP);
    expect(r.skipped).toEqual([]);
    expect(r.unreadLines).toEqual([]);
    expect(all(r).filter((c) => c.unknown)).toEqual([]);
  });
  it("keeps whole-number units, grades and mixed-case titles", () => {
    expect(find(r, "COGSCI 1")).toMatchObject({ term: "2025 Fall", units: 4, grade: "A", title: "Introduction to Cognitive Science" });
    expect(find(r, "ESPM 98")).toMatchObject({ units: 1, grade: "P", title: "Directed Group Study" });
    expect(find(r, "MATH 51")).toMatchObject({ grade: "A-", title: "Calculus I" });
    expect(find(r, "SOCIOL 3AC")).toMatchObject({ term: "2026 Spring", grade: "B+", units: 4 });
    expect(find(r, "ECON 199")?.title).toBe("Supervised Independent Study and Research");
  });
  it("drops the summer session from the class", () => {
    expect(find(r, "PBHLTH 126")).toMatchObject({ term: "2025 Summer", title: "Health Economics", grade: "B+" });
    expect(find(r, "MATH 54")).toMatchObject({ term: "2026 Summer", grade: "A", units: 4 });
    expect(find(r, "COMLIT R1B")?.title).toBe("English Composition in Connection with the Reading of World Literature");
  });
  it("treats a dash grade as in progress, for this term and the next", () => {
    expect(r.inProgress.find((c) => c.course === "COMPSCI 61B")).toMatchObject({ term: "2026 Fall", units: 4 });
    expect(r.inProgress.find((c) => c.course === "PHILOS 3")).toMatchObject({ term: "2027 Spring", units: 3 });
    expect(r.inProgress.every((c) => c.grade === undefined)).toBe(true);
  });
  it("does not take Expected Graduation for a term of classes", () => {
    expect(r.terms).toEqual(["2025 Summer", "2025 Fall", "2026 Spring", "2026 Summer", "2026 Fall", "2027 Spring"]);
  });
  it("reads the name without a colon and the unit total", () => {
    expect(r.studentName).toBe("Oski Golden Bear");
    expect(r.totalUnits).toBe(53);
  });
  it("marks a first-semester student's only term as in progress", () => {
    const f = parseTranscriptText("Fall 2026\nClass    Title    Un.    Gr.    Pts.\nCOMPSCI 61A    The Structure and Interpretation of Computer Programs    4    —    —\nMATH 1A    Calculus    4    —    —");
    expect(ipIds(f)).toEqual(["COMPSCI 61A", "MATH 1A"]);
    expect(f.courses).toEqual([]);
  });

  it("reads the same page pasted from the browser with tabs", () => {
    const tabbed = ACADEMIC_SUMMARY.replace(/ {4}/g, "\t");
    const t = parseTranscriptText(tabbed, { knownCourseIds: KNOWN });
    expect(ids(t)).toEqual(SUMMARY_DONE);
    expect(ipIds(t)).toEqual(SUMMARY_IP);
    expect(find(t, "MATH 51")).toMatchObject({ grade: "A-", units: 4, title: "Calculus I" });
  });
  it("reads the same page pasted one cell per line", () => {
    const cells = ACADEMIC_SUMMARY.split("\n")
      .map((l) => (/^(Class|[A-Z]{3,8} [A-Z]?\d)/.test(l) ? l.split(/ {4}/).join("\n") : l))
      .join("\n");
    const t = parseTranscriptText(cells, { knownCourseIds: KNOWN });
    expect(ids(t)).toEqual(SUMMARY_DONE);
    expect(ipIds(t)).toEqual(SUMMARY_IP);
    expect(find(t, "COGSCI 1")).toMatchObject({ grade: "A", units: 4, title: "Introduction to Cognitive Science" });
    expect(find(t, "PBHLTH 126")).toMatchObject({ grade: "B+", term: "2025 Summer" });
  });
  it("puts a wrapped session back when the cell broke across lines", () => {
    const t = parseTranscriptText("Summer 2025\nPBHLTH 126 (Session\tHealth Economics\t4\tA\t16\nA)\nFall 2025\nCOGSCI 1\tIntroduction to Cognitive Science\t4\tB+\t13.2");
    expect(ids(t)).toEqual(["COGSCI 1", "PBHLTH 126"]);
    expect(find(t, "PBHLTH 126")).toMatchObject({ title: "Health Economics", grade: "A", units: 4 });
  });
});

describe("Academic Summary read by OCR (image-only PDF)", () => {
  // the slips the OCR actually makes on this page
  const noisy = ACADEMIC_SUMMARY.replace("PBHLTH 126 (Session A)", "PBHLTH 126 (Session ~~ A)")
    .replace("COGSCI 1    Intro", "COGSCI 1.    Intro")
    .replace("Calculus I", "Calculus |")
    .replace("COMPSCI 61B", "COMPSCI| 61B")
    .replace("ASTRON C10", "ASTRON CIO")
    .replace("MATH 55 ", "MATH S5 ")
    .replace("P/NP Total", "P/INP Total");
  const conf = new Map([["SOCIOL 3AC    Principles of Sociology: American Society    4    B+    13.2", 41]]);
  const r = parseTranscriptText(noisy, { knownCourseIds: KNOWN, ocr: true, titleOf: (id) => TITLES[id], lineConfidence: conf });

  it("still reads every class", () => {
    expect(ids(r)).toEqual(SUMMARY_DONE);
    expect(ipIds(r)).toEqual(SUMMARY_IP);
    expect(r.unreadLines).toEqual([]);
  });
  it("repairs look-alike characters against the catalog and says so", () => {
    // the title on the row is the catalog's title for ASTRON C10, so the repair needs no flag
    expect(find(r, "ASTRON C10")).toMatchObject({ title: "Introduction to General Astronomy" });
    expect(find(r, "ASTRON C10")?.needsReview).toBeUndefined();
    expect(find(r, "MATH 55")).toMatchObject({ printedAs: "MATH S5", needsReview: expect.stringMatching(/closest match/) });
    expect(find(r, "MATH 51")).toMatchObject({ title: "Calculus I" });
    expect(find(r, "PBHLTH 126")?.title).toBe("Health Economics");
  });
  it("flags rows the OCR was unsure of, and only those", () => {
    expect(find(r, "SOCIOL 3AC")?.needsReview).toMatch(/hard to read/);
    expect(find(r, "COMPSCI 61A")?.needsReview).toBeUndefined();
    expect(find(r, "DATA C8")?.needsReview).toBeUndefined();
  });
  it("uses the title to catch a number read as another real class", () => {
    const t = parseTranscriptText("Fall 2025\nMATH 51    Linear Algebra and Differential Equations    4    B    12", {
      knownCourseIds: KNOWN,
      ocr: true,
      titleOf: (id) => TITLES[id],
    });
    expect(t.courses[0].needsReview).toMatch(/does not match MATH 51/);
    const u = parseTranscriptText("Fall 2025\nMATH S1    Calculus I    4    B    12", { knownCourseIds: KNOWN, ocr: true, titleOf: (id) => TITLES[id] });
    expect(u.courses[0]).toMatchObject({ course: "MATH 51" });
  });
  it("repairs a term heading with one letter off", () => {
    const t = parseTranscriptText("Summer 2026\nMATH 54 (Session C)    Linear Algebra and Differential Equations    4    B    12\nEall 2026\nCOMPSCI 61B    Data Structures    4    —    —\nSprlng 2027\nCOGSCI 131    Computational Models of Cognition    3    —    —", {
      knownCourseIds: KNOWN,
      ocr: true,
    });
    expect(t.terms).toEqual(["2026 Summer", "2026 Fall", "2027 Spring"]);
    expect(t.inProgress.map((c) => c.term)).toEqual(["2026 Fall", "2027 Spring"]);
  });
  it("never drops a row it cannot read", () => {
    const t = parseTranscriptText("Fall 2025\nC0G5CI ??    Introduction to Cognitive Science    4    B+    13.2\nDATA C8    Foundations of Data Science    4    A-    14.8", {
      knownCourseIds: KNOWN,
      ocr: true,
    });
    expect(ids(t)).toEqual(["DATA C8"]);
    expect(t.unreadLines).toHaveLength(1);
    expect(t.unreadLines[0]).toContain("Introduction to Cognitive Science");
  });
  it("does not use OCR repairs on real text", () => {
    const t = parseTranscriptText("Fall 2025\nMATH S5    Discrete Mathematics    4    B    12", { knownCourseIds: KNOWN });
    // kept exactly as printed and flagged, not silently turned into another class
    expect(t.courses).toMatchObject([{ course: "MATH S5", unknown: true }]);
  });
});

describe("Unofficial transcript: grades, repeats, odd numbers", () => {
  const text = `
Name:   Garcia-Lopez, Maria          Student ID:  3030000001
Test Credits
Test Credits Applied Toward Undergrad Engineering Program
Transferred to Term 2024 Fall as
AP CALCULUS BC    5    5.30
Test Trans GPA: 0.000 Transfer Totals: 5.30 5.30 0.000
Transfer Credits
Transfer Credit from De Anza College
Applied Toward Undergrad Engineering Program
Course Trans GPA: 0.000    Transfer Totals: 60.00 60.00 0.000
Beginning of Undergraduate Record
2024 Fall
Program: Undergrad Engineering
Plan: Mechanical Engineering BS
Course    Description    Attempted    Earned    Grade    Points
EL ENG 16A    DESIGNING INFO DEVICES & SYSTEMS I    4.00    4.00    B-    10.800
MEC ENG 40    THERMODYNAMICS    3.00    0.00    F    0.000
ETH STD 21AC    A COMPARATIVE SURVEY    4.00    4.00    A-    14.800
COMPSCI 24    FRESHMAN SEMINARS    1.00    1.00    P    0.000
ENGIN 98    DIRECTED GROUP STUDY    1.00    1.00    P    0.000
    Attempted    Earned    GPA Units    Points
Term GPA    2.933    Term Totals    13.00    10.00    25.600
2025 Summer
ENGLISH N1B    READING AND COMPOSITION    4.00    4.00    P    0.000
GWS W10    INTRO TO GENDER AND WOMENS STUDIES    4.00    4.00    A    16.000
2025 Fall
MEC ENG 40    THERMODYNAMICS    3.00    3.00    B    9.000
MCELLBI H196A    HONORS RESEARCH    2.00    2.00    A    8.000
PHILOS 25A    ANCIENT PHILOSOPHY    4.00    0.00    W    0.000
MEC ENG 132    DYNAMIC SYSTEMS AND FEEDBACK    3.00    0.00    I    0.000
CIV ENG 11    ENGINEERED SYSTEMS & SUSTAINABILITY    3.00    0.00    NP    0.000
DATA 100    PRINCIPLES & TECHNIQUES OF DATA SCIENCE    4.00    4.00    A-    14.800
THEATER 198    DIRECTED GROUP STUDY 2    1.00    1.00    P    0.000
2026 Fall
HISTORY 7B    US HIST: CIVIL WAR TO PRESENT    4.00    0.00        0.000
ESPM 50AC    INTRO TO CULTURE & NATURAL RESOURCE MGMT    4.00    0.00        0.000
2027 Spring
COMPSCI 189    INTRO TO MACHINE LEARNING    4.00    0.00        0.000
Cum GPA    3.100    Cum Totals    52.00    39.00    99.000
`;
  const r = parseTranscriptText(text, { knownCourseIds: KNOWN });

  it("keeps a title's trailing I and trailing number out of the grade and units", () => {
    expect(find(r, "ELENG 16A")).toMatchObject({ grade: "B-", units: 4, title: "DESIGNING INFO DEVICES & SYSTEMS I" });
    expect(find(r, "THEATER 198")).toMatchObject({ grade: "P", units: 1, title: "DIRECTED GROUP STUDY 2" });
    expect(find(r, "ENGIN 98")?.title).toBe("DIRECTED GROUP STUDY");
  });
  it("reads N, W, H prefixes and AC suffixes", () => {
    for (const id of ["ENGLISH N1B", "GWS W10", "MCELLBI H196A", "ETHSTD 21AC", "COMPSCI 24"]) expect(find(r, id), id).toBeDefined();
    expect(find(r, "ENGLISH N1B")?.term).toBe("2025 Summer");
  });
  it("does not count W, F, I or NP, and explains each", () => {
    expect(r.skipped.map((s) => [s.course, s.grade, s.retakenIn])).toEqual([
      ["MECENG 40", "F", "2025 Fall"],
      ["PHILOS 25A", "W", undefined],
      ["MECENG 132", "I", undefined],
      ["CIVENG 11", "NP", undefined],
    ]);
    expect(r.skipped.map((s) => s.reason)).toEqual(["Grade F, no credit", "Withdrawn (W), no credit", "Incomplete (I), not finished yet", "Not passed (NP), no credit"]);
    for (const id of ["PHILOS 25A", "MECENG 132", "CIVENG 11"]) expect(find(r, id)).toBeUndefined();
    expect(find(r, "MECENG 40")).toMatchObject({ grade: "B", term: "2025 Fall", units: 3 });
  });
  it("matches a dropped cross-listing C to the catalog, and keeps what the transcript said", () => {
    expect(find(r, "DATA C100")).toMatchObject({ printedAs: "DATA 100", grade: "A-" });
    expect(find(r, "DATA 100")).toBeUndefined();
  });
  it("keeps classes the catalog does not have, flagged", () => {
    expect(all(r).filter((c) => c.unknown).map((c) => c.course).sort()).toEqual(
      ["CIVENG 11", "COMPSCI 24", "ENGIN 98", "ENGLISH N1B", "GWS W10", "MCELLBI H196A", "MECENG 132", "MECENG 40", "MECENG 40", "PHILOS 25A", "THEATER 198"].sort(),
    );
    expect(find(r, "COMPSCI 24")).toMatchObject({ unknown: true, units: 1, grade: "P" });
  });
  it("puts both the current term and the next one in progress", () => {
    expect(ipIds(r)).toEqual(["COMPSCI 189", "ESPM 50AC", "HISTORY 7B"]);
    expect(r.inProgress.find((c) => c.course === "COMPSCI 189")?.term).toBe("2027 Spring");
  });
  it("reports transfer units that come without a class list", () => {
    expect(r.transferUnits).toBe(60);
    expect(r.warnings.some((w) => /60 transfer units/.test(w))).toBe(true);
  });
  it("has no em dashes in what the student reads", () => {
    for (const w of [...r.warnings, ...r.skipped.map((s) => s.reason)]) expect(w).not.toMatch(/[–—]/);
  });
});

describe("rows that arrive broken", () => {
  it("splits two classes that share a line (two-column page read straight across)", () => {
    const r = parseTranscriptText(
      "2025 Fall\nXMATH 1A    CALCULUS    4.00    4.00    A    16.000    ECON 141    ECONOMETRICS: MATH    4.00    4.00    B+    13.200\nL & S C70T    TIME    3.00    3.00    P    0.000",
    );
    expect(ids(r)).toEqual(["ECON 141", "LS C70T", "XMATH 1A"]);
    expect(find(r, "XMATH 1A")).toMatchObject({ grade: "A", title: "CALCULUS" });
    expect(find(r, "ECON 141")).toMatchObject({ grade: "B+", units: 4 });
  });
  it("joins a class number that wrapped under its subject", () => {
    const r = parseTranscriptText("2025 Fall\nCOMPSCI    STRUCTURE INTERPRET    4.00    4.00    A-    14.800\n61A    COMP PROG\nPB HLTH    INTRO TO EPIDEMIOLOGY    4.00    4.00    A    16.000\n150A");
    expect(ids(r)).toEqual(["COMPSCI 61A", "PBHLTH 150A"]);
    expect(find(r, "COMPSCI 61A")).toMatchObject({ grade: "A-", units: 4 });
  });
  it("joins a grade typed on the line after its class", () => {
    const r = parseTranscriptText("cs 61a\nA\ndata 100\nB+\nmath1b\nstat 20");
    expect(r.courses.map((c) => [c.course, c.grade])).toEqual([["COMPSCI 61A", "A"], ["DATA 100", "B+"], ["MATH 1B", undefined], ["STAT 20", undefined]]);
  });
  it("does not read a bare title letter as a grade", () => {
    const r = parseTranscriptText("EL ENG 16A Designing Information Devices and Systems I\nNUSCTX 10 Vitamin D");
    expect(r.skipped).toEqual([]);
    expect(r.courses.map((c) => c.grade)).toEqual([undefined, undefined]);
    expect(parseTranscriptText("CS 61B - A").courses[0].grade).toBe("A");
    expect(parseTranscriptText("CS 61B (W)").skipped[0]).toMatchObject({ course: "COMPSCI 61B", grade: "W" });
  });
});

describe("rows with no grade, by term", () => {
  const list = "Fall 2025\nCS 61A\nMATH 1B\nFall 2026\nCS 61B\nDATA C100\nSpring 2027\nCOGSCI 131";
  const r = parseTranscriptText(list, { currentTerm: "2026 Fall" });
  it("past term: taken as completed, and marked as an assumption", () => {
    expect(r.courses.map((c) => [c.course, c.term, c.assumedDone])).toEqual([["COMPSCI 61A", "2025 Fall", true], ["MATH 1B", "2025 Fall", true]]);
  });
  it("current term: in progress; later term: planned (both in inProgress, told apart by term)", () => {
    expect(r.inProgress.map((c) => [c.course, c.term])).toEqual([["COMPSCI 61B", "2026 Fall"], ["DATA C100", "2026 Fall"], ["COGSCI 131", "2027 Spring"]]);
    expect(r.currentTerm).toBe("2026 Fall");
  });
  it("a graded row is never an assumption", () => {
    const g = parseTranscriptText("Fall 2025\nCS 61A A-", { currentTerm: "2026 Fall" });
    expect(g.courses[0]).toMatchObject({ grade: "A-" });
    expect(g.courses[0].assumedDone).toBeUndefined();
  });
  it("no term at all: completed, as typed", () => {
    expect(parseTranscriptText("cs 61a\nmath 1b").courses.map((c) => c.assumedDone)).toEqual([undefined, undefined]);
  });
});

describe("several classes on one line", () => {
  const codes = (t: string, o = {}) => all(parseTranscriptText(t, { currentTerm: "2026 Fall", ...o })).map((c) => `${c.course}${c.term ? "@" + c.term : ""}${c.grade ? ":" + c.grade : ""}`);
  it("splits on commas, semicolons, slashes and 'and'", () => {
    expect(codes("CHEM 3A, CHEM 3AL, MATH 10B")).toEqual(["CHEM 3A", "CHEM 3AL", "MATH 10B"]);
    expect(codes("cs 61a; data c8 / math1b and english r1a")).toEqual(["COMPSCI 61A", "DATA C8", "MATH 1B", "ENGLISH R1A"]);
  });
  it("takes a term in front of the list", () => {
    expect(codes("Fall 2024: CS 61A, MATH 1B, RHETOR R1A\nSpring 2025 - CS 61B, CS 70")).toEqual([
      "COMPSCI 61A@2024 Fall", "MATH 1B@2024 Fall", "RHETOR R1A@2024 Fall", "COMPSCI 61B@2025 Spring", "COMPSCI 70@2025 Spring",
    ]);
    expect(codes("Fall 2025: CS 61A")).toEqual(["COMPSCI 61A@2025 Fall"]);
  });
  it("carries the subject and keeps grades", () => {
    expect(codes("CS 61A A-, 61B B+, 70")).toEqual(["COMPSCI 61A:A-", "COMPSCI 61B:B+", "COMPSCI 70"]);
  });
  it("leaves titles with commas alone", () => {
    const r = parseTranscriptText("PHILOS 3    Mind, Brain, and Identity    3    A    12\nMATH 10A  METHODS OF MATH: CALC, STATS & COMBINATORICS  4.00  4.00  B  12.000");
    expect(r.courses.map((c) => [c.course, c.title])).toEqual([["PHILOS 3", "Mind, Brain, and Identity"], ["MATH 10A", "METHODS OF MATH: CALC, STATS & COMBINATORICS"]]);
  });
});

describe("credit from other schools and tests", () => {
  it("keeps a community college number as transfer credit, as printed and flagged", () => {
    const r = parseTranscriptText("Fall 2024\nSTAT C1000    INTRODUCTION TO STATISTICS    4.00    4.00    A    16.000\nENGL C1001    CRITICAL THINKING AND WRITING    3    B+\nMATH 1B    CALCULUS    4.00    4.00    B    12.000", { knownCourseIds: KNOWN });
    expect(r.unreadLines).toEqual([]);
    expect(r.courses.map((c) => [c.course, c.source, c.units, c.title, !!c.unknown])).toEqual([
      ["STAT C1000", "transfer", 4, "INTRODUCTION TO STATISTICS", true],
      ["ENGL C1001", "transfer", 3, "CRITICAL THINKING AND WRITING", true],
      ["MATH 1B", "transcript", 4, "CALCULUS", false],
    ]);
    expect(r.courses[0].needsReview).toMatch(/Not a Berkeley class number/);
  });
  it("keeps odd rows inside a Transfer Credit block too", () => {
    const r = parseTranscriptText("Transfer Credits\nTransfer Credit from De Anza College\nCIS 22A    BEGINNING PROGRAMMING    4.50    4.50    A    0.000\nE WRIT 1A    COMPOSITION AND READING    5.00    5.00    A    0.000", { knownCourseIds: KNOWN });
    expect(r.courses.map((c) => [c.course, c.source, c.units])).toEqual([["CIS 22A", "transfer", 4.5], ["E WRIT 1A", "transfer", 5]]);
  });
  it("gives AP and IB rows units", () => {
    const r = parseTranscriptText("AP Calculus BC 5\nAP Psychology 4\nAP Chemistry 5 5.30\nAP Statistics 2");
    expect(r.courses.map((c) => [c.course, c.units])).toEqual([["MATH 1A", 2.65], ["MATH 1B", 2.65], ["AP PSYCHOLOGY", 2.7], ["AP CHEMISTRY", 5.3], ["AP STATISTICS", undefined]]);
  });
});

describe("OCR confidence and the catalog title", () => {
  const line = "COGSCI 1    Introduction to Cognitive Science    4    B+    13.2";
  const conf = new Map([[line, 38]]);
  it("does not flag a shaky row whose class and title both match the catalog", () => {
    const r = parseTranscriptText(`Fall 2025\n${line}`, { knownCourseIds: KNOWN, ocr: true, lineConfidence: conf, titleOf: (id) => TITLES[id] });
    expect(r.courses[0]).toMatchObject({ course: "COGSCI 1", grade: "B+" });
    expect(r.courses[0].needsReview).toBeUndefined();
  });
  it("still flags it when there is no catalog title to confirm it", () => {
    const r = parseTranscriptText(`Fall 2025\n${line}`, { knownCourseIds: KNOWN, ocr: true, lineConfidence: conf });
    expect(r.courses[0].needsReview).toMatch(/hard to read/);
  });
});
