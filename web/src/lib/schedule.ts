// Class times, section choices and the weekly calendar maths. Shapes mirror docs/schedule.md.
// Pure: no React, no node imports, so the browser and the tests share it.

import type { CourseId, ReservedSeats, Term } from "./types";

// ---- shapes (docs/schedule.md) ----

export interface Meeting {
  /** 0 = Monday ... 6 = Sunday */
  days: number[];
  /** "HH:MM", 24-hour, Pacific time */
  start: string;
  end: string;
  location?: string;
}

export interface ScheduleSection {
  classNumber: string;
  /** Number + component, e.g. "001 LEC". */
  section: string;
  component: string;
  instructor?: string;
  /** [] = no set time. */
  meetings: Meeting[];
  enrolled?: number;
  capacity?: number;
  waitlisted?: number;
  waitlistCapacity?: number;
  status?: "open" | "waitlist" | "closed" | string;
  /** Open seats that are not reserved for a group. */
  open?: number;
  reserved?: ReservedSeats[];
}

export interface ScheduleExam {
  type?: string;
  date?: string;
  start?: string;
  end?: string;
}

/** One primary section (usually the lecture) plus the discussions and labs that belong to it. */
export interface ScheduleClass {
  number: string;
  sessionId?: string;
  title?: string;
  units?: [number, number];
  exams?: ScheduleExam[];
  primary: ScheduleSection;
  sections: ScheduleSection[];
}

export interface ScheduleTermFile {
  term: Term;
  generatedAt: string;
  source?: string;
  classCount?: number;
  skipped?: number;
  failed?: number;
  courses: Record<CourseId, ScheduleClass[]>;
}

export interface ScheduleIndex {
  terms: { term: Term; file: string; generatedAt?: string; courses?: number; classes?: number }[];
}

/** Watcher API: GET /lookup */
export interface LookupResponse {
  course: CourseId;
  term: Term;
  source: string;
  fetchedAt: string;
  cached?: boolean;
  classes: ScheduleClass[];
}

/** Web app: GET /api/sections */
export interface SectionsResponse {
  course: CourseId;
  term: Term;
  /** The term the times really come from. */
  basisTerm: Term | null;
  /** True when basisTerm != term: times are from an earlier year and may change. */
  tentative: boolean;
  classes: ScheduleClass[];
  source: "file" | "berkeleytime" | "classes.berkeley.edu" | "none" | string;
  /** When the seat counts and times were read. */
  asOf: string | null;
  live: boolean;
  liveError?: string;
  publishedTerms: Term[];
}

// ---- time helpers ----

export const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const DAY_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const DAY_LETTER = ["M", "Tu", "W", "Th", "F", "Sa", "Su"] as const;

/** "13:05" -> 785. NaN when the text is not a time. */
export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return NaN;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 24 || min > 59) return NaN;
  return h * 60 + min;
}

/** 780 -> "1:00 PM"; with meridiem false -> "1:00". */
export function formatTime(minutes: number, meridiem = true): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const text = `${h12}:${String(m % 60).padStart(2, "0")}`;
  return meridiem ? `${text} ${h24 < 12 ? "AM" : "PM"}` : text;
}

/** 840, 930 -> "2:00-3:30 PM"; 660, 779 -> "11:00 AM-12:59 PM". */
export function formatRange(startMin: number, endMin: number, sep = "-"): string {
  const sameHalf = startMin < 720 === endMin < 720;
  return `${formatTime(startMin, !sameHalf)}${sep}${formatTime(endMin)}`;
}

/** 9 -> "9 AM", 12 -> "12 PM" (for the hour gutter). */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
}

/** [0] -> "Mon", [0, 2, 4] -> "MWF", [1, 3] -> "TuTh". */
export function daysLabel(days: number[]): string {
  const d = [...new Set(days)].filter((x) => x >= 0 && x <= 6).sort((a, b) => a - b);
  if (d.length === 0) return "";
  if (d.length === 1) return DAY_SHORT[d[0]];
  return d.map((x) => DAY_LETTER[x]).join("");
}

/** ["Monday", "Wednesday", "Friday"] -> "Monday, Wednesday and Friday" */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** A meeting counts as scheduled only when it has days and a real time range. */
export function isTimed(m: Meeting): boolean {
  const s = toMinutes(m.start);
  const e = toMinutes(m.end);
  return Array.isArray(m.days) && m.days.length > 0 && isFinite(s) && isFinite(e) && e > s;
}

export function timedMeetings(section: ScheduleSection): Meeting[] {
  return (section.meetings ?? []).filter(isTimed);
}

/** "MWF 1:00-1:59 PM", or "No set time". Several meeting patterns are joined with ", ". */
export function meetingsLabel(section: ScheduleSection): string {
  const timed = timedMeetings(section);
  if (!timed.length) return "No set time";
  return timed.map((m) => `${daysLabel(m.days)} ${formatRange(toMinutes(m.start), toMinutes(m.end))}`).join(", ");
}

export function locationsLabel(section: ScheduleSection): string {
  return [...new Set((section.meetings ?? []).map((m) => m.location?.trim()).filter((l): l is string => !!l))].join(", ");
}

/** Sort key: earliest day, then start time; sections without a time go last. */
export function sectionSortKey(section: ScheduleSection): number {
  let best = Infinity;
  for (const m of timedMeetings(section)) best = Math.min(best, Math.min(...m.days) * 1440 + toMinutes(m.start));
  return best;
}

/** "101 DIS" -> "101" */
export function sectionNumber(section: Pick<ScheduleSection, "section">): string {
  return section.section.split(" ")[0] ?? section.section;
}

// ---- components ----

const COMPONENT_ORDER = ["LEC", "SEM", "DIS", "LAB", "STD", "WOR", "WBD", "WBL", "REC", "CLN", "FLD", "GRP", "SUP", "IND", "TUT", "SLF"];

const COMPONENT_NAMES: Record<string, string> = {
  LEC: "lecture",
  DIS: "discussion",
  LAB: "lab",
  SEM: "seminar",
  STD: "studio",
  WOR: "workshop",
  WBD: "web discussion",
  WBL: "web lecture",
  REC: "recitation",
  CLN: "clinic",
  FLD: "field work",
  GRP: "group study",
  SUP: "supervised study",
  IND: "independent study",
  TUT: "tutorial",
  SLF: "self-paced section",
  COL: "colloquium",
  DEM: "demonstration",
  SES: "session",
  INT: "internship",
  PRA: "practicum",
  REA: "reading",
};

/** "DIS" -> "discussion". Unknown codes come back as they are. */
export function componentName(component: string): string {
  return COMPONENT_NAMES[component] ?? component;
}

function componentRank(c: string): number {
  const i = COMPONENT_ORDER.indexOf(c);
  return i < 0 ? COMPONENT_ORDER.length : i;
}

/** The kinds of secondary section a class needs one of each of, e.g. ["DIS", "LAB"], in a stable order. */
export function componentsOf(cls: ScheduleClass): string[] {
  const set = new Set((cls.sections ?? []).map((s) => s.component));
  return [...set].sort((a, b) => componentRank(a) - componentRank(b) || a.localeCompare(b));
}

export function sectionsOf(cls: ScheduleClass, component: string): ScheduleSection[] {
  return (cls.sections ?? []).filter((s) => s.component === component);
}

// ---- selection ----

export interface ResolvedSelection {
  cls?: ScheduleClass;
  primary?: ScheduleSection;
  /** One entry per component of `cls`; undefined = not picked yet. */
  picks: Record<string, ScheduleSection | undefined>;
}

/**
 * Turns the saved class numbers for one course into real sections. Tolerates stale numbers:
 * with no matching primary it falls back to the only class when there is exactly one, and a
 * component with a single option is picked automatically.
 */
export function resolveSelection(classes: ScheduleClass[], chosen: readonly string[] | undefined): ResolvedSelection {
  const want = new Set(chosen ?? []);
  const cls = classes.find((c) => want.has(c.primary.classNumber)) ?? (classes.length === 1 ? classes[0] : undefined);
  if (!cls) return { picks: {} };
  const picks: ResolvedSelection["picks"] = {};
  for (const comp of componentsOf(cls)) {
    const options = sectionsOf(cls, comp);
    picks[comp] = options.find((s) => want.has(s.classNumber)) ?? (options.length === 1 ? options[0] : undefined);
  }
  return { cls, primary: cls.primary, picks };
}

/** The class numbers to save for a resolved selection: primary first, then one per picked component. */
export function selectionNumbers(r: ResolvedSelection): string[] {
  if (!r.primary) return [];
  const out = [r.primary.classNumber];
  for (const s of Object.values(r.picks)) if (s) out.push(s.classNumber);
  return out;
}

/** Components of the chosen class that still need a pick. */
export function missingComponents(r: ResolvedSelection): string[] {
  return r.cls ? componentsOf(r.cls).filter((c) => !r.picks[c]) : [];
}

// ---- calendar blocks ----

export interface CourseChoice {
  course: CourseId;
  classes: ScheduleClass[];
  /** Saved class numbers (PlannedCourse.sections). */
  chosen?: readonly string[];
}

export interface Block {
  course: CourseId;
  /** Section label, e.g. "101 DIS". */
  section: string;
  component: string;
  classNumber: string;
  day: number;
  startMin: number;
  endMin: number;
  location?: string;
}

export function sectionBlocks(course: CourseId, section: ScheduleSection): Block[] {
  const out: Block[] = [];
  for (const m of timedMeetings(section)) {
    for (const day of [...new Set(m.days)].sort((a, b) => a - b)) {
      if (day < 0 || day > 6) continue;
      out.push({
        course,
        section: section.section,
        component: section.component,
        classNumber: section.classNumber,
        day,
        startMin: toMinutes(m.start),
        endMin: toMinutes(m.end),
        ...(m.location ? { location: m.location } : {}),
      });
    }
  }
  return out;
}

/** Every chosen section of every course in a term, flattened to one block per meeting day. */
export function blocksFor(courses: CourseChoice[]): Block[] {
  const out: Block[] = [];
  for (const c of courses) {
    const r = resolveSelection(c.classes, c.chosen);
    if (!r.primary) continue;
    out.push(...sectionBlocks(c.course, r.primary));
    for (const s of Object.values(r.picks)) if (s) out.push(...sectionBlocks(c.course, s));
  }
  return out;
}

/** Chosen sections that have no set time (listed under the grid). */
export function untimedSections(courses: CourseChoice[]): { course: CourseId; section: ScheduleSection }[] {
  const out: { course: CourseId; section: ScheduleSection }[] = [];
  for (const c of courses) {
    const r = resolveSelection(c.classes, c.chosen);
    for (const s of [r.primary, ...Object.values(r.picks)]) {
      if (s && timedMeetings(s).length === 0) out.push({ course: c.course, section: s });
    }
  }
  return out;
}

const sameSection = (a: Block, b: Block) => a.course === b.course && a.classNumber === b.classNumber && a.section === b.section;
const sectionKey = (b: Block) => `${b.course}\u0000${b.classNumber}\u0000${b.section}`;

/** Strict overlap: 13:00-13:59 and 13:59-15:00 (or 14:00 and 14:00) only touch, so they do not clash. */
export function overlaps(a: Block, b: Block): boolean {
  return a.day === b.day && a.startMin < b.endMin && b.startMin < a.endMin;
}

export interface Conflict {
  a: Block;
  b: Block;
  day: number;
  /** The overlapping part. */
  startMin: number;
  endMin: number;
}

/** Pairs of blocks from different sections that overlap on the same day. */
export function findConflicts(blocks: Block[]): Conflict[] {
  const out: Conflict[] = [];
  const sorted = [...blocks].sort((x, y) => x.day - y.day || x.startMin - y.startMin || x.endMin - y.endMin);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (b.day !== a.day || b.startMin >= a.endMin) break;
      if (sameSection(a, b) || !overlaps(a, b)) continue;
      out.push({ a, b, day: a.day, startMin: Math.max(a.startMin, b.startMin), endMin: Math.min(a.endMin, b.endMin) });
    }
  }
  return out;
}

/** How many pairs of sections clash (a MWF lecture against a MWF lecture counts once). */
export function conflictPairCount(conflicts: Conflict[]): number {
  return new Set(conflicts.map((c) => [sectionKey(c.a), sectionKey(c.b)].sort().join("\u0001"))).size;
}

/** "MATH 53 LEC" */
export function blockLabel(b: Pick<Block, "course" | "component">): string {
  return `${b.course} ${b.component}`;
}

/**
 * Blocks in `others` that a candidate section would overlap, one per clashing section. Pass the
 * blocks of the other current picks, without the section this candidate would replace.
 */
export function conflictsWith(candidate: ScheduleSection, others: Block[]): Block[] {
  const mine = sectionBlocks("", candidate);
  if (!mine.length) return [];
  const seen = new Set<string>();
  const out: Block[] = [];
  for (const o of others) {
    if (o.classNumber === candidate.classNumber && o.section === candidate.section) continue;
    if (seen.has(sectionKey(o))) continue;
    if (mine.some((m) => overlaps(m, o))) {
      seen.add(sectionKey(o));
      out.push(o);
    }
  }
  return out;
}

/**
 * One sentence per clashing pair of sections, days merged:
 * "COMPSCI 61A lecture overlaps MATH 53 discussion on Monday and Wednesday 1:00 to 1:59 PM".
 */
export function describeConflicts(conflicts: Conflict[]): string[] {
  const groups = new Map<string, { c: Conflict; days: number[] }>();
  for (const c of conflicts) {
    const key = `${sectionKey(c.a)}\u0001${sectionKey(c.b)}\u0001${c.startMin}\u0001${c.endMin}`;
    const g = groups.get(key);
    if (g) g.days.push(c.day);
    else groups.set(key, { c, days: [c.day] });
  }
  return [...groups.values()].map(({ c, days }) => {
    const dayText = joinWords([...new Set(days)].sort((x, y) => x - y).map((d) => DAY_LONG[d]));
    const name = (b: Block) => `${b.course} ${componentName(b.component)}`;
    return `${name(c.a)} overlaps ${name(c.b)} on ${dayText} ${formatRange(c.startMin, c.endMin, " to ")}`;
  });
}

// ---- side-by-side layout ----

export interface PlacedBlock<B extends { startMin: number; endMin: number } = Block> {
  block: B;
  /** 0-based column inside its cluster of overlapping blocks. */
  col: number;
  /** How many columns that cluster needs. */
  cols: number;
}

/** Gives overlapping blocks of one day side-by-side columns. */
export function layoutDay<B extends { startMin: number; endMin: number }>(blocks: B[]): PlacedBlock<B>[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: PlacedBlock<B>[] = [];
  let cluster: PlacedBlock<B>[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
    colEnds = [];
  };
  for (const block of sorted) {
    if (cluster.length && block.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= block.startMin);
    if (col < 0) col = colEnds.length;
    colEnds[col] = block.endMin;
    cluster.push({ block, col, cols: 1 });
    clusterEnd = Math.max(cluster.length === 1 ? -Infinity : clusterEnd, block.endMin);
  }
  flush();
  return out;
}

// ---- seats ----

export type SeatTone = "open" | "reserved" | "waitlist" | "full";

export interface SeatLabel {
  text: string;
  tone: SeatTone;
}

/** What a student needs to know at a glance. Null when the counts are unknown. */
export function seatLabel(section: ScheduleSection): SeatLabel | null {
  const { enrolled, capacity } = section;
  if (typeof enrolled !== "number" || typeof capacity !== "number") return null;
  if (capacity <= 0) return { text: "Closed", tone: "full" };
  const open = typeof section.open === "number" ? section.open : Math.max(0, capacity - enrolled);
  if (open > 0) return { text: `${open} open`, tone: "open" };
  if (enrolled < capacity) return { text: "Reserved seats only", tone: "reserved" };
  const wl = section.waitlisted ?? 0;
  const wlCap = section.waitlistCapacity ?? 0;
  if (wlCap > 0 && wl < wlCap) return { text: `Waitlist ${wl} of ${wlCap}`, tone: "waitlist" };
  return { text: "Full", tone: "full" };
}

/** 0 = open seats, 1 = unknown or reserved only, 2 = waitlist space, 3 = full. */
export function seatRank(section: ScheduleSection): number {
  const tone = seatLabel(section)?.tone;
  return tone === "open" ? 0 : tone === "waitlist" ? 2 : tone === "full" ? 3 : 1;
}

// ---- finding a schedule ----

export interface AutoPickResult {
  /** Class numbers per course, ready for `setSections`. Courses with no classes are left out. */
  selections: Record<CourseId, string[]>;
  /** Clashes that remain; [] means a clean schedule was found. */
  conflicts: Conflict[];
  /** True when the search stopped at the node cap before trying everything. */
  capped: boolean;
  nodes: number;
}

const CONFLICT_COST = 1_000_000;
const SEAT_COST = 100;
const CHANGE_COST = 1;

interface Interval {
  day: number;
  s: number;
  e: number;
}

/**
 * Looks for one class + sections per course with no time clashes. Among clean schedules it
 * prefers open seats, then waitlist space, then the fewest changes from the current picks.
 * `fixed` holds class numbers the user locked, per course: a locked lecture or section is never
 * swapped. When nothing clean exists (or the cap is hit) the best attempt comes back with the
 * clashes that remain. Sections with no meetings never clash.
 */
export function autoPick(
  courses: CourseChoice[],
  fixed: Record<CourseId, readonly string[] | undefined> = {},
  maxNodes = 20_000,
): AutoPickResult {
  interface Option {
    section: ScheduleSection;
    intervals: Interval[];
    base: number;
  }
  interface Slot {
    course: CourseId;
    options: Option[];
  }
  interface CoursePlan {
    course: CourseId;
    /** One entry per class that may be chosen: its primary option, then the slots it brings. */
    classes: { primary: Option; slots: Slot[] }[];
    size: number;
  }

  const intervalsOf = (s: ScheduleSection): Interval[] =>
    sectionBlocks("", s).map((b) => ({ day: b.day, s: b.startMin, e: b.endMin }));

  const plans: CoursePlan[] = [];
  for (const c of courses) {
    if (!c.classes.length) continue;
    const locked = new Set(fixed[c.course] ?? []);
    const current = resolveSelection(c.classes, c.chosen);
    const currentNumbers = new Set(selectionNumbers(current));
    const hadPrimary = !!(c.chosen ?? []).length && !!current.primary;
    const option = (s: ScheduleSection, hadPick: boolean): Option => ({
      section: s,
      intervals: intervalsOf(s),
      base: seatRank(s) * SEAT_COST + (hadPick && !currentNumbers.has(s.classNumber) ? CHANGE_COST : 0),
    });
    const lockedClass = c.classes.find((k) => locked.has(k.primary.classNumber)) ?? c.classes.find((k) => k.sections.some((s) => locked.has(s.classNumber)));
    const allowed = lockedClass ? [lockedClass] : c.classes;
    const classes = allowed.map((k) => ({
      primary: option(k.primary, hadPrimary),
      slots: componentsOf(k).map((comp) => {
        const all = sectionsOf(k, comp);
        const lockedHere = all.filter((s) => locked.has(s.classNumber));
        const hadPick = k === current.cls && !!current.picks[comp];
        return { course: c.course, options: (lockedHere.length ? lockedHere.slice(0, 1) : all).map((s) => option(s, hadPick)) };
      }),
    }));
    plans.push({ course: c.course, classes, size: classes.reduce((a, k) => a + 1 + k.slots.reduce((b, s) => b + s.options.length, 0), 0) });
  }
  // Most constrained first: fewer options means earlier, cheaper dead ends.
  plans.sort((a, b) => a.size - b.size);

  const assigned: { course: CourseId; opt: Option }[] = [];
  let best: { cost: number; picks: { course: CourseId; opt: Option }[] } | null = null;
  let nodes = 0;
  let capped = false;

  const clashes = (opt: Option): number => {
    if (!opt.intervals.length) return 0;
    let n = 0;
    for (const a of assigned) {
      if (a.opt.intervals.some((x) => opt.intervals.some((y) => x.day === y.day && x.s < y.e && y.s < x.e))) n++;
    }
    return n;
  };
  const ranked = (options: Option[]) =>
    options
      .map((opt) => ({ opt, cost: opt.base + clashes(opt) * CONFLICT_COST }))
      .sort((a, b) => a.cost - b.cost);

  // The work list is a stack of pending slots; a course contributes a "choose class" step.
  type Step = { kind: "course"; plan: CoursePlan } | { kind: "slot"; slot: Slot };

  const search = (steps: Step[], i: number, cost: number): void => {
    if (capped) return;
    if (best && cost >= best.cost) return;
    if (i >= steps.length) {
      best = { cost, picks: [...assigned] };
      return;
    }
    const step = steps[i];
    if (step.kind === "course") {
      const choices = ranked(step.plan.classes.map((k) => k.primary));
      for (const ch of choices) {
        if (++nodes > maxNodes) {
          capped = true;
          return;
        }
        const k = step.plan.classes.find((x) => x.primary === ch.opt)!;
        const next = [...steps.slice(0, i + 1), ...k.slots.map((slot): Step => ({ kind: "slot", slot })), ...steps.slice(i + 1)];
        assigned.push({ course: step.plan.course, opt: ch.opt });
        search(next, i + 1, cost + ch.cost);
        assigned.pop();
        if (capped) return;
      }
    } else {
      for (const ch of ranked(step.slot.options)) {
        if (best && cost + ch.cost >= best.cost) break; // sorted: the rest are no better
        if (++nodes > maxNodes) {
          capped = true;
          return;
        }
        assigned.push({ course: step.slot.course, opt: ch.opt });
        search(steps, i + 1, cost + ch.cost);
        assigned.pop();
        if (capped) return;
      }
    }
  };
  search(plans.map((plan): Step => ({ kind: "course", plan })), 0, 0);

  const selections: Record<CourseId, string[]> = {};
  const found = best as { cost: number; picks: { course: CourseId; opt: Option }[] } | null;
  for (const p of found?.picks ?? []) (selections[p.course] ??= []).push(p.opt.section.classNumber);
  const result = courses.filter((c) => selections[c.course]).map((c) => ({ ...c, chosen: selections[c.course] }));
  // A clean result found before the cap is still a real answer.
  return { selections, conflicts: findConflicts(blocksFor(result)), capped, nodes };
}
