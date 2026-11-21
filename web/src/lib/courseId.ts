import type { Course, CourseId } from "./types";

/** Common transcript / human spellings -> official subject codes. */
export const SUBJECT_ALIASES: Record<string, string> = {
  "COMP SCI": "COMPSCI",
  CS: "COMPSCI",
  "EL ENG": "ELENG",
  EE: "ELENG",
  "ELENG": "ELENG",
  "DATA SCI": "DATA",
  STATISTICS: "STAT",
  MATHEMATICS: "MATH",
  "MEC ENG": "MECENG",
  "CIV ENG": "CIVENG",
  "IND ENG": "INDENG",
  "BIO ENG": "BIOENG",
  "CHM ENG": "CHMENG",
  "MAT SCI": "MATSCI",
  "NUC ENG": "NUCENG",
  "MCELLBI": "MCELLBI",
  MCB: "MCELLBI",
  "MOL CELL BIO": "MCELLBI",
  "INTEGBI": "INTEGBI",
  IB: "INTEGBI",
  "POL SCI": "POLSCI",
  "POLI SCI": "POLSCI",
  "ECON": "ECON",
  ECONOMICS: "ECON",
  "PSYCH": "PSYCH",
  "UGBA": "UGBA",
  "COG SCI": "COGSCI",
  "L & S": "LS",
  "L&S": "LS",
  "ENV SCI": "ENVSCI",
  "AFRICAM": "AFRICAM",
  "AFRICAN AMERICAN STUDIES": "AFRICAM",
  "ETH STD": "ETHSTD",
  "ETHNIC STUDIES": "ETHSTD",
  "PUB POL": "PUBPOL",
  "PUBLIC POLICY": "PUBPOL",
  "ART HIST": "HISTART",
  "HISTORY OF ART": "HISTART",
  "PHYS ED": "PHYSED",
  "PHYSICS": "PHYSICS",
  "CHEM": "CHEM",
  "CHEMISTRY": "CHEM",
  "BIOLOGY": "BIOLOGY",
  "ENGLISH": "ENGLISH",
  "RHETORIC": "RHETOR",
  "RHETOR": "RHETOR",
  "COLWRIT": "COLWRIT",
  "COLLEGE WRITING": "COLWRIT",
  "DATA": "DATA",
  "INFO": "INFO",
  "ENGIN": "ENGIN",
  "PHILOS": "PHILOS",
  "PHILOSOPHY": "PHILOS",
  "SOCIOL": "SOCIOL",
  "SOCIOLOGY": "SOCIOL",
  "ANTHRO": "ANTHRO",
  "ANTHROPOLOGY": "ANTHRO",
  "HISTORY": "HISTORY",
  "GEOG": "GEOG",
  "LINGUIS": "LINGUIS",
  "MUSIC": "MUSIC",
  "ASTRON": "ASTRON",
  "EPS": "EPS",
  "NUSCTX": "NUSCTX",
  "ESPM": "ESPM",
  "LEGALST": "LEGALST",
  "MEDIAST": "MEDIAST",
  // transcript abbreviations (added by transcript import)
  "COMPUTER SCIENCE": "COMPSCI",
  "DATA SCIENCE": "DATA",
  "INTEG BIOL": "INTEGBI",
  "MOL & CELL BIO": "MCELLBI",
  "PB HLTH": "PBHLTH",
  "PUB HLTH": "PBHLTH",
  "PUBLIC HEALTH": "PBHLTH",
  "SOC WEL": "SOCWEL",
  "NAT RES": "NATRES",
  "PLANT BI": "PLANTBI",
  "ENV DES": "ENVDES",
  "ENV ECON": "ENVECON",
  "ENE RES": "ENERES",
  "ENE,RES": "ENERES",
  "LD ARCH": "LDARCH",
  "CY PLAN": "CYPLAN",
  "COM LIT": "COMLIT",
  "AS AM ST": "ASAMST",
  "NAT AM ST": "NATAMST",
  "AMERICAN STUDIES": "AMERSTD",
  "MEDIA ST": "MEDIAST",
  "LEGAL ST": "LEGALST",
  "DES INV": "DESINV",
  "DEV ENG": "DEVENG",
  "DEV STD": "DEVSTD",
  "VIS SCI": "VISSCI",
  "NE STUD": "NESTUD",
  "MIL SCI": "MILSCI",
  "NAV SCI": "NAVSCI",
  "MIL AFF": "MILAFF",
  "POL ECON": "POLECON",
  "CRIT TH": "CRITTH",
  "EA LANG": "EALANG",
  "NUTR SCI": "NUSCTX",
  "LETTERS & SCIENCE": "LS",
  "LETTERS AND SCIENCE": "LS",
  // what students actually type
  COMPSCI: "COMPSCI",
  COGSCI: "COGSCI",
  COG: "COGSCI",
  EECS: "EECS",
  MATH: "MATH",
  STAT: "STAT",
  STATS: "STAT",
  DS: "DATA",
  PHYS: "PHYSICS",
  PHIL: "PHILOS",
  PHILO: "PHILOS",
  PSYC: "PSYCH",
  PSYCHOLOGY: "PSYCH",
  SOC: "SOCIOL",
  ANTH: "ANTHRO",
  HIST: "HISTORY",
  LING: "LINGUIS",
  LINGUISTICS: "LINGUIS",
  BIO: "BIOLOGY",
  ASTRO: "ASTRON",
  ASTRONOMY: "ASTRON",
  GEOGRAPHY: "GEOG",
  POLISCI: "POLSCI",
  "POLITICAL SCIENCE": "POLSCI",
  PS: "POLSCI",
  "COGNITIVE SCIENCE": "COGSCI",
  "MOLECULAR AND CELL BIOLOGY": "MCELLBI",
  "INTEGRATIVE BIOLOGY": "INTEGBI",
  "INTEG BI": "INTEGBI",
  ME: "MECENG",
  "MECHANICAL ENGINEERING": "MECENG",
  CE: "CIVENG",
  CEE: "CIVENG",
  "CIVIL ENGINEERING": "CIVENG",
  IEOR: "INDENG",
  BIOE: "BIOENG",
  BIOENGINEERING: "BIOENG",
  MSE: "MATSCI",
  CHEME: "CHMENG",
  "CHEM ENG": "CHMENG",
  NE: "NUCENG",
  "AERO ENG": "AEROENG",
  "ELECTRICAL ENGINEERING": "ELENG",
  E: "ENGIN",
  ENGINEERING: "ENGIN",
  PH: "PBHLTH",
  PUBHLTH: "PBHLTH",
  NST: "NUSCTX",
  BUS: "UGBA",
  BA: "UGBA",
  HAAS: "UGBA",
  "BUS ADM": "UGBA",
  ES: "ETHSTD",
  "ETHNIC ST": "ETHSTD",
  AAS: "AFRICAM",
  "AFRICAN AM": "AFRICAM",
  "ASIAN AM": "ASAMST",
  "ASIAN AMERICAN STUDIES": "ASAMST",
  "CHICANO STUDIES": "CHICANO",
  "NATIVE AMERICAN STUDIES": "NATAMST",
  "COMP LIT": "COMLIT",
  "COMPARATIVE LITERATURE": "COMLIT",
  "LEGAL STUDIES": "LEGALST",
  "MEDIA STUDIES": "MEDIAST",
  "GLOBAL STUDIES": "GLOBAL",
  "GENDER AND WOMENS STUDIES": "GWS",
  "CITY PLANNING": "CYPLAN",
  "S ASIAN": "SASIAN",
  "SE ASIAN": "SEASIAN",
  "S,SEASN": "SSEASN",
  "HIN-URD": "HINURD",
  "M E STU": "MESTU",
  "MED ST": "MEDST",
  "VIS STD": "VISSTD",
  "LAN PRO": "LANPRO",
  "MALAY/I": "MALAYI",
  THEATRE: "THEATER",
  TDPS: "THEATER",
  EDUCATION: "EDUC",
  ARCHITECTURE: "ARCH",
  "COLLEGE WRIT": "COLWRIT",
  CW: "COLWRIT",
  "ENV SCI POL MGMT": "ESPM",
  "EARTH AND PLANETARY SCIENCE": "EPS",
  "NEUROSCIENCE": "NEUROSC",
  NEURO: "NEUROSC",
  "INFORMATION": "INFO",
  "UGIS": "UGIS",
  "X MATH": "XMATH",
  "X ENGLIS": "XENGLIS",
};

/** Official subject codes (compact form), so text can be checked before the catalog has loaded. */
const SUBJECT_CODES = new Set<string>(
  (
    "AEROENG AEROSPC AFRICAM AGRS AHMA AMERSTD ANTHRO ARABIC ARCH ART ARMENI ASAMST ASIANST ASTRON BIOENG " +
    "BIOLOGY BIOPHY BUDDSTD CATALAN CELTIC CHEM CHICANO CHINESE CHMENG CIVENG CLASSIC COGSCI COLWRIT COMLIT " +
    "COMPBIO COMPSCI CRITTH CUNEIF CYPLAN CZECH DANISH DATA DEMOG DESINV DEVENG DEVSTD DUTCH EALANG ECON EDUC " +
    "EGYPT ELENG ENERES ENGIN ENGLISH ENVDES ENVECON ENVSCI EPS ESPM ETHSTD EUST EECS FILIPN FILM FINNISH " +
    "FOLKLOR FRENCH GEOG GERMAN GLOBAL GMS GPP GREEK GWS HEBREW HINURD HISTART HISTORY HMEDSCI HUNGARI IAS " +
    "ICELAND INDENG INFO INTEGBI IRANIAN ISF ITALIAN JAPAN JEWISH JOURN KHMER KOREAN LS LATAMST LATIN LDARCH " +
    "LEGALST LGBT LINGUIS MATH MATSCI MCELLBI MECENG MEDIAST MEDST MESTU MILAFF MILSCI MONGOLN MUSIC NATAMST " +
    "NATRES NAVSCI NESTUD NEUROSC NORWEGN NUCENG NUSCTX NWMEDIA OPTOM PACS PBHLTH PERSIAN PHILOS PHYSED PHYSICS " +
    "PLANTBI POLECON POLISH POLSCI PORTUG PSYCH PUBAFF PUBPOL PUNJABI RELIGST RHETOR RUSSIAN SANSKR SASIAN " +
    "SCANDIN SCMATHE SEASIAN SEMITIC SLAVIC SOCIOL SOCWEL SPANISH SSEASN STAT SWEDISH TAGALG TAMIL TELUGU THAI " +
    "THEATER TIBETAN TURKISH UGBA UGIS UKRAINI URDU VIETNMS VISSCI VISSTD XMATH XENGLIS XMBA YIDDISH BUSADM MBA LAW"
  ).split(" "),
);

/** True for an official subject code such as "COMPSCI" (after normalizeSubject). */
export function isKnownSubject(code: string): boolean {
  return SUBJECT_CODES.has(code);
}

/** Add aliases from data/subjects.json ("EL ENG" -> "ELENG"). Official codes always win. */
export function registerSubjectAliases(subjects: { code: string; aliases?: string[] }[]) {
  for (const s of subjects) {
    SUBJECT_CODES.add(s.code);
    SUBJECT_ALIASES[s.code] = s.code;
    for (const a of s.aliases ?? []) {
      const key = a.trim().toUpperCase().replace(/\s+/g, " ");
      if (!subjects.some((x) => x.code === key)) SUBJECT_ALIASES[key] = s.code;
    }
  }
}

export function normalizeSubject(raw: string): string {
  const s = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (SUBJECT_ALIASES[s]) return SUBJECT_ALIASES[s];
  const tight = s.replace(/\s*&\s*/g, " & ");
  if (SUBJECT_ALIASES[tight]) return SUBJECT_ALIASES[tight];
  const compact = s.replace(/[^A-Z0-9]/g, "");
  return SUBJECT_ALIASES[compact] ?? compact;
}

for (const code of Object.values(SUBJECT_ALIASES)) SUBJECT_CODES.add(code);

/** A course number: optional C/H/N/R/W style prefix, 1 to 3 digits, optional letters ("C100", "R1A", "21AC"). */
const NUMBER_RE = /^[A-Z]{0,2}\d{1,3}[A-Z]{0,3}$/;

function subjectIfKnown(raw: string): string | null {
  if (!raw.trim()) return null;
  const s = normalizeSubject(raw);
  return SUBJECT_CODES.has(s) ? s : null;
}

/**
 * "comp sci 61a" -> "COMPSCI 61A". Also takes the forms students type: "cs61a", "ee16a",
 * "math1b", "datac100", "Data 100". Returns null if it doesn't look like a course.
 * It only fixes the spelling; use resolveCourseId to match against the catalog.
 */
export function normalizeCourseId(raw: string): CourseId | null {
  const s = raw
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ");
  if (!s || s.length > 60) return null;

  // "COMPSCI 61A", "L & S C70T", "COG SCI 1": the last word is the number
  const sp = s.lastIndexOf(" ");
  let spaced: CourseId | null = null;
  if (sp > 0) {
    const subj = s.slice(0, sp).replace(/[\s\-:.,]+$/, "");
    const num = s.slice(sp + 1);
    if (NUMBER_RE.test(num) && /[A-Z]/.test(subj)) {
      const known = subjectIfKnown(subj);
      if (known) return `${known} ${num}`;
      // an unknown subject of a single letter is a stray character, not a department
      const compact = normalizeSubject(subj);
      if (compact.length >= 2) spaced = `${compact} ${num}`;
    }
  }

  // "CS61A", "DATAC100", "COG SCI1", "MATH-1B": subject and number run together. Try every place the
  // number could start and take the longest subject we know.
  const tail = s.match(/[A-Z]{0,2}\d{1,3}[A-Z]{0,3}$/);
  if (tail && tail.index !== undefined) {
    const firstDigit = tail.index + tail[0].search(/\d/);
    for (let cut = firstDigit; cut >= tail.index && cut > 0; cut--) {
      const subj = s.slice(0, cut).replace(/[\s\-:.,]+$/, "");
      const known = subjectIfKnown(subj);
      if (known) return `${known} ${s.slice(cut)}`;
    }
  }
  if (spaced) return spaced;
  const glued = s.match(/^([A-Z][A-Z &,]*?)[\s\-:.]*(\d{1,3}[A-Z]{0,3})$/);
  if (glued) {
    const subj = normalizeSubject(glued[1]);
    if (subj.length >= 2) return `${subj} ${glued[2]}`;
  }
  return null;
}

/** Letters Berkeley puts in front of a number: cross-listed, R&C, summer, web, honors. */
const NUMBER_PREFIXES = ["C", "R", "N", "W", "H"];

/**
 * EECS classes are listed under EECS in some catalog years and under ELENG or COMPSCI in
 * others, so "EECS 16A" finds "ELENG 16A" when that is how the catalog has it.
 */
const SIBLING_SUBJECTS: Record<string, string[]> = {
  EECS: ["ELENG", "COMPSCI"],
  ELENG: ["EECS"],
  COMPSCI: ["EECS"],
};

function withPrefixes(subject: string, number: string, known: { has(id: string): boolean }): CourseId | null {
  // Only a plain number can gain a prefix ("100" -> "C100"); "C100" or "R1A" already has one.
  if (!/^\d/.test(number)) return null;
  for (const p of NUMBER_PREFIXES) {
    const id = `${subject} ${p}${number}`;
    if (known.has(id)) return id;
  }
  return null;
}

/**
 * The catalog id for loose input, or null when nothing in `known` matches.
 *
 * "cs61a" -> "COMPSCI 61A"; "data 100" -> "DATA C100" (the cross-listing C is often dropped);
 * "english 1a" -> "ENGLISH R1A"; "eecs 16a" -> "ELENG 16A" when that is how the catalog lists it.
 * An exact match always wins, so "COMPSCI 189" never becomes "COMPSCI C189". When more than one
 * prefix would fit, the order is C, R, N, W, H.
 */
export function resolveCourseId(raw: string, known: { has(id: string): boolean }): CourseId | null {
  const id = normalizeCourseId(raw);
  if (!id) return null;
  if (known.has(id)) return id;
  const sp = id.lastIndexOf(" ");
  const subject = id.slice(0, sp);
  const number = id.slice(sp + 1);

  const prefixed = withPrefixes(subject, number, known);
  if (prefixed) return prefixed;

  for (const sib of SIBLING_SUBJECTS[subject] ?? []) {
    if (known.has(`${sib} ${number}`)) return `${sib} ${number}`;
  }
  for (const sib of SIBLING_SUBJECTS[subject] ?? []) {
    const p = withPrefixes(sib, number, known);
    if (p) return p;
  }
  return null;
}

/** Numeric part of a course number: "C100" -> 100, "61A" -> 61, "W10" -> 10. */
export function courseNumberValue(courseIdOrNumber: string): number {
  const num = courseIdOrNumber.includes(" ") ? courseIdOrNumber.split(" ").pop()! : courseIdOrNumber;
  const m = num.match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}

export function subjectOf(id: CourseId): string {
  const parts = id.split(" ");
  parts.pop();
  return parts.join(" ");
}

export function isUpperDivision(id: CourseId): boolean {
  const n = courseNumberValue(id);
  return n >= 100 && n < 200;
}

export function courseUnits(c: Course | undefined, fallback = 4): number {
  if (!c) return fallback;
  return Array.isArray(c.units) ? c.units[1] : c.units;
}
