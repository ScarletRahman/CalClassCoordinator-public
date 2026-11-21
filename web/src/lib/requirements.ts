import { courseNumberValue, courseUnits, subjectOf } from "./courseId";
import { familyOf } from "./crossList";
import type { Course, CourseFilter, CourseId, GroupChoice, Rule, RequirementGroup } from "./types";

export type CourseStatus = "taken" | "planned";

export interface StudentCourse {
  id: CourseId;
  status: CourseStatus;
  term?: string;
  units: number;
  /** A planned class in the term happening now. */
  inProgress?: boolean;
  /** AP, IB or other test credit: counts for unit totals only, never as a class. */
  credit?: boolean;
}

export interface RuleResult {
  /** Fully satisfied counting taken + planned. */
  satisfied: boolean;
  /** Fully satisfied by taken courses alone. */
  completed: boolean;
  /** 0..1 */
  progress: number;
  label: string;
  used: StudentCourse[];
  children?: RuleResult[];
  manual?: boolean;
  /** Courses that could still fill this rule (for suggestions). */
  candidates?: CourseId[];
  /** The catalog's name for this alternative or bin ("Language and Mind", "Africa"). */
  name?: string;
  /** For filter/units rules: the part of `have` that is finished (taken), in the same unit. */
  haveDone?: number;
  /** Rule type this result came from. */
  kind?: Rule["type"];
  /** For a `course` rule: the course asked for. */
  course?: CourseId;
  /** For filter/units/nOf/anyOf rules: how many are needed and how many the student has. */
  need?: number;
  have?: number;
  unit?: "classes" | "units" | "options";
  /** For filter/units rules: the filter, so the UI can list matching classes. */
  filter?: CourseFilter;
  /** For children of anyOf/nOf: whether this option is one of the n being counted. */
  chosen?: boolean;
}

export interface RequirementResult {
  key: string; // `${groupId}/${requirementId}`
  title: string;
  section?: string;
  notes?: string;
  result: RuleResult;
  /** Set when the requirement belongs to a chosen option of a group choice. */
  choice?: string;
  option?: string;
  /** Honors and other extras: shown, never counted in totals. */
  optional?: boolean;
}

export interface ChoiceOptionResult {
  id: string;
  title: string;
  /** Requirements this option adds, and how many the student's classes already cover. */
  total: number;
  satisfied: number;
  /** 0..1, average progress over the option's requirements. */
  progress: number;
}

export interface ChoiceResult {
  /** `${groupId}/choice:${choiceId}` */
  key: string;
  id: string;
  title: string;
  pick: number;
  chosen: string[];
  /** True while fewer than `pick` options are chosen; counts as one unmet requirement. */
  pending: boolean;
  /** Every option in catalog order, with a preview of how well the student's classes fit. */
  options: ChoiceOptionResult[];
  /** Best-fitting option not chosen yet, when at least one class already counts toward it. */
  suggested?: string;
  /** Index in `requirements` before which the "choose" row belongs (may equal its length). */
  insertAt: number;
}

export interface GroupResult {
  group: RequirementGroup;
  requirements: RequirementResult[];
  satisfied: number;
  completed: number;
  total: number;
  choices: ChoiceResult[];
}

export interface EvalContext {
  courseIndex: Map<CourseId, Course>;
  manualChecks: Record<string, boolean>;
  /** course id -> requirement key it is pinned to; pinned courses are only used there. */
  pins: Record<string, string>;
  /** groupId -> choiceId -> chosen option ids. */
  choices?: Record<string, Record<string, string[]>>;
}

export function buildCourseIndex(courses: Course[]): Map<CourseId, Course> {
  const idx = new Map<CourseId, Course>();
  for (const c of courses) idx.set(c.id, c);
  // A cross-listed id with no record of its own resolves to its sibling's record.
  for (const c of courses) for (const x of c.crossListed ?? []) if (!idx.has(x)) idx.set(x, c);
  return idx;
}

const familyKeyCache = new WeakMap<Map<CourseId, Course>, Map<CourseId, CourseId>>();

/** Cached family key (alphabetically first id of the cross-list family). */
export function familyKeyOf(id: CourseId, idx: Map<CourseId, Course>): CourseId {
  let cache = familyKeyCache.get(idx);
  if (!cache) familyKeyCache.set(idx, (cache = new Map()));
  let key = cache.get(id);
  if (key === undefined) {
    const members = familyOf(id, idx);
    key = [...members].sort()[0];
    for (const m of members) cache.set(m, key);
  }
  return key;
}

/** Two ids are the same course if equal or in the same cross-list family. */
export function sameCourse(a: CourseId, b: CourseId, idx: Map<CourseId, Course>): boolean {
  return a === b || familyKeyOf(a, idx) === familyKeyOf(b, idx);
}

/** One entry per cross-list family, preferring the taken one, keeping input order otherwise. */
export function dedupeStudentCourses(courses: StudentCourse[], idx: Map<CourseId, Course>): StudentCourse[] {
  const best = new Map<CourseId, StudentCourse>();
  for (const s of courses) {
    const k = familyKeyOf(s.id, idx);
    const cur = best.get(k);
    if (!cur || (cur.status !== "taken" && s.status === "taken")) best.set(k, s);
  }
  const keep = new Set(best.values());
  return courses.filter((s) => keep.has(s));
}

export function matchesFilter(id: CourseId, f: CourseFilter, idx: Map<CourseId, Course>): boolean {
  if (f.exclude?.some((x) => sameCourse(x, id, idx))) return false;
  if (f.courses && f.courses.length && !f.courses.some((x) => sameCourse(x, id, idx))) return false;
  const c = idx.get(id);
  if (f.subjects && f.subjects.length) {
    const subs = [...familyOf(id, idx).map(subjectOf), c ? c.subject : ""];
    if (!subs.some((s) => f.subjects!.includes(s))) return false;
  }
  const n = courseNumberValue(id);
  if (f.minNumber != null && !(n >= f.minNumber)) return false;
  if (f.maxNumber != null && !(n <= f.maxNumber)) return false;
  if (f.breadth && !(c?.breadths ?? []).includes(f.breadth)) return false;
  if (f.attribute) {
    const attrs = c?.attributes ?? [];
    if (f.attribute === "UD") {
      if (!(attrs.includes("UD") || (n >= 100 && n < 200))) return false;
    } else if (!attrs.includes(f.attribute)) {
      // R&C classes missing from the course list still follow the numbering rule: R1A, R5B.
      const num = id.split(" ").pop() ?? "";
      const rc = f.attribute === "RCA" ? /^[A-Z]?R\d+A$/ : f.attribute === "RCB" ? /^[A-Z]?R\d+B$/ : null;
      if (!(rc && !c && rc.test(num))) return false;
    }
  }
  return true;
}

function describeFilter(r: Extract<Rule, { type: "filter" | "units" }>, listed?: number): string {
  const f = r.filter ?? {};
  const bits: string[] = [];
  if (r.type === "filter" && r.count) bits.push(`${r.count} ${r.count > 1 ? "classes" : "class"}`);
  const minUnits = r.type === "units" ? r.minUnits : r.minUnits;
  if (minUnits) bits.push(`${minUnits} units`);
  if (f.breadth) bits.push(`in ${f.breadth}`);
  if (f.attribute === "UD") bits.push("in the upper division");
  else if (f.attribute) bits.push(`that ${r.type === "filter" && r.count === 1 ? "meets" : "meet"} ${ATTRIBUTE_NAMES[f.attribute] ?? f.attribute}`);
  if (f.subjects?.length) bits.push(`in ${f.subjects.join("/")}`);
  if (f.minNumber != null && f.maxNumber != null) bits.push(`numbered ${f.minNumber}–${f.maxNumber}`);
  else if (f.minNumber != null) bits.push(`numbered ${f.minNumber}+`);
  // `listed` is the list length with cross-listed twins counted once, so it matches what is shown.
  if (f.courses?.length && f.courses.length <= 6) bits.push(`from ${f.courses.join(", ")}`);
  else if (f.courses?.length) bits.push(`from ${listed ?? f.courses.length} approved classes`);
  return bits.join(" ") || "Classes";
}

export function describeRule(rule: Rule): string {
  switch (rule.type) {
    case "course":
      return rule.course;
    case "allOf":
      return "All of";
    case "anyOf":
      return "One of";
    case "nOf":
      return `${rule.n} of`;
    case "filter":
    case "units":
      return describeFilter(rule);
    case "manual":
      return rule.text;
  }
}

const statusRank = (s: StudentCourse) => (s.status === "taken" ? 0 : 1);

/**
 * Evaluate a rule against the student's courses. `used` is the set of course ids already
 * consumed by earlier requirements in the same group; it is mutated as courses are claimed.
 * Claiming a course claims its whole cross-list family, so DATA C100 and STAT C100 can never
 * count as two classes.
 */
export function evaluateRule(
  rule: Rule,
  courses: StudentCourse[],
  used: Set<CourseId>,
  ctx: EvalContext,
  reqKey: string,
): RuleResult {
  const res = evaluateRuleInner(rule, courses, used, ctx, reqKey);
  const name = rule.label?.trim();
  return name ? { ...res, name } : res;
}

/** A trial result that is not being counted must not look like it claimed any class. */
function unclaimed(res: RuleResult): RuleResult {
  return { ...res, used: [], satisfied: false, completed: false, chosen: false, children: res.children?.map(unclaimed) };
}

function evaluateRuleInner(rule: Rule, courses: StudentCourse[], used: Set<CourseId>, ctx: EvalContext, reqKey: string): RuleResult {
  const idx = ctx.courseIndex;
  const available = (id: CourseId) => !used.has(id) && (!ctx.pins[id] || ctx.pins[id] === reqKey);
  const claim = (id: CourseId) => {
    for (const m of familyOf(id, idx)) used.add(m);
  };
  // Stable: taken before planned, otherwise the order the student's classes came in.
  const sorted = [...courses].sort((a, b) => statusRank(a) - statusRank(b));

  switch (rule.type) {
    case "course": {
      const hit = sorted.find((s) => !s.credit && available(s.id) && sameCourse(s.id, rule.course, idx));
      if (hit) claim(hit.id);
      return {
        kind: "course",
        course: rule.course,
        satisfied: !!hit,
        completed: hit?.status === "taken",
        progress: hit ? 1 : 0,
        label: rule.course,
        used: hit ? [hit] : [],
        candidates: hit ? [] : [rule.course],
      };
    }
    case "manual": {
      const done = !!ctx.manualChecks[reqKey];
      return { kind: "manual", satisfied: done, completed: done, progress: done ? 1 : 0, label: rule.text, used: [], manual: true, candidates: rule.mentionedCourses };
    }
    case "allOf": {
      let children: RuleResult[];
      if (rule.overlap) {
        // Conditions on the same set of classes (six H/SS courses, two of them upper division):
        // each one is checked on its own, then everything they used is claimed together.
        const sets = rule.rules.map(() => new Set(used));
        children = rule.rules.map((r, i) => evaluateRule(r, courses, sets[i], ctx, `${reqKey}.${i}`));
        for (const set of sets) for (const id of set) used.add(id);
      } else {
        children = rule.rules.map((r, i) => evaluateRule(r, courses, used, ctx, `${reqKey}.${i}`));
      }
      return { ...combine("All of", children, children.length), kind: "allOf", need: children.length, have: children.filter((c) => c.satisfied).length, unit: "options" };
    }
    case "anyOf":
    case "nOf": {
      const n = Math.max(1, rule.type === "anyOf" ? 1 : rule.n);
      // Pick the n best options one at a time: each pick is scored against what earlier picks
      // left over, so two options can't both count the same class. Ties go to the option listed
      // first, which keeps the result the same from one render to the next.
      const picked = new Map<number, RuleResult>();
      for (let k = 0; k < n && picked.size < rule.rules.length; k++) {
        let best = -1;
        let bestScore = -1;
        rule.rules.forEach((r, i) => {
          if (picked.has(i)) return;
          const sc = score(evaluateRule(r, courses, new Set(used), ctx, `${reqKey}.${i}`));
          if (sc > bestScore) {
            best = i;
            bestScore = sc;
          }
        });
        if (best < 0) break;
        // Once the remaining options add nothing, stop claiming so later picks stay "open".
        if (bestScore <= 0 && k > 0) break;
        picked.set(best, evaluateRule(rule.rules[best], courses, used, ctx, `${reqKey}.${best}`));
      }
      const children: RuleResult[] = rule.rules.map((r, i) => {
        const hit = picked.get(i);
        if (hit) return { ...hit, chosen: true };
        const trial = evaluateRule(r, courses, new Set(used), ctx, `${reqKey}.${i}`);
        // Not counted here, so it claims nothing; progress stays as a hint for the UI.
        return { ...unclaimed(trial), progress: trial.progress };
      });
      const counted = [...picked.values()];
      const res = combine(rule.type === "anyOf" ? "One of" : `${n} of`, counted, n);
      return { ...res, children, kind: rule.type, need: n, have: counted.filter((c) => c.satisfied).length, unit: "options" };
    }
    case "filter":
    case "units": {
      const f = rule.filter ?? {};
      const needCount = rule.type === "filter" ? rule.count ?? 0 : 0;
      const needUnits = rule.minUnits ?? 0;
      // "units" rules over everything (e.g. 120 total) don't consume courses.
      const consumes = rule.type === "filter";
      const hits: StudentCourse[] = [];
      const seen = new Set<CourseId>();
      let units = 0;
      for (const s of sorted) {
        if (needCount && hits.length >= needCount && (!needUnits || units >= needUnits)) break;
        if (!needCount && needUnits && units >= needUnits) break;
        if (consumes && !available(s.id)) continue;
        if (s.credit && consumes) continue; // test credit adds units, it is not a class
        const fam = familyKeyOf(s.id, idx);
        if (seen.has(fam)) continue; // a cross-listed sibling of a class already counted
        if (!matchesFilter(s.id, f, idx)) continue;
        seen.add(fam);
        hits.push(s);
        units += s.units;
      }
      if (consumes) hits.forEach((h) => claim(h.id));
      const pc = needCount ? Math.min(1, hits.length / needCount) : 1;
      const pu = needUnits ? Math.min(1, units / needUnits) : 1;
      const takenUnits = hits.filter((h) => h.status === "taken").reduce((a, h) => a + h.units, 0);
      const takenCount = hits.filter((h) => h.status === "taken").length;
      const satisfied = pc >= 1 && pu >= 1 && (needCount > 0 || needUnits > 0);
      const completed =
        satisfied && (!needCount || takenCount >= needCount) && (!needUnits || takenUnits >= needUnits);
      const byUnits = !needCount || (needUnits > 0 && pu < pc);
      return {
        kind: rule.type,
        satisfied,
        completed,
        progress: Math.min(pc, pu),
        label: describeFilter(rule, f.courses ? new Set(f.courses.map((c) => familyKeyOf(c, idx))).size : undefined),
        used: hits,
        candidates: f.courses?.filter((c) => !seen.has(familyKeyOf(c, idx))),
        need: byUnits ? needUnits : needCount,
        have: byUnits ? units : hits.length,
        haveDone: byUnits ? takenUnits : takenCount,
        unit: byUnits ? "units" : "classes",
        filter: f,
      };
    }
  }
}

function score(r: RuleResult) {
  return (r.completed ? 2 : 0) + (r.satisfied ? 1 : 0) + r.progress;
}

function combine(label: string, children: RuleResult[], need: number): RuleResult {
  const satisfied = children.filter((c) => c.satisfied).length >= need && children.length >= need;
  const completed = children.filter((c) => c.completed).length >= need && children.length >= need;
  const progress = need ? Math.min(1, children.reduce((a, c) => a + c.progress, 0) / need) : 1;
  return { satisfied, completed, progress, label, used: children.flatMap((c) => c.used), children };
}

/** Chosen option ids for one choice, cleaned against the catalog (unknown ids dropped, capped at pick). */
export function chosenOptions(choice: GroupChoice, groupId: string, choices: EvalContext["choices"]): string[] {
  const raw = choices?.[groupId]?.[choice.id];
  if (!Array.isArray(raw)) return [];
  const valid = new Set(choice.options.map((o) => o.id));
  return [...new Set(raw.filter((id) => typeof id === "string" && valid.has(id)))].slice(0, Math.max(1, choice.pick));
}

/**
 * Evaluate one program. Requirements tied to a choice (`choice`/`option`, e.g. a Data Science
 * domain emphasis) are only included once that option is chosen. An unmade choice counts as one
 * unmet requirement; the other options are evaluated only for the "how well does this fit"
 * preview in `choices`, never for totals.
 */
export function evaluateGroup(group: RequirementGroup, courses: StudentCourse[], ctx: EvalContext): GroupResult {
  const used = new Set<CourseId>();
  // A major or minor counts each class once. College and university rules are independent of
  // each other: one class may meet American Cultures and a breadth and the unit total at once.
  const shared = isProgramKind(group.kind);
  const groupChoices = group.choices ?? [];
  const choiceById = new Map(groupChoices.map((c) => [c.id, c]));
  const chosen = new Map(groupChoices.map((c) => [c.id, chosenOptions(c, group.id, ctx.choices)]));
  const isActive = (r: { choice?: string; option?: string }) =>
    !r.choice || !choiceById.has(r.choice) || (!!r.option && chosen.get(r.choice)!.includes(r.option));

  const active = group.requirements.map((r, dataIndex) => ({ r, dataIndex })).filter(({ r }) => isActive(r));
  // Evaluate specific requirements before broad filters so a broad filter doesn't steal a
  // course a specific requirement needs. Rows keep the catalog's order whatever their status.
  const order = active.map(({ r }, i) => ({ r, i, w: specificity(r.rule) })).sort((a, b) => b.w - a.w || a.i - b.i);
  const results: RequirementResult[] = new Array(active.length);
  const evalReq = (r: RequirementGroup["requirements"][number], claimed: Set<CourseId>): RequirementResult => {
    const key = `${group.id}/${r.id}`;
    return {
      key,
      title: (r.title ?? "").trim(),
      section: r.section?.trim() || undefined,
      notes: r.notes?.trim() || undefined,
      result: evaluateRule(r.rule, courses, claimed, ctx, key),
      ...(r.choice && choiceById.has(r.choice) ? { choice: r.choice, option: r.option } : {}),
      ...(r.optional ? { optional: true } : {}),
    };
  };
  for (const { r, i } of order) results[i] = evalReq(r, shared ? used : new Set());

  // Pool for the option previews: what the requirements everyone shares leave over. It is the
  // same whatever is currently chosen, so an option's match does not move when you pick one.
  const common = new Set<CourseId>();
  if (groupChoices.length && shared) {
    const everyone = group.requirements.filter((r) => !r.choice || !choiceById.has(r.choice));
    for (const r of [...everyone].sort((a, b) => specificity(b.rule) - specificity(a.rule))) evalReq(r, common);
  }

  const choices: ChoiceResult[] = groupChoices.map((c) => {
    const mine = chosen.get(c.id)!;
    const options: ChoiceOptionResult[] = c.options.map((o) => {
      const reqs = group.requirements.filter((r) => r.choice === c.id && r.option === o.id);
      const scratch = new Set(common);
      const res = [...reqs].sort((a, b) => specificity(b.rule) - specificity(a.rule)).map((r) => evalReq(r, shared ? scratch : new Set()).result);
      return {
        id: o.id,
        title: o.title,
        total: res.length,
        satisfied: res.filter((x) => x.satisfied).length,
        progress: res.length ? res.reduce((a, x) => a + x.progress, 0) / res.length : 0,
      };
    });
    const pending = mine.length < Math.max(1, c.pick);
    const open = options.filter((o) => !mine.includes(o.id) && o.progress > 0);
    const suggested = pending ? [...open].sort((a, b) => b.progress - a.progress || b.satisfied - a.satisfied)[0]?.id : undefined;
    let lastOfChoice = -1;
    group.requirements.forEach((r, i) => {
      if (r.choice === c.id) lastOfChoice = i;
    });
    const insertAt = lastOfChoice < 0 ? active.length : active.filter((a) => a.dataIndex <= lastOfChoice).length;
    return { key: `${group.id}/choice:${c.id}`, id: c.id, title: c.title, pick: Math.max(1, c.pick), chosen: mine, pending, options, suggested, insertAt };
  });

  const pendingCount = choices.filter((c) => c.pending).length;
  const counted = results.filter((r) => !r.optional);
  return {
    group,
    requirements: results,
    satisfied: counted.filter((r) => r.result.satisfied).length,
    completed: counted.filter((r) => r.result.completed).length,
    total: counted.length + pendingCount,
    choices,
  };
}

function specificity(rule: Rule): number {
  switch (rule.type) {
    case "course":
      return 3;
    case "allOf":
    case "anyOf":
    case "nOf":
      return Math.min(...rule.rules.map(specificity), 3);
    case "filter":
      return rule.filter.courses?.length ? 2 : 1;
    case "units":
      return 0;
    case "manual":
      return 3;
  }
}

/** AP, IB and similar exam credit: an entry that is not a Berkeley class. */
export function isTestCredit(t: { course: CourseId; source?: string }): boolean {
  return t.source === "ap" || /^(AP|IB|GCE|A-?LEVEL)\s/i.test(t.course);
}

/**
 * The student's classes for the evaluator. `now` is the current term ("2026 Fall"): a planned
 * class in that term is marked in progress. Test credit keeps its units but is flagged so it
 * only feeds unit totals.
 */
export function toStudentCourses(
  taken: { course: CourseId; units?: number; term?: string; source?: string }[],
  planned: { course: CourseId; term: string; units?: number }[],
  idx: Map<CourseId, Course>,
  now?: string,
): StudentCourse[] {
  // The student's own number first, then the catalog; a class we know nothing about adds 0.
  const unitsOf = (id: CourseId, own?: number) => (typeof own === "number" && isFinite(own) ? own : idx.has(id) ? courseUnits(idx.get(id)) : 0);
  return [
    ...taken.map((t) =>
      // Credit the student mapped to a real Berkeley class (AP Calculus AB as MATH 1A) counts as that class.
      isTestCredit(t) && !idx.has(t.course)
        ? { id: t.course, status: "taken" as const, term: t.term, units: t.units ?? 0, credit: true }
        : { id: t.course, status: "taken" as const, term: t.term, units: unitsOf(t.course, t.units) },
    ),
    ...planned.map((p) => ({
      id: p.course,
      status: "planned" as const,
      term: p.term,
      units: unitsOf(p.course, p.units),
      ...(now && p.term === now ? { inProgress: true } : {}),
    })),
  ];
}

// ---- classes that count for more than one program ----

/** Majors, minors, joint majors and so on: everything except college and university rules. */
export function isProgramKind(kind: string): boolean {
  return kind !== "college" && kind !== "university";
}

export interface OverlapProgram {
  groupId: string;
  /** Short name for badges ("CogSci", "DS"). */
  label: string;
  title: string;
  kind: string;
}

export interface OverlapEntry {
  /** The family member to show and act on: the one the student has, else the first one seen. */
  id: CourseId;
  /** Other ids of the same cross-listed class. */
  also: CourseId[];
  status?: CourseStatus;
  term?: string;
  /** A planned class in the current term. */
  inProgress?: boolean;
  /** Group ids of the student's programs this class counts for (or could), in program order. */
  programs: string[];
  /** Titles of college or university requirements it also meets (or could meet), e.g. a breadth. */
  breadth: string[];
  /**
   * The requirements behind `programs`. `selfCheck` marks ones the student ticks off by hand;
   * `have`/`need` are set when the requirement is only partly filled so far.
   */
  requirements: { groupId: string; key: string; title: string; selfCheck?: boolean; have?: number; need?: number }[];
  /** How many of those requirements are still open (0 for classes already counting). */
  closes: number;
}

export interface OverlapResult {
  programs: OverlapProgram[];
  /** Taken or planned classes already counted by two or more programs. */
  counting: OverlapEntry[];
  /** Classes not in the plan that sit in open requirements of two or more programs, best first. */
  could: OverlapEntry[];
  /** Every id of every family worth a badge: 2+ programs, or one program plus a breadth. */
  byCourse: Map<CourseId, OverlapEntry>;
}

/** Courses a requirement is counting, ignoring unit totals that don't consume classes. */
export function claimedCourses(res: RuleResult): StudentCourse[] {
  if (res.kind === "units") return [];
  // Options tried but not counted (the unchosen side of a "one of") claim nothing.
  if (res.children) return res.children.filter((c) => c.chosen !== false).flatMap(claimedCourses);
  return res.used;
}

/** Explicitly listed courses that would still help an unmet rule. Self-check prose is left out. */
export function openCandidates(res: RuleResult): CourseId[] {
  if (res.satisfied || res.manual || res.kind === "units") return [];
  if (res.children) {
    // In an n-of, options already counted are closed; the rest are all still possible.
    return res.children.filter((c) => !(c.chosen && c.satisfied)).flatMap((c) => openCandidates({ ...c, satisfied: false }));
  }
  return res.candidates ?? [];
}

/** Classes named in the prose of self-check rules the student has not ticked yet. */
function openMentions(res: RuleResult): CourseId[] {
  if (res.satisfied) return [];
  if (res.manual) return res.candidates ?? [];
  if (res.children) return res.children.filter((c) => !(c.chosen && c.satisfied)).flatMap((c) => openMentions({ ...c, satisfied: false }));
  return [];
}

/** Open filter rules with no explicit course list (a breadth area, a subject range). */
function openFilters(res: RuleResult): CourseFilter[] {
  if (res.satisfied || res.manual || res.kind === "units") return [];
  if (res.children) return res.children.filter((c) => !(c.chosen && c.satisfied)).flatMap((c) => openFilters({ ...c, satisfied: false }));
  const f = res.filter;
  if (!f || f.courses?.length) return [];
  // A filter with nothing to narrow it would match every class in the catalog.
  return f.subjects?.length || f.breadth || f.attribute || f.minNumber != null || f.maxNumber != null ? [f] : [];
}

/**
 * Which classes count (or could count) for two or more of the student's programs.
 * Takes the already evaluated groups, so it costs one pass over their results. Cross-listed
 * families are one class. Only majors and minors make an overlap; a college or university
 * requirement the class also meets is reported in `breadth`.
 */
export function computeOverlap(
  results: GroupResult[],
  students: StudentCourse[],
  ctx: { courseIndex: Map<CourseId, Course> },
  labels: Record<string, string> = {},
): OverlapResult {
  const idx = ctx.courseIndex;
  const fam = (id: CourseId) => familyKeyOf(id, idx);
  const programResults = results.filter((g) => isProgramKind(g.group.kind));
  const otherResults = results.filter((g) => !isProgramKind(g.group.kind));
  const programs: OverlapProgram[] = programResults.map((g) => ({
    groupId: g.group.id,
    label: labels[g.group.id] ?? g.group.title,
    title: g.group.title,
    kind: g.group.kind,
  }));

  const held = new Map<CourseId, StudentCourse>();
  for (const s of dedupeStudentCourses(students, idx)) held.set(fam(s.id), s);

  type Ref = { key: string; title: string; selfCheck?: boolean; have?: number; need?: number };
  interface Acc {
    firstSeen: CourseId;
    counting: Map<string, Ref[]>;
    open: Map<string, Ref[]>;
    breadthCounting: Set<string>;
    breadthOpen: Set<string>;
  }
  const acc = new Map<CourseId, Acc>();
  const entry = (id: CourseId) => {
    const k = fam(id);
    let a = acc.get(k);
    if (!a) acc.set(k, (a = { firstSeen: id, counting: new Map(), open: new Map(), breadthCounting: new Set(), breadthOpen: new Set() }));
    return a;
  };
  const push = (m: Map<string, Ref[]>, groupId: string, req: Ref) => {
    const list = m.get(groupId);
    if (!list) m.set(groupId, [req]);
    else if (!list.some((r) => r.key === req.key)) list.push(req);
  };

  const pendingFilters: { groupId: string; req: Ref; filters: CourseFilter[] }[] = [];
  for (const g of programResults) {
    for (const req of g.requirements) {
      if (req.optional) continue;
      // Inside a chosen emphasis the row titles are generic ("Upper Division"): name the emphasis.
      const choice = req.choice ? g.choices.find((c) => c.id === req.choice) : undefined;
      const option = choice?.options.find((o) => o.id === req.option);
      const title = option ? `${option.title} ${choice!.title.split(/\s+/).pop()!.toLowerCase()}` : req.title;
      const ref: Ref = { key: req.key, title };
      const partial = fractionOf(req.result);
      // Counting means the evaluator really used the class for this requirement.
      for (const u of claimedCourses(req.result)) {
        if (!u.credit) push(entry(u.id).counting, g.group.id, req.result.satisfied || !partial ? ref : { ...ref, ...partial });
      }
      for (const c of openCandidates(req.result)) if (!held.has(fam(c))) push(entry(c).open, g.group.id, ref);
      // A class the catalog names in a self-check rule ("complete 3 of: ...") counts there too,
      // once the student ticks the box; say so rather than hide it.
      for (const c of openMentions(req.result)) {
        if (held.has(fam(c))) continue; // not counted until the student ticks the box
        const e = entry(c);
        if (!e.open.get(g.group.id)?.length) push(e.open, g.group.id, { ...ref, selfCheck: true });
      }
      const filters = openFilters(req.result);
      if (filters.length) pendingFilters.push({ groupId: g.group.id, req: ref, filters });
    }
  }
  // A class listed by one program may also fit an open "any upper-division X" rule of another.
  const known = [...acc.entries()];
  for (const { groupId, req, filters } of pendingFilters) {
    for (const [k, a] of known) {
      if (held.has(k) || a.open.get(groupId)?.some((r) => r.key === req.key)) continue;
      if (filters.some((f) => matchesFilter(a.firstSeen, f, idx))) push(a.open, groupId, req);
    }
  }
  for (const g of otherResults) {
    for (const req of g.requirements) {
      if (req.result.manual) continue;
      // Name the breadth area itself ("Historical Studies"), not the umbrella requirement.
      for (const leaf of leaves(req.result)) {
        if (leaf.kind === "units" || leaf.manual) continue;
        const name = breadthName(leaf.filter) ?? req.title;
        for (const u of leaf.used) acc.get(fam(u.id))?.breadthCounting.add(name);
      }
      if (req.result.satisfied) continue;
      const explicit = new Set(openCandidates(req.result).map(fam));
      // Only real "this class also covers X" rules: a breadth area, American Cultures, R&C.
      const filters = openFilters(req.result).filter((f) => breadthName(f));
      if (!explicit.size && !filters.length) continue;
      for (const [k, a] of known) {
        if (held.has(k)) continue;
        if (explicit.has(k)) a.breadthOpen.add(req.title);
        for (const f of filters) if (matchesFilter(a.firstSeen, f, idx)) a.breadthOpen.add(breadthName(f)!);
      }
    }
  }

  const order = new Map(programs.map((p, i) => [p.groupId, i]));
  const sortGroups = (ids: string[]) => ids.sort((a, b) => order.get(a)! - order.get(b)!);
  const counting: OverlapEntry[] = [];
  const could: OverlapEntry[] = [];
  const byCourse = new Map<CourseId, OverlapEntry>();
  for (const [k, a] of acc) {
    const student = held.get(k);
    const source = student ? a.counting : a.open;
    const programIds = sortGroups([...source.keys()]);
    const breadth = [...(student ? a.breadthCounting : a.breadthOpen)];
    if (programIds.length < 2 && !(programIds.length === 1 && breadth.length)) continue;
    const id = student?.id ?? a.firstSeen;
    const requirements = programIds.flatMap((groupId) => source.get(groupId)!.map((r) => ({ groupId, ...r })));
    const e: OverlapEntry = {
      id,
      also: familyOf(id, idx).filter((m) => m !== id).sort(),
      status: student?.status,
      term: student?.term,
      ...(student?.inProgress ? { inProgress: true } : {}),
      programs: programIds,
      breadth,
      requirements,
      closes: student ? 0 : requirements.filter((r) => !r.selfCheck).length,
    };
    for (const m of familyOf(id, idx)) byCourse.set(m, e);
    if (programIds.length >= 2) (student ? counting : could).push(e);
  }
  counting.sort((x, y) => y.programs.length - x.programs.length || statusRankOf(x) - statusRankOf(y) || x.id.localeCompare(y.id, undefined, { numeric: true }));
  could.sort((x, y) => y.programs.length - x.programs.length || y.closes - x.closes || y.breadth.length - x.breadth.length || x.id.localeCompare(y.id, undefined, { numeric: true }));
  return { programs, counting, could, byCourse };
}

/** "1 of 2" for a requirement that is only partly filled, when it has one countable part. */
function fractionOf(res: RuleResult): { have: number; need: number } | undefined {
  if (res.satisfied) return undefined;
  if (res.need && res.need > 1 && res.have != null) return { have: res.have, need: res.need };
  return undefined;
}

/** Does this rule name or match the class at all, whether or not it is already met? */
function ruleAccepts(res: RuleResult, course: CourseId, idx: Map<CourseId, Course>): boolean {
  if (res.manual || res.kind === "units") return false;
  if (res.children) return res.children.some((c) => ruleAccepts(c, course, idx));
  if (res.course) return sameCourse(res.course, course, idx);
  if (res.filter) {
    const f = res.filter;
    const narrowed = !!(f.courses?.length || f.subjects?.length || f.breadth || f.attribute || f.minNumber != null || f.maxNumber != null);
    return narrowed && matchesFilter(course, f, idx);
  }
  return false;
}

/**
 * For a class the student is about to add: if every requirement it could count for is already
 * met, say which and by what ("R&C Part B, already met by COMLIT R1B"). Empty when the class
 * would still help somewhere, or counts for nothing we track.
 */
export function alreadyMetBy(course: CourseId, groups: GroupResult[], idx: Map<CourseId, Course>): { groupId: string; requirement: string; by: CourseId[] }[] {
  const met: { groupId: string; requirement: string; by: CourseId[] }[] = [];
  for (const g of groups) {
    for (const req of g.requirements) {
      for (const part of req.result.kind === "allOf" && req.result.children ? req.result.children : [req.result]) {
        if (!ruleAccepts(part, course, idx)) continue;
        if (!part.satisfied) return [];
        const by = claimedCourses(part).map((u) => u.id);
        if (by.some((b) => sameCourse(b, course, idx))) return [];
        met.push({ groupId: g.group.id, requirement: part.name ?? req.title, by });
      }
    }
  }
  return met;
}

const LANGUAGE_EXAM = /\b(spanish|french|german|italian|chinese|japanese|korean|latin|hebrew|arabic|russian|portuguese)\b/i;

/**
 * Test or transfer credit on record that plausibly covers a requirement, for a "tick this if it
 * covers it" hint. A match needs the catalog note to name the exam, or an obvious pairing
 * (AP US History with American History and Institutions, AP Calculus with Quantitative
 * Reasoning, AP English with Reading and Composition, a language exam with the language rule).
 */
export function creditHints(req: { title: string; notes?: string; text?: string }, credits: { course: CourseId; label?: string }[]): string[] {
  const hay = `${req.title}\n${req.notes ?? ""}\n${req.text ?? ""}`.toLowerCase();
  const title = `${req.title} ${req.text ?? ""}`.toLowerCase();
  const out: string[] = [];
  for (const c of credits) {
    const name = (c.label?.trim() || c.course).replace(/\s+/g, " ");
    const subject = name.toLowerCase().replace(/^(ap|ib|a-?level|gce)\b[:\s]*/i, "").replace(/\b(exam|test|hl|sl|higher level|standard level)\b/g, "").trim();
    if (!subject) continue;
    const words = subject.split(/[^a-z]+/).filter((w) => w.length > 2 && !["and", "the", "language", "literature", "composition", "culture"].includes(w));
    // The note lists exams as "AP: Statistics, score 3+".
    const named = /\b(ap|ib|a-?level|exam)\b/.test(hay) && words.length > 0 && words.every((w) => hay.includes(w));
    const pair =
      (/(u\.?s\.? history|united states history|government)/.test(subject) && /(american history|institutions|ah&i)/.test(title)) ||
      (/(calculus|statistics|computer science)/.test(subject) && /quantitative reasoning/.test(title)) ||
      (/english/.test(subject) && /(reading and composition|r&c|entry level writing)/.test(title)) ||
      (LANGUAGE_EXAM.test(subject) && /(foreign language|language requirement)/.test(title));
    if ((named || pair) && !out.includes(name)) out.push(name);
  }
  return out;
}

function leaves(res: RuleResult): RuleResult[] {
  return res.children ? res.children.flatMap(leaves) : [res];
}

const ATTRIBUTE_NAMES: Record<string, string> = {
  AC: "American Cultures",
  "AH&I": "American History and Institutions",
  ELW: "Entry Level Writing",
  RCA: "Reading and Composition A",
  RCB: "Reading and Composition B",
  FL: "Foreign language",
  HSS: "Humanities and social sciences",
};

function breadthName(f?: CourseFilter): string | undefined {
  if (!f) return undefined;
  if (f.breadth) return f.breadth;
  if (f.attribute && f.attribute !== "UD") return ATTRIBUTE_NAMES[f.attribute] ?? f.attribute;
  return undefined;
}

const statusRankOf = (e: OverlapEntry) => (e.status === "taken" ? 0 : 1);
