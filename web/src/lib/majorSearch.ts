import type { College } from "./types";

/**
 * Search for majors and minors the way students actually name them: "cs", "eecs", "cogsci",
 * "poli sci", "meche", "haas". Ranking, best first:
 *   exact shorthand or exact name > shorthand prefix > initials (EECS, MCB, IEOR) and squeezed
 *   word prefixes ("cogsci" = COGnitive SCIence) > word prefix in the name > substring > college.
 * Spaces, punctuation and case never matter.
 */

export interface SearchableProgram {
  name: string;
  degree?: string;
  college?: string;
  programType?: string;
  aliases?: string[];
}

export type MatchKind = "alias" | "name" | "initials" | "abbreviation" | "prefix" | "substring" | "college" | "typo";

export interface ProgramHit<T> {
  item: T;
  score: number;
  kind: MatchKind;
  /** Short text to show when the match is not obvious from the name ("cs", "EECS", "Haas"). */
  tag?: string;
}

const DEGREE_WORDS = new Set(["ba", "bs", "bachelor", "bachelors", "major", "minor", "degree"]);
const STOP = new Set(["and", "of", "the", "in", "for", "a", "an", "to"]);

/** Lower-case letters and digits only: "Cog. Sci" -> "cogsci". */
export function squash(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "");
}

function words(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const significant = (ws: string[]) => ws.filter((w) => !STOP.has(w));

/**
 * Shorthands students use, keyed by program name. Merged with `aliases` from the data files.
 * Order matters a little: the first alias is the program's main shorthand, so "cs" ranks
 * Computer Science (where it is first) above EECS (where it is third).
 */
export const FALLBACK_ALIASES: Record<string, string[]> = {
  "Aerospace Engineering": ["aero", "aeroe", "aerospace"],
  "African American Studies": ["aas", "africam", "afam"],
  "American Studies": ["amerstd", "amstud"],
  Analytics: ["orms", "operations research", "or"],
  "Ancient Greek and Roman Studies": ["agrs", "classics"],
  Anthropology: ["anthro"],
  "Applied Mathematics": ["applied math", "amath", "apma"],
  Architecture: ["arch"],
  Art: ["art practice"],
  "Asian American and Asian Diaspora Studies": ["aaads", "asamst", "asian american studies"],
  Astrophysics: ["astro", "astron", "astronomy"],
  Bioengineering: ["bioe", "bioeng", "be", "biomedical engineering"],
  "Business Administration": ["haas", "biz", "business", "ugba", "bus ad"],
  "Chemical Biology": ["chembio"],
  "Chemical Engineering": ["cheme", "chemeng", "cbe"],
  Chemistry: ["chem"],
  "Chicanx Latinx Studies": ["chicano studies", "chicanx", "latinx"],
  "City and Regional Planning": ["crp", "cyplan", "city planning"],
  "Civil Engineering": ["cee", "cive", "civeng", "civil"],
  "Cognitive Science": ["cogsci", "cog sci"],
  "Comparative Literature": ["complit", "comp lit"],
  "Computer Science": ["cs", "compsci", "comp sci", "lscs"],
  "Conservation and Resource Studies": ["crs"],
  "Dance and Performance Studies": ["dance", "tdps"],
  "Data Science": ["ds", "datasci", "data"],
  Demography: ["demog"],
  "Digital Humanities": ["dh", "dighum"],
  "Earth & Planetary Science": ["eps", "geology"],
  "Earth and Planetary Science": ["eps"],
  Economics: ["econ"],
  "Ecosystem Management and Forestry": ["emf", "forestry"],
  Education: ["educ"],
  "Educational Sciences": ["edsci", "education"],
  "Electrical and Computer Engineering": ["ece", "computer engineering", "ee"],
  "Electrical Engineering and Computer Sciences": ["eecs", "ee", "cs"],
  "Electrical Engineering and Computer Science": ["eecs", "ee", "cs"],
  "Energy and Resources": ["erg"],
  "Engineering Math and Statistics": ["ems"],
  "Engineering Physics": ["ep", "engphys"],
  "Environmental Economics and Policy": ["eep", "envecon"],
  "Environmental Engineering Science": ["ees"],
  "Environmental Sciences": ["envsci", "env sci"],
  "Ethnic Studies": ["ethstd", "ethnic"],
  "Film and Media": ["film"],
  "Gender and Women's Studies": ["gws", "womens studies"],
  "Genetics and Plant Biology": ["gpb", "plant bio"],
  Geography: ["geog"],
  "Geospatial Information Science and Technology": ["gis", "gist"],
  "Global Poverty & Practice": ["gpp"],
  "Global Studies": ["gs", "global"],
  History: ["hist"],
  "History of Art": ["art history", "histart", "hoa"],
  "Human Rights Interdisciplinary": ["hri", "human rights"],
  "Industrial Engineering and Operations Research": ["ieor", "ie"],
  "Integrative Biology": ["ib", "integbi", "bio", "biology"],
  "Interdisciplinary Studies": ["isf"],
  Journalism: ["jschool"],
  "Landscape Architecture": ["ldarch", "la"],
  "Legal Studies": ["legal studies", "legal", "legalst", "law", "prelaw"],
  "Life Science, Business, and Entrepreneurship": ["lsbe", "robinson"],
  Linguistics: ["ling"],
  "Materials Science and Engineering": ["mse", "matsci", "mat sci"],
  Mathematics: ["math", "maths", "pure math"],
  "Mechanical Engineering": ["meche", "me", "mecheng"],
  "Media Studies": ["media studies", "media", "mediast"],
  "Microbial Biology": ["microbio", "mb"],
  "Middle Eastern Languages and Cultures": ["melc"],
  "Middle Eastern Languages & Cultures": ["melc"],
  "Molecular and Cell Biology": ["mcb", "bio", "biology"],
  "Molecular Environmental Biology": ["meb"],
  "Native American Studies": ["nas"],
  Neuroscience: ["neuro", "neurosci"],
  "Nuclear Engineering": ["ne", "nuce", "nuceng"],
  "Nutrition and Metabolic Biology": ["nst", "nmb", "nutrisci", "nutrition"],
  "Nutritional Science": ["nst", "nutrisci"],
  Philosophy: ["phil", "philo"],
  Physics: ["phys"],
  "Political Economy": ["polecon", "poli econ", "pe"],
  "Political Science": ["polisci", "poli sci", "polsci", "ps"],
  "Politics, Philosophy, & Law": ["ppl"],
  Psychology: ["psych", "psyc"],
  "Public Health": ["ph", "pubhealth", "pbhlth"],
  "Public Policy": ["pubpol", "pp"],
  Rhetoric: ["rhet"],
  Scandinavian: ["scandi"],
  "Science, Technology, and Society": ["sts"],
  "Social Welfare": ["socwel", "sw", "social work"],
  "Society and Environment": ["se"],
  Sociology: ["soc", "socio"],
  "South and Southeast Asian Studies": ["sseas"],
  "South & Southeast Asian Studies": ["sseas"],
  "Spanish and Portuguese": ["spanish"],
  Statistics: ["stats", "stat"],
  "Sustainable Environmental Design": ["sed"],
  "Theater & Performance Studies": ["tdps", "theater", "theatre", "drama"],
  "Urban Studies": ["urban"],
};

const FALLBACK_BY_KEY = new Map(Object.entries(FALLBACK_ALIASES).map(([name, a]) => [squash(name), a]));

/** How a program is written on small badges ("CogSci + DS"). */
const SHORT_NAMES: Record<string, string> = {
  "Aerospace Engineering": "Aero",
  "African American Studies": "AAS",
  "Applied Mathematics": "Applied Math",
  "Asian American and Asian Diaspora Studies": "AAADS",
  Bioengineering: "BioE",
  "Business Administration": "Business",
  "Chemical Biology": "Chem Bio",
  "Chemical Engineering": "ChemE",
  "Civil Engineering": "Civil Eng",
  "Cognitive Science": "CogSci",
  "Comparative Literature": "Comp Lit",
  "Computer Science": "CS",
  "Conservation and Resource Studies": "CRS",
  "Data Science": "DS",
  Economics: "Econ",
  "Electrical and Computer Engineering": "ECE",
  "Electrical Engineering and Computer Sciences": "EECS",
  "Electrical Engineering and Computer Science": "EECS",
  "Engineering Physics": "Eng Physics",
  "Environmental Economics and Policy": "EEP",
  "Environmental Sciences": "Env Sci",
  "Gender and Women's Studies": "GWS",
  "Industrial Engineering and Operations Research": "IEOR",
  "Integrative Biology": "IB",
  "Interdisciplinary Studies": "ISF",
  "Materials Science and Engineering": "MSE",
  Mathematics: "Math",
  "Mechanical Engineering": "MechE",
  "Molecular and Cell Biology": "MCB",
  "Molecular Environmental Biology": "MEB",
  Neuroscience: "Neuro",
  "Nuclear Engineering": "NucE",
  "Political Economy": "Poli Econ",
  "Political Science": "PoliSci",
  Psychology: "Psych",
  Statistics: "Stats",
};
const SHORT_BY_KEY = new Map(Object.entries(SHORT_NAMES).map(([name, s]) => [squash(name), s]));

/** Short label for a program, for badges. Pass `minor` to tell a minor from a major. */
export function programShortName(name: string, opts: { minor?: boolean } = {}): string {
  const clean = name.replace(/\s+(BA|BS|BA\/BS|Minor)$/i, "").trim();
  let short = SHORT_BY_KEY.get(squash(clean));
  if (!short) {
    const initials = significant(words(clean)).map((w) => w[0]).join("").toUpperCase();
    short = clean.length <= 14 || initials.length < 3 ? clean : initials;
  }
  return opts.minor ? `${short} minor` : short;
}

const COLLEGE_SHORT: Record<string, string> = {
  LS: "L&S",
  CDSS: "CDSS",
  COE: "Engineering",
  HAAS: "Haas",
  CED: "Environmental Design",
  CNR: "Rausser",
  CHEM: "Chemistry",
  BSE: "Education",
};
const COLLEGE_ALIASES: Record<string, string[]> = {
  LS: ["ls", "l&s", "letters and science", "letters"],
  CDSS: ["cdss", "computing data science and society"],
  COE: ["coe", "engineering", "college of engineering"],
  HAAS: ["haas", "business school"],
  CED: ["ced", "environmental design"],
  CNR: ["cnr", "rausser", "natural resources"],
  CHEM: ["coc", "college of chemistry"],
  BSE: ["bse", "school of education"],
};

/** "College of Letters & Science" -> "L&S". Unknown colleges fall back to their name. */
export function collegeShortLabel(collegeId: string | undefined, colleges: Pick<College, "id" | "name">[] = []): string {
  if (!collegeId) return "";
  return COLLEGE_SHORT[collegeId] ?? colleges.find((c) => c.id === collegeId)?.name ?? collegeId;
}

/** Every shorthand for a program: built-in ones first, then any from the data files. */
export function aliasesFor(p: SearchableProgram): string[] {
  const out: string[] = [];
  const add = (a: string) => {
    if (a && !out.some((x) => squash(x) === squash(a))) out.push(a);
  };
  (FALLBACK_BY_KEY.get(squash(p.name)) ?? []).forEach(add);
  // "Bioengineering/Materials Science and Engineering Joint Major" answers to both halves.
  if (/\//.test(p.name)) {
    for (const part of p.name.replace(/\bJoint Major\b/i, "").split("/")) (FALLBACK_BY_KEY.get(squash(part)) ?? []).forEach(add);
  }
  const met = p.name.match(/^(.*?) and Business(?: Administration)?$/i);
  if (met && p.programType !== "major") {
    add("met");
    add("management entrepreneurship and technology");
    (FALLBACK_BY_KEY.get(squash(met[1])) ?? []).slice(0, 1).forEach((a) => add(`${a} met`));
  }
  (p.aliases ?? []).forEach(add);
  return out;
}

/** Can `q` be spelled by taking a prefix of each of some consecutive words? Returns words used. */
function squeezeMatch(q: string, ws: string[], start: number): number {
  // memo over (position in q, word index); small inputs, so plain recursion is fine.
  const go = (qi: number, wi: number): number => {
    if (qi === q.length) return wi;
    if (wi >= ws.length) return -1;
    const w = ws[wi];
    let max = 0;
    while (max < w.length && qi + max < q.length && w[max] === q[qi + max]) max++;
    for (let len = max; len >= 1; len--) {
      const end = go(qi + len, wi + 1);
      if (end >= 0) return end;
    }
    return -1;
  };
  const end = go(0, start);
  return end < 0 ? 0 : end - start;
}

/** True when a and b differ by one typo (one edit, or two neighbouring letters swapped). */
function oneTypoApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

interface Prepared<T> {
  item: T;
  nameKey: string;
  words: string[];
  sig: string[];
  aliases: { text: string; key: string }[];
  /** Shorthands from the built-in table (as opposed to the data file). */
  curated: Set<string>;
  collegeKeys: string[];
  collegeLabel: string;
}

function prepare<T extends SearchableProgram>(item: T, colleges: Pick<College, "id" | "name">[]): Prepared<T> {
  const ws = words(item.name);
  const college = item.college ? colleges.find((c) => c.id === item.college) : undefined;
  const collegeKeys = item.college
    ? [item.college, college?.name ?? "", COLLEGE_SHORT[item.college] ?? "", ...(COLLEGE_ALIASES[item.college] ?? [])].map(squash).filter(Boolean)
    : [];
  return {
    item,
    nameKey: squash(item.name),
    words: ws,
    sig: significant(ws),
    aliases: aliasesFor(item).map((text) => ({ text, key: squash(text) })),
    curated: new Set(aliasesFor({ ...item, aliases: [] }).map(squash)),
    collegeKeys,
    collegeLabel: collegeShortLabel(item.college, colleges),
  };
}

function scoreOne<T>(p: Prepared<T>, q: string, tokens: string[]): { score: number; kind: MatchKind; tag?: string } | null {
  if (p.nameKey === q) return { score: 1000, kind: "name" };
  // Shorthands. Earlier aliases are the program's main ones and rank a little higher.
  let best: { score: number; kind: MatchKind; tag?: string } | null = null;
  const consider = (score: number, kind: MatchKind, tag?: string) => {
    if (!best || score > best.score) best = { score, kind, tag };
  };
  const initials = p.sig.map((w) => w[0]).join("");
  p.aliases.forEach((a, i) => {
    // A data alias that is only the program's initials ("cs" for Celtic Studies) is not a real
    // shorthand; it ranks with the other initials below, unless our own table vouches for it.
    if (a.key === initials && !p.curated.has(a.key)) return;
    if (a.key === q) consider(1000 - Math.min(i, 8) * 5, "alias", a.text);
    else if (q.length >= 2 && a.key.startsWith(q)) consider(800 - Math.min(i, 8) * 5 - (a.key.length - q.length), "alias", a.text);
  });

  if (q.length >= 2 && p.sig.length >= 2) {
    if (initials === q) consider(700, "initials", initials);
    else {
      // "cogsci" -> COGnitive SCIence, "meche" -> MECHanical Engineering.
      const fromStart = squeezeMatch(q, p.sig, 0);
      if (fromStart >= 2) consider(fromStart === p.sig.length ? 680 : 640, "abbreviation");
      else {
        for (let s = 1; s < p.sig.length - 1; s++) {
          if (squeezeMatch(q, p.sig, s) >= 2) {
            consider(360, "abbreviation");
            break;
          }
        }
      }
    }
  }

  // Every typed word starts a different word of the name.
  if (tokens.length) {
    const usedWords = new Set<number>();
    const all = tokens.every((t) => {
      const i = p.words.findIndex((w, wi) => !usedWords.has(wi) && w.startsWith(t));
      if (i < 0) return false;
      usedWords.add(i);
      return true;
    });
    if (all) consider((usedWords.has(0) ? 620 : 600) - Math.min(p.nameKey.length, 60) / 10, "prefix");
  }

  // Inside one word only: "physics" finds Astrophysics, but "nst" must not find "urbaN STudies".
  // Four letters or more: "art" must not find eARTh, nor "bio" microBIOlogy.
  if (q.length >= 4) {
    const wi = p.words.findIndex((w) => w.includes(q));
    if (wi >= 0) consider(400 - Math.min(wi, 9) * 5 - Math.min(p.nameKey.length, 60) / 10, "substring");
    else if (tokens.length > 1 && tokens.every((t) => t.length >= 3 && p.words.some((w) => w.includes(t)))) consider(340, "substring");
  }

  // A college's own name or shorthand ("haas", "l&s", "engineering") lists its programs.
  if (q.length >= 2) {
    if (p.collegeKeys.includes(q)) consider(650, "college", p.collegeLabel);
    else if (q.length >= 3 && p.collegeKeys.some((k) => k.startsWith(q))) consider(200, "college", p.collegeLabel);
  }
  return best;
}

function fuzzy<T>(p: Prepared<T>, q: string): { score: number; kind: MatchKind; tag?: string } | null {
  if (q.length < 5) return null;
  if (oneTypoApart(p.nameKey, q)) return { score: 150, kind: "typo" };
  const alias = p.aliases.find((a) => a.key.length >= 4 && oneTypoApart(a.key, q));
  if (alias) return { score: 140, kind: "typo", tag: alias.text };
  if (p.words.some((w) => w.length >= 4 && (oneTypoApart(w, q) || oneTypoApart(w.slice(0, q.length), q)))) return { score: 120, kind: "typo" };
  return null;
}

/**
 * Rank programs for a query. An empty query returns everything in the given order.
 * `colleges` lets a college name ("haas", "engineering") bring up its programs last.
 */
export function searchPrograms<T extends SearchableProgram>(query: string, programs: T[], colleges: Pick<College, "id" | "name">[] = []): ProgramHit<T>[] {
  // "cs ba", "eecs bs", "data science major": the degree word is not part of the name.
  const typed = words(query);
  const core = typed.filter((w) => !DEGREE_WORDS.has(w));
  const tokens = core.length ? core : typed;
  const q = core.length && core.length < typed.length ? core.join("") : squash(query);
  if (!q) return programs.map((item) => ({ item, score: 0, kind: "name" as const }));
  const prepared = programs.map((p) => prepare(p, colleges));
  let hits = prepared.flatMap((p, order) => {
    const s = scoreOne(p, q, tokens);
    return s ? [{ p, order, ...s }] : [];
  });
  if (!hits.length) {
    hits = prepared.flatMap((p, order) => {
      const s = fuzzy(p, q);
      return s ? [{ p, order, ...s }] : [];
    });
  }
  // When the query is somebody's exact shorthand, short mid-word matches are just noise.
  // The same goes for letters picked out of the middle of a long name ("ds" in asian Diaspora Studies).
  if (hits.some((h) => h.score >= 900)) hits = hits.filter((h) => !(h.kind === "substring" && q.length < 5) && !(h.kind === "abbreviation" && h.score < 600));
  const typeRank = (t?: string) => (!t || t === "major" ? 0 : 1);
  hits.sort(
    (a, b) =>
      b.score - a.score ||
      typeRank(a.p.item.programType) - typeRank(b.p.item.programType) ||
      a.p.nameKey.length - b.p.nameKey.length ||
      a.order - b.order,
  );
  return hits.map(({ p, score, kind, tag }) => {
    // Only tag a result when the reader could not tell why it is there from its name.
    const obvious = kind === "name" || kind === "prefix" || kind === "substring" || kind === "abbreviation" || (tag ? p.nameKey.startsWith(squash(tag)) : true);
    // A long alias makes a poor chip: show the program's main shorthand instead.
    const short = tag && tag.length > 16 ? (p.aliases.find((x) => x.text.length <= 16)?.text ?? undefined) : tag;
    return { item: p.item, score, kind, tag: obvious ? undefined : short?.toLowerCase() };
  });
}

/** Search majors: `searchMajors("cs", majors, colleges)` puts Computer Science first. */
export function searchMajors<T extends SearchableProgram>(query: string, majors: T[], colleges: Pick<College, "id" | "name">[] = []): ProgramHit<T>[] {
  return searchPrograms(query, majors, colleges);
}

/** Same ranking for minors (no college). */
export function searchMinors<T extends SearchableProgram>(query: string, minors: T[]): ProgramHit<T>[] {
  return searchPrograms(query, minors, []);
}
