#!/usr/bin/env python3
"""Turn the scraped Berkeley catalog into the files the planner reads.

Pipeline:
  1. scripts/scrape_catalog.js + scripts/fetch_payloads.py fill data/.cache/catalog/ (git-ignored).
  2. `build_requirements.py --pack` squeezes that cache into data/raw/catalog/*.json.gz (committed, so the
     build below is reproducible without touching the network).
  3. `build_requirements.py` reads data/raw/catalog/ and writes:
       data/courses.json                    lean course list with breadths[] and attributes[]
       data/course_details.json             descriptions and prerequisite text, keyed by course id
       data/subjects.json                   subject codes plus spelling aliases ("EL ENG" -> ELENG)
       data/requirements/colleges.json      colleges and their requirement group
       data/requirements/majors.json        every major (and dual/joint program)
       data/requirements/minors.json        every minor
       data/requirements/groups/<id>.json   one requirement group each (major, minor, college, university)
       data/requirements/REPORT.md          counts and anything that needs a human look

The rule format is documented in docs/data-contracts.md (section 2) and CLAUDE.md.
Usage: python3 scripts/build_requirements.py [--pack] [--strict]
"""
import collections
import glob
import gzip
import html
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", ".cache", "catalog")
RAW = os.path.join(ROOT, "data", "raw", "catalog")
REQ = os.path.join(ROOT, "data", "requirements")
GROUPS = os.path.join(REQ, "groups")
OVERRIDES = os.path.join(REQ, "overrides")
CHOICES_FILE = os.path.join(OVERRIDES, "choices.json")
SUPPLEMENT = os.path.join(ROOT, "data", "raw", "supplement", "courses.json")
PREDICTIONS = os.path.join(ROOT, "data", "predictions", "predictions.json")
CATALOG = "https://undergraduate.catalog.berkeley.edu"
CATALOG_YEAR = "2026-27"

BREADTHS = ["Arts & Literature", "Biological Science", "Historical Studies", "International Studies",
            "Philosophy & Values", "Physical Science", "Social & Behavioral Sciences"]
HSS_BREADTHS = {"Arts & Literature", "Historical Studies", "International Studies", "Philosophy & Values",
                "Social & Behavioral Sciences"}
ATTRS = {"AC", "RCA", "RCB", "ELW", "AH&I", "QR", "FL", "UD", "HSS"}
COLLEGES = {
    "LS": ("College of Letters & Science", "letters-science"),
    "CDSS": ("College of Computing, Data Science, and Society", "computing-data-science-society"),
    "COE": ("College of Engineering", "engineering"),
    "HAAS": ("Haas School of Business", "haas"),
    "CED": ("College of Environmental Design", "environmental-design"),
    "CNR": ("Rausser College of Natural Resources", "rausser-natural-resources"),
    "CHEM": ("College of Chemistry", "chemistry"),
    "BSE": ("Berkeley School of Education", "bse"),
}
COLLEGE_PREFIX = {"CLS": "LS", "COE": "COE", "CNR": "CNR", "CCH": "CHEM", "CED": "CED", "CDSS": "CDSS", "BUS": "HAAS", "GSE": "BSE"}
LEVEL_COLLEGE = {"Undergrad Letters & Science": "LS", "Undergrad Engineering": "COE", "Rausser Clg Natural Resources": "CNR",
                 "Undergrad Chemistry": "CHEM", "Undergrad Environmental Design": "CED", "Undergrad Comp Data Sci & Soc": "CDSS",
                 "Undergrad Business": "HAAS", "Undergraduate Education": "BSE"}
# Older spellings people (and transcripts, Berkeleytime, department sites) still use. An alias is only
# emitted when it maps onto a subject code that exists in the catalog.
LEGACY_SUBJECTS = ["EL ENG", "L & S", "L&S", "PB HLTH", "MEC ENG", "CIV ENG", "IND ENG", "MAT SCI", "NUC ENG", "BIO ENG",
                   "CHM ENG", "ENV DES", "CY PLAN", "LD ARCH", "POL SCI", "PHYS ED", "A,RESEC", "S,SEASN", "S ASIAN",
                   "SE ASIAN", "M E STU", "NE STUD", "NAT RES", "NATAMST", "ETH STD", "ENE,RES", "COM LIT", "COG SCI",
                   "DEV STD", "ENV SCI", "MIL AFF", "MIL SCI", "NAV SCI", "PUB POL", "SOC WEL", "VIS SCI", "VIS STD",
                   "EA LANG", "AERO ENG", "DES INV", "ENV ECON", "GLOBAL", "HIN-URD", "ISF", "MED ST", "NWMEDIA",
                   "PUB AFF", "S,SEASN", "SCANDIN", "MALAY/I", "ASAMST", "LAN PRO", "DEV ENG", "DATASCI", "ENGIN"]
NICKNAMES = {"CS": "COMPSCI", "EE": "ELENG", "MCB": "MCELLBI", "IB": "INTEGBI", "PH": "PBHLTH", "BIOE": "BIOENG",
             "CEE": "CIVENG", "ME": "MECENG", "IEOR": "INDENG", "MSE": "MATSCI", "NE": "NUCENG", "CHEME": "CHMENG",
             "PS": "POLSCI", "POLISCI": "POLSCI", "GWS": "GWS", "NST": "NUSCTX", "ESPM": "ESPM", "EPS": "EPS"}


# Shorthands students use for programs, matched against the program name (regex, case-insensitive).
# add_aliases() also adds department subject codes and the initials of the name.
PROGRAM_ALIASES = [
    (r"^Cognitive Science", ["cogsci", "cog sci"]),
    (r"^Data Science", ["ds", "data sci", "datasci"]),
    (r"^Computer Science$", ["cs", "compsci", "comp sci"]),
    (r"Electrical Engineering and Computer Science", ["eecs", "ee", "electrical engineering"]),
    (r"^Electrical and Computer Engineering", ["ece", "ee", "electrical engineering"]),
    (r"Molecular and Cell Biology", ["mcb"]),
    (r"Integrative Biology", ["ib"]),
    (r"^Political Science", ["poli sci", "polisci", "ps"]),
    (r"^Political Economy", ["polecon", "poli econ", "pe"]),
    (r"^Economics", ["econ"]),
    (r"Mechanical Engineering", ["meche", "me", "mech e"]),
    (r"Industrial Engineering and Operations Research", ["ieor"]),
    (r"Business", ["haas", "business", "biz"]),
    (r"^Business Administration", ["ugba", "bba"]),
    (r"Public Health", ["ph", "pubhealth", "pub health"]),
    (r"Psychology", ["psych"]),
    (r"Bioengineering", ["bioe", "bio e"]),
    (r"Materials Science", ["mse", "mat sci"]),
    (r"^Civil Engineering|^Environmental Engineering$|^Structural Engineering|^Geosystems", ["cee", "civ e"]),
    (r"Nuclear Engineering", ["ne", "nuc e"]),
    (r"Chemical Engineering", ["cheme", "cbe", "chem e"]),
    (r"^Chemical Biology", ["chembio", "chem bio"]),
    (r"^Chemistry", ["chem"]),
    (r"Environmental Economics and Policy", ["eep"]),
    (r"Conservation and Resource Studies", ["crs"]),
    (r"Interdisciplinary Studies", ["isf"]),
    (r"Applied Math", ["applied math", "am", "amath"]),
    (r"^Mathematics", ["math", "maths"]),
    (r"^Statistics", ["stats", "stat"]),
    (r"Engineering Math and Statistics", ["ems"]),
    (r"Operations Research and Management Science", ["orms"]),
    (r"Molecular Environmental Biology", ["meb"]),
    (r"and Business( Administration)?$", ["met", "m.e.t."]),
    (r"^Global Studies", ["gs", "global", "dev studies", "development studies", "pacs", "peace and conflict"]),
    (r"Sustainable|^Sustainability", ["sustainability"]),
    (r"Middle Eastern|^Jewish Studies|^Hebrew|^Arabic|^Persian|^Turkish", ["near eastern", "mes", "middle east"]),
    (r"^Jewish Studies|^Hebrew|Middle Eastern Languages", ["jewish"]),
    (r"Molecular and Cell Biology", ["mcellbi"]), (r"Integrative Biology", ["integbi"]), (r"^Political Science", ["polsci"]),
    (r"Public Health", ["pbhlth"]), (r"Industrial Engineering and Operations Research", ["indeng"]),
    (r"Society and Environment", ["se"]), (r"^Ethnic Studies", ["ethnic studies"]),
    (r"Legal Studies", ["legal"]),
    (r"Media Studies", ["media"]),
    (r"^Nutrition", ["nst", "nutrition", "nutri sci"]),
    (r"Society and Environment", ["s&e", "s and e"]),
    (r"Engineering Physics", ["ep", "engphys", "eng phys"]),
    (r"Environmental Engineering Science", ["ees"]),
    (r"^Environmental Sciences|^Environmental Earth Science", ["es", "envsci", "env sci"]),
    (r"Urban Studies|City and Regional Planning", ["urban", "urbst", "city planning", "cp"]),
    (r"^Architecture", ["arch"]),
    (r"Landscape Architecture", ["la", "ld arch", "land arch", "landscape"]),
    (r"City and Regional Planning", ["dcrp", "city planning", "crp"]),
    (r"Sustainable Environmental Design", ["sed"]),
    (r"Aerospace Engineering", ["aero", "aerospace"]),
    (r"Energy Engineering", ["energy"]),
    (r"^Astrophysics", ["astro"]),
    (r"^Physics", ["phys"]),
    (r"Earth (&|and) Planetary Science", ["eps"]),
    (r"^Anthropology", ["anthro"]),
    (r"^Sociology", ["soc"]),
    (r"^Social Welfare", ["sw", "socwel"]),
    (r"^Philosophy", ["phil", "philo"]),
    (r"^Linguistics", ["ling"]),
    (r"^History of Art", ["art history", "histart"]),
    (r"^Rhetoric", ["rhet"]),
    (r"^Comparative Literature", ["comp lit", "complit"]),
    (r"Gender and Women's Studies", ["gws"]),
    (r"^African American Studies", ["afam", "africam"]),
    (r"^Asian American", ["aaads", "asamst"]),
    (r"^Chicanx Latinx", ["chicano studies", "chicanx"]),
    (r"^Ethnic Studies", ["es", "ethstd"]),
    (r"^Native American Studies", ["nas"]),
    (r"^American Studies", ["amerstd"]),
    (r"Theater", ["tdps", "theater", "theatre"]),
    (r"^Dance", ["tdps", "dance"]),
    (r"^Film", ["film"]),
    (r"^Neuroscience", ["neuro"]),
    (r"^Microbial Biology", ["mb", "microbio"]),
    (r"Genetics and Plant Biology", ["gpb", "plant bio"]),
    (r"Ecosystem Management and Forestry", ["emf", "forestry"]),
    (r"^Forestry", ["forestry"]),
    (r"Life Science, Business", ["lsbe"]),
    (r"^Analytics", ["analytics", "ieor"]),
    (r"^Educational Sciences|^Education$", ["educ", "ed"]),
    (r"Middle Eastern Languages", ["melc", "nes"]),
    (r"South (and|&) Southeast Asian", ["sseas"]),
    (r"^Spanish and Portuguese", ["spanish", "portuguese", "span-port"]),
    (r"^Slavic", ["slavic", "russian"]),
    (r"East Asian", ["ealc"]),
    (r"^Public Policy", ["pp", "gspp"]),
    (r"^Journalism", ["jschool", "j-school"]),
    (r"^Demography", ["demog"]),
    (r"Global Poverty", ["gpp"]),
    (r"^Bioengineering/Materials", ["bioe/mse"]),
    (r"^Logic$", ["logic"]),
    (r"Science, Technology, and Society", ["sts"]),
]
ALIAS_STOP = {"and", "of", "the", "in", "for", "to", "a", "an", "minor", "major", "joint", "program", "dual", "degree"}


# Department names as the catalog writes them in "formerly known as" and in prose lists -> subject code.
DEPT_NAMES = {
    "Digital Humanities": "DIGHUM", "Engineering": "ENGIN", "Industrial Engineering": "INDENG", "International & Area Studies": "IAS",
    "Landscape Architecture & Environmental Planning": "LDARCH", "Letters & Science": "LS", "Nutritional Science and Toxicology": "NUSCTX",
    "Physical Education": "PHYSED", "Plant and Microbial Biology": "PLANTBI", "Public Health": "PBHLTH",
    "Environmental Science, Policy and Management": "ESPM", "Cognitive Science": "COGSCI", "Chemical and Biomolecular Engineering": "CHMENG",
    "City and Regional Planning": "CYPLAN", "Chemistry": "CHEM", "Compsci": "COMPSCI", "Data": "DATA", "STS": "STS",
    "Computational Biology": "CMPBIO",
    "Slavic Languages and Literatures": "SLAVIC", "Linguistics": "LINGUIS", "Hindi-Urdu": "HINURD", "Statistics": "STAT",
    "Political Economy of Industrial Societies": "POLECON", "Political Economy of Industrial Soc": "POLECON",
    "Political Economy of Industrical Societies": "POLECON", "Women's Studies": "GWS", "WOMENST": "GWS", "Computer Science": "COMPSCI",
    "Scandinavian": "SCANDIN", "Geology": "EPS", "Geophysics": "EPS", "Business Administration": "UGBA", "NUTRSCI": "NUSCTX",
    "Integrative Biology": "INTEGBI", "Dramatic Art": "THEATER", "Economics": "ECON", "Psychology": "PSYCH",
    "Data Science, Undergraduate": "DATA", "Data Science": "DATA", "Information": "INFO", "History": "HISTORY",
    "Chinese": "CHINESE", "Physics": "PHYSICS", "Political Science": "POLSCI", "Demography": "DEMOG",
    "Molecular and Cell Biology": "MCELLBI", "American Studies": "AMERSTD", "New Media": "NWMEDIA", "Environmental Design": "ENVDES",
    "Asian American Studies": "ASAMST", "Ethnic Studies": "ETHSTD", "French": "FRENCH", "Journalism": "JOURN", "Education": "EDUC",
    "Geography": "GEOG", "Undergraduate Interdisciplinary Studies": "UGIS", "Undergrad Interdisciplinary Studies": "UGIS",
    "South and Southeast Asian Studies": "SSEASN", "South Asian": "SASIAN", "Near Eastern Studies": "MELC",
    "Mathematics": "MATH", "Anthropology": "ANTHRO", "Architecture": "ARCH", "Astronomy": "ASTRON", "Bioengineering": "BIOENG",
    "Chemical and Biomolecular Engineering": "CHMENG", "Chemical Engineering": "CHMENG", "Chemistry": "CHEM",
    "Civil and Environmental Engineering": "CIVENG", "Cognitive Science": "COGSCI", "Earth and Planetary Science": "EPS",
    "Electrical Engineering": "ELENG", "Electrical Engineering and Computer Sciences": "EECS", "Energy and Resources Group": "ENERES",
    "Environmental Economics and Policy": "ENVECON", "Environmental Science, Policy, and Management": "ESPM",
    "Industrial Engineering and Operations Research": "INDENG", "Legal Studies": "LEGALST",
    "Materials Science and Engineering": "MATSCI", "Mechanical Engineering": "MECENG", "Nuclear Engineering": "NUCENG",
    "Nutritional Sciences and Toxicology": "NUSCTX", "Philosophy": "PHILOS", "Plant and Microbial Biology": "PLANTBI",
    "Public Health": "PBHLTH", "Public Policy": "PUBPOL", "Sociology": "SOCIOL", "City and Regional Planning": "CYPLAN",
    "Landscape Architecture": "LDARCH", "Neuroscience": "NEU", "Music": "MUSIC", "Film": "FILM", "Rhetoric": "RHETOR",
    "Global Studies": "GLOBAL", "Media Studies": "MEDIAST", "English": "ENGLISH", "Engineering": "ENGIN",
}
# The same class under two numbers where the catalog does not say so (old id, current id), with the evidence.
SAME_AS = [("ELENG 16A", "ELENG 66"), ("ELENG 16B", "ELENG 64"), 
    ("UGBA 10", "UGBA 10X"),      # Haas replaced "Principles of Business" with "Foundations of Business" (10X) as the prerequisite
    ("EECS 16A", "ELENG 16A"),    # the EECS 16 series was recoded EL ENG 16A/16B; same title and units
    ("EECS 16B", "ELENG 16B"),
]
# Berkeleytime gives a retired id the title of the class that replaced it; the title it was taught under:
SUPPLEMENT_TITLES = {"EECS 16A": "Designing Information Devices and Systems I", "EECS 16B": "Designing Information Devices and Systems II"}
OPTIONAL_BLOCK = re.compile(r"\b(honors|optional|recommended)\b", re.I)
# (groupId, block, rule): further prose rules that only restate their heading or a choice; folded into notes like the generic ones
FOLD = {("major-molecular-environmental-biology-bs", "Concentrations", "Area of Concentration"),
        ("major-analytics-ba", "Upper Division Electives", "Concentration Electives"),
        ("major-microbial-biology-bs", "Concentrations", "Choose Option 1 or Option 2"),
        ("major-economics-ba", "Upper Division Requirements", "Course Requirements"),
        ("major-statistics-ba", "Cluster Courses", "Requirement")}
# programs whose course lists are written "Department: 101, C102 (note), 110*. Not 105" and are read leniently
LENIENT_LISTS = {"Statistics"}
GENERIC_RULE_NAMES = {"", "requirement", "requirements", "note", "notes", "note:", "course requirements", "areas", "options", "categories"}


def load(path):
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def dump(path, obj, compact=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if path.endswith(".gz"):
        with gzip.GzipFile(path, "wb", mtime=0) as gz:
            gz.write(json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8"))
        return
    with open(path, "w", encoding="utf-8") as f:
        if compact:
            f.write("[\n" + ",\n".join(json.dumps(x, ensure_ascii=False, separators=(",", ":")) for x in obj) + "\n]\n")
        else:
            json.dump(obj, f, indent=1, ensure_ascii=False)
            f.write("\n")


def text_of(markup):
    """HTML fragment -> readable plain text (keeps list bullets and line breaks)."""
    if not markup:
        return ""
    s = re.sub(r"<li[^>]*>", "\n- ", markup)
    s = re.sub(r"</(p|h\d|tr|ul|ol|div|table)>|<br\s*/?>", "\n", s)
    s = re.sub(r"</t[dh]>", " | ", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ").replace("​", "")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r" ?\n ?", "\n", s)
    s = re.sub(r"\n-\s*\n", "\n- ", s)
    s = re.sub(r"( \| )+\n", "\n", s)
    return re.sub(r"\n{2,}", "\n", s).strip()


def clip(s, n):
    """Shorten at the end of a line or sentence (never mid-word, never mid-list item) and say that there is more."""
    if len(s) <= n:
        return s
    head = s[:n]
    cut = max(head.rfind("\n"), head.rfind(". ") + 1)
    if cut < n // 3:
        cut = head.rfind(" ")
    return head[:cut].rstrip(" ,;:-\n") + " … (see the catalog for the rest)"


def slug(s):
    s = s.lower().replace("&", " and ")
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", s)).strip("-")


def tidy(s):
    """Catalog names carry tabs, non-breaking spaces, doubled or trailing spaces and trailing colons."""
    s = re.sub(r"\s+", " ", (s or "").replace("\xa0", " ")).strip()
    s = s.replace("Seminiars", "Seminars").replace("Mathmatics", "Mathematics")  # the catalog's own typos
    s = re.sub(r"\s*:\s*(?=[A-Za-z])", ": ", s)  # "Structural Biology:Track 2" -> "Structural Biology: Track 2"
    return s.rstrip(":").strip()


def tidy_section(s):
    """One spelling for the two commonest headings ("Upper-Division Requirements" -> "Upper Division")."""
    s = tidy(s)
    m = re.match(r"^(upper|lower)[- ]division(?: (?:requirements?|courses))?$", s, re.I)
    return f"{m.group(1).title()} Division" if m else s


WORD_NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
# "Complete at least 3 of:", "Complete at least 2 of the following courses:", "Earn at least 8 credits from the following:"
LIST_HEAD = re.compile(r"^(?:complete|take|select|choose|earn)\s+(?:at least\s+|a minimum of\s+|any\s+)?(\d+|" + "|".join(WORD_NUMBERS) + r")"
                       r"\s*(units?|credits?|courses?)?\s*(?:of|from)?(?:\s+the following(?:\s+(?:courses|list))?)?\s*:?$", re.I)
EXAM_LINE = re.compile(r"^(?:- )?(?:AP|IB|A-?LEVEL|GCE)\b[^\n]*\bscore\b", re.I)
# "Physics: Option 1", "Upper Division Course 2 - Option 2", "Biology, Option 1", "Physics B Option 2 (only for ...)"
OPTION_SUFFIX = re.compile(r"^(?P<base>.*?)[\s:,\-–(]*\bOption (?P<n>\d+)\)?(?P<tail>\s*\(.*\))?$")


def exam_lead_in(notes):
    """Give bare lists of exam scores ("- AP: Statistics, score 3+") a sentence a student can read."""
    out, prev_exam, prev = [], False, ""
    for line in (notes or "").split("\n"):
        is_exam = bool(EXAM_LINE.match(line.strip()))
        if is_exam:
            line = re.sub(r"\bALEVEL\b", "A-Level", line.strip())
            if not line.startswith("- "):
                line = "- " + line
            if not prev_exam and not (prev.rstrip().endswith(":") and re.search(r"exam|satisf", prev, re.I)):
                out.append("Also satisfied by:")
        out.append(line)
        prev_exam, prev = is_exam, line
    return "\n".join(out)


def compact_notes(notes):
    """Notes are printed above the rule: a run of more than 12 bare course-id bullets becomes one short line,
    and a line or sentence that was already said is not said again."""
    seen, fresh = set(), []
    for line in (notes or "").split("\n"):
        key = re.sub(r"^(?:Option \d+[^:]*: )", "", line.strip()).lower()
        if key and key in seen and len(key) > 25:
            continue
        seen.add(key)
        fresh.append(line)
    notes = "\n".join(fresh)
    out, run = [], []

    def flush():
        if len(run) > 12:
            out.append(clip(", ".join(run), 260) + " (full list on the catalog page)")
        else:
            out.extend("- " + x for x in run)
        run.clear()
    for line in (notes or "").split("\n"):
        m = re.match(r"^- ([A-Z][A-Z0-9]* [A-Z]{0,2}\d{1,3}[A-Z]{0,3})$", line.strip())
        if m:
            run.append(m.group(1))
        else:
            flush()
            out.append(line)
    flush()
    return "\n".join(out)


# --------------------------------------------------------------------------- pack

def pack():
    """Squeeze the scrape cache into the committed raw snapshot.

    The cache may be partial (only the courses that were missing were fetched again): whatever it does not
    hold is kept from the existing snapshot. Fails when a course the catalog lists has no detail record,
    unless --allow-missing is given, so a throttled download cannot silently shrink the course list."""
    programs = [load(f) for f in sorted(glob.glob(os.path.join(CACHE, "program_payloads", "*.json")))]
    have_programs = bool(programs)
    if not have_programs:
        print("pack: no program payloads in the cache; keeping programs, requisite sets and course sets from the snapshot")
    sets, csets, seen_courses, req_paths, page_text = {}, {}, {}, {}, {}
    for f in sorted(glob.glob(os.path.join(CACHE, "programs", "*.json"))):
        p = load(f)
        req_paths[p["id"]] = p.get("requirementsPath")
        page_text[p["id"]] = p.get("text")
        for s in p.get("requisiteSets", []):
            sets[s["requisiteSetGroupId"]] = {k: s.get(k) for k in ("requisiteSetGroupId", "name", "description", "requisites", "effectiveStartDate")}
        for blob in p.get("courseSets", []):
            for v in (blob or {}).values():
                if isinstance(v, dict) and v.get("courseSetGroupId"):
                    csets[v["courseSetGroupId"]] = {"courseSetGroupId": v["courseSetGroupId"], "name": v.get("name"),
                                                    "description": v.get("description"),
                                                    "courses": v.get("dynamicCourseList") or v.get("courseList") or []}
        for gid, c in (p.get("courses") or {}).items():
            seen_courses[str(gid)] = c
    # Requirement rules sometimes name a course by its older internal id; collect old id -> current id.
    old_ids = collections.defaultdict(set)
    listing = os.path.join(CACHE, "courses_list.json")
    for c in list(seen_courses.values()) + (load(listing) if os.path.exists(listing) else []):
        if c.get("deprecatedCourseGroupId") and c.get("courseGroupId"):
            old_ids[str(c["courseGroupId"])].add(str(c["deprecatedCourseGroupId"]))
    courses = {}
    raw_courses_path = os.path.join(RAW, "courses.json.gz")
    if os.path.exists(raw_courses_path) and "--pack-fresh" not in sys.argv:
        courses = {str(c["courseGroupId"]): c for c in load(raw_courses_path)}  # base: the existing snapshot
    fresh = 0
    for f in glob.glob(os.path.join(CACHE, "course_payloads", "*.json")):
        c = load(f)
        fresh += 1
        cf = c.get("customFields") or {}
        ch = (c.get("credits") or {}).get("creditHours") or {}
        if c.get("deprecatedCourseGroupId"):
            old_ids[str(c["courseGroupId"])].add(str(c["deprecatedCourseGroupId"]))
        for x in c.get("crossListedCourses") or []:
            if isinstance(x, dict) and x.get("deprecatedCourseGroupId") and x.get("courseGroupId"):
                old_ids[str(x["courseGroupId"])].add(str(x["deprecatedCourseGroupId"]))
        courses[str(c["courseGroupId"])] = {
            "courseGroupId": str(c["courseGroupId"]), "subjectCode": c.get("subjectCode"), "courseNumber": c.get("courseNumber"),
            "longName": c.get("longName"), "description": c.get("description"), "career": c.get("career"),
            "creditsMin": ch.get("min"), "creditsMax": ch.get("max"), "departments": c.get("departments"),
            "breadth": cf.get("approvedBreadthAreas"), "americanCultures": cf.get("americanCulturesRequirement"),
            "universityRequirements": cf.get("universityRequirements"), "readingComposition": cf.get("courseProposetToMeetThe"),
            "foreignLanguageLevel": cf.get("foreignLanguageAcquisitionLevelOfInstruction"),
            "catalogAttributes": cf.get("catalogAttributes"), "formerly": cf.get("formerCodeCatalogDisplay"),
            "offering": cf.get("customOfferingPhrase"), "gradeMode": c.get("gradeMode"),
            "crossListed": [x.get("courseGroupId") for x in (c.get("crossListedCourses") or []) if isinstance(x, dict)],
            "requisites": c.get("requisites"),
        }
    for gid, c in seen_courses.items():  # courses a program references that are not in the undergraduate list (e.g. graduate)
        if (gid not in courses or courses[gid].get("fromProgramPage")) and c.get("subjectCode") and c.get("courseNumber"):
            courses[gid] = {"courseGroupId": gid, "subjectCode": c["subjectCode"], "courseNumber": c["courseNumber"],
                            "longName": c.get("longName"), "description": c.get("description"), "career": c.get("career"),
                            "creditsMin": c.get("creditsMin"), "creditsMax": c.get("creditsMax"),
                            "catalogAttributes": c.get("catalogAttributes"), "fromProgramPage": True}
    for gid, olds in old_ids.items():
        if gid in courses:
            courses[gid]["oldIds"] = sorted(set(olds) | set(courses[gid].get("oldIds") or []))
    # Completeness: every course in the catalog's list (and in its own CSV export) must have a detail record.
    problems = []
    rich = {gid for gid, c in courses.items() if "breadth" in c}
    if os.path.exists(listing):
        listed = {str(c["courseGroupId"]): f"{c.get('subjectCode')} {c.get('courseNumber')}" for c in load(listing) if c.get("courseGroupId")}
        lost = sorted(v for k, v in listed.items() if k not in rich)
        if lost:
            problems.append(f"{len(lost)} listed courses have no detail record (failed downloads?): {', '.join(lost[:40])}")
    export = os.path.join(CACHE, "courses_export.csv")
    index_path = os.path.join(RAW, "course_index.json.gz")
    if os.path.exists(export):
        import csv
        with open(export, encoding="utf-8-sig", newline="") as f:
            exported = sorted({f"{r['Subject']} {r['Course Number']}".upper().strip() for r in csv.DictReader(f)})
        dump(index_path, exported)  # the catalog's own list of course ids, checked again on every build
    if os.path.exists(index_path):
        have_ids = {f"{c['subjectCode']} {c['courseNumber']}".upper().strip() for gid, c in courses.items() if gid in rich}
        lost = sorted(set(load(index_path)) - have_ids)
        if lost:
            problems.append(f"{len(lost)} courses in the catalog's CSV export have no detail record: {', '.join(lost[:40])}")
    if problems:
        print("PACK INCOMPLETE:\n  " + "\n  ".join(problems))
        if "--allow-missing" not in sys.argv:
            sys.exit("pack: refusing to write an incomplete course snapshot (re-run the fetch, or pass --allow-missing)")
    if have_programs:
        for p in programs:
            p["requirementsPath"] = req_paths.get(p.get("programGroupId"))
            p["pageText"] = page_text.get(p.get("programGroupId"))  # the Requirements tab as a visitor sees it, for cross-checks
        dump(os.path.join(RAW, "programs.json.gz"), programs)
        dump(os.path.join(RAW, "requisite_sets.json.gz"), sets)
        dump(os.path.join(RAW, "course_sets.json.gz"), csets)
    dump(raw_courses_path, [courses[k] for k in sorted(courses)])
    print(f"packed {len(programs)} programs, {len(sets)} requisite sets, {len(csets)} course sets, {len(courses)} courses ({fresh} from the cache)")


# --------------------------------------------------------------------------- build

class Builder:
    def __init__(self):
        self.programs = load(os.path.join(RAW, "programs.json.gz"))
        for p in self.programs:
            p["catalogDisplayName"] = re.sub(r"\s*/\s*", "/", re.sub(r"\s+", " ", p["catalogDisplayName"]).strip())
        self.sets = load(os.path.join(RAW, "requisite_sets.json.gz"))
        self.csets = load(os.path.join(RAW, "course_sets.json.gz"))
        self.raw_courses = load(os.path.join(RAW, "courses.json.gz"))
        index = os.path.join(RAW, "course_index.json.gz")
        self.course_index = load(index) if os.path.exists(index) else []
        self.supplement = load(SUPPLEMENT) if os.path.exists(SUPPLEMENT) else []
        self.choice_specs = (load(CHOICES_FILE).get("programs") or {}) if os.path.exists(CHOICES_FILE) else {}
        self.group_overrides = {os.path.basename(f)[:-5]: load(f) for f in sorted(glob.glob(os.path.join(OVERRIDES, "*.json")))
                                if os.path.basename(f) != "choices.json"}
        self.gid2id = {}
        self.courses = {}
        self.warnings = []
        self.fatal = []  # problems that must fail a --strict build (and the tests)
        self.used_courses = set()
        self.unresolved = collections.Counter()
        self.stats = collections.defaultdict(list)  # what the clean-up passes did, for REPORT.md
        self.build_courses()

    # ---- courses
    def build_courses(self):
        # Two catalog records can share a number (an older version of a course and its replacement). The
        # current undergraduate record supplies the title and tags; both internal ids resolve to the one id.
        rank = lambda c: (0 if "breadth" in c else 1, 0 if c.get("career") == "Undergraduate" else 1, str(c["courseGroupId"]))  # noqa: E731
        for c in sorted(self.raw_courses, key=rank):
            cid = f"{c['subjectCode']} {c['courseNumber']}".upper().strip()
            self.gid2id[str(c["courseGroupId"])] = cid
            if cid in self.courses:
                continue
            for old in c.get("oldIds") or []:
                self.gid2id.setdefault(old, cid)
            lo, hi = c.get("creditsMin"), c.get("creditsMax")
            units = lo if (hi is None or lo == hi) else [lo, hi]
            breadths = set()
            for raw in c.get("breadth") or []:
                hit = next((x for x in BREADTHS if x.split(" ")[0].lower() == raw.strip().split(" ")[0].lower()), None)
                if hit:
                    breadths.add(hit)
                else:
                    self.warnings.append(f"unknown breadth area {raw!r} on {cid}")
            breadths = sorted(breadths)
            attrs = set()
            if c.get("americanCultures"):
                attrs.add("AC")
            ureq = " ".join(c.get("universityRequirements") or [])
            if "American" in ureq:
                attrs.add("AH&I")
            if "Entry Level Writing" in ureq:
                attrs.add("ELW")
            rc = c.get("readingComposition") or ""
            if "First half" in rc or "First or second" in rc:
                attrs.add("RCA")
            if "Second half" in rc or "First or second" in rc:
                attrs.add("RCB")
            levels = c.get("foreignLanguageLevel") or []
            if any(l for l in levels if l != "Beginning 1st semester"):
                attrs.add("FL")  # completes at least second-semester college level
            digits = int(re.sub(r"\D", "", c["courseNumber"]) or 0)
            if 100 <= digits <= 199:
                attrs.add("UD")
            if (set(breadths) & HSS_BREADTHS) or attrs & {"RCA", "RCB", "AC"}:
                attrs.add("HSS")
            self.courses[cid] = {
                "id": cid, "subject": c["subjectCode"].upper(), "number": c["courseNumber"].upper(),
                "title": c.get("longName") or "", "units": units, "breadths": breadths, "attributes": attrs,
                "crossListedGids": c.get("crossListed") or [], "career": c.get("career"),
                "_rich": "breadth" in c, "_desc": c.get("description"), "_req": c.get("requisites"),
                "_offering": c.get("offering"), "_formerly": c.get("formerly"), "_levels": levels,
                "_grading": c.get("gradeMode"),
            }
        # Courses that exist in the enrollment data but that the catalog no longer publishes (retired or
        # renumbered). They come from Berkeleytime (scripts/fetch_supplement.py) and are marked as such.
        for c in self.supplement:
            cid = c["id"].upper().strip()
            if cid in self.courses:
                continue
            subj, number = cid.rsplit(" ", 1)
            digits = int(re.sub(r"\D", "", number) or 0)
            attrs = {"UD"} if 100 <= digits <= 199 else set()
            lo, hi = c.get("unitsMin"), c.get("unitsMax")
            self.courses[cid] = {
                "id": cid, "subject": subj, "number": number, "title": SUPPLEMENT_TITLES.get(cid) or c.get("title") or "",
                "units": lo if (hi is None or lo == hi) else [lo, hi], "breadths": [], "attributes": attrs,
                "crossListedGids": [], "career": "Undergraduate", "_rich": False, "_desc": c.get("description"),
                "_req": None, "_offering": None, "_formerly": None, "_levels": [], "_grading": None,
                "source": "berkeleytime", "_lastOffered": c.get("lastOffered"),
            }
        self.subjects = sorted({c["subject"] for c in self.courses.values()})
        self.alias = {}
        for a in LEGACY_SUBJECTS:
            code = re.sub(r"[^A-Z0-9]", "", a.upper())
            if code in self.subjects and a != code:
                self.alias[a] = code
        # pattern for spotting course mentions in free text
        names = sorted(set(self.subjects) | set(self.alias), key=len, reverse=True)
        self.mention_re = re.compile(r"(?<![A-Za-z])(" + "|".join(re.escape(n) for n in names) + r")\s+([A-Z]{0,2}\d{1,3}[A-Z]{0,3})\b")
        self.more_re = re.compile(r"\s*(?:,|/|,?\s+or|,?\s+and|&)\s*([A-Z]{0,2}\d{1,3}[A-Z]{0,3})\b(?!\s+units?)")

    def cid(self, gid):
        cid = self.gid2id.get(str(gid))
        if cid:
            self.used_courses.add(cid)
        return cid

    def mentions(self, text):
        out = []
        for m in self.mention_re.finditer(text or ""):
            subj = self.alias.get(m.group(1), m.group(1))
            pos = m.end()
            nums = [m.group(2)]
            while True:
                m2 = self.more_re.match(text, pos)
                if not m2:
                    break
                nums.append(m2.group(1))
                pos = m2.end()
            for n in nums:
                cid = f"{subj} {n}"
                if cid in self.courses and cid not in out:
                    out.append(cid)
        return out

    # ---- prose that is really a course list
    def exact_courses(self, item, ctx):
        """'COGSCI 1' or 'ANTHRO C147B or QTP C147B' -> list of known course ids ([] when all are retired);
        None when the text is anything other than course ids."""
        ids = []
        for part in re.split(r"\s+(?:or|and)\s+|\s*/\s*(?=[A-Z])", item.strip().rstrip(".,;")):
            m = re.match(r"^([A-Z][A-Z0-9 ,&]*?)\s+([A-Z]{0,2}\d{1,3}[A-Z]{0,3})$", part.strip())
            if not m:
                return None
            subj = self.alias.get(m.group(1), m.group(1))
            if subj not in self.subjects:
                return None
            cid = f"{subj} {m.group(2)}"
            if cid in self.courses:
                self.used_courses.add(cid)
                ids.append(cid)
            else:
                self.unresolved[ctx] += 1
        return ids

    def course_range(self, item):
        """'Any 3+ unit SCANDIN 100-196 level course (excluding SCANDIN 100A and 149)' ->
        (subject, min, max, [excluded ids], [notes]); None for anything else."""
        m = re.match(r"^Any (?:(\d)\s*\+?[- ]?units? )?([A-Z][A-Z0-9]*) (\d+)\s*[-–]\s*(\d+)(?:[- ]level)? course"
                     r"(?:,?\s*\(?(?:not including|excluding|except)\s+(.+?)\)?)?\.?$", item.strip(), re.I)
        if not m or m.group(2).upper() not in self.subjects:
            return None
        subj, notes, exclude = m.group(2).upper(), [], []
        if m.group(1):
            notes.append(f"Each course must be at least {m.group(1)} units.")
        for tok in re.split(r",\s*(?:and|or)?\s*|\s+(?:and|or)\s+", m.group(5) or ""):
            tok = re.sub(rf"^(?:the\s+)?{subj}\s+", "", tok.strip().rstrip("."), flags=re.I)
            if not tok:
                continue
            if re.match(r"^[A-Z]{0,2}\d+[A-Z]{0,3}$", tok):
                if f"{subj} {tok}" in self.courses:
                    exclude.append(f"{subj} {tok}")
            else:
                notes.append(f"Does not count: {tok}.")
        return subj, int(m.group(3)), int(m.group(4)), exclude, notes

    def expand_range(self, rng):
        subj, lo, hi, exclude, _ = rng
        out = []
        for cid, c in sorted(self.courses.items()):
            if c["subject"] == subj and cid not in exclude and lo <= int(re.sub(r"\D", "", c["number"]) or 0) <= hi:
                self.used_courses.add(cid)
                out.append(cid)
        return out

    def subject_of(self, name):
        name = tidy(name)
        code = self.alias.get(name.upper(), DEPT_NAMES.get(name) or name.upper().replace(" ", ""))
        return code if code in self.subjects else None

    def named_numbers(self, item):
        """'Anthropology: C103, 121C or C121C' / 'BIOENG C117, C119, C137' -> known course ids; None when it is not that shape."""
        num = r"[A-Z]{0,2}\d{1,3}[A-Z]{0,3}"
        m = re.match(rf"^([A-Za-z][A-Za-z ,&']+?):?\s+({num}(?:(?:\s*,\s*|\s*/\s*|\s+or\s+){num})*)\.?$", item.strip())
        subj = self.subject_of(m.group(1)) if m else None
        if not subj:
            return None
        ids = [f"{subj} {n}" for n in re.findall(num, m.group(2))]
        for c in ids:
            if c in self.courses:
                self.used_courses.add(c)
        return [c for c in ids if c in self.courses]

    def lenient_numbers(self, item):
        """'Data Science (Undergraduate): Data 101, Data C104 / History C184D, 144*. Not 100' -> known course ids.
        Remarks in brackets and everything after "Not" are dropped; a word before a number switches the subject."""
        m = re.match(r"^([A-Za-z][A-Za-z ,&'()]+?):\s*(.+)$", item.strip())
        subj = self.subject_of(re.sub(r"\s*\(.*?\)", "", m.group(1))) if m else None
        if not subj:
            return None
        body = re.sub(r"\(.*?\)", " ", re.split(r"\.\s*Not\b|\bNot\s", m.group(2))[0])
        ids = []
        for word, num in re.findall(r"(?:([A-Za-z][A-Za-z ]*?)\s+)?\b([A-Z]{0,2}\d{1,3}[A-Z]{0,3})\b", body):
            other = self.subject_of(word) if word and word.lower() != "or" else None
            cid = f"{other or subj} {num}"
            if cid in self.courses and cid not in ids:
                self.used_courses.add(cid)
                ids.append(cid)
        return ids or None

    def widen_with_ranges(self, rule, notes):
        """A course list whose notes add "Any ECON 100-196 level course, not including ..." accepts those courses too."""
        extra = []
        for line in (notes or "").split("\n"):
            rng = self.course_range(line.strip()[2:]) if line.strip().startswith("- ") else None
            if rng:
                extra += self.expand_range(rng)
        if not extra:
            return rule
        if rule.get("type") == "filter" and "courses" in rule.get("filter", {}):
            rule["filter"]["courses"] = list(dict.fromkeys(rule["filter"]["courses"] + extra))
            self.stats["widened"].append(len(extra))
        elif rule.get("type") == "nOf" or (rule.get("type") == "anyOf" and all(r.get("type") == "course" for r in rule["rules"])):
            have = set(rule_courses(rule)) if "rule_courses" in globals() else {r.get("course") for r in rule["rules"]}
            rule["rules"] += [{"type": "course", "course": c} for c in dict.fromkeys(extra) if c not in have]
            self.stats["widened"].append(len(extra))
        return rule

    def parse_course_list(self, body, ctx):
        """"Complete at least 3 of:" followed by a bullet list of course ids -> (filter RULE, short notes).
        Returns None unless every bullet is a course id, so prose such as "Any BIOENG 100-196 course" stays a self-check."""
        lines = [l.strip() for l in body.split("\n") if l.strip()]
        parts, prose, i, lists = [], [], 0, 0
        while i < len(lines):
            m = LIST_HEAD.match(lines[i])
            if m:
                j, ids, ranges = i + 1, [], []
                while j < len(lines) and lines[j].startswith("- "):
                    got = self.exact_courses(lines[j][2:], ctx)
                    if got is None:
                        got = self.named_numbers(lines[j][2:])
                    rng = self.course_range(lines[j][2:]) if got is None else None
                    if got is None and rng is None and ctx in LENIENT_LISTS:
                        got = self.lenient_numbers(lines[j][2:])
                        if got is None:
                            if ":" in lines[j] and os.environ.get("DEBUG_LIST"):
                                print("LENIENT: not read", ctx, "|", lines[j][:100])
                            prose.append(lines[j])
                            got = []
                    if got is None and rng is None:
                        if os.environ.get("DEBUG_LIST"):
                            print("LIST FAIL", ctx, "|", lines[j][:150])
                            for k in range(j + 1, len(lines)):
                                if lines[k].startswith("- ") and self.exact_courses(lines[k][2:], ctx) is None and self.named_numbers(lines[k][2:]) is None and self.course_range(lines[k][2:]) is None:
                                    print("   ALSO", lines[k][:150])
                        return None
                    ids += got or []
                    ranges += [rng] if rng else []
                    j += 1
                ids = list(dict.fromkeys(ids))
                n = int(WORD_NUMBERS.get(m.group(1).lower(), 0) or m.group(1))
                by_units = (m.group(2) or "").lower().startswith(("unit", "credit"))
                if ranges and (ids or len({(r[1], r[2]) for r in ranges}) != 1):
                    # ranges mixed with single courses, or several ranges: write the ranges out as course lists
                    for r in ranges:
                        ids += self.expand_range(r)
                        prose += [x for x in r[4] if x not in prose]
                    ids, ranges = list(dict.fromkeys(ids)), []
                if ranges:
                    # "Any GERMAN 100-196 course" bullets sharing one number range: a subject + number filter
                    flt = {"subjects": list(dict.fromkeys(r[0] for r in ranges)), "minNumber": ranges[0][1], "maxNumber": ranges[0][2]}
                    exclude = list(dict.fromkeys(c for r in ranges for c in r[3]))
                    if exclude:
                        flt["exclude"] = exclude
                    prose += [x for r in ranges for x in r[4] if x not in prose]
                    parts.append({"type": "filter", "minUnits" if by_units else "count": n, "filter": flt})
                    lists += 1
                    i = j
                    continue
                if j == i + 1 or not ids:
                    return None
                if by_units:
                    parts.append({"type": "filter", "minUnits": n, "filter": {"courses": ids}})
                elif n > len(ids):
                    return None
                elif n == len(ids):
                    parts.append({"type": "course", "course": ids[0]} if n == 1 else {"type": "allOf", "rules": [{"type": "course", "course": c} for c in ids]})
                else:
                    parts.append({"type": "filter", "count": n, "filter": {"courses": ids}})
                lists += 1
                i = j
                continue
            m = re.match(r"^Complete (.+)$", lines[i])
            ids = self.exact_courses(m.group(1), ctx) if m else None
            if ids:
                parts.append({"type": "course", "course": ids[0]} if len(ids) == 1 else {"type": "anyOf", "rules": [{"type": "course", "course": c} for c in ids]})
            elif lines[i].startswith("- ") and not prose:
                return None  # a bullet list without a "complete N of" heading: leave it as prose
            else:
                prose.append(lines[i])
            i += 1
        if not lists:
            return None
        return (parts[0] if len(parts) == 1 else {"type": "allOf", "rules": parts}), clip("\n".join(prose), 500)

    # ---- rule conversion
    def course_group(self, ids, logic, ctx):
        rules = []
        for gid in ids:
            cid = self.cid(gid)
            if cid:
                rules.append({"type": "course", "course": cid})
            else:
                self.unresolved[ctx] += 1
        if not rules:
            return None
        if len(rules) == 1:
            return rules[0]
        return {"type": "anyOf" if logic == "or" else "allOf", "rules": rules}

    def value_groups(self, value, ctx):
        """-> (list of RULE, all_single_courses flag)"""
        cond = (value or {}).get("condition")
        groups = (value or {}).get("values") or []
        out = []
        if cond in ("courses", None) and groups:
            for g in groups:
                r = self.course_group(g.get("value") or [], g.get("logic"), ctx)
                if r:
                    out.append(r)
        elif cond == "courseSets":
            for g in groups:
                for sid in g.get("value") or []:
                    cs = self.csets.get(sid)
                    if not cs:
                        out.append({"type": "manual", "text": "Course list not published in the catalog data; see the catalog page."})
                        self.warnings.append(f"{ctx}: course set {sid} not captured")
                        continue
                    for gid in cs["courses"]:
                        cid = self.cid(gid)
                        if cid:
                            out.append({"type": "course", "course": cid})
        elif cond == "requisiteSets":
            for g in groups:
                for sid in g.get("value") or []:
                    out.append(self.set_rule(sid, ctx))
        return out

    def convert_rule(self, r, ctx):
        """One catalog rule -> (RULE, notes)."""
        rule, notes = self.convert_rule_raw(r, ctx)
        notes = "\n".join(dict.fromkeys(notes.split("\n"))) if notes else notes  # description and notes often repeat each other
        return (self.widen_with_ranges(rule, notes) if r.get("condition") != "freeformText" else rule), notes

    def convert_rule_raw(self, r, ctx):
        cond = r.get("condition")
        notes = "\n".join(x for x in (text_of(r.get("description")), text_of(r.get("notes"))) if x)
        value = r.get("value") if isinstance(r.get("value"), dict) else None
        if cond == "freeformText":
            own = text_of(r["value"]) if isinstance(r.get("value"), str) else ""
            body = "\n".join(x for x in dict.fromkeys([own, notes]) if x) or tidy(r.get("name")) or "See the catalog."
            parsed = self.parse_course_list(body, ctx)
            if parsed:
                self.stats["lists"].append(f"{ctx}: {tidy(r.get('name')) or '(untitled)'}")
                return parsed
            rule = {"type": "manual", "text": clip(body, 600)}
            kept = re.sub(r"(?i)\b(?:not including|excluding|except(?: for)?|other than|may not (?:use|count)|cannot (?:use|count))[^.\n]*", " ", body)
            banned = set(self.mentions(body)) - set(self.mentions(kept))
            grad_ok = re.search(r"(?i)graduate|200[- ]level|numbered 2\d\d", body)
            found = [c for c in self.mentions(kept) if c not in banned and (grad_ok or int(re.sub(r"\D", "", c.rsplit(" ", 1)[1]) or 0) < 200)]
            if found:
                rule["mentionedCourses"] = found
            # The notes are printed above the rule, so they never repeat a long list.
            return rule, ("The full text is on the catalog page." if len(body) > 600 else "")
        subs = self.value_groups(value, ctx)
        singles = bool(subs) and all(s["type"] == "course" for s in subs)
        if cond == "minimumCredits":
            credits = r.get("credits") or r.get("restriction")
            ids = []
            for s in subs:
                ids += [s["course"]] if s["type"] == "course" else [x["course"] for x in s.get("rules", []) if x.get("type") == "course"]
            if ids and credits:
                return {"type": "filter", "minUnits": credits, "filter": {"courses": list(dict.fromkeys(ids))}}, notes
            return {"type": "manual", "text": clip(notes or f"Complete at least {credits} units ({tidy(r.get('name'))}).", 600)}, ""
        if not subs:
            return {"type": "manual", "text": clip(notes or tidy(r.get("name")) or "See the catalog.", 600)}, ""
        if cond == "completedAllOf":
            return (subs[0] if len(subs) == 1 else {"type": "allOf", "rules": subs}), notes
        n = r.get("restriction") or 1
        if cond == "completedAnyOf":
            n = 1
        if n > len(subs):
            # "pick N" written over one or more either/or lists: count N courses from the pooled list
            pool = []
            for s_ in subs:
                pool += [s_["course"]] if s_["type"] == "course" else [x["course"] for x in s_.get("rules", []) if x.get("type") == "course"]
            pool = list(dict.fromkeys(pool))
            if len(pool) > n:
                return {"type": "filter", "count": n, "filter": {"courses": pool}}, notes
            if len(pool) < n:
                self.warnings.append(f"{ctx}: '{(r.get('name') or '').strip()}' asks for {n} but lists only {len(pool)} current courses; treated as all")
            subs = [{"type": "course", "course": c} for c in pool] or subs
            n = len(subs)
        if n >= len(subs):
            return (subs[0] if len(subs) == 1 else {"type": "allOf", "rules": subs}), notes
        if n == 1:
            flat = []
            for s_ in subs:
                flat += s_["rules"] if s_["type"] == "anyOf" else [s_]
            return {"type": "anyOf", "rules": flat}, notes
        if singles:
            return {"type": "filter", "count": n, "filter": {"courses": [s["course"] for s in subs]}}, notes
        return {"type": "nOf", "n": n, "rules": subs}, notes

    def set_rule(self, sid, ctx):
        """A shared requisite set referenced from inside a major -> one RULE."""
        s = self.sets.get(sid)
        if not s:
            self.warnings.append(f"{ctx}: requisite set {sid} not captured")
            return {"type": "manual", "text": "Requirement set not published in the catalog data; see the catalog page."}
        reqs, _ = self.set_requirements(s, ctx)
        rules = [q["rule"] for q in reqs]
        if not rules:
            return {"type": "manual", "text": clip(s["name"], 200)}
        return rules[0] if len(rules) == 1 else {"type": "allOf", "rules": rules}

    def set_requirements(self, s, ctx):
        """A requisite set -> list of requirement dicts (without ids)."""
        out, narrative = [], []
        for q in s.get("requisites") or []:
            if q.get("type") == "Narrative Text":
                t = text_of(q.get("notes"))
                if t:
                    narrative.append(t)
                continue
            for r in q.get("rules") or []:
                rule, notes = self.convert_rule(r, ctx + "/" + s["name"])
                title = tidy(r.get("name") or q.get("name") or s["name"])
                out.append({"title": title, "notes": notes, "rule": rule})
        return out, "\n".join(narrative)

    # ---- college / university sets with hand-written machine rules
    def breadth_rule(self, areas=BREADTHS):
        return {"type": "allOf", "rules": [{"type": "filter", "count": 1, "filter": {"breadth": a}} for a in areas]}

    def attr(self, code, count=1):
        return {"type": "filter", "count": count, "filter": {"attribute": code}}

    def either(self, rule, how):
        return {"type": "anyOf", "rules": [rule, {"type": "manual", "text": how}]}

    def have(self, ids):
        ok = [i for i in ids if i in self.courses]
        missing = [i for i in ids if i not in self.courses]
        if missing:
            self.warnings.append("hand-written rule mentions courses not in the catalog: " + ", ".join(missing))
        for i in ok:
            self.used_courses.add(i)
        return ok

    def subjects_have(self, subs):
        return [s for s in subs if s in self.subjects]

    def named_set(self, s, converted):
        """Hand-written rules for the college/university sets the catalog only describes in prose.
        `converted` is what the generic converter produced (used where the catalog has real lists)."""
        name = s["name"].strip()
        man = lambda t: {"type": "manual", "text": t}  # noqa: E731
        any_conv = converted[0]["rule"] if converted else None
        if name == "American Cultures":
            return self.attr("AC")
        if name == "American History and Institutions":
            return self.either(self.attr("AH&I"), "Satisfied in high school, by exam, by transfer work, or exempt (nonimmigrant visa)")
        if name == "Entry Level Writing (ELWR)":
            # Completing any first-half Reading & Composition course also completes Entry Level Writing.
            return {"type": "anyOf", "rules": [any_conv or self.attr("ELW"), self.attr("ELW"), self.attr("RCA"),
                                               {"type": "manual", "text": "Satisfied by exam score, placement, or transfer course"}]}
        if name == "Minimum Total Units":
            return {"type": "units", "minUnits": 120, "filter": {}}
        if name in ("Minimum Cumulative GPA", "Senior Residence", "1/3 Passed Grade Limit"):
            return man({"Minimum Cumulative GPA": "Overall GPA of at least 2.00",
                        "Senior Residence": "Senior residence: after 90 units, at least 24 of the remaining units in residence over two semesters",
                        "1/3 Passed Grade Limit": "No more than one-third of Berkeley units graded Passed"}[name])
        if name in ("Reading and Composition", "M.E.T. Reading and Composition"):
            return {"type": "allOf", "rules": [
                self.either(self.attr("RCA"), "R&C Part A satisfied by exam or transfer course"),
                self.either(self.attr("RCB"), "R&C Part B satisfied by exam or transfer course")]}
        if name == "L&S Quantitative Reasoning":
            return self.either(any_conv or self.attr("QR"), "Satisfied by exam score or transfer course")
        if name == "L&S Language Requirement":
            return self.either(self.attr("FL"), "Satisfied by high school coursework, exam, or demonstrated proficiency")
        if name in ("L&S Seven-Course Breadth", "CDSS Breadth", "Haas Seven Course Breadth", "CED Seven Course Breadth",
                    "Environmental Economics & Policy Major Breadth Requirements"):
            return self.breadth_rule()
        if name == "M.E.T. Breadth":
            return {"type": "allOf", "rules": [
                {"type": "filter", "count": 1, "filter": {"breadth": "Arts & Literature"}},
                {"type": "filter", "count": 1, "filter": {"breadth": "Historical Studies"}},
                {"type": "filter", "count": 1, "filter": {"breadth": "International Studies"}},
                {"type": "anyOf", "rules": [{"type": "course", "course": c} for c in self.have(["UGBA 107"])] + [{"type": "filter", "count": 1, "filter": {"breadth": "Philosophy & Values"}}]},
                {"type": "anyOf", "rules": [{"type": "course", "course": c} for c in self.have(["PHYSICS 7B"])] + [{"type": "filter", "count": 1, "filter": {"breadth": "Physical Science"}}]},
                {"type": "anyOf", "rules": [{"type": "course", "course": c} for c in self.have(["ECON 1", "ECON 2"])] + [{"type": "filter", "count": 1, "filter": {"breadth": "Social & Behavioral Sciences"}}]},
            ]}
        ud36 = {"type": "units", "minUnits": 36, "filter": {"attribute": "UD"}}
        # The 120-unit minimum is in the university group ("Minimum Total Units"), so college groups do not repeat it.
        if name == "L&S Unit Requirements":
            return {"type": "allOf", "rules": [ud36, man("Of the 36 upper division units, 6 are outside your major department and 18 are taken in residence")]}
        if name == "CDSS Unit and Academic Requirements":
            return {"type": "allOf", "rules": [ud36, man("At most 4 PE units, 16 Special Studies units and 6 units of 300-499 courses count toward the 120"),
                                               man("2.0 cumulative GPA and 2.0 GPA in upper division courses for the major; 12 to 20.5 units per semester")]}
        if name == "RCNR Unit and Academic Requirements":
            return {"type": "allOf", "rules": [ud36,
                                               {"type": "units", "minUnits": 15, "filter": {"subjects": self.subjects_have(["ENVECON", "ENERES", "ESPM", "MBN", "NUSCTX", "PLANTBI"]), "minNumber": 100, "maxNumber": 199}},
                                               man("At most 16 Special Studies units and 4 PE units count toward the 120; major courses taken for a letter grade")]}
        if name == "COE Humanities and Social Sciences Requirement":
            # The conditions describe the same six courses, so one class may meet several of them.
            return {"type": "allOf", "overlap": True, "rules": [
                self.either(self.attr("RCA"), "R&C Part A satisfied by exam or transfer course"),
                self.either(self.attr("RCB"), "R&C Part B satisfied by exam or transfer course"),
                {"type": "filter", "count": 6, "filter": {"attribute": "HSS"}},
                {"type": "filter", "count": 2, "filter": {"attribute": "HSS", "minNumber": 100, "maxNumber": 196}},
                man("Each H/SS course is at least 3 units, at most two of the six come from AP/IB/A-Level exams, and approved foreign language courses also count (see notes)")]}
        if name == "COE Unit and Academic Requirements":
            return {"type": "allOf", "rules": [man("2.0 overall GPA and 2.0 GPA in upper division technical courses; final 30 units in residence in the College of Engineering; technical courses letter-graded")]}
        if name in ("COC Breadth", "COC Breadth: Chemical Engineering"):
            n = 22 if "Chemical Engineering" in name else 15
            rules = [{"type": "units", "minUnits": n, "filter": {"attribute": "HSS"}}]
            if n == 22:
                rules.append(man("Breadth Series: two courses in the same or closely allied humanities/social science department, at least one upper division"))
            rules.append(man("Breadth units exclude courses that only teach a skill (for example drawing or playing an instrument)"))
            return {"type": "allOf", "rules": rules}
        if name == "COC Unit and Academic Requirements":
            return man("College of Chemistry unit load, semester limit and senior residence rules are met (see notes)")
        if name == "Haas Academic Requirements":
            return {"type": "allOf", "rules": [man("Degree completed in four or eight semesters, not counting summer")]}
        if name == "CED Environmental Design":
            return {"type": "allOf", "rules": [
                {"type": "filter", "count": 3, "minUnits": 9, "filter": {"subjects": self.subjects_have(["ARCH", "ENVDES", "VISSTD", "LDARCH", "CYPLAN"]), "minNumber": 100, "maxNumber": 299, "exclude": []}},
                man("The three courses are from CED departments outside your major, C- or better, not 197/198/199, and not reused for breadth or the major")]}
        if name == "CED Unit and Academic Requirements":
            return {"type": "allOf", "rules": [man("2.0 GPA overall and in the major; no more than 60 units from one department count toward the 120")]}
        if name == "M.E.T. Unit and Academic Requirements":
            return man("M.E.T. unit load and academic standing rules are met (see notes)")
        if name == "CDSS Computational Reasoning":
            ids = self.have(["DATA C8", "COMPSCI C8", "STAT C8", "COMPSCI 10", "COMPSCI W10", "COMPSCI 61A", "COMPSCI 61B", "COMPSCI 61C"])
            return self.either({"type": "filter", "count": 1, "filter": {"courses": ids}}, "Satisfied by AP/IB exam, transfer course, or automatically by the Computer Science or Data Science major")
        if name == "CDSS Statistical Reasoning":
            ids = self.have(["DATA C8", "COMPSCI C8", "STAT C8", "STAT 2", "STAT 20", "STAT 21", "STAT W21"])
            return self.either({"type": "filter", "count": 1, "filter": {"courses": ids}}, "Satisfied by AP/IB/A-level exam, transfer course, an approved upper division course, or automatically by a CDSS major")
        if name == "CDSS Human and Social Dynamics of Data and Technology":
            ids = self.have(["CDSS 94", "DATA 94", "DATA C4AC", "HISTORY 30", "ISF 60", "LS 22", "LS 25", "PHILOS 5"])
            return self.either({"type": "filter", "count": 1, "filter": {"courses": ids}}, "Satisfied by an approved upper division Human Contexts and Ethics course (see notes)")
        return None

    def set_as_requirement(self, sid, ctx):
        s = self.sets.get(sid)
        if not s:
            self.warnings.append(f"{ctx}: requisite set {sid} not captured")
            return {"title": "Additional requirement", "notes": "", "rule": {"type": "manual", "text": "This requirement set is not published in the catalog data; check the catalog page."}}
        mark = len(self.warnings)
        converted, narrative = self.set_requirements(s, ctx)
        rule = self.named_set(s, converted)
        if rule is not None:
            del self.warnings[mark:]
        if rule is None:
            rules = [c["rule"] for c in converted]
            if not rules:
                if "Guidelines" in s["name"]:
                    return {"title": s["name"].strip(), "notes": narrative, "rule": None}
                rule = {"type": "manual", "text": clip(narrative or s["name"], 400)}
                self.warnings.append(f"{ctx}: set '{s['name']}' is prose only; emitted as a self-check")
            else:
                rule = rules[0] if len(rules) == 1 else {"type": "allOf", "rules": rules}
        extra = "\n".join(c["notes"] for c in converted if c.get("notes"))
        return {"title": s["name"].strip(), "notes": clip("\n".join(x for x in (narrative, extra) if x), 4000), "rule": rule}

    # ---- groups
    def drop_repeats(self, rule):
        """The catalog sometimes lists the same course twice in one list; keep the first."""
        if rule.get("type") in ("anyOf", "nOf", "allOf"):
            seen, kept = set(), []
            for r in rule["rules"]:
                r = self.drop_repeats(r)
                key = json.dumps({k: v for k, v in r.items() if k != "label"}, sort_keys=True)
                if key in seen:
                    self.stats["repeats"].append(key)
                    continue
                seen.add(key)
                kept.append(r)
            if len(kept) == 1 and rule["type"] != "nOf":
                return dict(kept[0], **({"label": rule["label"]} if rule.get("label") else {}))
            rule["rules"] = kept
            if rule["type"] == "nOf":
                rule["n"] = min(rule["n"], len(kept))
        return rule

    def finish_group(self, gid, title, kind, source, reqs, notes, extra=None):
        seen, out = set(), []
        for q in reqs:
            if q.get("rule") is None:
                if q.get("notes"):
                    notes.append(f"{q['title']}\n{q['notes']}")
                continue
            q["title"] = tidy(q["title"]) or "Requirement"
            base = slug(q["title"])[:60] or "requirement"
            if q.get("option"):  # ids inside a choice start with the option, so 28 "Lower Division" rows stay distinct and stable
                base = f"{q['option']}-{base}"[:90]
            rid, i = base, 2
            while rid in seen:
                rid, i = f"{base}-{i}", i + 1
            seen.add(rid)
            item = {"id": rid, "title": q["title"]}
            if q.get("section"):
                item["section"] = tidy_section(q["section"])
            if q.get("choice"):
                item["choice"], item["option"] = q["choice"], q["option"]
            if q.get("optional"):
                item["optional"] = True
            if q.get("notes"):
                item["notes"] = compact_notes(exam_lead_in(q["notes"])).strip()
            item["rule"] = self.drop_repeats(q["rule"])
            out.append(item)
        if not out:
            out.append({"id": "requirements", "title": "Requirements", "rule": {"type": "manual", "text": "The catalog lists no checkable requirements for this program; see the notes and the catalog page."}})
        g = {"id": gid, "title": title, "kind": kind, "source": source, "catalogYear": CATALOG_YEAR}
        g.update(extra or {})
        if notes:
            g["notes"] = [clip(n, 4000) for n in notes]
        g["requirements"] = out
        return g

    def set_ids(self, item):
        ids = []
        for r in item.get("rules") or []:
            v = r.get("value")
            if isinstance(v, dict) and v.get("condition") == "requisiteSets":
                for g in v.get("values") or []:
                    ids += g.get("value") or []
        return ids

    def program_college(self, p):
        pre = (p.get("college") or "").split(" ")[0]
        if pre in COLLEGE_PREFIX:
            return COLLEGE_PREFIX[pre]
        return LEVEL_COLLEGE.get(p.get("level") or "")

    def degree(self, p):
        d = p.get("degreeDesignation") or ""
        if "Arts" in d:
            return "BA"
        if "Science" in d:
            return "BS"
        m = re.search(r"\b(BA/BS|BA|BS)\b", p.get("longName") or "")
        return m.group(1) if m else ""

    def program_group(self, p, gid, kind):
        ctx = p["catalogDisplayName"]
        items = ((p.get("requisites") or {}).get("requisitesSimple")) or []
        reqs, notes = [], []
        ov = self.group_overrides.get(gid) or {}
        renames = {}
        for x in ov.get("renameRules") or []:
            renames[(tidy(x["block"]), tidy(x.get("rule")))] = x["title"]
            self.stats["titles"].append(f"{gid}: {tidy(x['block'])} / {tidy(x.get('rule')) or '(untitled)'} -> \"{x['title']}\"")
        for q in items:
            level = q.get("requirementLevel")
            shared_only = all(isinstance(r.get("value"), dict) and r["value"].get("condition") == "requisiteSets" for r in q.get("rules") or [])
            if kind == "major" and level in ("universityRequirements", "collegeRequirements") and (shared_only or q.get("type") == "Narrative Text"):
                continue  # college and university rules live in their own groups
            if q.get("type") == "Narrative Text":
                t = text_of(q.get("notes"))
                if t:
                    notes.append(t)
                continue
            block = tidy(q.get("name"))
            block_note = text_of(q.get("notes"))
            for r in q.get("rules") or []:
                v = r.get("value") if isinstance(r.get("value"), dict) else {}
                name = tidy(r.get("name"))
                if v.get("condition") == "requisiteSets":
                    for g in v.get("values") or []:
                        for sid in g.get("value") or []:
                            sr = self.set_as_requirement(sid, ctx)
                            sr.update(section=block, _block=block, _rule=name)
                            reqs.append(sr)
                    continue
                if r.get("condition") == "freeformText" and not (text_of(r.get("description")) or text_of(r.get("notes")) or (isinstance(r.get("value"), str) and r["value"].strip())):
                    # A rule with a name and nothing else is a heading, not something to tick off: a sentence
                    # becomes a note on the requirement below it, a bare sub-heading is dropped.
                    if len(name) > 40:
                        block_note = "\n".join(x for x in (block_note, name) if x)
                    self.stats["headings"].append(f"{ctx}: {block} / {name}")
                    continue
                rule, rnotes = self.convert_rule(r, ctx)
                rename = renames.get((block, name))
                title = rename or (name if name and name.lower() not in ("requirement", "requirements", "courses", block.lower()) else block)
                reqs.append({"title": title or block or "Requirement", "section": block, "_block": block, "_rule": name,
                             "notes": "\n".join(x for x in (block_note, rnotes) if x), "rule": rule})
                block_note = ""
            if not q.get("rules") and block_note:
                notes.append(f"{block}\n{block_note}")
        by_block = collections.OrderedDict()
        for q in reqs:
            by_block.setdefault(q["_block"], []).append(q["_rule"])
        for block, names in by_block.items():
            # the Cognitive Science symptom: a block that took the name of its own first rule
            if len(set(names)) > 1 and names[0].lower() == block.lower() and block not in (ov.get("renameSections") or {}) and (gid, block) not in AUDIT_OK:
                self.stats["audit"].append(f"{gid}: block \"{block}\" holds {', '.join(names[:7])}")
        reqs = self.merge_alternatives(gid, ctx, reqs, ov.get("merge") or [])
        reqs = self.fold_generic(gid, reqs)
        for q in reqs:
            if OPTIONAL_BLOCK.search(q["_block"]):
                q["optional"] = True  # honors and other optional blocks are shown apart and never counted
                self.stats["optional"].append(f"{gid}: {q['_block']} / {q['title']}")
        choices = []
        if gid in self.choice_specs:
            reqs, choices = self.apply_choices(gid, reqs, self.choice_specs[gid])
        for old, new in (ov.get("renameSections") or {}).items():
            hit = [q for q in reqs if q.get("section") == tidy(old)]
            if not hit:
                self.fatal.append(f"override {gid}: renameSections names a section that does not exist: {old!r}")
            for q in hit:
                q["section"] = new
            self.stats["sections"].append(f"{gid}: \"{tidy(old)}\" -> \"{new}\" ({len(hit)} requirements)")
        url = f"{CATALOG}/programs/{p['programGroupId']}"
        source = [url] + ([CATALOG + p["requirementsPath"]] if p.get("requirementsPath") else [])
        if not reqs:
            reqs.append({"title": "Requirements", "notes": "", "rule": {"type": "manual", "text": "The catalog lists no structured requirements for this program; see the catalog page."}})
            self.warnings.append(f"{ctx}: no structured requirements in the catalog")
        title = p["catalogDisplayName"] + (" " + self.degree(p) if kind == "major" and self.degree(p) else (" minor" if kind == "minor" else ""))
        extra = {"catalogCode": p.get("code")}
        if choices:
            extra["choices"] = choices
            self.stats["choices"].append((gid, choices, self.choice_specs[gid].get("why", "")))
        return self.finish_group(gid, title, kind, source, reqs, notes, extra)

    def fold_generic(self, gid, reqs):
        """A prose rule with no name of its own ("Requirements", "Note", unnamed) that sits above other rules of
        its block is a remark about them, not something to tick: it becomes a note on the requirement below it."""
        out, carry = [], None
        for i, q in enumerate(reqs):
            nxt = reqs[i + 1] if i + 1 < len(reqs) else None
            if carry and carry[0] == q["_block"]:
                q["notes"] = "\n".join(x for x in (carry[1], q.get("notes")) if x)
            carry = None
            forced = (gid, q["_block"], q["_rule"]) in FOLD
            generic = q["_rule"].lower() in GENERIC_RULE_NAMES or q["_rule"].lower() == q["_block"].lower() or forced
            if (q["rule"] or {}).get("type") == "manual" and generic and nxt and nxt["_block"] == q["_block"] and (forced or not q["rule"].get("mentionedCourses")):
                carry = (q["_block"], clip(q["rule"]["text"], 500))
                self.stats["folded"].append(f"{gid}: {q['_block']} / {q['_rule'] or '(untitled)'}")
                continue
            out.append(q)
        return out

    # ---- alternatives written as separate rows ("Linear Algebra: Option 1", "Linear Algebra: Option 2")
    @staticmethod
    def labelled(rule, label):
        out = dict(rule)
        out["label"] = label  # extra field: what this alternative is called in the catalog
        return out

    def merge_alternatives(self, gid, ctx, reqs, directives):
        taken, extra_at = set(), []
        # 1. hand-written merges from data/requirements/overrides/<groupId>.json
        for d in directives:
            block = tidy(d["block"])
            parts = d.get("parts") or [{"label": tidy(x), "rules": [x]} for x in d["rules"]]
            idx = lambda name: [i for i, q in enumerate(reqs) if i not in taken and q["_block"] == block and q["_rule"] == tidy(name)]  # noqa: E731
            subs, first, notes, missing = [], None, [], []
            for x in d.get("notesFrom") or []:
                for i in idx(x):
                    taken.add(i)
                    notes.append(reqs[i]["rule"].get("text") or reqs[i].get("notes") or "")
            for part in parts:
                rules = []
                for name in part["rules"]:
                    hit = idx(name)
                    if not hit:
                        missing.append(name)
                        continue
                    taken.add(hit[0])
                    first = hit[0] if first is None else min(first, hit[0])
                    rules.append(reqs[hit[0]]["rule"])
                    if reqs[hit[0]].get("notes"):
                        notes.append(f"{part.get('label') or tidy(name)}: {reqs[hit[0]]['notes']}")
                if rules:
                    subs.append(self.labelled(rules[0] if len(rules) == 1 else {"type": "allOf", "rules": rules}, part.get("label") or tidy(part["rules"][0])))
            if missing or first is None:
                self.fatal.append(f"override {gid}: merge '{d.get('title')}' names rules that do not exist in block '{block}': {missing}")
                continue
            kind = d.get("type", "anyOf")
            rule = {"type": kind, "rules": subs}
            if kind == "nOf":
                rule["n"] = d["n"]
            if kind == "pool":  # n courses from the lists of all the named rules together
                rule = {"type": "filter", "count": d["n"], "filter": {"courses": list(dict.fromkeys(c for x in subs for c in rule_course_ids(x)))}}
            if d.get("notes"):
                notes = [d["notes"]]
            merged = {"title": d["title"], "section": reqs[first]["section"], "_block": block, "_rule": tidy(d["title"]),
                      "notes": "\n".join(n for n in dict.fromkeys(notes) if n), "rule": rule}
            if d.get("keep"):  # the named rules stay; the new requirement is added after the last of them
                used = [i for part in parts for name in part["rules"] for i, q in enumerate(reqs) if q["_block"] == block and q["_rule"] == tidy(name)]
                taken -= set(used)
                extra_at.append((max(used), merged))
            else:
                reqs[first] = merged
                taken.discard(first)
            self.stats["merged"].append(f"{gid}: \"{d['title']}\" = {'any one' if kind == 'anyOf' else str(d.get('n')) + ' of'} {len(subs)} ({'; '.join(x['label'] for x in subs)}) [override]")
        for at, merged in sorted(extra_at, key=lambda x: -x[0]):
            reqs.insert(at + 1, merged)
            taken = {i + 1 if i > at else i for i in taken}
        reqs = [q for i, q in enumerate(reqs) if i not in taken]
        # 2. automatic: siblings in one block named "<X>: Option <N>" are alternatives for <X>
        groups = collections.OrderedDict()
        for i, q in enumerate(reqs):
            m = OPTION_SUFFIX.match(q["_rule"]) if q["_rule"].count("Option ") == 1 else None
            if m:
                groups.setdefault((q["_block"], tidy(m.group("base")).lower()), []).append((i, m))
        drop = set()
        for (block, _), members in groups.items():
            i0, m0 = members[0]
            base = tidy(m0.group("base")) or block
            if len(members) == 1:  # a lone "…: Option 1" (the catalog folded the other options into it)
                reqs[i0]["title"] = reqs[i0]["_rule"] = base
                self.stats["merged"].append(f"{gid}: \"{reqs[i0]['_rule']}\" renamed \"{base}\" (no other option listed)")
                continue
            subs, notes = [], []
            for k, (i, m) in enumerate(members):
                # the catalog sometimes numbers two different options "Option 1"; number them in order then
                n = m.group("n") if len({x.group("n") for _, x in members}) == len(members) else str(k + 1)
                label = f"Option {n}" + (" " + tidy(m.group("tail")) if m.group("tail") else "")
                subs.append(self.labelled(reqs[i]["rule"], label))
                if reqs[i].get("notes"):
                    notes.append((label, reqs[i]["notes"]))
                if i != i0:
                    drop.add(i)
            same = len({n for _, n in notes}) == 1
            reqs[i0] = {"title": base, "section": reqs[i0]["section"], "_block": block, "_rule": base,
                        "notes": (notes[0][1] if same and notes else "\n".join(f"{l}: {n}" for l, n in notes)),
                        "rule": {"type": "anyOf", "rules": subs}}
            self.stats["merged"].append(f"{gid}: \"{base}\" = any one of {len(subs)} options")
        reqs = [q for i, q in enumerate(reqs) if i not in drop]
        for q in reqs:  # anything option-like that is left, for the report
            if re.search(r"\bOption \d", q["_rule"]) and not (q["rule"].get("rules") or [{}])[0].get("label"):
                self.stats["unmerged"].append(f"{gid}: {q['_block']} / {q['_rule']}")
        return reqs

    # ---- concentrations, emphases, tracks: blocks of which a student completes one
    def apply_choices(self, gid, reqs, spec):
        """See data/requirements/overrides/choices.json for the format. Returns (requirements, choices)."""
        choices, assign = [], collections.defaultdict(list)
        blocks = list(dict.fromkeys(q["_block"] for q in reqs))
        for ch in spec.get("choices") or []:
            cid = ch.get("id") or slug(ch["title"])
            options = []

            def opt(title):
                title = tidy(title)
                oid = slug(title)
                if oid not in [o["id"] for o in options]:
                    options.append({"id": oid, "title": title})
                return oid

            def claim(i, oid, section=None, title=None):
                assign[i].append((cid, oid, section, title))

            for o in ch.get("options") or []:
                oid, n = opt(o["title"]), 0
                for b in o.get("blocks") or []:
                    b = b if isinstance(b, dict) else {"block": b}
                    only = [tidy(x) for x in b.get("rules") or []]
                    skip = [tidy(x) for x in b.get("except") or []]
                    for i, q in enumerate(reqs):
                        if q["_block"] == tidy(b["block"]) and (not only or q["_rule"] in only) and q["_rule"] not in skip:
                            claim(i, oid, b.get("section") or o.get("section"), b.get("title"))
                            n += 1
                if n == 0 and not o.get("empty"):
                    self.fatal.append(f"choices {gid}: option '{o['title']}' matches no requirement")
            if ch.get("blockRange"):
                a, b = (tidy(x) for x in ch["blockRange"])
                if a not in blocks or b not in blocks:
                    self.fatal.append(f"choices {gid}: blockRange {ch['blockRange']} not found")
                else:
                    for name in blocks[blocks.index(a): blocks.index(b) + 1]:
                        oid = opt(re.sub(ch.get("strip", r"$^"), "", name))
                        for i, q in enumerate(reqs):
                            if q["_block"] == name:
                                claim(i, oid)
            if ch.get("blockPattern"):
                rx, n = re.compile(ch["blockPattern"]), 0
                for i, q in enumerate(reqs):
                    m = rx.match(q["_block"])
                    if m:
                        claim(i, opt(m.group("option")), m.groupdict().get("section") or ch.get("section"))
                        n += 1
                if not n:
                    self.fatal.append(f"choices {gid}: blockPattern {ch['blockPattern']!r} matches nothing")
            if ch.get("rulesIn"):
                rx, n = re.compile(ch.get("rulePattern", r"^(?P<option>.+)$")), 0
                skip = [tidy(x) for x in ch.get("skipRules") or []]
                for i, q in enumerate(reqs):
                    m = rx.match(q["_rule"]) if q["_block"] == tidy(ch["rulesIn"]) and q["_rule"] not in skip else None
                    if m:
                        claim(i, opt(m.group("option")), m.groupdict().get("section") or ch.get("section"), ch.get("ruleTitle"))
                        n += 1
                if not n:
                    self.fatal.append(f"choices {gid}: rulesIn {ch['rulesIn']!r} matches nothing")
            choices.append({"id": cid, "title": ch["title"], "pick": ch.get("pick", 1), "options": options})
        titles = {(c["id"], o["id"]): o["title"] for c in choices for o in c["options"]}
        out = []
        for i, q in enumerate(reqs):
            if i not in assign:
                out.append(q)
                continue
            for cid, oid, section, title in assign[i]:
                # one format everywhere: "<Option>" or "<Option>: Lower Division"
                name = titles[(cid, oid)]
                c = dict(q, choice=cid, option=oid, section=f"{name}: {section}" if section and section != name else name)
                if title:
                    c["title"] = title
                out.append(c)
        return out, choices

    def build(self):
        os.makedirs(GROUPS, exist_ok=True)
        for f in glob.glob(os.path.join(GROUPS, "*.json")):
            os.remove(f)
        majors, minors, groups = [], [], {}
        used_group_ids = set()
        college_keys = collections.defaultdict(collections.Counter)
        univ_keys = collections.Counter()
        pending = []
        for p in sorted(self.programs, key=lambda x: (x["catalogDisplayName"].lower(), x["code"])):
            is_minor = p.get("type") == "Minor"
            deg = self.degree(p)
            base = slug(p["catalogDisplayName"])
            if is_minor:
                gid = f"minor-{base}"
            else:
                gid = f"major-{base}" + (f"-{slug(deg)}" if deg else "")
            if gid in used_group_ids:
                gid += "-" + slug(p["code"])
            used_group_ids.add(gid)
            groups[gid] = self.program_group(p, gid, "minor" if is_minor else "major")
            tags = p.get("tags") or {}
            rec = {"name": re.sub(r" Joint Major$", "", p["catalogDisplayName"]), "degree": deg, "catalogCode": p["code"],
                   "requirementGroupIds": [gid], "url": f"{CATALOG}/programs/{p['programGroupId']}",
                   "departments": p.get("departments") or [], "interests": tags.get("TJgJ7") or [],
                   "academicFocus": tags.get("QQ4sF") or []}
            if is_minor:
                rec = {"id": gid[len("minor-"):] + "-minor", **rec}
                rec.pop("degree")
                minors.append(rec)
                continue
            col = self.program_college(p)
            if not col:
                self.warnings.append(f"{p['catalogDisplayName']}: could not tell the college; defaulted to LS")
                col = "LS"
            kind = "major"
            if "Joint Major" in p["catalogDisplayName"]:
                kind = "joint-major"
            elif p["code"].startswith("*") and ("Dual Degree" in p["catalogDisplayName"] or "Haas School of Business" in (tags.get("z2cJJ") or [])):
                kind = "dual-degree"
            items = ((p.get("requisites") or {}).get("requisitesSimple")) or []
            ckey = tuple(i for q in items if q.get("requirementLevel") == "collegeRequirements" for i in self.set_ids(q))
            ukey = tuple(i for q in items if q.get("requirementLevel") == "universityRequirements" for i in self.set_ids(q))
            if ckey and kind == "major":
                college_keys[col][ckey] += 1
            if ukey:
                univ_keys[ukey] += 1
            rec = {"id": f"{col.lower()}-{gid[len('major-'):]}", **rec, "college": col, "programType": kind}
            g = groups[gid]  # `kind` stays "major"; programType says joint-major / dual-degree for the card label
            groups[gid] = {k: v for kk in [list(g)[:3] + ["programType"] + list(g)[3:]] for k in kk for v in [kind if k == "programType" else g[k]]}
            if kind == "joint-major":
                groups[gid]["title"] = groups[gid]["title"].replace(" Joint Major", "")
            pending.append((rec, ckey))
            majors.append(rec)

        # university group
        ukey = max(univ_keys, key=lambda k: (univ_keys[k], len(k)))
        uni_reqs = [self.set_as_requirement(sid, "university") for sid in ukey]
        groups["university"] = self.finish_group(
            "university", "University of California and Berkeley campus requirements", "university",
            [f"{CATALOG}/earning-your-degree/university-campus-requirements"], uni_reqs, [])

        # college groups: canonical per college, plus variants for programs with different sets
        colleges, variant_ids = [], {}
        canon = {}
        for col, (cname, cslug) in COLLEGES.items():
            if not college_keys.get(col):
                self.warnings.append(f"no majors found for college {col}")
                continue
            key = max(college_keys[col], key=lambda k: (college_keys[col][k], len(k)))
            canon[col] = key
            reqs = [self.set_as_requirement(sid, f"college-{col}") for sid in dict.fromkeys(key)]
            groups[f"college-{col}"] = self.finish_group(f"college-{col}", cname + " requirements", "college",
                                                         [f"{CATALOG}/colleges/{cslug}"], reqs, [], {"college": col})
            colleges.append({"id": col, "name": cname, "requirementGroupId": f"college-{col}",
                             "universityGroupId": "university", "url": f"{CATALOG}/colleges/{cslug}"})
        for rec, ckey in pending:
            col = rec["college"]
            gid = f"college-{col}"
            base = set(canon.get(col, ())) | set(ukey)
            if ckey and not set(ckey) <= base:
                vkey = (col, tuple(dict.fromkeys(ckey)))
                if vkey not in variant_ids:
                    names = [self.sets[s]["name"] for s in ckey if s in self.sets and s not in base]
                    label = "met" if any(n.startswith("M.E.T.") for n in names) else (slug(names[0] if names else "variant")[:32].strip("-") or "variant")
                    vid, i = f"college-{col}-{label}", 2
                    while vid in groups:
                        vid, i = f"college-{col}-{label}-{i}", i + 1
                    reqs = [self.set_as_requirement(sid, vid) for sid in vkey[1]]
                    short = "M.E.T. program" if label == "met" else (names[0].split(": ", 1)[1] if names and ": " in names[0] else (re.sub(r"^(?:L&S|COE|COC|CED|RCNR|CDSS|Haas) ", "", names[0]) if names else "program-specific"))
                    short = re.sub(r"\s+(?:Major )?(?:Breadth )?Requirements$", "", short)
                    groups[vid] = self.finish_group(vid, COLLEGES[col][0] + " requirements (" + short + ")",
                                                    "college", [rec["url"]], reqs, [], {"college": col, "variantOf": f"college-{col}"})
                    variant_ids[vkey] = vid
                gid = variant_ids[vkey]
            rec["collegeGroupId"] = gid
            rec["universityGroupId"] = "university"

        self.apply_overrides(groups)
        for gid in sorted(set(self.choice_specs) - set(groups)):
            self.fatal.append(f"choices.json names an unknown group {gid}")
        self.add_aliases(majors + minors)
        errors = list(self.fatal)
        for gid, g in groups.items():
            validate_group(g, self.courses, errors)
            dump(os.path.join(GROUPS, gid + ".json"), g)
        majors.sort(key=lambda m: (m["name"].lower(), m["degree"]))
        minors.sort(key=lambda m: m["name"].lower())
        dump(os.path.join(REQ, "majors.json"), majors)
        dump(os.path.join(REQ, "minors.json"), minors)
        dump(os.path.join(REQ, "colleges.json"), colleges)
        self.link_same_courses()
        self.write_courses()
        errors += self.course_gaps()
        by_code = {g.get("catalogCode"): g for g in groups.values() if g.get("catalogCode")}
        self.check = crosscheck(self.programs, by_code)
        self.report(majors, minors, groups, errors)
        return errors

    def apply_overrides(self, groups):
        """data/requirements/overrides/<groupId>.json: {"why", "source", "replace": {"<requirementId>": {"rule": ..., "notes": ...}}}.
        The keys renameSections, renameRules and merge of the same file are applied earlier, in program_group."""
        for gid, ov in self.group_overrides.items():
            if gid not in groups:
                self.fatal.append(f"override for unknown group {gid}")
                continue
            byid = {q["id"]: q for q in groups[gid]["requirements"]}
            for rid, patch in (ov.get("replace") or {}).items():
                if rid not in byid:
                    self.warnings.append(f"override {gid}: no requirement '{rid}'")
                    continue
                byid[rid].update(patch)
                byid[rid]["overridden"] = True
            groups[gid]["source"] = groups[gid]["source"] + (ov.get("source") or [])

    def former_ids(self, c):
        """Ids this course says it used to have: the catalog's "formerly" field and "formerly/previously ..." in its description."""
        texts = [c.get("_formerly") or ""]
        texts += re.findall(r"(?i)\b(?:formerly|previously)(?: known as| numbered| offered as| listed as)?:?\s+([^.;()]{2,80})", c.get("_desc") or "")
        out = []
        for text in texts:
            subj = c["subject"]
            for part in re.split(r"\s*(?:/|;|\n|,(?!\s*Undergraduate)|\bor\b|\band\b)\s*", text):
                m = re.match(r"^(.*?)\s*\b([A-Z]{0,2}\d{1,3}[A-Z]{0,3})$", part.strip())
                if not m:
                    continue
                if m.group(1).strip():
                    subj = self.subject_of(m.group(1)) or self.legacy_subject(m.group(1))
                if subj:
                    out.append(f"{subj} {m.group(2)}")
        return [x for x in dict.fromkeys(out) if x != c["id"]]

    def legacy_subject(self, name):
        """Subjects that no longer exist ("Hindi-Urdu", "Geology"): keep the old code so old transcripts resolve."""
        code = DEPT_NAMES.get(tidy(name)) or re.sub(r"[^A-Z0-9]", "", tidy(name).upper())
        return code if re.fullmatch(r"[A-Z][A-Z0-9]{1,9}", code or "") and " " not in tidy(name).strip() or code in DEPT_NAMES.values() else None

    def link_same_courses(self):
        """`sameAs`: the same class under another number or code (renumbered, recoded, or the C-prefixed cross-listed form)."""
        index = set(self.course_index)
        cross = collections.defaultdict(set)
        for cid, c in self.courses.items():
            for g in c["crossListedGids"]:
                other = self.gid2id.get(str(g))
                if other and other != cid:
                    cross[cid].add(other)
                    cross[other].add(cid)
        # C-numbered courses are cross-listed by definition; where the catalog names no partner, the same title and
        # units under a C number in another subject is the partner (not for titles shared by many, e.g. "Special Topics")
        twins = collections.defaultdict(list)
        for cid, c in self.courses.items():
            if c["number"].startswith("C") and c.get("title"):
                twins[(re.sub(r"[^a-z0-9]+", " ", c["title"].lower()).strip(), json.dumps(c["units"]))].append(cid)
        self.inferred_cross = []
        for (title, _), ids in sorted(twins.items()):
            if not title or not 2 <= len(ids) <= 4:
                continue
            for a in ids:
                for b2 in ids:
                    if a < b2 and self.courses[a]["subject"] != self.courses[b2]["subject"] and b2 not in cross[a] and (not cross[a] or not cross[b2]) \
                            and (int(re.sub(r"\D", "", self.courses[a]["number"]) or 0) >= 200) == (int(re.sub(r"\D", "", self.courses[b2]["number"]) or 0) >= 200):
                        self.inferred_cross.append((a, b2))
        for a, b2 in self.inferred_cross:
            cross[a].add(b2)
            cross[b2].add(a)
        links, claims = [], collections.defaultdict(set)
        for cid, c in list(self.courses.items()):
            for old in self.former_ids(c):
                claims[old].add(cid)
        for old, news in claims.items():
            roots = {min({n} | cross[n]) for n in news}
            if len(roots) > 1 or old in set().union(*(cross[n] for n in news)):
                continue  # one old number split into several classes, or just the cross-listing spelled out
            if old in index and old in self.courses and all(self.courses[old]["title"].strip().lower() != self.courses[n]["title"].strip().lower() for n in news):
                self.stats["reused"].append(f"{old} (formerly of {', '.join(sorted(news))})")
                continue  # the old number has since been given to a different class ("SOCIOL 103, formerly 102")
            links += [(old, n, "formerly") for n in news]
        links += [(a, b, "curated") for a, b in SAME_AS]
        by_title = collections.defaultdict(list)
        for cid, c in self.courses.items():
            core = re.sub(r"^C", "", c["number"])
            by_title[(c["title"].strip().lower(), core)].append(cid)
        for (title, core), ids in by_title.items():
            if not title or len(ids) < 2:
                continue
            for a in ids:
                for b in ids:
                    ca, cb = self.courses[a], self.courses[b]
                    # "COGSCI C131" is the cross-listed form of "COGSCI 131"
                    if a < b and ca["subject"] == cb["subject"] and {ca["number"], cb["number"]} == {core, "C" + core}:
                        links.append((a, b, "C-prefix"))
                    # an id the catalog no longer lists, with the title and number of exactly one current course ("ELENG 126" -> "EECS 126")
                    if a not in index and b in index and ca["subject"] != cb["subject"] and ca["number"] == cb["number"] \
                            and sum(1 for x in ids if x in index and self.courses[x]["number"] == ca["number"] and min({x} | cross[x]) != min({b} | cross[b])) == 0:
                        links.append((a, b, "same title and number"))
        parent = {}

        def find(x):
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for cid, others in cross.items():
            for o in others:
                parent[find(cid)] = find(o)
        for a, b, why in links:
            if b not in self.courses:
                continue
            if a not in self.courses:  # a number that is no longer a course anywhere: a stub so transcripts resolve
                src = self.courses[b]
                subj, number = a.rsplit(" ", 1)
                digits = int(re.sub(r"\D", "", number) or 0)
                self.courses[a] = {"id": a, "subject": subj, "number": number, "title": src["title"], "units": src["units"],
                                   "breadths": [], "attributes": {"UD"} if 100 <= digits <= 199 else set(), "crossListedGids": [],
                                   "career": "Undergraduate", "_rich": False, "retired": True}
            parent[find(a)] = find(b)
            self.stats["same"].append((a, b, why))
        family = collections.defaultdict(set)
        for cid in parent:
            if cid in self.courses:
                family[find(cid)].add(cid)
        self.same_as = {cid: sorted(fam - {cid} - cross[cid]) for fam in family.values() for cid in fam}
        # popularity: total enrolment in the primary component over all terms on file, shared by a sameAs family
        own = collections.Counter()
        for path in (os.path.join(ROOT, "data", "enrollment", "berkeleytime", "sections.csv"),):
            if os.path.exists(path):
                import csv
                per = collections.defaultdict(collections.Counter)
                with open(path, encoding="utf-8", newline="") as f:
                    for r in csv.DictReader(f):
                        per[(r["term"], r["course"].upper().strip())][r["component"]] += int(float(r["enrolled"] or 0))
                for (_, cid), comps in per.items():
                    own[cid] += max(comps.values())
        self.popularity = {cid: own[cid] + sum(own[o] for o in self.same_as.get(cid, [])) for cid in self.courses}
        # a 0-unit umbrella record ("HISTORY 103") takes the range of its lettered offerings ("HISTORY 103A" ...)
        for cid, c in self.courses.items():
            if c["units"] in (0, None, [0, 0]):
                kids = [k["units"] for k in self.courses.values() if k["subject"] == c["subject"] and k is not c
                        and re.fullmatch(re.escape(c["number"]) + r"[A-Z]{1,2}", k["number"]) and k["units"] not in (0, None)]
                flat = [u for k in kids for u in (k if isinstance(k, list) else [k]) if u]
                if flat:
                    c["units"] = min(flat) if min(flat) == max(flat) else [min(flat), max(flat)]
                    self.stats["units"].append(cid)
                else:
                    self.stats["zero"].append(cid)

    def add_aliases(self, programs):
        """`aliases`: lower-case shorthands students type when searching for a program."""
        subjects = set(self.subjects)
        for rec in programs:
            name = rec["name"]
            out = []
            for key, vals in PROGRAM_ALIASES:
                if re.search(key, name, re.I):
                    out += vals
            words = [w for w in re.findall(r"[A-Za-z]+", name.replace("&", " ")) if w.lower() not in ALIAS_STOP]
            initials = "".join(w[0] for w in words).lower()
            taken = {v for key, vals in PROGRAM_ALIASES if not re.search(key, name, re.I) for v in vals}  # "cs" stays Computer Science's
            if len(words) >= 3 and "/" not in name and "(" not in name and "Business" not in name and initials not in taken:
                out.append(initials)
            lowered = name.lower()
            rec["aliases"] = [a for a in dict.fromkeys(out) if a != lowered]

    def course_gaps(self):
        """Courses other parts of the app know about must exist in courses.json; returns errors for --strict."""
        have = {c["id"] for c in self.course_out}
        errors = []
        lost = sorted(set(self.course_index) - have)
        if lost:
            errors.append(f"{len(lost)} courses the catalog publishes are missing from courses.json: {', '.join(lost[:30])}")
        if os.path.exists(PREDICTIONS):
            pred = {x["course"] for x in load(PREDICTIONS).get("predictions", [])}
            lost = sorted(c for c in pred - have if int(re.sub(r"\D", "", c.rsplit(" ", 1)[-1]) or 0) < 200)
            if lost:
                errors.append(f"{len(lost)} undergraduate courses in data/predictions/predictions.json are missing from courses.json: {', '.join(lost[:30])}")
        self.gap_errors = errors
        return errors

    def prereq_text(self, req):
        parts = []
        for q in ((req or {}).get("requisitesSimple")) or []:
            for r in q.get("rules") or []:
                v = r.get("value")
                if isinstance(v, str) and v.strip():
                    parts.append(text_of(v))
                elif isinstance(v, dict):
                    ids = [self.gid2id.get(str(x)) for g in v.get("values") or [] for x in g.get("value") or []]
                    ids = [i for i in ids if i]
                    name = (r.get("name") or "").strip()
                    parts.append(name if name and name.lower() != "requirement" else ", ".join(ids))
        return clip("; ".join(p for p in parts if p), 500)

    def write_courses(self):
        out, details = [], {}
        linked = {x for cid, v in self.same_as.items() if v for x in [cid] + v}
        keep = [cid for cid in sorted(self.courses)
                if self.courses[cid].get("career") in (None, "Undergraduate") or cid in self.used_courses or cid in linked]
        # Cross-listing is a family: if A lists B, B lists A, and every member lists every other member.
        parent = {cid: cid for cid in keep}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x
        for cid in keep:
            for g in self.courses[cid]["crossListedGids"]:
                other = self.gid2id.get(str(g))
                if other in parent and other != cid:
                    parent[find(cid)] = find(other)
        for a, b2 in self.inferred_cross:
            if a in parent and b2 in parent:
                parent[find(a)] = find(b2)
        family = collections.defaultdict(set)
        for cid in keep:
            family[find(cid)].add(cid)
        for cid in keep:
            c = self.courses[cid]
            xl = sorted(family[find(cid)] - {cid})
            rec = {"id": cid, "subject": c["subject"], "number": c["number"], "title": c["title"], "units": c["units"],
                   "breadths": c["breadths"], "attributes": sorted(c["attributes"])}
            if xl:
                rec["crossListed"] = xl
            same = [x for x in self.same_as.get(cid, []) if x in parent and x not in rec.get("crossListed", [])]
            if same:
                rec["sameAs"] = same  # same class under another number; never overlaps crossListed
            if c.get("retired"):
                rec["retired"] = True  # an old number kept only so transcripts resolve; title and units are its successor's
            if True:
                rec["popularity"] = self.popularity[cid]  # students enrolled over the terms on file; for ordering search results
            if c.get("source"):
                rec["source"] = c["source"]  # "berkeleytime": not in the current catalog, filled in from enrollment history
            out.append(rec)
            d = {}
            if c.get("_desc"):
                d["description"] = c["_desc"].strip()
            pr = self.prereq_text(c.get("_req"))
            if pr:
                d["prereqs"] = pr
            for k, src in (("offered", "_offering"), ("formerly", "_formerly"), ("grading", "_grading")):
                if c.get(src):
                    d[k] = c[src]
            if c.get("_levels"):
                d["languageLevel"] = c["_levels"]
            if c.get("_lastOffered"):
                d["lastOffered"] = c["_lastOffered"]
            if d:
                details[cid] = d
        dump(os.path.join(ROOT, "data", "courses.json"), out, compact=True)
        dump(os.path.join(ROOT, "data", "course_details.json"), details)
        by_subj = collections.Counter(c["subject"] for c in out)
        aliases = collections.defaultdict(list)
        for a, code in self.alias.items():
            aliases[code].append(a)
        for a, code in NICKNAMES.items():
            if code in by_subj and a != code:
                aliases[code].append(a)
        dump(os.path.join(ROOT, "data", "subjects.json"),
             [{"code": s, "courses": by_subj[s], "aliases": sorted(set(aliases.get(s, [])))} for s in sorted(by_subj)])
        self.course_out = out

    def report(self, majors, minors, groups, errors):
        manual = collections.Counter()
        total_reqs = collections.Counter()

        def has_manual(rule):
            return rule.get("type") == "manual" or any(has_manual(r) for r in rule.get("rules", []) or [])
        for gid, g in groups.items():
            for q in g["requirements"]:
                total_reqs[gid] += 1
                if has_manual(q["rule"]):
                    manual[gid] += 1
        by_col = collections.Counter(m["college"] for m in majors)
        co = self.course_out
        lines = ["# Requirements build report", "",
                 f"Catalog year {CATALOG_YEAR}, built from data/raw/catalog/ by scripts/build_requirements.py.", "",
                 f"- Majors and dual/joint programs: {len(majors)} ({', '.join(f'{k} {v}' for k, v in sorted(by_col.items()))})",
                 f"- Minors: {len(minors)}",
                 f"- Requirement groups: {len(groups)}",
                 f"- Courses: {len(co)}; with a breadth area: {sum(1 for c in co if c['breadths'])}; "
                 + "; ".join(f"{a}: {sum(1 for c in co if a in c['attributes'])}" for a in ["AC", "AH&I", "ELW", "RCA", "RCB", "FL", "HSS", "UD"]),
                 f"- Requirements that include a self-check (manual) step: {sum(manual.values())} of {sum(total_reqs.values())}, across {sum(1 for g in manual if manual[g])} groups",
                 f"- Course references the catalog could not resolve (retired courses): {sum(self.unresolved.values())}",
                 f"- Validation errors: {len(errors)}", ""]
        if errors:
            lines += ["## Validation errors", ""] + [f"- {e}" for e in errors] + [""]
        lines += ["## Groups with the most self-check rules", "",
                  "These are requirements the catalog states only in prose (for example \"see the department's approved list\").", ""]
        lines += [f"- {gid}: {n} of {total_reqs[gid]} requirements include a self-check" for gid, n in manual.most_common(25)] + [""]
        shown, missing, extra, detail = self.check
        lines += ["## Cross-check against the rendered catalog pages", "",
                  f"The Requirements tab of every program was also saved as plain text. It lists {shown} course lines in total; "
                  f"{missing} of them are not in the generated rules and {extra} courses in the rules are not on the page "
                  "(a page shows a course set as one line, so courses that come from a set count as extra here).", ""]
        lines += [f"- {name}: page lists {n}; missing {m[:8]}{' …' if len(m) > 8 else ''}" for name, n, m, e in detail if m] + [""]
        gaps = getattr(self, "gap_errors", [])
        lines += ["## Course coverage", "",
                  f"- Courses in the catalog's own CSV export (data/raw/catalog/course_index.json.gz): {len(self.course_index)}",
                  f"- Courses added from Berkeleytime because the catalog no longer lists them (`source: berkeleytime`): {sum(1 for c in co if c.get('source'))}",
                  f"- Courses in a cross-listed family: {sum(1 for c in co if c.get('crossListed'))}"]
        lines += [f"- WARNING: {g}" for g in gaps] or ["- Every catalog course and every undergraduate course in the predictions file is present."]
        same = self.stats["same"]
        root = {}

        def top(x):
            while root.setdefault(x, x) != x:
                x = root[x]
            return x
        for c in co:
            for o in c.get("sameAs", []):
                root[top(c["id"])] = top(o)
        comp = collections.defaultdict(list)
        for x in sorted(root):
            comp[top(x)].append(x)
        fams = {tuple(v) for v in comp.values()}
        pop = {c["id"]: c.get("popularity", 0) for c in co}
        lines += ["", f"## Same class under another number (`sameAs`): {len(fams)} families, {sum(1 for c in co if c.get('retired'))} retired stubs", "",
                  "Links by evidence: " + ", ".join(f"{k} {v}" for k, v in collections.Counter(w for _, _, w in same).most_common()) + ". Most enrolled families:", ""]
        lines += [f"- {' = '.join(f)}" for f in sorted(fams, key=lambda f: -max(pop.get(x, 0) for x in f))[:30]]
        lines += ["", "Old numbers since given to a different class, so not linked: " + "; ".join(self.stats["reused"]) + "."]
        lines += ["", f"### Cross-listings inferred for C-numbered courses ({len(self.inferred_cross)})", "",
                  "Same title and units under a C number in another subject, where the catalog named no partner for at least one of them.", ""]
        lines += [f"- {a} = {b2}: {self.courses[a]['title']}" for a, b2 in self.inferred_cross]
        lines += ["", f"Repeated entries dropped from course lists: {len(self.stats['repeats'])}."]
        lines += ["", f"## Optional requirements (`optional: true`): {len(self.stats['optional'])}", ""] + [f"- {x}" for x in self.stats["optional"]]
        lines += ["", f"## Prose rules folded into the notes of the requirement below them ({len(self.stats['folded'])})", ""] + [f"- {x}" for x in self.stats["folded"]]
        lines += ["", f"## Units: {len(self.stats['units'])} umbrella courses took the range of their lettered offerings; still 0 units: {', '.join(self.stats['zero']) or 'none'}"]
        lines += ["", "## Programs with a choice", "",
                  "Concentrations, emphases, tracks and the like: the student completes one option. Decided per program in "
                  "data/requirements/overrides/choices.json.", ""]
        for gid, choices, why in sorted(self.stats["choices"], key=lambda x: x[0]):
            for c in choices:
                lines.append(f"- {gid}: {c['title']} (pick {c['pick']} of {len(c['options'])}): " + "; ".join(o["title"] for o in c["options"]))
        lines += ["", f"## Alternatives merged into one requirement ({len(self.stats['merged'])})", ""] + [f"- {x}" for x in self.stats["merged"]]
        if self.stats["unmerged"]:
            lines += ["", "Option-like rows left as they are (not siblings of one requirement):", ""] + [f"- {x}" for x in self.stats["unmerged"]]
        lines += ["", f"## Prose lists converted to checkable rules ({len(self.stats['lists'])})", ""] + [f"- {x}" for x in self.stats["lists"]]
        lines += ["", f"## Headings the catalog wrote as rules ({len(self.stats['headings'])}; kept as notes or dropped)", ""] + [f"- {x}" for x in self.stats["headings"]]
        lines += ["", "## Section and title corrections", ""] + [f"- {x}" for x in self.stats["sections"] + self.stats["titles"]]
        lines += ["", "## Section audit", "",
                  "Catalog blocks named exactly like their own first rule while holding other rules (the Cognitive Science "
                  "symptom). Each is either fixed by a renameSections override or reviewed and listed in AUDIT_OK.", ""]
        lines += [f"- {x}" for x in self.stats["audit"]] or ["- none left"]
        lines += [""]
        if self.warnings:
            lines += ["## Warnings", ""] + [f"- {w}" for w in sorted(set(self.warnings))] + [""]
        if self.unresolved:
            lines += ["## Retired course references dropped", ""] + [f"- {k}: {v}" for k, v in sorted(self.unresolved.items())] + [""]
        with open(os.path.join(REQ, "REPORT.md"), "w", encoding="utf-8") as f:
            f.write("\n".join(lines))
        print("\n".join(lines[:12]))


# --------------------------------------------------------------------------- cross-check against the rendered pages

def rule_course_ids(rule):
    if rule.get("type") == "course":
        yield rule["course"]
    for c in (rule.get("filter") or {}).get("courses", []):
        yield c
    for r in rule.get("rules", []) or []:
        yield from rule_course_ids(r)


def crosscheck(programs, groups_by_code):
    """Compare each generated program group with the text of its catalog Requirements tab.

    The rendered page prints every listed course as "SUBJ 123 - Title". Returns
    (courses shown, shown but missing from our rules, in our rules but not shown, per-program detail)."""
    shown_n = missing_n = extra_n = 0
    detail = []
    for p in programs:
        g = groups_by_code.get(p["code"])
        text = p.get("pageText") or ""
        if not g or not text:
            continue
        i = text.find("Program Requirements")
        body = text[i:] if i >= 0 else text
        shown = set(re.findall(r"^([A-Z][A-Z0-9]+ [A-Z]{0,2}\d+[A-Z]{0,3}) - ", body, re.M))
        mine = {c for q in g["requirements"] for c in rule_course_ids(q["rule"])}
        shown_n += len(shown)
        missing_n += len(shown - mine)
        extra_n += len(mine - shown)
        if shown - mine or mine - shown:
            detail.append((p["catalogDisplayName"], len(shown), sorted(shown - mine), sorted(mine - shown)))
    return shown_n, missing_n, extra_n, detail


# --------------------------------------------------------------------------- validation (also used by tests)

RULE_TYPES = {"course", "allOf", "anyOf", "nOf", "filter", "units", "manual"}
# (groupId, block) pairs from the section audit that were read and are fine: the first rule is the block's
# own general statement ("Electives: choose ...") and the block name is right for everything under it.
AUDIT_OK = {("minor-journalism", "Minor Requirements"), ("major-mechanical-engineering-nuclear-engineering-bs", "Electives"),
            ("minor-political-economy", "Electives")}
FILTER_KEYS = {"courses", "subjects", "minNumber", "maxNumber", "breadth", "attribute", "exclude"}


def validate_rule(rule, where, courses, errors):
    if not isinstance(rule, dict) or rule.get("type") not in RULE_TYPES:
        errors.append(f"{where}: bad rule {str(rule)[:80]}")
        return
    t = rule["type"]
    if t == "course":
        if rule.get("course") not in courses:
            errors.append(f"{where}: unknown course {rule.get('course')!r}")
    elif t in ("allOf", "anyOf", "nOf"):
        rules = rule.get("rules")
        if not isinstance(rules, list) or not rules:
            errors.append(f"{where}: {t} without rules")
            return
        if t == "nOf" and not (isinstance(rule.get("n"), int) and 1 <= rule["n"] <= len(rules)):
            errors.append(f"{where}: nOf n={rule.get('n')} with {len(rules)} rules")
        for i, r in enumerate(rules):
            validate_rule(r, f"{where}.{t}[{i}]", courses, errors)
    elif t in ("filter", "units"):
        flt = rule.get("filter")
        if t == "filter" and "count" not in rule and "minUnits" not in rule:
            errors.append(f"{where}: filter needs count or minUnits")
        if t == "units" and not isinstance(rule.get("minUnits"), (int, float)):
            errors.append(f"{where}: units needs minUnits")
        if not isinstance(flt, dict):
            errors.append(f"{where}: filter is not an object")
            return
        if set(flt) - FILTER_KEYS:
            errors.append(f"{where}: unknown filter keys {sorted(set(flt) - FILTER_KEYS)}")
        if "breadth" in flt and flt["breadth"] not in BREADTHS:
            errors.append(f"{where}: unknown breadth {flt['breadth']!r}")
        if "attribute" in flt and flt["attribute"] not in ATTRS:
            errors.append(f"{where}: unknown attribute {flt['attribute']!r}")
        for key in ("courses", "exclude"):
            for c in flt.get(key, []):
                if c not in courses:
                    errors.append(f"{where}: unknown course {c!r} in {key}")
        if "courses" in flt and not flt["courses"]:
            errors.append(f"{where}: empty course list")
    elif t == "manual" and not rule.get("text"):
        errors.append(f"{where}: manual without text")


def validate_group(g, courses, errors):
    gid = g.get("id")
    if g.get("kind") not in ("major", "college", "university", "minor"):
        errors.append(f"{gid}: bad kind {g.get('kind')!r}")
    reqs = g.get("requirements")
    if not isinstance(reqs, list) or not reqs:
        errors.append(f"{gid}: no requirements")
        return
    options = {}
    for c in g.get("choices") or []:
        ids = [o.get("id") for o in c.get("options") or []]
        if not c.get("id") or c["id"] in options or not c.get("title") or not isinstance(c.get("pick"), int) or not ids \
                or len(set(ids)) != len(ids) or not all(o.get("id") and o.get("title") for o in c["options"]) or not 1 <= c["pick"] <= len(ids):
            errors.append(f"{gid}: bad choice {c.get('id')!r}")
        options[c.get("id")] = set(ids)
    seen = set()
    for q in reqs:
        if not q.get("id") or q["id"] in seen or not q.get("title"):
            errors.append(f"{gid}: missing/duplicate requirement id or title {q.get('id')!r}")
        seen.add(q.get("id"))
        for key in ("title", "section"):
            if q.get(key) is not None and (q[key] != q[key].strip() or "  " in q[key] or "\t" in q[key] or q[key].endswith(":")):
                errors.append(f"{gid}/{q.get('id')}: untidy {key} {q[key]!r}")
        if ("choice" in q) != ("option" in q) or ("choice" in q and q.get("option") not in options.get(q["choice"], ())):
            errors.append(f"{gid}/{q.get('id')}: choice/option {q.get('choice')!r}/{q.get('option')!r} is not declared in the group's choices")
        validate_rule(q.get("rule"), f"{gid}/{q.get('id')}", courses, errors)


def main():
    if "--pack" in sys.argv:
        pack()
    b = Builder()
    errors = b.build()
    if errors:
        print("\n".join(errors[:40]))
    sys.exit(1 if (errors and "--strict" in sys.argv) else 0)


if __name__ == "__main__":
    main()
