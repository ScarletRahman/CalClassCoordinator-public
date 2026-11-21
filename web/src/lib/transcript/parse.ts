import { isKnownSubject, normalizeCourseId, normalizeSubject, resolveCourseId } from "../courseId";
import { currentTerm as termOfToday } from "../terms";
import type { CourseId, TakenCourse, Term } from "../types";

/**
 * Parses text pulled from a UC Berkeley transcript into TakenCourse rows.
 *
 * Handles:
 *  (a) the CalCentral unofficial transcript PDF ("Fall 2024" / "2024 Fall" headers, then
 *      "COMPSCI 61A  THE STRUCTURE & INTERP  4.00  4.00  A  16.000")
 *  (b) Academic Progress Report style rows ("COMPSCI 61A  Description  4.00  A  Fall 2023",
 *      or with the term first)
 *  (c) text pasted from CalCentral My Academics ("COMPSCI 61A  Lecture  4.0  A-") and plain
 *      lists, one per line ("CS 61A - A", "Math 1A Fall 2023 B+")
 * plus Test Credit (AP / IB) and Transfer Credit sections.
 */

/** A TakenCourse plus what the transcript printed (for the review step). */
export interface ParsedCourse extends TakenCourse {
  title?: string;
  /**
   * The id as printed, when it was changed to match the catalog ("DATA 100" is listed as
   * "DATA C100"). Only set when `knownCourseIds` was given.
   */
  printedAs?: CourseId;
  /** True when `knownCourseIds` was given and has no such class. The class is still kept. */
  unknown?: boolean;
  /** Set when the row should be confirmed by the student, with the reason in plain words. */
  needsReview?: string;
  /** The row had no grade and its term is over, so it was taken as completed. */
  assumedDone?: boolean;
}

/** An attempt that gave no credit (W, F, NP, I, U, NC). Never counted as completed. */
export interface SkippedCourse extends ParsedCourse {
  /** Plain-language reason, e.g. "Withdrawn (W), no credit". */
  reason: string;
  /** Term of the later attempt that is counted instead, when the class was retaken. */
  retakenIn?: Term;
}

export interface ParseOptions {
  /** Catalog course ids. Used to fix near misses and to flag classes the catalog does not have. */
  knownCourseIds?: { has(id: string): boolean };
  /** Catalog title for an id. Lets a doubtful read be checked against the title on the row. */
  titleOf?: (id: CourseId) => string | undefined;
  /**
   * The text came from OCR (a scanned or image-only PDF). Look-alike characters in class numbers
   * (O/0, I/1, S/5, B/8) are then repaired against the catalog, and every such row is flagged.
   */
  ocr?: boolean;
  /** The term today falls in, as "2026 Fall". Defaults to today's date. Decides in progress vs planned vs done for rows with no grade. */
  currentTerm?: Term;
  /** OCR confidence (0 to 100) per line of text, keyed by the line. Low rows are flagged. */
  lineConfidence?: { get(line: string): number | undefined };
}

export interface ParsedTranscript {
  /** Completed (passing or no grade yet recorded) courses, one per course id. */
  courses: ParsedCourse[];
  /** Terms seen, oldest first, as "2024 Fall". */
  terms: string[];
  studentName?: string;
  warnings: string[];
  totalUnits?: number;
  /**
   * Courses not finished yet: IP grade, or no grade in the current term (in progress) or in a
   * later term (planned). Compare each row's `term` with `currentTerm` to tell the two apart.
   */
  inProgress: ParsedCourse[];
  /** Attempts with no credit (withdrawn, failed, not passed, incomplete), including ones later retaken. */
  skipped: SkippedCourse[];
  /** Units in a Transfer Credit block, when the transcript prints a total. */
  transferUnits?: number;
  /** The term used as "now" when sorting ungraded rows. */
  currentTerm: Term;
  /** Lines that look like class rows (units and a grade) but could not be read. Never dropped silently. */
  unreadLines: string[];
}

// ---------- grades ----------

const GRADE_TOKENS = new Set([
  "A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F",
  "P", "NP", "S", "U", "I", "IP", "W", "NR", "RD", "CR", "NC",
]);
/** Grades that do not give credit. */
const NOT_COMPLETED = new Set(["W", "NP", "F", "I", "U", "NC"]);
const NO_CREDIT_REASON: Record<string, string> = {
  W: "Withdrawn (W), no credit",
  F: "Grade F, no credit",
  NP: "Not passed (NP), no credit",
  I: "Incomplete (I), not finished yet",
  U: "Unsatisfactory (U), no credit",
  NC: "No credit (NC)",
};
/** Grades that mean the class is still going / not yet graded. */
const PENDING = new Set(["IP", "NR", "RD"]);

function normGrade(tok: string): string | null {
  const t = tok.trim().toUpperCase().replace(/[()]/g, "");
  if (GRADE_TOKENS.has(t)) return t;
  if (t === "PASS") return "P";
  if (t === "NOPASS") return "NP";
  return null;
}

// ---------- terms ----------

const SEASONS: Record<string, string> = {
  FALL: "Fall", FA: "Fall", FL: "Fall",
  SPRING: "Spring", SP: "Spring", SPR: "Spring",
  SUMMER: "Summer", SU: "Summer", SM: "Summer", SUM: "Summer",
  WINTER: "Winter", WI: "Winter",
};
const SEASON_ORDER: Record<string, number> = { Winter: 0, Spring: 1, Summer: 2, Fall: 3 };

const SEASON_WORD = "(fall|spring|summer|winter)";
const TERM_PATTERNS: { re: RegExp; season: number; year: number }[] = [
  // "Fall 2024", "Fall Semester 2024", "Summer Session 2024"
  { re: new RegExp(`\\b${SEASON_WORD}\\s+(?:semester\\s+|session\\s+|term\\s+)?(\\d{4})\\b`, "i"), season: 1, year: 2 },
  // "2024 Fall"
  { re: new RegExp(`\\b(\\d{4})\\s+${SEASON_WORD}\\b`, "i"), season: 2, year: 1 },
  // "FA23", "SP 24", "Fa24"
  { re: /\b(FA|FL|SP|SU|SM)\s?(\d{2})\b/i, season: 1, year: 2 },
];

function buildTerm(season: string, year: string): Term | null {
  const s = SEASONS[season.toUpperCase()];
  if (!s) return null;
  let y = parseInt(year, 10);
  if (year.length === 2) y += 2000;
  if (y < 1950 || y > 2100) return null;
  return `${y} ${s}`;
}

/** Finds a term anywhere in s. Returns the term and s with that term removed. */
function findTerm(s: string): { term: Term; rest: string; index: number } | null {
  let best: { term: Term; rest: string; index: number } | null = null;
  for (const p of TERM_PATTERNS) {
    const m = s.match(p.re);
    if (!m || m.index === undefined) continue;
    const term = buildTerm(m[p.season], m[p.year]);
    if (!term) continue;
    if (!best || m.index < best.index) {
      best = { term, rest: (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).trim(), index: m.index };
    }
  }
  return best;
}

export function termSortKey(t: Term): number {
  const [y, s] = t.split(" ");
  return parseInt(y, 10) * 10 + (SEASON_ORDER[s] ?? 0);
}

// ---------- subjects ----------

/**
 * Corrections applied before normalizeCourseId. "EL ENG" is the transcript spelling of the
 * ELENG subject (e.g. EL ENG 120 = ELENG 120), not EECS.
 */
const PARSER_SUBJECT_OVERRIDES: Record<string, string> = {
  "EL ENG": "ELENG",
  "ELECTRICAL ENGINEERING": "ELENG",
};

const isSubject = (code: string) => isKnownSubject(code) || Object.values(PARSER_SUBJECT_OVERRIDES).includes(code);

function canonicalSubject(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, " ");
  return PARSER_SUBJECT_OVERRIDES[s] ?? normalizeSubject(s);
}

/** First words that mean "this is not a course line". */
const JUNK_FIRST_WORDS = new Set([
  "PAGE", "TERM", "CUM", "CUMULATIVE", "TOTAL", "TOTALS", "GPA", "UNITS", "PRINTED", "PRINT",
  "DATE", "STUDENT", "NAME", "ID", "SID", "UNIVERSITY", "UC", "UNOFFICIAL", "OFFICIAL", "ACADEMIC",
  "TRANSCRIPT", "RECORD", "PROGRAM", "PLAN", "MAJOR", "MINOR", "DEGREE", "ATTEMPTED", "EARNED",
  "COURSE", "COURSES", "DESCRIPTION", "GRADE", "POINTS", "END", "BEGINNING", "CONTINUED",
  "REQUIREMENT", "REQUIREMENTS", "SATISFIED", "NOT", "TAKEN", "NEEDED", "STATUS", "CAREER",
  "CAMPUS", "ADDRESS", "BIRTH", "BERKELEY", "CALIFORNIA", "CA", "OF", "THE", "AND", "SEMESTER",
  "SESSION", "COMBINED", "TRANSFER", "TEST", "CREDIT", "CREDITS", "UNDERGRADUATE", "GRADUATE",
  "GOOD", "STANDING", "DEAN", "DEANS", "HONORS", "EXPECTED", "LEVEL", "CLASS", "YEAR", "SCORE",
  "INSTITUTION", "LETTER", "PASSED", "PNP", "HOURS", "NO", "YES", "IN", "AT", "FOR", "TO",
]);

/** Instruction-format words that show up between the course id and units in My Academics. */
const COMPONENT_WORDS = new Set([
  "LECTURE", "LEC", "DISCUSSION", "DIS", "LAB", "LABORATORY", "SEMINAR", "SEM", "IND",
  "INDEPENDENT", "STUDY", "COL", "COLLOQUIUM", "STUDIO", "STD", "FLD", "FIELDWORK", "WOR",
  "WORKSHOP", "TUT", "TUTORIAL", "GRP", "CLN", "CLINIC", "REC", "WBL", "WBD", "SES",
]);

// subject: up to 4 space-separated tokens ("L & S", "MOL CELL BIO"), then the course number
const COURSE_RE =
  /^((?:[A-Za-z][A-Za-z&,.']*|&)(?: (?:[A-Za-z][A-Za-z&,.']*|&)){0,3}?)\s+([A-Za-z]{0,2}\d{1,3}[A-Za-z]{0,3})(?=$|[\s\-–—:,(|])(.*)$/;
// no space between subject and number: "CS61A", "MATH1A"
const COURSE_NOSPACE_RE = /^([A-Za-z]{2,8})(\d{1,3}[A-Za-z]{0,3})(?=$|[\s\-–—:,(|])(.*)$/;

const NUM_RE = /^\d{1,3}(?:\.\d{1,4})?$/;

interface RawCourse {
  id: CourseId;
  title: string;
  grade?: string;
  units?: number;
  /** Units attempted and earned, when the row has both columns (transcript tables). */
  attempted?: number;
  earned?: number;
  term?: Term;
  status?: "ip" | "skip";
  /** Why the row should be double-checked (OCR). */
  doubt?: string;
  /** A class from another school, kept exactly as printed. */
  foreign?: boolean;
}

const isNum = (t: string) => NUM_RE.test(t);
const isNumOrGrade = (t: string) => isNum(t) || normGrade(t) !== null;
const DECIMAL_RE = /^\d{1,2}\.\d{1,3}$/;

/** "Course  Description  Attempted  Earned  [Grade]  [Points]": read from the right-hand end. */
const TABLE_TAIL_RE =
  /^(.*?)(?:^|\s)(\d{1,2}\.\d{1,3})\s+(\d{1,2}\.\d{1,3})(?:\s+([A-Za-z]{1,2}[+-]?))?(?:\s+(\d{1,3}\.\d{1,3}))?$/;

function parseCourseLine(line: string): RawCourse | null {
  const m = line.match(COURSE_RE) ?? line.match(COURSE_NOSPACE_RE);
  if (!m) return null;
  const subjRaw = m[1].replace(/[,.]$/, "");
  const number = m[2].toUpperCase();
  let rest = m[3] ?? "";

  const firstWord = subjRaw.split(/\s+/)[0].toUpperCase().replace(/[^A-Z&]/g, "");
  if (JUNK_FIRST_WORDS.has(firstWord)) return null;

  const subject = canonicalSubject(subjRaw);
  const isKnown = isSubject(subject);
  const isAllCaps = subjRaw === subjRaw.toUpperCase() && /^[A-Z&][A-Z&, ]*$/.test(subjRaw);
  if (!isKnown && !isAllCaps) return null;
  if (!isKnown && subject.length > 10) return null;

  const id = normalizeCourseId(`${subject} ${number}`);
  if (!id) return null;

  // "PBHLTH 126 (Session A)": the summer session is not part of the class
  rest = rest.replace(/^\s*\(\s*(?:session|sess\.?)(?:[^)]{0,8}\)|\s*[A-Z0-9]{0,3}\b)/i, " ");
  rest = rest.replace(/^\s*[-–—:|,]+\s*/, " ").trim();

  // CalCentral prints a dash for a grade that is not in yet: "Data Structures  4  —  —"
  let dashGrade = false;
  const dashTail = rest.match(/^(.*\s\d{1,2}(?:\.\d{1,2})?)((?:\s+[-–—_]{1,3}){1,2})$/);
  if (dashTail) {
    dashGrade = true;
    rest = dashTail[1];
  }

  // term inside the line (APR / pasted lists)
  let term: Term | undefined;
  const t = findTerm(rest);
  if (t) {
    term = t.term;
    rest = t.rest;
  }

  // status words
  let status: RawCourse["status"];
  if (/\b(in progress|currently enrolled|enrolled)\b/i.test(rest)) status = "ip";
  if (/\b(dropped|waitlisted|wait listed|planned)\b/i.test(rest)) status = "skip";
  if (dashGrade && !status) status = "ip";
  rest = rest
    .replace(/\b(in progress|currently enrolled|enrolled|taken|completed|dropped|waitlisted|wait listed|planned)\b/gi, " ")
    .replace(/\b(no pass)\b/gi, "NP")
    .replace(/\s[-–—|]+\s*$/, "")
    .trim();

  let titleTokens: string[];
  let grade: string | undefined;
  let units: number | undefined;
  let attempted: number | undefined;
  let earned: number | undefined;

  const table = rest.match(TABLE_TAIL_RE);
  if (table) {
    // A transcript table row. Reading from the right keeps numbers and single letters that are
    // part of the title ("DIRECTED GROUP STUDY 2", "DEVICES & SYSTEMS I") out of the grade and units.
    titleTokens = table[1].split(/\s+/).filter(Boolean);
    attempted = parseFloat(table[2]);
    earned = parseFloat(table[3]);
    grade = (table[4] && normGrade(table[4])) || undefined;
    units = earned > 0 ? earned : attempted;
  } else {
    // Lists and pasted text: "Lecture 4.0 A-", "- A", "4 B+", or nothing at all. Cells separated
    // by tabs or wide gaps are kept whole, so a number inside the title cell stays in the title.
    const cells = rest.split(/\s{2,}/).filter(Boolean);
    let run: string[] = [];
    while (cells.length) {
      const toks = cells[cells.length - 1].split(" ").filter(Boolean);
      if (!toks.every(isNumOrGrade)) break;
      run = [...toks, ...run];
      cells.pop();
    }
    const fromCells = run.length > 0;
    titleTokens = cells.join(" ").split(" ").filter(Boolean);
    let separated = fromCells;
    while (titleTokens.length) {
      const last = titleTokens[titleTokens.length - 1];
      if (/^[-–—:|,]+$/.test(last)) {
        if (run.length) separated = true;
        titleTokens.pop();
        continue;
      }
      const bare = last.replace(/^\(|\)$/g, "");
      if (!(fromCells ? DECIMAL_RE.test(bare) : isNumOrGrade(bare))) break;
      if (bare !== last) separated = true;
      run.unshift(bare);
      titleTokens.pop();
    }
    // "INFO DEVICES I" or "VITAMIN D" with nothing else on the line: that letter is the title,
    // not a grade. A lone letter counts as a grade only with units, a +/-, or a clear separator.
    if (run.length === 1 && /^[A-Za-z]$/.test(run[0]) && titleTokens.length > 0 && !separated) {
      titleTokens.push(run[0]);
      run = [];
    }
    let gradeIdx = -1;
    for (let i = run.length - 1; i >= 0; i--) {
      if (!isNum(run[i])) {
        gradeIdx = i;
        break;
      }
    }
    if (gradeIdx >= 0) grade = normGrade(run[gradeIdx])!;
    const nums = run.slice(0, gradeIdx >= 0 ? gradeIdx : run.length).filter(isNum).map(Number);
    if (nums.length >= 2) {
      attempted = nums[0];
      earned = nums[1];
      units = earned > 0 ? earned : attempted;
    } else if (nums.length === 1) units = nums[0];
  }
  if (units !== undefined && (units <= 0 || units > 20)) units = undefined;

  // "COMPSCI 61A  Lecture  4.0  A-": the middle cell is the class format, not a title. A real
  // title can end in such a word ("Directed Group Study"), so only an all-format title is dropped.
  if (titleTokens.every((w) => COMPONENT_WORDS.has(w.toUpperCase()) || /^\d{3}[A-Z]?$/.test(w))) titleTokens = [];
  const title = titleTokens.join(" ");

  // all-caps lines from unknown subjects need some evidence they are courses
  if (!isKnown && grade === undefined && units === undefined) return null;
  // reject title-only words that look like a sentence ("Math 1 of 2")
  if (!grade && units === undefined && !term && titleTokens.length > 0 && /^(of|and|to|the|or)$/i.test(titleTokens[0])) return null;

  return { id, title, grade, units, attempted, earned, term, status };
}

// ---------- AP / IB test credit ----------

interface ApExam {
  name: string;
  match: RegExp;
}
const AP_EXAMS: ApExam[] = [
  { name: "Calculus BC", match: /CALC(ULUS)?\.?\s*BC/ },
  { name: "Calculus AB", match: /CALC(ULUS)?\.?\s*AB/ },
  { name: "English Language", match: /ENG(LISH|L)?\.?\s*LANG/ },
  { name: "English Literature", match: /ENG(LISH|L)?\.?\s*LIT/ },
  { name: "US History", match: /(U\.?S\.?|UNITED STATES|AMERICAN)\s*HIST/ },
  { name: "US Government", match: /(U\.?S\.?|UNITED STATES|AMERICAN)\s*GOV|GOV(ERNMENT|T)?\.?\s*(&|AND)?\s*POL(ITICS)?\.?\s*(:|-)?\s*(U\.?S|UNITED STATES|AMER)/ },
  { name: "Physics C: Mechanics", match: /PHYS(ICS)?\.?\s*C\b.*MECH/ },
  { name: "Physics C: E&M", match: /PHYS(ICS)?\.?\s*C\b.*(E\s*&\s*M|ELEC)/ },
  { name: "Physics 1", match: /PHYS(ICS)?\.?\s*1\b/ },
  { name: "Physics 2", match: /PHYS(ICS)?\.?\s*2\b/ },
  { name: "Statistics", match: /STAT/ },
  { name: "Chemistry", match: /CHEM/ },
  { name: "Biology", match: /BIOL?/ },
  { name: "Computer Science A", match: /COMP(UTER)?\.?\s*SCI(ENCE)?\.?\s*A\b|\bCSA\b/ },
  { name: "Computer Science Principles", match: /COMP(UTER)?\.?\s*SCI(ENCE)?\.?\s*PRIN|\bCSP\b/ },
  { name: "Macroeconomics", match: /MACRO/ },
  { name: "Microeconomics", match: /MICRO/ },
  { name: "Psychology", match: /PSYCH/ },
  { name: "World History", match: /WORLD\s*HIST/ },
  { name: "European History", match: /EURO(PEAN)?\.?\s*HIST/ },
  { name: "Environmental Science", match: /ENV(IRONMENTAL|\.)?\s*SCI/ },
  { name: "Human Geography", match: /HUM(AN)?\.?\s*GEO/ },
  { name: "Spanish Language", match: /SPAN(ISH)?\.?\s*LANG/ },
];

const AP_DEFAULT_UNITS: Record<string, number> = {
  "Calculus BC": 5.3, "Calculus AB": 2.7, "English Language": 5.3, "English Literature": 5.3, "US History": 5.3,
  "US Government": 2.7, "Physics C: Mechanics": 2.7, "Physics C: E&M": 2.7, "Physics 1": 5.3, "Physics 2": 5.3,
  Statistics: 2.7, Chemistry: 5.3, Biology: 5.3, "Computer Science A": 2.7, "Computer Science Principles": 5.3,
  Macroeconomics: 2.7, Microeconomics: 2.7, Psychology: 2.7, "World History": 5.3, "European History": 5.3,
  "Environmental Science": 2.7, "Human Geography": 2.7, "Spanish Language": 5.3,
};

interface ApMapping {
  courses?: { course: CourseId; units: number }[];
  label?: string;
}

/**
 * Only mappings we're confident in. Everything else is kept as "AP <EXAM>" with the exam
 * name as label so the student still sees it.
 */
function apMapping(exam: string, score: number | undefined): ApMapping | null {
  if (score === undefined) return null;
  switch (exam) {
    case "Calculus BC":
      if (score >= 4) return { courses: [{ course: "MATH 1A", units: 4 }, { course: "MATH 1B", units: 4 }] };
      return null;
    case "Calculus AB":
      if (score >= 4) return { courses: [{ course: "MATH 1A", units: 4 }] };
      return null;
    case "English Language":
    case "English Literature":
      if (score >= 4) return { label: "Entry Level Writing; Reading & Composition Part A" };
      if (score === 3) return { label: "Entry Level Writing" };
      return null;
    case "US History":
      if (score >= 4) return { label: "American History (AH&I)" };
      return null;
    case "US Government":
      if (score >= 4) return { label: "American Institutions (AH&I)" };
      return null;
  }
  return null;
}

interface ApResult {
  rows: TakenCourse[];
  warning?: string;
}

function parseApLine(line: string, inTestSection: boolean): ApResult | null {
  let s = line.trim();
  let kind: "AP" | "IB" | null = null;
  const pre = s.match(/^(?:AP|A\.P\.|ADVANCED PLACEMENT)\b[\s:\-]*/i);
  const ib = s.match(/^(?:IB|INTERNATIONAL BACCALAUREATE)\b[\s:\-]*(?=(HL|SL|HIGHER|STANDARD|[A-Z][a-z]))/i);
  if (pre) {
    kind = "AP";
    s = s.slice(pre[0].length);
  } else if (ib && (inTestSection || /\b(HL|SL|HIGHER LEVEL|STANDARD LEVEL)\b/i.test(s))) {
    kind = "IB";
    s = s.slice(ib[0].length);
  } else if (inTestSection) {
    if (!AP_EXAMS.some((e) => e.match.test(s.toUpperCase()))) return null;
    kind = "AP";
  } else return null;

  // score: "Score 5", "Score: 5", "(5)", or a lone 1-7 integer; units: decimal number
  let score: number | undefined;
  const sm = s.match(/\bscore\s*[:=]?\s*([1-7])\b/i) ?? s.match(/\(([1-7])\)/);
  let body = s;
  if (sm) {
    score = parseInt(sm[1], 10);
    body = body.replace(sm[0], " ");
  }
  const tokens = body.split(/\s+/).filter(Boolean);
  // the score is the last lone 1-7 integer that isn't part of the name ("PHYSICS 1  4")
  if (score === undefined) {
    for (let i = tokens.length - 1; i > 0; i--) {
      if (/^[1-7]$/.test(tokens[i])) {
        score = parseInt(tokens[i], 10);
        tokens.splice(i, 1);
        break;
      }
    }
  }
  const nameTokens: string[] = [];
  let units: number | undefined;
  tokens.forEach((tok, i) => {
    if (/^\d{1,2}\.\d+$/.test(tok)) {
      if (units === undefined) units = parseFloat(tok);
    } else if (i > 0 && /^(P|CR|S|T|TE)$/.test(tok)) {
      // grade column on test credit rows
    } else if (/^(units?|score|exam|test|credit)$/i.test(tok)) {
      // filler
    } else {
      nameTokens.push(tok);
    }
  });
  // Physics C / "Computer Science A" keep their trailing letter; any other trailing number was
  // a score we've already taken.
  let level = "";
  const lv = nameTokens.findIndex((x) => /^(HL|SL)$/i.test(x));
  if (lv >= 0) level = " " + nameTokens.splice(lv, 1)[0].toUpperCase();
  const rawName = nameTokens.join(" ").replace(/[-:,]+$/, "").trim();
  if (!rawName) return null;
  const upper = rawName.toUpperCase();
  const exam = AP_EXAMS.find((e) => e.match.test(upper))?.name ?? titleCase(rawName);
  const examLabel = `${kind} ${exam}${level}${score !== undefined ? ` (${score})` : ""}`;
  const genericId = `${kind} ${exam.toUpperCase()}`;

  // Berkeley grants 2.7 or 5.3 semester units per exam (score 3 or higher). Use the printed
  // figure when there is one, so the planner can count test credit toward the unit total.
  if (units === undefined && kind === "AP" && score !== undefined && score >= 3) units = AP_DEFAULT_UNITS[exam];
  if (kind === "AP") {
    const map = apMapping(exam, score);
    if (map?.courses) {
      // the exam's units are shared between the classes it stands for
      const each = units !== undefined ? Math.round((units / map.courses.length) * 100) / 100 : undefined;
      return { rows: map.courses.map((c) => ({ course: c.course, units: each ?? c.units, source: "ap", label: examLabel })) };
    }
    if (map?.label) {
      return { rows: [{ course: genericId, units, source: "ap", label: `${examLabel}: ${map.label}` }] };
    }
  }
  const warning =
    score === undefined && kind === "AP" && /^(Calculus|English)/.test(exam)
      ? `${kind} ${exam}: no score found, so it wasn't mapped to a Berkeley course. Add the equivalent manually if it applies.`
      : undefined;
  return { rows: [{ course: genericId, units, source: "ap", label: examLabel }], warning };
}

/** In a Test Credit section: "CALCULUS BC  5  8.00" (exam name + lone score), not "MATH 1A". */
function looksLikeExamRow(line: string): boolean {
  const upper = line.toUpperCase();
  if (!AP_EXAMS.some((e) => e.match.test(upper))) return false;
  const c = line.match(COURSE_RE);
  if (!c) return true;
  if (/^[1-7]$/.test(c[2])) return true;
  return !isSubject(canonicalSubject(c[1]));
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length <= 2 && /^(us|ii|iii|ab|bc|hl|sl)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// ---------- line-level helpers ----------

type Section = "term" | "test" | "transfer";

const TEST_SECTION_RE =
  /^(test credits?|test credit summary|advanced placement(\s+(exams?|credit|tests?))?|ap (exams?|tests?|credits?)|international baccalaureate|ib (exams?|credits?)|external (test|exam)s?( credits?)?|credit by exam(ination)?|exam credits?)\s*:?\s*$/i;
const TRANSFER_SECTION_RE =
  /^(transfer (credits?|coursework|course ?work|work|units|credit summary)|credit from other institutions?|other institutions?|external credits?|courses? from other institutions?)\b/i;
const RECORD_SECTION_RE =
  /^(beginning of (undergraduate|graduate|law) record|undergraduate (career|record)|institution credit|uc berkeley coursework|berkeley coursework|course history)\b/i;

function isJunkLine(line: string): boolean {
  const l = line.trim();
  if (!l) return true;
  if (/^[-=_*.\s]+$/.test(l)) return true;
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(l)) return true;
  if (/^\d+\s*(of|\/)\s*\d+$/.test(l)) return true;
  if (/^\d+$/.test(l)) return true;
  if (/\b(term|cum(ulative)?|career|overall|semester)\s+(gpa|totals?)\b/i.test(l)) return true;
  if (/^(gpa|totals?|uc totals|ucb totals)\b/i.test(l)) return true;
  return false;
}

function extractTotalUnits(line: string): number | undefined {
  if (!/^(uc\s+|ucb\s+|undergraduate\s+|berkeley\s+)?(cum(ulative)?|career|overall|total|combined)\b.*\b(units?|totals?)\b/i.test(line) && !/^(uc|ucb)\s+totals?\b/i.test(line)) return undefined;
  if (/\b(term|semester)\b/i.test(line) && !/\b(cum|cumulative|career)\b/i.test(line)) return undefined;
  // numbers after the last "Totals"/"Units" keyword ("Cum GPA 3.70  Cum Totals 62.00 58.00")
  const kw = [...line.matchAll(/\b(totals?|units?)\b/gi)].pop();
  const tail = kw && kw.index !== undefined ? line.slice(kw.index) : line;
  const nums = (tail.match(/\d+\.\d+|\b\d{1,3}\b/g) ?? []).map(Number).filter((n) => n > 0 && n < 400);
  if (!nums.length) return undefined;
  // "Cum Totals  Attempted  Earned  GPA Units  Points": earned is the 2nd number
  if (/earned|passed|completed/i.test(line) && nums.length === 1) return nums[0];
  return nums.length >= 2 ? nums[1] : nums[0];
}

function extractName(line: string): string | undefined {
  // "Name: Bear, Oski" (transcript) or "Name    Oski Bear" (Academic Summary)
  const m = line.match(/^(?:student\s+name|name)(?:\s*[:\-]\s*|\s{2,})(.+)$/i);
  if (!m) return undefined;
  let name = m[1].split(/\s{2,}|\t|\b(?:student\s+id|sid|id)\b/i)[0].trim().replace(/[,;]+$/, "");
  const lf = name.match(/^([A-Za-z'\- ]+),\s*([A-Za-z'\- .]+)$/);
  if (lf) name = `${lf[2].trim()} ${lf[1].trim()}`;
  if (!/[A-Za-z]/.test(name) || name.length > 60) return undefined;
  return name;
}

// ---------- rows broken across lines, or two rows on one line ----------

const BARE_SUBJECT_RE = /^([A-Z][A-Z&,]*(?: [A-Z&][A-Z&,]*){0,3})(\s{2,}.*)?$/;
const BARE_NUMBER_RE = /^([A-Z]{0,2}\d{1,3}[A-Z]{0,3})(?:\s{2,}.*)?$/;
const ID_ONLY_RE = /^[A-Za-z][A-Za-z&,.' ]{0,24}?\s?[A-Za-z]{0,2}\d{1,3}[A-Za-z]{0,3}$/;

function isIdOnlyLine(full: string): boolean {
  const line = full.replace(/\s*\(\s*session[^)]{0,8}\)\s*$/i, "");
  if (!ID_ONLY_RE.test(line)) return false;
  const m = line.match(COURSE_RE) ?? line.match(COURSE_NOSPACE_RE);
  return !!m && !m[3].trim() && isSubject(canonicalSubject(m[1]));
}

/**
 * Repairs rows that reach us in pieces:
 *  - a wrapped course cell: "COMPSCI    STRUCTURE ...  4.00  4.00  A" then "61A" on the next line
 *  - one cell per line (how some browsers copy a table): "COMPSCI 61A" / "Title" / "4.00" / "A"
 */
function joinBrokenRows(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const next = lines[i + 1];

    const bare = line.match(BARE_SUBJECT_RE);
    if (bare && next !== undefined && isSubject(canonicalSubject(bare[1])) && !JUNK_FIRST_WORDS.has(bare[1].split(" ")[0])) {
      const num = next.match(BARE_NUMBER_RE);
      // With columns, the row must carry units. Alone on its line, the number must look like a
      // course number ("61A", "70"), not a score or a unit count.
      const rowLike = bare[2] ? /\d\.\d/.test(bare[2]) : !!num && next.trim() === num[1] && /[A-Z]|\d{2}/.test(num[1]);
      if (num && rowLike) {
        line = `${bare[1]} ${num[1]}${bare[2] ?? ""}`;
        i++;
      }
    }

    if (isIdOnlyLine(line)) {
      const cells: string[] = [];
      let j = i + 1;
      let sawValue = false;
      while (j < lines.length && j <= i + 7) {
        const c = lines[j];
        const toks = c.split(/\s+/).filter(Boolean);
        if (toks.length > 0 && toks.length <= 4 && toks.every(isNumOrGrade)) {
          cells.push(c);
          sawValue = true;
          j++;
          continue;
        }
        // one title line, straight after the id and followed by a value
        const after = lines[j + 1];
        if (
          j === i + 1 &&
          c.length <= 90 &&
          after !== undefined &&
          after.split(/\s+/).filter(Boolean).every(isNumOrGrade) &&
          !findTerm(c) &&
          !isJunkLine(c) &&
          !parseCourseLine(c)
        ) {
          cells.push(c);
          j++;
          continue;
        }
        break;
      }
      if (sawValue) {
        line = [line, ...cells].join("    ");
        i = j - 1;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Two class rows on one line (a two-column page read straight across): split after the first
 * row's last number when what follows is itself a class row.
 */
function splitMergedRows(line: string): string[] {
  const re = /\d\.\d{2,3}\s{2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const cut = m.index + m[0].length;
    const right = line.slice(cut);
    const c = right.match(COURSE_RE);
    if (!c || !isSubject(canonicalSubject(c[1])) || !/\d/.test(c[3])) continue;
    const left = line.slice(0, cut).trim();
    if (!parseCourseLine(left)) continue;
    return [left, ...splitMergedRows(right)];
  }
  return [line];
}

// ---------- plain lists ----------

const GRADE_SUFFIX_RE = /\s+\(?(?:[A-DF][+-]?|P|NP|S|U|W|I|IP)\)?$/i;

/**
 * "CHEM 3A, CHEM 3AL, MATH 10B", "CS 61A; 61B / 70", "Fall 2024: CS 61A, MATH 1B and ENGLISH R1A":
 * several class codes on one line become one line each (with the term as a heading above them).
 * A line is only split when every piece is a bare class code, so titles with commas are safe.
 */
function expandLists(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let body = line;
    let heading: string | undefined;
    const t = findTerm(line);
    if (t && t.index === 0) {
      const after = t.rest.replace(/^[\s:\-|,]+/, "");
      if (after) {
        heading = line.slice(0, line.length - t.rest.length).trim().replace(/[\s:\-|,]+$/, "");
        body = after;
      }
    }
    if (!/[,;/]|\band\b/i.test(body) || /\s{2,}\S+\s{2,}/.test(body)) {
      out.push(line);
      continue;
    }
    const parts = body.split(/\s*(?:[,;/]|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
    let subject: string | undefined;
    const rows: string[] = [];
    for (const part of parts) {
      const bare = part.replace(GRADE_SUFFIX_RE, "");
      const m = bare.match(COURSE_RE) ?? bare.match(COURSE_NOSPACE_RE);
      if (m && !m[3].trim() && isSubject(canonicalSubject(m[1]))) {
        subject = m[1];
        rows.push(part);
      } else if (subject && /^[A-Za-z]{0,2}\d{1,3}[A-Za-z]{0,3}$/.test(bare)) {
        rows.push(`${subject} ${part}`); // "CS 61A, 61B"
      } else {
        rows.length = 0;
        break;
      }
    }
    if (rows.length < 2 && !(rows.length === 1 && heading && parts.length === 1)) {
      out.push(line);
      continue;
    }
    if (heading) out.push(heading);
    out.push(...rows);
  }
  return out;
}

// ---------- classes from another school ----------

/** "STAT C1000  INTRODUCTION TO STATISTICS  4.00  4.00  A": a number no Berkeley class has. */
const FOREIGN_ROW_RE = /^([A-Z][A-Z&.]{0,9}(?: [A-Z&][A-Z&.]{0,7}){0,2})\s+([A-Z]{0,2}\d{1,4}[A-Z]{0,3})\s+(\S.*)$/;
export const NOT_BERKELEY = "Not a Berkeley class number. It counts as transfer units; tick the requirement it covers yourself.";

function parseForeignRow(line: string, inTransfer: boolean): RawCourse | null {
  const m = line.match(FOREIGN_ROW_RE);
  if (!m) return null;
  const fourDigit = /\d{4}/.test(m[2]);
  if (!fourDigit && !inTransfer) return null;
  if (JUNK_FIRST_WORDS.has(m[1].split(" ")[0])) return null;
  // reuse the row reader for the title, units and grade
  const probe = parseCourseLine(`MATH 1 ${m[3]}`);
  if (!probe || (probe.units === undefined && probe.grade === undefined)) return null;
  return { ...probe, id: `${m[1].replace(/\s+/g, " ")} ${m[2]}`, doubt: NOT_BERKELEY, foreign: true };
}

// ---------- OCR repairs ----------

const NUMBER_FORMAT_RE = /^[A-Z]{0,2}\d{1,3}[A-Z]{0,3}$/;
const TO_DIGIT: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", "|": "1", "!": "1", S: "5", B: "8", Z: "2", G: "6" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G" };

/** Every way to swap look-alike characters in a class number, fewest swaps first, valid numbers only. */
function lookalikeNumbers(token: string): string[] {
  const chars = token.toUpperCase().split("").slice(0, 7);
  let variants: { s: string; swaps: number }[] = [{ s: "", swaps: 0 }];
  for (const ch of chars) {
    const alt = TO_DIGIT[ch] ?? TO_LETTER[ch];
    const next: typeof variants = [];
    for (const v of variants) {
      if (ch !== "|" && ch !== "!") next.push({ s: v.s + ch, swaps: v.swaps });
      if (alt) next.push({ s: v.s + alt, swaps: v.swaps + 1 });
    }
    variants = next;
  }
  return variants
    .filter((v) => v.swaps > 0 && NUMBER_FORMAT_RE.test(v.s))
    .sort((a, b) => a.swaps - b.swaps)
    .map((v) => v.s);
}

const TITLE_STOP = new Set(["a", "an", "and", "the", "of", "to", "in", "for", "on", "with", "i", "ii"]);
function titleWords(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !TITLE_STOP.has(w));
}

/** 0 to 1: how much of the shorter title is found in the other. Tolerates one misread word ending. */
export function titleSimilarity(a: string, b: string): number {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (!wa.length || !wb.length) return 0;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const hit = short.filter((w) => long.some((x) => x === w || (w.length >= 5 && x.length >= 5 && x.slice(0, 4) === w.slice(0, 4)))).length;
  return hit / short.length;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Cleans one OCR line: stray bars, and a class number read with a letter for a digit ("C1O"). */
function fixOcrLine(line: string, known?: { has(id: string): boolean }): { line: string; fixed: boolean } {
  let out = line
    .replace(/([A-Za-z0-9])[|\]]+(?=\s|$)/g, "$1")
    .replace(/(^|\s)[|](?=\s|$)/g, "$1I")
    // specks after the class number: "COGSCI 1." (the end of a link underline)
    .replace(/^([A-Z][A-Z&]{1,8}\s+[A-Z]{0,2}\d{1,3}[A-Z]{0,3})[._,'`~-]+(?=\s)/, "$1");
  let fixed = false;
  // a term heading with a letter off: "Eall 2026", "Sprlng 2027" (headings are underlined links)
  const head = out.match(/^([A-Za-z|!1]{3,7})\s+((?:19|20)\d{2})$/);
  if (head && !SEASONS[head[1].toUpperCase()]) {
    const season = ["Fall", "Spring", "Summer", "Winter"].find((x) => editDistance(x.toLowerCase(), head[1].toLowerCase()) <= (x.length > 4 ? 2 : 1));
    if (season) out = `${season} ${head[2]}`;
  }
  const m = out.match(/^([A-Z][A-Z&]{1,8})\s+(\S{1,7})(\s.*)$/);
  if (m && isSubject(canonicalSubject(m[1])) && !NUMBER_FORMAT_RE.test(m[2].toUpperCase()) && /\d\s*\S*\s*$|[-–—]\s*$/.test(m[3])) {
    const subject = canonicalSubject(m[1]);
    const options = lookalikeNumbers(m[2]);
    const pick = options.find((n) => known?.has(`${subject} ${n}`)) ?? options[0];
    if (pick) {
      out = `${m[1]} ${pick}${m[3]}`;
      fixed = true;
    }
  }
  return { line: out, fixed };
}

/** A line with units and a grade at the end that we still could not read as a class. */
const ROWISH_RE = /\S\s+\d{1,2}(?:\.\d{1,2})?\s+(?:[A-DFPSUIW][+-]?|NP|IP|[-–—_]{1,3})(?:\s+(?:\d{1,3}(?:\.\d{1,3})?|[-–—_]{1,3}))?$/;

const LOW_CONFIDENCE = 70;

// ---------- main ----------

interface Attempt extends ParsedCourse {
  order: number;
  pending: boolean;
  failed: boolean;
}

export function parseTranscriptText(text: string, options: ParseOptions = {}): ParsedTranscript {
  const known = options.knownCourseIds;
  const warnings: string[] = [];
  const attempts: Attempt[] = [];
  const apRows: TakenCourse[] = [];
  const termsSeen = new Set<Term>();
  let studentName: string | undefined;
  let totalUnits: number | undefined;
  let transferUnits: number | undefined;
  let section: Section = "term";
  let currentTerm: Term | undefined;
  let order = 0;

  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2010-\u2013]/g, "-")
    .split("\n")
    .map((raw) => raw.replace(/\t/g, "    ").replace(/^[\s•*·▪-]+(?=[A-Za-z])/, "").trim())
    .filter(Boolean);
  const lines = joinBrokenRows(expandLists(cleaned)).flatMap(splitMergedRows);
  const now = options.currentTerm ?? termOfToday();
  const unreadLines: string[] = [];
  let prevLine = "";

  for (const rawLine of lines) {
    let line = rawLine;
    let doubt: string | undefined;
    if (options.ocr) {
      const f = fixOcrLine(rawLine, known);
      line = f.line;
      if (f.fixed) doubt = "The class number was hard to read, so we picked the closest match. Please check it.";
    }
    const conf = options.lineConfidence?.get(rawLine);
    if (!doubt && conf !== undefined && conf < LOW_CONFIDENCE) doubt = "This row was hard to read. Please check the class, units and grade.";
    const before = prevLine;
    prevLine = line;

    if (!studentName) {
      const n = extractName(line);
      if (n) {
        studentName = n;
        continue;
      }
    }

    if (TEST_SECTION_RE.test(line)) {
      section = "test";
      continue;
    }
    if (TRANSFER_SECTION_RE.test(line)) {
      section = "transfer";
      continue;
    }
    if (RECORD_SECTION_RE.test(line)) {
      section = "term";
      continue;
    }

    // "Course Trans GPA: 0.000  Transfer Totals: 60.00  60.00  0.000"
    const tt = line.match(/\btransfer\s+(?:totals?|units)\s*:?\s*(\d{1,3}(?:\.\d+)?)(?:\s+(\d{1,3}(?:\.\d+)?))?/i);
    if (tt) {
      if (section === "transfer") transferUnits = (transferUnits ?? 0) + parseFloat(tt[2] ?? tt[1]);
      continue;
    }

    // term header, or a row that starts with its term ("2023 Fall  COMPSCI 61A ...")
    const lead = line.match(/^(?:term\s*[:\-]?\s*)?/i)![0];
    const t = findTerm(line.slice(lead.length));
    if (t && t.index === 0) {
      const after = t.rest.replace(/^[\s:\-|,]+/, "");
      const asCourse = after ? parseCourseLine(after) : null;
      if (asCourse) {
        asCourse.doubt = doubt;
        if (section === "test") section = "term";
        asCourse.term = asCourse.term ?? t.term;
        termsSeen.add(asCourse.term);
        pushAttempt(asCourse);
        continue;
      }
      // a header: "Fall 2024", "Fall 2024 Term", "2024 Fall Semester  Term GPA 3.9"
      // "Expected Graduation" with the term on the next line is not a term of classes
      const labelBefore = /\b(expected|graduat|admit|matric|entry|declared|anticipated)/i;
      if (!labelBefore.test(line) && !(labelBefore.test(before) && !after)) {
        currentTerm = t.term;
        termsSeen.add(t.term);
        if (section !== "term") section = "term";
        continue;
      }
    }

    const tu = extractTotalUnits(line);
    if (tu !== undefined) {
      if (/\b(cum|cumulative|career|overall|uc|ucb|combined)\b/i.test(line) || totalUnits === undefined) totalUnits = tu;
      continue;
    }
    if (isJunkLine(line)) continue;

    // AP / IB
    if (/\bsub-?score\b/i.test(line)) continue;
    const apPrefixed = /^(AP|A\.P\.|ADVANCED PLACEMENT|IB|INTERNATIONAL BACCALAUREATE)\b/i.test(line);
    if (apPrefixed || (section === "test" && looksLikeExamRow(line))) {
      const ap = parseApLine(line, section === "test");
      if (ap) {
        apRows.push(...ap.rows);
        if (ap.warning) warnings.push(ap.warning);
        continue;
      }
    }

    // In a transfer block, a subject Berkeley does not have is another school's class: keep it as printed.
    const otherSchool = section === "transfer" && !isSubject(canonicalSubject(line.match(FOREIGN_ROW_RE)?.[1] ?? "MATH"));
    const c = (otherSchool ? parseForeignRow(line, true) : null) ?? parseCourseLine(line) ?? parseForeignRow(line, section === "transfer");
    if (!c) {
      if (ROWISH_RE.test(line) && /\s{2,}/.test(line) && !/^(class|course)\b/i.test(line)) unreadLines.push(line);
      continue;
    }
    c.doubt = c.doubt ?? doubt;
    if (c.term) termsSeen.add(c.term);
    pushAttempt(c);
  }

  function pushAttempt(c: RawCourse) {
    if (c.status === "skip") return;
    const source: TakenCourse["source"] = section === "transfer" || c.foreign ? "transfer" : section === "test" ? "ap" : "transcript";
    const term = section === "term" ? c.term ?? currentTerm : c.term;
    // Enrolled with units attempted but none earned and no grade yet: the class is still going.
    const enrolledOnly = c.grade === undefined && c.attempted !== undefined && c.attempted > 0 && c.earned === 0;
    const pending = c.status === "ip" || enrolledOnly || (c.grade !== undefined && PENDING.has(c.grade));
    const failed = c.grade !== undefined && NOT_COMPLETED.has(c.grade);
    const row: Attempt = { course: c.id, source, order: order++, pending, failed };
    if (c.doubt) row.needsReview = c.doubt;
    if (c.foreign) row.unknown = true;
    else if (known && !known.has(c.id)) {
      // Classes from another school keep their own numbering, so only Berkeley rows are matched
      // loosely ("DATA 100" is listed as "DATA C100").
      let resolved = source === "transfer" ? null : resolveCourseId(c.id, known);
      if (!resolved && options.ocr && source !== "transfer") {
        resolved = lookalikeIds(c.id).find((id) => known.has(id)) ?? null;
        if (resolved) row.needsReview = `Read as ${c.id}, which is not a class. ${resolved} is the closest match. Please check it.`;
      }
      if (resolved) {
        row.course = resolved;
        row.printedAs = c.id;
      } else row.unknown = true;
    }
    // OCR can turn one real class into another ("MATH 51" for "MATH 54"). When the row has the
    // full catalog-style title, compare it with the catalog and prefer a look-alike that fits.
    if (options.ocr && known && options.titleOf && c.title && /[a-z]/.test(c.title) && !row.unknown) {
      const fit = (id: CourseId) => titleSimilarity(c.title, options.titleOf!(id) ?? "");
      const catalogTitle = options.titleOf(row.course);
      if (catalogTitle && fit(row.course) >= 0.75 && !row.printedAs) {
        // A class the catalog has, with the catalog's own title on the row: the read is right,
        // whatever speck (an underline stub) lowered the confidence.
        delete row.needsReview;
      } else if (catalogTitle && fit(row.course) < 0.5) {
        const better = lookalikeIds(row.course).find((id) => known.has(id) && fit(id) >= 0.75);
        if (better) {
          row.printedAs = row.printedAs ?? c.id;
          row.course = better;
          row.needsReview = `Read as ${c.id}, but the title matches ${better}. Please check it.`;
        } else if (!row.needsReview) {
          row.needsReview = `The title on this row does not match ${row.course} in the catalog ("${catalogTitle}"). Please check the class number.`;
        }
      }
    }
    if (term) row.term = term;
    if (c.grade) row.grade = c.grade;
    if (c.units !== undefined) row.units = c.units;
    if (c.title) row.title = c.title;
    attempts.push(row);
  }

  const terms = [...termsSeen].sort((a, b) => termSortKey(a) - termSortKey(b));

  // Rows with no grade: this term is in progress, a later term is planned, an earlier term is
  // taken as completed (and says so in the review step).
  for (const a of attempts) {
    if (a.grade || a.failed || a.source !== "transcript" || !a.term) continue;
    const future = termSortKey(a.term) >= termSortKey(now);
    if (!a.pending && future) a.pending = true;
    else if (!a.pending && !future) a.assumedDone = true;
  }

  // dedupe: prefer a passing attempt (latest), then in-progress, then the not-completed one
  const byId = new Map<CourseId, Attempt[]>();
  for (const a of attempts) {
    const list = byId.get(a.course) ?? [];
    list.push(a);
    byId.set(a.course, list);
  }
  const courses: ParsedCourse[] = [];
  const inProgress: ParsedCourse[] = [];
  const skipped: SkippedCourse[] = [];
  const rank = (a: Attempt) => (a.failed ? 0 : a.pending ? 1 : 2);
  const tkey = (a: Attempt) => (a.term ? termSortKey(a.term) : 0);
  const reasonFor = (a: Attempt) => NO_CREDIT_REASON[a.grade ?? ""] ?? "No credit";
  for (const [id, list] of byId) {
    const best = [...list].sort((x, y) => rank(y) - rank(x) || tkey(y) - tkey(x) || y.order - x.order)[0];
    const out = strip(best);
    if (best.failed) {
      skipped.push({ ...out, reason: reasonFor(best) });
      warnings.push(`${id}${best.term ? ` (${best.term})` : ""}: ${reasonFor(best)}. Not counted as completed.`);
    } else {
      if (best.pending) inProgress.push(out);
      else courses.push(out);
      for (const a of list) {
        if (a === best || !a.failed) continue;
        skipped.push({ ...strip(a), reason: reasonFor(a), ...(best.term ? { retakenIn: best.term } : {}) });
      }
      if (list.length > 1 && list.some((a) => a !== best && (a.term !== best.term || a.grade !== best.grade))) {
        warnings.push(
          `${id} appears ${list.length} times. Kept the ${best.pending ? "in-progress " : ""}attempt${best.grade ? ` with grade ${best.grade}` : ""}${best.term ? ` from ${best.term}` : ""}.`,
        );
      }
    }
  }
  skipped.sort((a, b) => (a.term ? termSortKey(a.term) : 0) - (b.term ? termSortKey(b.term) : 0));

  // AP rows: dedupe, never overriding a real Berkeley attempt
  const seenAp = new Set<CourseId>();
  for (const r of apRows) {
    if (seenAp.has(r.course) || courses.some((c) => c.course === r.course) || inProgress.some((c) => c.course === r.course)) continue;
    seenAp.add(r.course);
    courses.push(r);
  }

  if (transferUnits !== undefined && transferUnits > 0 && !attempts.some((a) => a.source === "transfer")) {
    warnings.push(
      `Your transcript shows ${fmtUnits(transferUnits)} transfer units but does not list the classes. Add the Berkeley classes they count for by hand.`,
    );
  }

  if (!courses.length && !inProgress.length && !skipped.length && !apRows.length) {
    warnings.push("No classes were recognized. If this is a scanned PDF, paste the text from CalCentral instead.");
  }

  return {
    courses,
    terms,
    ...(studentName ? { studentName } : {}),
    warnings,
    ...(totalUnits !== undefined ? { totalUnits } : {}),
    inProgress,
    skipped,
    ...(transferUnits !== undefined ? { transferUnits } : {}),
    currentTerm: now,
    unreadLines,
  };
}

/** Ids that differ from `id` only by look-alike characters in the number. */
function lookalikeIds(id: CourseId): CourseId[] {
  const sp = id.lastIndexOf(" ");
  return lookalikeNumbers(id.slice(sp + 1)).map((n) => `${id.slice(0, sp)} ${n}`);
}

const fmtUnits = (n: number) => String(Math.round(n * 100) / 100);

function strip(a: Attempt): ParsedCourse {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { order, pending, failed, ...rest } = a;
  return rest;
}
