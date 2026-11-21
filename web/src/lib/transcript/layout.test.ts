import { describe, it, expect } from "vitest";
import { findColumnSplit, pageLayout, pageLines, type TextItem } from "./layout";

/** One text item per cell, like pdf.js gives for a table. */
const cell = (str: string, x: number, y: number, conf?: number): TextItem => ({ str, x, y, w: str.length * 5, h: 10, ...(conf !== undefined ? { conf } : {}) });
const row = (y: number, cells: [string, number][], dx = 0) => cells.map(([s, x]) => cell(s, x + dx, y));
const HEAD: [string, number][] = [["Class", 50], ["Title", 170], ["Un.", 440], ["Gr.", 495], ["Pts.", 540]];

describe("pageLines", () => {
  it("keeps table cells apart and rows in order", () => {
    const items = [...row(700, HEAD), ...row(685, [["COGSCI 1", 50], ["Introduction to Cognitive Science", 170], ["4", 446], ["A", 498], ["16", 541]]), cell("Fall 2025", 50, 730)];
    expect(pageLines(items)).toEqual(["Fall 2025", "Class    Title    Un.    Gr.    Pts.", "COGSCI 1    Introduction to Cognitive Science    4    A    16"]);
  });
  it("puts a wrapped class cell and a wrapped title back on their row", () => {
    const items = [
      ...row(700, HEAD),
      ...row(685, [["COMLIT R1B (Session", 50], ["English Composition in Connection with the Reading of", 170], ["4", 446], ["A-", 498], ["14.8", 545]]),
      ...row(670, [["D)", 50], ["World Literature", 170]]),
      ...row(655, [["MATH 54 (Session C)", 50], ["Linear Algebra and Differential Equations", 170], ["4", 446], ["A", 498], ["16", 545]]),
      cell("Fall 2026", 50, 600),
    ];
    expect(pageLines(items)).toEqual([
      "Class    Title    Un.    Gr.    Pts.",
      "COMLIT R1B (Session D)    English Composition in Connection with the Reading of World Literature    4    A-    14.8",
      "MATH 54 (Session C)    Linear Algebra and Differential Equations    4    A    16",
      "Fall 2026",
    ]);
  });
  it("separates the class from the title even when OCR words nearly touch", () => {
    const words = [...row(700, HEAD), cell("PBHLTH", 50, 685), cell("126", 92, 685), cell("(Session", 112, 685), cell("Health", 170, 685), cell("Economics", 204, 685), cell("4", 446, 685), cell("A", 498, 685), cell("16", 545, 685), cell("A)", 50, 671)];
    expect(pageLines(words)[1]).toBe("PBHLTH 126 (Session A)    Health Economics    4    A    16");
  });
  it("does not fold a heading or a full-width line into the row above", () => {
    const items = [
      ...row(700, [["Course", 50], ["Description", 150], ["Attempted", 400], ["Earned", 460], ["Grade", 510], ["Points", 550]]),
      ...row(686, [["STAT 20", 50], ["INTRO TO PROB & STATISTICS", 150], ["4.00", 410], ["4.00", 465], ["T", 512], ["0.000", 555]]),
      cell("Course Trans GPA: 0.000 Transfer Totals: 60.00 60.00 0.000", 50, 672),
      cell("2025 Fall", 50, 658),
    ];
    expect(pageLines(items).slice(1)).toEqual(["STAT 20    INTRO TO PROB & STATISTICS    4.00    4.00    T    0.000", "Course Trans GPA: 0.000 Transfer Totals: 60.00 60.00 0.000", "2025 Fall"]);
  });
  it("carries the columns onto the next page", () => {
    const state = {};
    pageLines(row(700, HEAD), state);
    const next = [...row(740, [["ECON 199", 50], ["Supervised Independent Study and", 170], ["3", 446], ["P", 498], ["0.0", 543]]), ...row(726, [["Research", 170]])];
    expect(pageLines(next, state)).toEqual(["ECON 199    Supervised Independent Study and Research    3    P    0.0"]);
  });
  it("reports the lowest confidence of the class and number cells", () => {
    const items = [...row(700, HEAD), cell("MATH", 50, 685, 96), cell("51", 80, 685, 52), cell("Calculus", 170, 685, 30), cell("4", 446, 685, 95), cell("B", 498, 685, 91), cell("12", 545, 685, 93)];
    expect(pageLayout(items)[1]).toEqual({ text: "MATH 51    Calculus    4    B    12", conf: 52 });
  });
});

describe("two-column pages", () => {
  const HEAD2: [string, number][] = [["Course", 40], ["Description", 110], ["Attempted", 230], ["Earned", 270], ["Grade", 300], ["Points", 330]];
  const body = (dx: number, term: string, rows: string[][]) => [
    cell(term, 40 + dx, 700),
    ...row(688, HEAD2, dx),
    ...rows.flatMap((r, i) => row(676 - i * 12, [[r[0], 40], [r[1], 110], [r[2], 236], [r[3], 274], [r[4], 302], [r[5], 334]], dx)),
  ];
  const left = body(0, "2025 Fall", [["COMPSCI 61A", "STRUCTURE INTERPRET", "4.00", "4.00", "A-", "14.800"], ["MATH 1B", "CALCULUS", "4.00", "4.00", "B+", "13.200"]]);
  const right = body(390, "2026 Spring", [["COMPSCI 61B", "DATA STRUCTURES", "4.00", "4.00", "B", "12.000"], ["PB HLTH 142", "INTRO TO PROB", "4.00", "4.00", "A", "16.000"]]);
  const filler = Array.from({ length: 6 }, (_, i) => cell("Program: Undergrad Letters", 40, 640 - i * 12));

  it("finds the gutter and reads the left column first", () => {
    const items = [...left, ...right, ...filler];
    expect(findColumnSplit(items)).not.toBeNull();
    const lines = pageLines(items);
    expect(lines.indexOf("2025 Fall")).toBeLessThan(lines.indexOf("2026 Spring"));
    expect(lines).toContain("COMPSCI 61B    DATA STRUCTURES    4.00    4.00    B    12.000");
    expect(lines.filter((l) => /61A.*61B/.test(l))).toEqual([]);
    expect(lines.indexOf("MATH 1B    CALCULUS    4.00    4.00    B+    13.200")).toBeLessThan(lines.indexOf("2026 Spring"));
  });
  it("leaves a single-column table alone", () => {
    expect(findColumnSplit([...left, ...filler, ...row(500, HEAD2), ...row(488, HEAD2)])).toBeNull();
  });
});
