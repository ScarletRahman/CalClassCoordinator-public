import { courseNumberValue, normalizeCourseId, normalizeSubject } from "./courseId";
import { familyMembers } from "./courseFamily";
import type { Course, CourseId } from "./types";

/**
 * Class search for the planner: loose input ("data 100", "cs61a", "r1a", "linear algebra") over
 * the catalog, one row per cross-list family. Pure so it can be tested against the real data.
 *
 * Ranking, best first:
 *   0  exact id                              "compsci 61a", "cs 61a", "cs61a"
 *   1  exact but for the C/R/W/N/H prefix    "data 100" -> DATA C100, "english 1a" -> ENGLISH R1A
 *   2  number typed alone, exact             "61a", "r1a" (every department's R1A)
 *   3  id prefix within the subject          "cs 61" -> 61A, 61B, 61C; a subject alone lists it
 *   4  looser id matches                     subject prefix, number prefix across subjects
 *   5  suggestions only, never picked by Enter: the closest numbers in the typed subject when it
 *      has no such class ("mcb 160"), or the same number elsewhere when the subject is unknown
 *   6  title, every typed word starts a word "structure and interp"
 *   7  title contains the text
 * Inside a tier classes sort by number (numeric-aware), then code, extension (X...) subjects last.
 */

export type Range = [start: number, end: number];

export interface SearchHit {
  /** The code to show and add: the member the query matched, else the family's usual code. */
  id: CourseId;
  /** The class's other cross-listed codes. */
  also: CourseId[];
  /** Retired numbers of this same class ("RHETOR 1A" for RHETOR R1A). */
  formerly: CourseId[];
  /** Other current numbers of this same class (MATH 1B and MATH 52 while both are listed). */
  sameAs: CourseId[];
  /** Not a match for what was typed, only a nearby class. Enter must not add it. */
  suggestion: boolean;
  title: string;
  units: number | [number, number];
  tier: number;
  /** Highlight ranges inside `id` and `title`. */
  idRanges: Range[];
  titleRanges: Range[];
}

export interface SearchResult {
  hits: SearchHit[];
  /** How many classes matched before the limit was applied. */
  total: number;
  /** True when a hit is the class the query names (tier 0 or 1). */
  exact: boolean;
  /** A well-formed id for "add anyway" when the query names a class the catalog lacks. */
  custom: CourseId | null;
  /** "MCELLBI 160" when the query names a real subject that has no such number. */
  missing: CourseId | null;
}

interface Member {
  id: CourseId;
  subject: string;
  number: string;
  /** Number without its leading letters: C100 -> 100, R1A -> 1A. */
  core: string;
  value: number;
  retired: boolean;
  /** Ids this one is a renumbering of (sameAs links, either direction). */
  sameAs: Set<CourseId>;
}

interface Family {
  rep: CourseId;
  members: Member[];
  title: string;
  titleLower: string;
  words: { text: string; at: number }[];
  units: number | [number, number];
  popularity: number;
}

export interface SearchIndex {
  families: Family[];
  subjects: Set<string>;
  ids: Set<CourseId>;
}

/** Subject codes students use for classes that are listed under a sibling department. */
const RELATED_SUBJECTS: Record<string, string[]> = {
  EECS: ["ELENG", "COMPSCI"],
  ELENG: ["EECS"],
  COMPSCI: ["EECS"],
  ED: ["ENVDES"],
};

/** The code students say first for a family with no other signal: Data 8, Data 100, Data 140. */
const HOME_SUBJECTS = ["DATA"];

const NUM = /^[A-Z]{0,2}\d{1,3}[A-Z]{0,3}$/;
const core = (n: string) => n.replace(/^[A-Z]+(?=\d)/, "");
const isExtension = (subject: string) => /^X[A-Z]{3,}/.test(subject);

function toMember(id: CourseId, retired = false): Member {
  const sp = id.lastIndexOf(" ");
  const subject = id.slice(0, sp);
  const number = id.slice(sp + 1);
  return { id, subject, number, core: core(number), value: courseNumberValue(number), retired, sameAs: new Set() };
}

function wordsOf(lower: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  const re = /[a-z0-9]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) out.push({ text: m[0], at: m.index });
  return out;
}

export function buildSearchIndex(courses: Course[]): SearchIndex {
  const byId = new Map(courses.map((c) => [c.id, c]));
  const done = new Set<CourseId>();
  const families: Family[] = [];
  for (const c of courses) {
    if (done.has(c.id)) continue;
    const ids = familyMembers(c.id, byId).sort();
    ids.forEach((i) => done.add(i));
    const members = ids.map((i) => toMember(i, !!byId.get(i)?.retired));
    for (const m of members)
      for (const x of byId.get(m.id)?.sameAs ?? []) {
        m.sameAs.add(x);
        members.find((o) => o.id === x)?.sameAs.add(m.id);
      }
    const live = members.filter((m) => !m.retired);
    const pool = live.length ? live : members;
    const home = pool.find((m) => HOME_SUBJECTS.includes(m.subject)) ?? pool.find((m) => !isExtension(m.subject)) ?? pool[0];
    const rec = byId.get(home.id) ?? c;
    const titleLower = rec.title.toLowerCase();
    const popularity = Math.max(0, ...ids.map((i) => byId.get(i)?.popularity ?? 0));
    families.push({ rep: home.id, members, title: rec.title, titleLower, words: wordsOf(titleLower), units: rec.units, popularity });
  }
  return { families, subjects: new Set(courses.map((c) => c.subject)), ids: new Set(families.flatMap((f) => f.members.map((m) => m.id))) };
}

const indexCache = new WeakMap<Course[], SearchIndex>();
/** One index per catalog array, shared by every search box on the page. */
export function searchIndexFor(courses: Course[]): SearchIndex {
  let idx = indexCache.get(courses);
  if (!idx) {
    idx = buildSearchIndex(courses);
    indexCache.set(courses, idx);
  }
  return idx;
}

interface SubjectMatch {
  code: string;
  /** 0 exact code or alias, 1 related department, 2 prefix of a code. */
  quality: 0 | 1 | 2;
  /** Characters of the code the student actually typed (for highlighting). */
  typed: number;
}

function resolveSubjects(raw: string, index: SearchIndex): SubjectMatch[] {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return [];
  const out = new Map<string, SubjectMatch>();
  const add = (m: SubjectMatch) => {
    const prev = out.get(m.code);
    if (!prev || m.quality < prev.quality) out.set(m.code, m);
  };
  const norm = normalizeSubject(text);
  if (index.subjects.has(norm)) add({ code: norm, quality: 0, typed: norm.length });
  for (const rel of RELATED_SUBJECTS[norm] ?? []) if (index.subjects.has(rel)) add({ code: rel, quality: 1, typed: 0 });
  const compact = text.replace(/[^A-Z0-9]/g, "");
  if (compact.length >= 2) for (const code of index.subjects) if (code.startsWith(compact)) add({ code, quality: 2, typed: compact.length });
  return [...out.values()];
}

/** Ways to read the query as "subject + number". The number may be glued on: "cs61a", "eecs16a". */
function splits(q: string): { subject: string; number: string }[] {
  const out: { subject: string; number: string }[] = [];
  const sp = q.lastIndexOf(" ");
  const last = sp < 0 ? q : q.slice(sp + 1);
  const head = sp < 0 ? "" : q.slice(0, sp);
  if (NUM.test(last)) out.push({ subject: head, number: last });
  // Peel letters off the front of the last token: "EECS16A" -> EECS + 16A (and EE + CS16A, which
  // only survives if "EE" has a class numbered CS16A).
  for (let i = 1; i < last.length; i++) {
    const number = last.slice(i);
    if (!/^[A-Z]+$/.test(last.slice(0, i)) || !NUM.test(number)) continue;
    out.push({ subject: `${head} ${last.slice(0, i)}`.trim(), number });
  }
  return out;
}

/** 0 exact, 1 exact without the letter prefix, 2 prefix, 3 prefix without the letter prefix. */
function numberQuality(m: Member, typed: string): { q: 0 | 1 | 2 | 3; from: number; len: number } | null {
  if (m.number === typed) return { q: 0, from: 0, len: typed.length };
  const offset = m.number.length - m.core.length;
  if (m.core === typed) return { q: 1, from: offset, len: typed.length };
  if (m.number.startsWith(typed)) return { q: 2, from: 0, len: typed.length };
  if (offset && m.core.startsWith(typed)) return { q: 3, from: offset, len: typed.length };
  return null;
}

const TIER_WITH_SUBJECT = [
  [0, 1, 3, 3.2], // exact subject
  [1, 1.5, 3.4, 3.6], // related department
  [4, 4.1, 4.4, 4.6], // subject prefix
];
const TIER_NUMBER_ONLY = [2, 2.5, 4.2, 4.7];

interface Scored {
  family: Family;
  member: Member;
  tier: number;
  idRanges: Range[];
  titleRanges: Range[];
  suggestion?: boolean;
}

export function searchCourses(
  query: string,
  index: SearchIndex,
  opts: { limit?: number; exclude?: { has(id: CourseId): boolean } } = {},
): SearchResult {
  const limit = opts.limit ?? 10;
  const q = query.trim().toUpperCase().replace(/\s+/g, " ");
  if (!q) return { hits: [], total: 0, exact: false, custom: null, missing: null };
  const lower = q.toLowerCase();

  const best = new Map<Family, Scored>();
  const offer = (s: Scored) => {
    const prev = best.get(s.family);
    // On a tie keep the family's usual code ("c8" shows DATA C8, not COMPSCI C8).
    if (!prev || s.tier < prev.tier || (s.tier === prev.tier && s.member.id === s.family.rep && prev.member.id !== s.family.rep)) best.set(s.family, s);
  };
  const idHit = (family: Family, member: Member, tier: number, subjTyped: number, num?: { from: number; len: number }, suggestion = false) => {
    const idRanges: Range[] = [];
    if (subjTyped > 0) idRanges.push([0, Math.min(subjTyped, member.subject.length)]);
    if (num) idRanges.push([member.subject.length + 1 + num.from, member.subject.length + 1 + num.from + num.len]);
    offer({ family, member, tier, idRanges, titleRanges: [], suggestion });
  };

  // 1. subject + number readings
  let namedSubject: string | null = null;
  let namedNumber: string | null = null;
  let fallbackNumber: string | null = null;
  for (const { subject, number } of splits(q)) {
    if (!subject) {
      for (const f of index.families)
        for (const m of f.members) {
          const nq = numberQuality(m, number);
          if (nq) idHit(f, m, TIER_NUMBER_ONLY[nq.q], 0, nq);
        }
      continue;
    }
    if (!fallbackNumber) fallbackNumber = number;
    const subs = resolveSubjects(subject, index);
    if (!subs.length) continue;
    const byCode = new Map(subs.map((s) => [s.code, s]));
    const exactSub = subs.find((s) => s.quality === 0);
    if (exactSub && !namedSubject) {
      namedSubject = exactSub.code;
      namedNumber = number;
    }
    for (const f of index.families)
      for (const m of f.members) {
        const sm = byCode.get(m.subject);
        if (!sm) continue;
        const nq = numberQuality(m, number);
        if (nq) idHit(f, m, TIER_WITH_SUBJECT[sm.quality][nq.q], sm.typed, nq);
      }
  }

  // 2. a subject on its own lists that subject
  if (!/\d/.test(q)) {
    const subs = resolveSubjects(q, index).filter((s) => s.quality !== 1);
    const byCode = new Map(subs.map((s) => [s.code, s]));
    if (subs.length)
      for (const f of index.families)
        for (const m of f.members) {
          const sm = byCode.get(m.subject);
          if (sm) idHit(f, m, sm.quality === 0 ? 3 : 4.8, sm.typed);
        }
  }

  let exact = [...best.values()].some((s) => s.tier <= 1);

  // 3. nothing by that code. A recognised subject never falls back to other departments by
  // number ("mcb 160" must not offer ANTHRO 160): show its closest numbers as suggestions. Only
  // when the subject is not recognised do we suggest the same number elsewhere.
  let missing: CourseId | null = null;
  if (!exact && namedSubject && namedNumber) {
    const inSubject = [...best.values()].some((s) => s.member.subject === namedSubject);
    if (!inSubject) {
      missing = `${namedSubject} ${namedNumber}`;
      const want = courseNumberValue(namedNumber);
      const near: { f: Family; m: Member; d: number }[] = [];
      for (const f of index.families) for (const m of f.members) if (m.subject === namedSubject && !m.retired) near.push({ f, m, d: Math.abs(m.value - want) });
      near.sort((x, y) => x.d - y.d || x.m.id.localeCompare(y.m.id, undefined, { numeric: true }));
      near.slice(0, 5).forEach((n, i) => idHit(n.f, n.m, 5 + i * 0.01, namedSubject!.length, undefined, true));
    }
  } else if (!exact && !namedSubject && best.size === 0 && fallbackNumber) {
    for (const f of index.families)
      for (const m of f.members) {
        const nq = numberQuality(m, fallbackNumber);
        if (nq && nq.q <= 1) idHit(f, m, 5 + nq.q * 0.1, 0, nq, true);
      }
  }

  // 4. titles
  const tokens = wordsOf(lower).map((w) => w.text);
  if (lower.length >= 3 && tokens.length) {
    for (const f of index.families) {
      if (best.has(f) && best.get(f)!.tier < 6) continue;
      const ranges: Range[] = [];
      const all = tokens.every((t) => {
        const w = f.words.find((x) => x.text.startsWith(t));
        if (w) ranges.push([w.at, w.at + t.length]);
        return !!w;
      });
      const rep = f.members.find((m) => m.id === f.rep)!;
      if (all) {
        const phrase = f.titleLower.indexOf(lower);
        const tier = phrase === 0 ? 6 : phrase > 0 ? 6.2 : 6.5;
        offer({ family: f, member: rep, tier, idRanges: [], titleRanges: phrase >= 0 ? [[phrase, phrase + lower.length]] : ranges });
      } else if (lower.length >= 4) {
        const at = f.titleLower.indexOf(lower);
        if (at >= 0) offer({ family: f, member: rep, tier: 7, idRanges: [], titleRanges: [[at, at + lower.length]] });
      }
    }
  }

  let scored = [...best.values()];
  if (opts.exclude) scored = scored.filter((s) => !s.family.members.some((m) => opts.exclude!.has(m.id)));
  exact = scored.some((s) => s.tier <= 1);
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(isExtension(a.member.subject)) - Number(isExtension(b.member.subject)) ||
      // A number typed alone, or a title: the classes most students take come first.
      ((a.tier >= 2 && a.tier < 3) || a.tier >= 6 ? b.family.popularity - a.family.popularity : 0) ||
      (a.tier >= 6 || a.suggestion ? 0 : a.member.value - b.member.value) ||
      a.member.id.localeCompare(b.member.id, undefined, { numeric: true }),
  );

  // "Add anyway" only makes sense for something shaped like a class code that we do not have.
  let custom: CourseId | null = null;
  if (![...best.values()].some((s) => s.tier <= 1)) {
    const guess = namedSubject && namedNumber ? `${namedSubject} ${namedNumber}` : q.includes(" ") || /^[A-Z]{2,}\d/.test(q) ? normalizeCourseId(q) : null;
    if (guess && !index.ids.has(guess) && /^[A-Z]{2,} [A-Z]{0,2}\d{1,3}[A-Z]{0,3}$/.test(guess)) custom = guess;
  }

  return {
    hits: scored.slice(0, limit).map((s) => {
      const others = s.family.members.filter((m) => m.id !== s.member.id);
      // A sibling is a renumbering when a sameAs link joins the two, else a cross-listing.
      const renumbered = others.filter((m) => s.member.sameAs.has(m.id) || (m.retired && m.subject === s.member.subject));
      // An old number surfaces the class under its current code, "formerly" the one typed.
      const current = s.member.retired ? (renumbered.find((m) => !m.retired) ?? s.family.members.find((m) => m.id === s.family.rep && !m.retired)) : undefined;
      if (current) {
        const rest = s.family.members.filter((m) => m.id !== current.id);
        const old = rest.filter((m) => m.retired || current.sameAs.has(m.id));
        return {
          id: current.id,
          also: rest.filter((m) => !old.includes(m)).map((m) => m.id),
          formerly: [s.member.id, ...old.filter((m) => m.retired && m.id !== s.member.id).map((m) => m.id)],
          sameAs: old.filter((m) => !m.retired).map((m) => m.id),
          suggestion: !!s.suggestion,
          title: s.family.title,
          units: s.family.units,
          tier: s.tier,
          idRanges: [],
          titleRanges: mergeRanges(s.titleRanges),
        };
      }
      return {
      id: s.member.id,
      also: others.filter((m) => !renumbered.includes(m)).map((m) => m.id),
      formerly: renumbered.filter((m) => m.retired).map((m) => m.id),
      sameAs: renumbered.filter((m) => !m.retired).map((m) => m.id),
      suggestion: !!s.suggestion,
      title: s.family.title,
      units: s.family.units,
      tier: s.tier,
      idRanges: s.idRanges,
      titleRanges: mergeRanges(s.titleRanges),
      };
    }),
    total: scored.length,
    exact,
    custom,
    missing: scored.some((s) => !s.suggestion && s.tier < 5) ? null : missing,
  };
}

function mergeRanges(r: Range[]): Range[] {
  const sorted = [...r].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else out.push([x[0], x[1]]);
  }
  return out;
}

/** Split text into plain and highlighted pieces for rendering. */
export function highlightParts(text: string, ranges: Range[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [s, e] of mergeRanges(ranges)) {
    if (s > at) out.push({ text: text.slice(at, s), hit: false });
    out.push({ text: text.slice(s, e), hit: true });
    at = e;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
