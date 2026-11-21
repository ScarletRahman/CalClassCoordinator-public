// Shapes mirror docs/data-contracts.md. Producers may add fields; we ignore unknown ones.

export type CourseId = string; // "COMPSCI 61A"
export type Term = string; // "2026 Fall"

export interface Course {
  id: CourseId;
  subject: string;
  number: string;
  title: string;
  units: number | [number, number];
  description?: string;
  breadths?: string[];
  attributes?: string[];
  crossListed?: CourseId[];
  /** The same class under an old or new number (MATH 1A = MATH 51). */
  sameAs?: CourseId[];
  /** No longer offered under this number. */
  retired?: boolean;
  popularity?: number;
  prereqs?: string;
  url?: string;
}

export type CollegeId = "LS" | "CDSS" | "COE" | "HAAS" | "CED" | "CNR" | "CHEM" | string;

export interface College {
  id: CollegeId;
  name: string;
  requirementGroupId: string;
}

export interface Major {
  id: string;
  name: string;
  degree: string;
  college: CollegeId;
  requirementGroupIds: string[];
  /** Some programs (M.E.T., Chemical Engineering) have their own college-level group. */
  collegeGroupId?: string;
  universityGroupId?: string;
  programType?: string;
  url?: string;
  /** Lower-case shorthands students search by ("cs", "eecs", "cogsci"). */
  aliases?: string[];
}

export interface Minor {
  id: string;
  name: string;
  requirementGroupIds: string[];
  url?: string;
  aliases?: string[];
}

export interface SubjectInfo {
  code: string;
  aliases?: string[];
}

export interface CourseDetails {
  description?: string;
  prereqs?: string;
  offered?: string;
  grading?: string;
}

export interface CourseFilter {
  courses?: CourseId[];
  subjects?: string[];
  minNumber?: number;
  maxNumber?: number;
  breadth?: string;
  attribute?: string;
  exclude?: CourseId[];
}

export type Rule =
  | { type: "course"; course: CourseId; label?: string }
  /** `overlap`: the sub-rules are conditions on the same classes, so one class may meet several of them. */
  | { type: "allOf"; rules: Rule[]; label?: string; overlap?: boolean }
  | { type: "anyOf"; rules: Rule[]; label?: string }
  | { type: "nOf"; n: number; rules: Rule[]; label?: string }
  | { type: "filter"; count?: number; minUnits?: number; filter: CourseFilter; label?: string }
  | { type: "units"; minUnits: number; filter?: CourseFilter; label?: string }
  | { type: "manual"; text: string; mentionedCourses?: CourseId[]; label?: string };

export interface Requirement {
  id: string;
  title: string;
  /** Catalog block it sits in, e.g. "Lower Division". */
  section?: string;
  notes?: string;
  rule: Rule;
  /** Set when this requirement only applies to one option of a group choice (see GroupChoice). */
  choice?: string;
  option?: string;
  /** Honors and other extras: shown, never counted. */
  optional?: boolean;
}

/** A pick-one (or pick-n) inside a program, e.g. the Data Science domain emphasis. */
export interface GroupChoice {
  id: string;
  title: string;
  pick: number;
  options: { id: string; title: string }[];
}

export interface RequirementGroup {
  id: string;
  title: string;
  kind: "major" | "college" | "university" | "minor" | string;
  source?: string | string[];
  requirements: Requirement[];
  choices?: GroupChoice[];
  /** "major" | "joint-major" | "dual-degree" for program groups. */
  programType?: string;
}

export interface Phase {
  name: string;
  start: string;
  end: string;
  /** Dates are a guess from earlier years, not yet announced. */
  estimated?: boolean;
}

export interface Prediction {
  course: CourseId;
  professor?: string;
  professorSeenBefore: boolean;
  warning?: string | null;
  popularity: number;
  expectedFillDate?: string | null;
  fillsInPhase?: string | null;
  pFullByPhase?: Record<string, number>;
  recommendation?: string;
  confidence?: number | "high" | "medium" | "low" | string;
  basis?: "professor" | "course" | "department" | "global" | string;
  historyTerms?: number;
  /** Capacity listed when Phase 1 opened (before any seats were added). */
  capacity?: number | null;
  /** How often this class adds seats after enrollment opens, and by how much. */
  capacityExpansion?: { pExpands: number; expectedGrowth: number; pastTerms: number; pastTermsExpanded: number } | null;
  /** clearRate: share of the longest waitlist that ended up with a seat. */
  waitlist?: {
    pWaitlist: number;
    expectedPeak?: number | null;
    clearRate: number;
    pastTerms: number;
    pastTermsWithWaitlist: number;
    pastTermsMeasured?: number;
  } | null;
  /** 0..1 chance of ending up without a seat if the class is left for Phase 2. */
  waitRisk?: number | null;
  /** One sentence on whether waitlisting this class usually works. */
  advice?: string | null;
}

export interface PredictionsFile {
  term: Term;
  generatedAt: string;
  phases: Phase[];
  /** Units a continuing undergraduate can hold in Phase 1 (waitlisted units count). */
  phase1UnitCap?: number;
  predictions: Prediction[];
}

export interface ReservedSeats {
  group: string;
  enrolled: number;
  capacity: number;
}

export interface SectionSeats {
  course: CourseId;
  classNumber: string;
  section: string;
  /** Per the seat contract every section carries its term, e.g. "2026 Fall". */
  term?: Term;
  instructor?: string;
  enrolled: number;
  capacity: number;
  waitlisted?: number;
  waitlistCapacity?: number;
  open: boolean;
  reserved?: ReservedSeats[];
}

export interface SeatsFile {
  updatedAt: string;
  term: Term;
  sections: SectionSeats[];
}

export type InsightConfidence = "low" | "medium" | "high";

/** One professor's record in one class (data/insights/details). */
export interface ProfessorInsight {
  professor: string;
  /** Typical number of scheduled midterms when this professor taught it. */
  midterms?: number;
  /** RateMyProfessors quality, 1..5. */
  rmp?: number;
  rmpCount?: number;
  rmpDifficulty?: number;
  rmpUrl?: string;
  /** True when `rmp` comes from reviews of this professor in this very class. */
  rmpForThisClass?: boolean;
  /** Percent of RateMyProfessors reviewers who would take this professor again. */
  wouldTakeAgain?: number;
  /** Average grade (GPA) in this professor's offerings of the class. */
  gpa?: number;
  terms?: number;
  lastTaught?: Term;
  teachingNext?: Term;
  studentCount?: number;
  studentDifficulty?: number;
  studentUsefulness?: number;
  difficulty?: number;
  shouldTake?: number;
}

export interface InsightSignal {
  label: string;
  value: number;
  /** Share of the rating this signal carries, after reliability. */
  weight: number;
}

/**
 * Class ratings. `data/insights/insights.json` carries only course, difficulty, shouldTake
 * and confidence for every class; the rest comes per class from /api/course
 * (data/insights/details/<SUBJECT>.json).
 */
export interface CourseInsight {
  course: CourseId;
  summary?: string;
  /** 1..5, 5 = hardest. */
  difficulty?: number;
  /** 1..5, 5 = strongly yes. */
  shouldTake?: number;
  confidence?: InsightConfidence | { difficulty?: InsightConfidence; shouldTake?: InsightConfidence };
  signals?: { difficulty?: InsightSignal[]; shouldTake?: InsightSignal[] };
  byProfessor?: ProfessorInsight[];
  sentiment?: string;
  sentimentWrittenBy?: "model";
  midterms?: number;
  finalExam?: string;
  grades?: {
    average: number;
    letter: string;
    students: number;
    pctA?: number;
    pctBelowB?: number;
    pctPassNoPass?: number;
    distribution?: { letter: string; count: number }[];
  };
  studentRatings?: { count: number; difficulty: number; workload?: number; usefulness?: number; recordedPct?: number; attendanceRequiredPct?: number };
  reviews?: { text: string; term?: string; date?: string; title?: string; professor?: string; grade?: string; source?: string }[];
  reddit?: { title: string; url: string; score: number; date?: string }[];
  sources?: string[];
  stub?: boolean;
}

/** The full static catalog the client needs. */
export interface Catalog {
  courses: Course[];
  colleges: College[];
  majors: Major[];
  minors: Minor[];
  subjects: SubjectInfo[];
  groups: RequirementGroup[];
  predictions: PredictionsFile | null;
  seats: SeatsFile | null;
  insights: CourseInsight[];
  sources: Record<string, "data" | "stub" | "none">;
}

// ---- user state ----

export type Year = "Freshman" | "Sophomore" | "Junior" | "Senior" | "Transfer (Junior)" | "Fifth year+";

export interface TakenCourse {
  course: CourseId;
  term?: Term;
  grade?: string;
  units?: number;
  source: "transcript" | "manual" | "ap" | "transfer";
  /** For AP/transfer credit that maps to a requirement not a course. */
  label?: string;
}

export interface PlannedCourse {
  course: CourseId;
  professor?: string;
  /** Units the student entered for a class the catalog does not list. */
  units?: number;
  /** Chosen class numbers for the weekly schedule: the lecture plus at most one per discussion/lab kind. */
  sections?: string[];
}

export interface SemesterPlan {
  term: Term;
  courses: PlannedCourse[];
}

export interface PlannerState {
  version: 1;
  majorIds: string[];
  /** Minor ids (from minors.json). */
  minorGroupIds: string[];
  year: Year | null;
  startTerm: Term | null;
  taken: TakenCourse[];
  semesters: SemesterPlan[];
  manualChecks: Record<string, boolean>; // requirementKey -> done
  /** Course id -> requirement key it should count for (user override). */
  pins?: Record<string, string>;
  /** groupId -> choiceId -> chosen option ids (length <= pick). Absent in older saved plans. */
  choices?: Record<string, Record<string, string[]>>;
}
