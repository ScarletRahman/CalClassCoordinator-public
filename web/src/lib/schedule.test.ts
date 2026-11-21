import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/schedule-2027-spring.json";
import {
  autoPick,
  blockLabel,
  blocksFor,
  componentName,
  componentsOf,
  conflictPairCount,
  conflictsWith,
  daysLabel,
  describeConflicts,
  findConflicts,
  formatRange,
  formatTime,
  hourLabel,
  layoutDay,
  meetingsLabel,
  missingComponents,
  resolveSelection,
  seatLabel,
  seatRank,
  sectionBlocks,
  sectionSortKey,
  selectionNumbers,
  toMinutes,
  untimedSections,
  type Block,
  type CourseChoice,
  type ScheduleClass,
  type ScheduleSection,
  type ScheduleTermFile,
} from "./schedule";

const file = fixture as unknown as ScheduleTermFile;
const cs61a = file.courses["COMPSCI 61A"];
const math53 = file.courses["MATH 53"];

let nextNumber = 10000;
function sec(section: string, days: number[] | null, start = "10:00", end = "10:59", extra: Partial<ScheduleSection> = {}): ScheduleSection {
  return {
    classNumber: String(nextNumber++),
    section,
    component: section.split(" ")[1],
    meetings: days ? [{ days, start, end, location: "Room 1" }] : [],
    ...extra,
  };
}
function cls(primary: ScheduleSection, sections: ScheduleSection[] = []): ScheduleClass {
  return { number: primary.section.split(" ")[0], primary, sections };
}
const block = (course: string, section: string, day: number, startMin: number, endMin: number): Block => ({
  course,
  section,
  component: section.split(" ")[1],
  classNumber: `${course}-${section}`,
  day,
  startMin,
  endMin,
});

describe("time helpers", () => {
  it("parses HH:MM", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("13:05")).toBe(785);
    expect(toMinutes("9:30")).toBe(570);
    expect(toMinutes("nope")).toBeNaN();
    expect(toMinutes("25:00")).toBeNaN();
  });
  it("formats 12-hour labels", () => {
    expect(formatTime(0)).toBe("12:00 AM");
    expect(formatTime(780)).toBe("1:00 PM");
    expect(formatTime(720)).toBe("12:00 PM");
    expect(formatTime(599)).toBe("9:59 AM");
    expect(formatTime(780, false)).toBe("1:00");
    expect(hourLabel(8)).toBe("8 AM");
    expect(hourLabel(12)).toBe("12 PM");
    expect(hourLabel(18)).toBe("6 PM");
  });
  it("formats ranges, repeating AM/PM only when it changes", () => {
    expect(formatRange(840, 930)).toBe("2:00-3:30 PM");
    expect(formatRange(660, 779)).toBe("11:00 AM-12:59 PM");
    expect(formatRange(780, 839, " to ")).toBe("1:00 to 1:59 PM");
  });
  it("labels days", () => {
    expect(daysLabel([0])).toBe("Mon");
    expect(daysLabel([4, 0, 2])).toBe("MWF");
    expect(daysLabel([1, 3])).toBe("TuTh");
    expect(daysLabel([])).toBe("");
  });
  it("labels meetings and sections with no time", () => {
    expect(meetingsLabel(sec("101 DIS", [0], "14:00", "15:30"))).toBe("Mon 2:00-3:30 PM");
    expect(meetingsLabel(sec("101 DIS", null))).toBe("No set time");
    // 00:00 to 00:00 is how "to be announced" sometimes arrives
    expect(meetingsLabel(sec("101 DIS", [0], "00:00", "00:00"))).toBe("No set time");
    expect(componentName("DIS")).toBe("discussion");
    expect(componentName("XYZ")).toBe("XYZ");
  });
  it("sorts by day then time, untimed last", () => {
    const a = sec("101 DIS", [2], "09:00", "09:59");
    const b = sec("102 DIS", [0], "17:00", "17:59");
    const c = sec("103 DIS", null);
    const d = sec("104 DIS", [0], "08:00", "08:59");
    expect([a, b, c, d].sort((x, y) => sectionSortKey(x) - sectionSortKey(y)).map((s) => s.section)).toEqual(["104 DIS", "102 DIS", "101 DIS", "103 DIS"]);
  });
});

describe("componentsOf", () => {
  it("lists secondary kinds in a stable order", () => {
    expect(componentsOf(cs61a[0])).toEqual(["DIS", "LAB"]);
    const c = cls(sec("001 LEC", [0]), [sec("201 LAB", [1]), sec("301 ZZZ", [1]), sec("101 DIS", [2]), sec("202 LAB", [3])]);
    expect(componentsOf(c)).toEqual(["DIS", "LAB", "ZZZ"]);
    expect(componentsOf(cls(sec("001 LEC", [0])))).toEqual([]);
  });
});

describe("resolveSelection", () => {
  it("auto-picks the only class and leaves multi-option components open", () => {
    const r = resolveSelection(cs61a, undefined);
    expect(r.primary?.classNumber).toBe(cs61a[0].primary.classNumber);
    expect(r.picks).toEqual({ DIS: undefined, LAB: undefined });
    expect(missingComponents(r)).toEqual(["DIS", "LAB"]);
    expect(selectionNumbers(r)).toEqual([cs61a[0].primary.classNumber]);
  });
  it("uses the chosen primary and sections", () => {
    const k = math53[1];
    const dis = k.sections[3];
    const r = resolveSelection(math53, [dis.classNumber, k.primary.classNumber]);
    expect(r.cls).toBe(k);
    expect(r.picks.DIS).toBe(dis);
    expect(missingComponents(r)).toEqual([]);
    expect(selectionNumbers(r)).toEqual([k.primary.classNumber, dis.classNumber]);
  });
  it("leaves the primary undefined when several classes exist and nothing valid is chosen", () => {
    expect(resolveSelection(math53, undefined)).toEqual({ picks: {} });
    expect(resolveSelection(math53, ["99999"])).toEqual({ picks: {} });
    expect(resolveSelection([], ["1"])).toEqual({ picks: {} });
  });
  it("ignores stale numbers and sections of another lecture", () => {
    const other = math53[0].sections[0];
    const r = resolveSelection(math53, [math53[1].primary.classNumber, other.classNumber, "00000"]);
    expect(r.cls).toBe(math53[1]);
    expect(r.picks.DIS).toBeUndefined();
    const single = resolveSelection(cs61a, ["00000"]);
    expect(single.cls).toBe(cs61a[0]);
  });
  it("auto-picks a component with exactly one option", () => {
    const only = sec("101 DIS", [1]);
    const c = cls(sec("001 LEC", [0]), [only, sec("201 LAB", [2]), sec("202 LAB", [3])]);
    const r = resolveSelection([c], []);
    expect(r.picks.DIS).toBe(only);
    expect(r.picks.LAB).toBeUndefined();
    expect(selectionNumbers(r)).toEqual([c.primary.classNumber, only.classNumber]);
  });
});

describe("blocksFor", () => {
  it("makes one block per meeting day for the chosen sections only", () => {
    const k = cs61a[0];
    const dis = k.sections.find((s) => s.component === "DIS")!;
    const blocks = blocksFor([{ course: "COMPSCI 61A", classes: cs61a, chosen: [k.primary.classNumber, dis.classNumber] }]);
    expect(blocks.filter((b) => b.component === "LEC").map((b) => b.day)).toEqual([0, 2, 4]);
    expect(blocks.filter((b) => b.component === "DIS")).toHaveLength(dis.meetings[0].days.length);
    expect(blocks.some((b) => b.component === "LAB")).toBe(false);
    expect(blocks[0]).toMatchObject({ course: "COMPSCI 61A", section: "001 LEC", classNumber: k.primary.classNumber, startMin: 780, endMin: 839, location: "Dwinelle 155" });
  });
  it("draws nothing for a course with no chosen lecture, and skips untimed sections", () => {
    expect(blocksFor([{ course: "MATH 53", classes: math53 }])).toEqual([]);
    const c = cls(sec("001 IND", null));
    const choice: CourseChoice = { course: "X 199", classes: [c] };
    expect(blocksFor([choice])).toEqual([]);
    expect(untimedSections([choice])).toEqual([{ course: "X 199", section: c.primary }]);
  });
});

describe("findConflicts", () => {
  it("finds overlaps on the same day only", () => {
    const a = block("A 1", "001 LEC", 0, 600, 659);
    const b = block("B 1", "001 LEC", 0, 630, 700);
    const c = block("C 1", "001 LEC", 1, 630, 700);
    const found = findConflicts([a, b, c]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ day: 0, startMin: 630, endMin: 659 });
    expect([found[0].a.course, found[0].b.course]).toEqual(["A 1", "B 1"]);
  });
  it("does not count touching ends", () => {
    expect(findConflicts([block("A 1", "001 LEC", 0, 780, 839), block("B 1", "001 LEC", 0, 840, 900)])).toEqual([]);
    expect(findConflicts([block("A 1", "001 LEC", 0, 780, 840), block("B 1", "001 LEC", 0, 840, 900)])).toEqual([]);
  });
  it("ignores overlapping meetings of one section but not two sections of one course", () => {
    const lec = block("A 1", "001 LEC", 0, 600, 700);
    expect(findConflicts([lec, { ...lec, startMin: 650, endMin: 720 }])).toEqual([]);
    expect(findConflicts([lec, block("A 1", "101 DIS", 0, 650, 720)])).toHaveLength(1);
  });
  it("finds a pair that is not adjacent after sorting", () => {
    const long = block("A 1", "001 LEC", 0, 540, 720);
    const mid = block("B 1", "001 LEC", 0, 560, 600);
    const late = block("C 1", "001 LEC", 0, 660, 700);
    expect(findConflicts([late, mid, long])).toHaveLength(2);
  });
  it("sees the real COMPSCI 61A and MATH 53 lecture clash, and describes it in words", () => {
    const courses: CourseChoice[] = [
      { course: "COMPSCI 61A", classes: cs61a },
      { course: "MATH 53", classes: math53, chosen: [math53[1].primary.classNumber] },
    ];
    const conflicts = findConflicts(blocksFor(courses));
    expect(conflicts.map((c) => c.day)).toEqual([0, 2, 4]);
    expect(conflictPairCount(conflicts)).toBe(1);
    expect(describeConflicts(conflicts)).toEqual(["COMPSCI 61A lecture overlaps MATH 53 lecture on Monday, Wednesday and Friday 1:00 to 1:59 PM"]);
    const clean = findConflicts(blocksFor([courses[0], { ...courses[1], chosen: [math53[0].primary.classNumber] }]));
    expect(clean).toEqual([]);
  });
});

describe("conflictsWith", () => {
  it("names each clashing section once", () => {
    const others = blocksFor([{ course: "MATH 53", classes: math53, chosen: [math53[1].primary.classNumber] }]);
    const hits = conflictsWith(cs61a[0].primary, others);
    expect(hits).toHaveLength(1);
    expect(blockLabel(hits[0])).toBe("MATH 53 LEC");
  });
  it("is empty for touching times and sections with no time", () => {
    const others = [block("A 1", "001 LEC", 0, 780, 839)];
    expect(conflictsWith(sec("101 DIS", [0], "14:00", "14:59"), others)).toEqual([]);
    expect(conflictsWith(sec("101 DIS", [0], "13:59", "14:59"), others)).toEqual([]);
    expect(conflictsWith(sec("101 DIS", [0], "13:30", "14:59"), others)).toHaveLength(1);
    expect(conflictsWith(sec("101 DIS", null), others)).toEqual([]);
  });
});

describe("layoutDay", () => {
  it("keeps separate blocks full width", () => {
    const placed = layoutDay([{ startMin: 600, endMin: 660 }, { startMin: 660, endMin: 720 }]);
    expect(placed.map((p) => [p.col, p.cols])).toEqual([[0, 1], [0, 1]]);
  });
  it("puts overlapping blocks side by side", () => {
    const placed = layoutDay([{ startMin: 600, endMin: 700 }, { startMin: 630, endMin: 690 }]);
    expect(placed.map((p) => [p.col, p.cols])).toEqual([[0, 2], [1, 2]]);
  });
  it("reuses a column inside a chain and sizes the whole cluster alike", () => {
    const a = { id: "a", startMin: 600, endMin: 700 };
    const b = { id: "b", startMin: 630, endMin: 660 };
    const c = { id: "c", startMin: 660, endMin: 720 };
    const d = { id: "d", startMin: 800, endMin: 860 };
    const placed = Object.fromEntries(layoutDay([d, c, b, a]).map((p) => [p.block.id, [p.col, p.cols]]));
    expect(placed).toEqual({ a: [0, 2], b: [1, 2], c: [1, 2], d: [0, 1] });
  });
  it("handles three at once", () => {
    const placed = layoutDay([{ startMin: 600, endMin: 700 }, { startMin: 600, endMin: 700 }, { startMin: 610, endMin: 650 }]);
    expect(placed.map((p) => p.col).sort()).toEqual([0, 1, 2]);
    expect(placed.every((p) => p.cols === 3)).toBe(true);
  });
});

describe("seatLabel", () => {
  const seats = (o: Partial<ScheduleSection>) => seatLabel({ ...sec("101 DIS", [0]), ...o });
  it("shows open seats", () => {
    expect(seats({ enrolled: 332, capacity: 600, open: 173 })).toEqual({ text: "173 open", tone: "open" });
    expect(seats({ enrolled: 10, capacity: 24 })).toEqual({ text: "14 open", tone: "open" });
    expect(seatLabel(cs61a[0].primary)).toEqual({ text: "173 open", tone: "open" });
  });
  it("says when only reserved seats are left", () => {
    expect(seats({ enrolled: 359, capacity: 540, open: 0 })).toEqual({ text: "Reserved seats only", tone: "reserved" });
    expect(seatLabel(file.courses["COMPSCI 70"][0].primary)?.tone).toBe("reserved");
  });
  it("shows waitlist space, then full", () => {
    expect(seats({ enrolled: 400, capacity: 400, open: 0, waitlisted: 12, waitlistCapacity: 300 })).toEqual({ text: "Waitlist 12 of 300", tone: "waitlist" });
    expect(seats({ enrolled: 400, capacity: 400, open: 0, waitlisted: 300, waitlistCapacity: 300 })).toEqual({ text: "Full", tone: "full" });
    expect(seats({ enrolled: 30, capacity: 30 })).toEqual({ text: "Full", tone: "full" });
    expect(seats({ enrolled: 0, capacity: 0, status: "closed" })).toEqual({ text: "Closed", tone: "full" });
  });
  it("is null when counts are unknown", () => {
    expect(seats({})).toBeNull();
    expect(seats({ capacity: 30 })).toBeNull();
    expect(seatRank(sec("101 DIS", [0]))).toBe(1);
  });
});

describe("autoPick", () => {
  const open = { enrolled: 0, capacity: 10, open: 10 };
  const waitlist = { enrolled: 10, capacity: 10, open: 0, waitlisted: 1, waitlistCapacity: 5 };
  const full = { enrolled: 10, capacity: 10, open: 0, waitlisted: 5, waitlistCapacity: 5 };

  it("fills every component of the real 61A + MATH 53 pair without clashes", () => {
    const courses: CourseChoice[] = [
      { course: "COMPSCI 61A", classes: cs61a },
      { course: "MATH 53", classes: math53 },
    ];
    const r = autoPick(courses);
    expect(r.conflicts).toEqual([]);
    expect(r.capped).toBe(false);
    expect(r.selections["COMPSCI 61A"]).toHaveLength(3);
    expect(r.selections["MATH 53"]).toHaveLength(2);
    for (const c of courses) {
      const res = resolveSelection(c.classes, r.selections[c.course]);
      expect(res.primary).toBeDefined();
      expect(missingComponents(res)).toEqual([]);
    }
    // 61A's lecture sits on top of MATH 53 lecture 002, so lecture 001 it is.
    expect(r.selections["MATH 53"][0]).toBe(math53[0].primary.classNumber);
  });

  it("handles a full real term's worth of classes", () => {
    const ids = ["COMPSCI 61A", "MATH 54", "DATA C8", "ENGLISH R1A", "COMPSCI 70"];
    const courses = ids.map((course) => ({ course, classes: file.courses[course] }));
    const r = autoPick(courses);
    expect(Object.keys(r.selections).sort()).toEqual([...ids].sort());
    expect(findConflicts(blocksFor(courses.map((c) => ({ ...c, chosen: r.selections[c.course] }))))).toEqual(r.conflicts);
    expect(r.nodes).toBeLessThanOrEqual(20_001);
  });

  it("prefers open seats, then waitlist space", () => {
    const a = cls(sec("001 LEC", [0], "09:00", "09:59", open), [
      sec("101 DIS", [1], "09:00", "09:59", full),
      sec("102 DIS", [1], "10:00", "10:59", waitlist),
      sec("103 DIS", [1], "11:00", "11:59", open),
    ]);
    expect(autoPick([{ course: "A 1", classes: [a] }]).selections["A 1"]).toEqual([a.primary.classNumber, a.sections[2].classNumber]);
    // The open one clashes with another class, so the waitlisted one wins over a conflict.
    const b = cls(sec("001 LEC", [1], "11:00", "11:59", open));
    const r = autoPick([
      { course: "A 1", classes: [a] },
      { course: "B 1", classes: [b] },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.selections["A 1"][1]).toBe(a.sections[1].classNumber);
  });

  it("keeps current picks when they are as good as any other", () => {
    const a = cls(sec("001 LEC", [0], "09:00", "09:59", open), [
      sec("101 DIS", [1], "09:00", "09:59", open),
      sec("102 DIS", [1], "10:00", "10:59", open),
      sec("103 DIS", [1], "11:00", "11:59", open),
    ]);
    const chosen = [a.primary.classNumber, a.sections[2].classNumber];
    expect(autoPick([{ course: "A 1", classes: [a], chosen }]).selections["A 1"]).toEqual(chosen);
  });

  it("never swaps a locked section, even when that leaves a clash", () => {
    const a1 = cls(sec("001 LEC", [0], "09:00", "09:59", open));
    const a2 = cls(sec("002 LEC", [0], "11:00", "11:59", open));
    const b = cls(sec("001 LEC", [0], "09:00", "09:59", open));
    const courses: CourseChoice[] = [
      { course: "A 1", classes: [a1, a2], chosen: [a1.primary.classNumber] },
      { course: "B 1", classes: [b] },
    ];
    expect(autoPick(courses).selections["A 1"]).toEqual([a2.primary.classNumber]);
    const locked = autoPick(courses, { "A 1": [a1.primary.classNumber] });
    expect(locked.selections["A 1"]).toEqual([a1.primary.classNumber]);
    expect(locked.conflicts).toHaveLength(1);
  });

  it("honours a locked discussion and still moves the rest", () => {
    const a = cls(sec("001 LEC", [0], "09:00", "09:59", open), [sec("101 DIS", [1], "09:00", "09:59", full), sec("102 DIS", [1], "10:00", "10:59", open)]);
    const b1 = cls(sec("001 LEC", [1], "09:00", "09:59", open));
    const b2 = cls(sec("002 LEC", [1], "13:00", "13:59", waitlist));
    const r = autoPick(
      [
        { course: "A 1", classes: [a] },
        { course: "B 1", classes: [b1, b2] },
      ],
      { "A 1": [a.sections[0].classNumber] },
    );
    expect(r.selections["A 1"]).toEqual([a.primary.classNumber, a.sections[0].classNumber]);
    expect(r.selections["B 1"]).toEqual([b2.primary.classNumber]);
    expect(r.conflicts).toEqual([]);
  });

  it("returns the best attempt and the remaining clashes when nothing fits", () => {
    const a = cls(sec("001 LEC", [0, 2], "09:00", "09:59"));
    const b = cls(sec("001 LEC", [0, 2], "09:30", "10:29"));
    const c = cls(sec("001 LEC", [1], "09:00", "09:59"), [sec("101 DIS", [3], "09:00", "09:59"), sec("102 DIS", [0], "09:00", "09:59")]);
    const r = autoPick([
      { course: "A 1", classes: [a] },
      { course: "B 1", classes: [b] },
      { course: "C 1", classes: [c] },
    ]);
    expect(conflictPairCount(r.conflicts)).toBe(1);
    expect(describeConflicts(r.conflicts)).toEqual(["A 1 lecture overlaps B 1 lecture on Monday and Wednesday 9:30 to 9:59 AM"]);
    expect(r.selections["C 1"]).toEqual([c.primary.classNumber, c.sections[0].classNumber]);
    expect(r.capped).toBe(false);
  });

  it("never treats sections without meetings as clashing, and skips courses with no classes", () => {
    const a = cls(sec("001 IND", null), [sec("101 DIS", null), sec("102 DIS", null)]);
    const b = cls(sec("001 IND", null));
    const r = autoPick([
      { course: "A 199", classes: [a] },
      { course: "B 199", classes: [b] },
      { course: "C 1", classes: [] },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(Object.keys(r.selections).sort()).toEqual(["A 199", "B 199"]);
    expect(r.selections["A 199"]).toHaveLength(2);
  });

  it("stops at the node cap and still answers", () => {
    // Six classes that all meet at the same time, 12 identical sections each: no clean answer.
    const courses: CourseChoice[] = Array.from({ length: 6 }, (_, i) => ({
      course: `X ${i}`,
      classes: [cls(sec("001 LEC", [0], "09:00", "09:59"), Array.from({ length: 12 }, (_, j) => sec(`${101 + j} DIS`, [1], "09:00", "09:59")))],
    }));
    const r = autoPick(courses, {}, 500);
    expect(r.capped).toBe(true);
    expect(r.nodes).toBeLessThanOrEqual(501);
    expect(Object.keys(r.selections)).toHaveLength(6);
    expect(r.conflicts.length).toBeGreaterThan(0);
    for (const c of courses) expect(r.selections[c.course]).toHaveLength(2);
  });

  it("makes blocks for exactly what it picked", () => {
    const r = autoPick([{ course: "COMPSCI 61A", classes: cs61a }]);
    const picked = new Set(r.selections["COMPSCI 61A"]);
    const all = [cs61a[0].primary, ...cs61a[0].sections].filter((s) => picked.has(s.classNumber));
    expect(all.flatMap((s) => sectionBlocks("COMPSCI 61A", s))).toHaveLength(blocksFor([{ course: "COMPSCI 61A", classes: cs61a, chosen: [...picked] }]).length);
  });
});
