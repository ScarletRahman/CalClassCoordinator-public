"""Scrape historical enrollment time series from Berkeleytime.

Berkeleytime (https://berkeleytime.com) is a JS SPA backed by a GraphQL API at
/api/graphql that only accepts *persisted operations*: the client POSTs
``{"id": sha256(minified query), "variables": {...}}`` (no query text). The id is
the SHA-256 of the query document with ``__typename`` removed, printed and run
through ``stripIgnoredCharacters`` -- which is exactly the minified strings in
``QUERIES`` below. If Berkeleytime changes its queries the server will start
answering "Invalid persisted operation request"; run ``refresh-ops`` to
re-derive the queries from the live JS bundle (needs ``pip install graphql-core``).

Operations used:
  GetTerms                  -> list of terms
  GetCatalogClassIdentities -> every class (subject, courseNumber, number, sessionId) in a term
  GetEnrollmentTimeframes   -> enrollment phase windows per term (saved as timeframes.json)
  GetClass                  -> one class: primary-section enrollment history (run-length
                               encoded daily snapshots), instructors, and all sections

Raw responses are cached (gzip JSON) under --cache so runs are resumable.

Usage:
  python ml/scrapers/berkeleytime.py all              # fetch + build (defaults below)
  python ml/scrapers/berkeleytime.py fetch --terms "Spring 2022-Spring 2027" --level undergrad
  python ml/scrapers/berkeleytime.py build            # rebuild CSVs from cache only
  python ml/scrapers/berkeleytime.py refresh-ops      # re-derive persisted queries from the bundle
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

BASE = "https://berkeleytime.com"
API = BASE + "/api/graphql"
REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = REPO_ROOT / "data" / "enrollment" / "berkeleytime"
DEFAULT_CACHE = Path(os.environ.get("BT_CACHE", "/tmp/claude-0/bt/cache"))
SOURCE = "berkeleytime"
UA = "CalClassCoordinator/0.1 (enrollment-history research scraper)"

QUERIES = {
    "GetTerms": 'query GetTerms{terms(withCatalogData:true){year semester temporalPosition hasCatalogData sessions{id name startDate endDate temporalPosition}startDate endDate}}',
    "GetCatalogClassIdentities": 'query GetCatalogClassIdentities($year:Int!$semester:Semester!){catalogClassIdentities(year:$year semester:$semester){subject courseNumber number sessionId}}',
    "GetEnrollmentTimeframes": 'query GetEnrollmentTimeframes($year:Int!$semester:Semester!){enrollmentTimeframes(year:$year semester:$semester){phase isAdjustment group startDate endDate startEventSummary}}',
    "GetClass": 'query GetClass($year:Int!$semester:Semester!$sessionId:SessionIdentifier!$subject:String!$courseNumber:CourseNumber!$number:ClassNumber!){class(year:$year semester:$semester sessionId:$sessionId subject:$subject courseNumber:$courseNumber number:$number){year semester subject sessionId courseNumber number title description decal{title syllabus description syllabusUrl applicationUrl applicationDueDate instructors{name email}}unitsMax unitsMin gradingBasis finalExam gradeDistribution{average pnpPercentage distribution{letter count}}course{title description aggregatedRatings{metrics{categories{count value}count metricName weightedAverage}}gradeDistribution{average pnpPercentage distribution{letter count}}academicCareer requirements requiredCourses{subject number}classes{semester year number anyPrintInScheduleOfClasses primarySection{startDate meetings{instructors{familyName givenName}}}}}primarySection{number sectionId component online attendanceRequired lecturesRecorded startDate endDate sectionAttributes(attributeCode:"NOTE"){attribute{code description formalDescription}value{code description formalDescription}}enrollment{history{startTime endTime granularitySeconds status enrolledCount maxEnroll waitlistedCount maxWaitlist}latest{startTime endTime granularitySeconds status enrolledCount maxEnroll waitlistedCount maxWaitlist activeReservedMaxCount seatReservationCount{enrolledCount maxEnroll requirementGroup{description}isValid}}}meetings{days location endTime startTime instructors{familyName givenName}}exams{date type location startTime endTime}}sections{number sectionId component online attendanceRequired lecturesRecorded startDate endDate sectionAttributes(attributeCode:"NOTE"){attribute{code description formalDescription}value{code description formalDescription}}enrollment{latest{startTime endTime granularitySeconds status enrolledCount maxEnroll waitlistedCount maxWaitlist activeReservedMaxCount}}meetings{days location endTime startTime instructors{familyName givenName}}exams{date type location startTime endTime}}}}',
    # Lighter fallbacks for classes whose GetClass 502s (courses with hundreds of classes, e.g. UGIS 192).
    "GetClassDetails": 'query GetClassDetails($year:Int!$semester:Semester!$sessionId:SessionIdentifier!$subject:String!$courseNumber:CourseNumber!$number:ClassNumber!){class(year:$year semester:$semester sessionId:$sessionId subject:$subject courseNumber:$courseNumber number:$number){year semester subject sessionId courseNumber courseId number unitsMax unitsMin finalExam decal{title}course{title description requirements aggregatedRatings(metricNames:[Attendance Recording]){metrics{metricName count weightedAverage categories{value count}}}gradeDistribution{average pnpPercentage}}primarySection{sectionId component sectionAttributes(attributeCode:"NOTE"){attribute{code formalDescription}value{description formalDescription}}exams{date startTime endTime location type}enrollment{latest{endTime enrolledCount maxEnroll waitlistedCount maxWaitlist activeReservedMaxCount seatReservationCount{enrolledCount maxEnroll requirementGroup{description}isValid}}}meetings{days location endTime startTime instructors{familyName givenName}}}decal{syllabus description syllabusUrl applicationUrl applicationDueDate instructors{name email}}}}',
    "GetClassEnrollment": 'query GetClassEnrollment($year:Int!$semester:Semester!$sessionId:SessionIdentifier!$subject:String!$courseNumber:CourseNumber!$number:ClassNumber!){class(year:$year semester:$semester sessionId:$sessionId subject:$subject courseNumber:$courseNumber number:$number){primarySection{enrollment{history{startTime endTime granularitySeconds enrolledCount maxEnroll waitlistedCount maxWaitlist}}}}}',
    "GetClassSections": 'query GetClassSections($year:Int!$semester:Semester!$sessionId:SessionIdentifier!$subject:String!$courseNumber:CourseNumber!$number:ClassNumber!){class(year:$year semester:$semester sessionId:$sessionId subject:$subject courseNumber:$courseNumber number:$number){sections{sectionId number component meetings{days location endTime startTime instructors{familyName givenName}}enrollment{latest{enrolledCount maxEnroll waitlistedCount maxWaitlist}}}}}',
    # Section-level history incl. reserved seats (not used by default; one extra request per section).
    "GetEnrollment": 'query GetEnrollment($year:Int!$semester:Semester!$sessionId:SessionIdentifier$subject:String!$courseNumber:CourseNumber!$sectionNumber:SectionNumber!){enrollment(year:$year semester:$semester sessionId:$sessionId subject:$subject courseNumber:$courseNumber sectionNumber:$sectionNumber){year semester sessionId sectionId subject courseNumber sectionNumber history{startTime endTime granularitySeconds status enrolledCount waitlistedCount reservedCount minEnroll maxEnroll maxWaitlist openReserved activeReservedMaxCount seatReservationCount{maxEnroll enrolledCount requirementGroup{description}isValid}}}}',
}

OPS_OVERRIDE = Path(__file__).with_name("berkeleytime_ops.json")  # written by refresh-ops
if OPS_OVERRIDE.exists():
    QUERIES.update(json.loads(OPS_OVERRIDE.read_text()))

SEMESTER_ORDER = {"Spring": 0, "Summer": 1, "Fall": 2}


# --------------------------------------------------------------------------- HTTP
class RateLimiter:
    def __init__(self, rps: float):
        self.interval = 1.0 / rps
        self.lock = threading.Lock()
        self.next = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next)
            self.next = t + self.interval
        if t > now:
            time.sleep(t - now)


class Client:
    def __init__(self, cache: Path, rps: float = 4.0):
        self.cache = cache
        self.limiter = RateLimiter(rps)
        self.local = threading.local()

    def _session(self) -> requests.Session:
        s = getattr(self.local, "s", None)
        if s is None:
            s = self.local.s = requests.Session()
            s.headers.update({"User-Agent": UA, "content-type": "application/json",
                              "accept": "application/graphql-response+json,application/json;q=0.9"})
        return s

    def fetch_class(self, v: dict) -> dict:
        """GetClass, or (if it keeps failing server-side) the three light queries merged into its shape."""
        try:
            return self.query("GetClass", v, attempts=2)
        except (requests.RequestException, ValueError):
            pass
        det = (self.query("GetClassDetails", v).get("data") or {}).get("class")
        if det is None:
            raise RuntimeError(f"GetClassDetails returned no class for {v}")
        enr = ((self.query("GetClassEnrollment", v).get("data") or {}).get("class") or {}).get("primarySection") or {}
        secs = ((self.query("GetClassSections", v).get("data") or {}).get("class") or {}).get("sections") or []
        prim = det.get("primarySection") or {}
        prim["number"] = v["number"]
        prim["enrollment"] = {**(prim.get("enrollment") or {}), "history": (enr.get("enrollment") or {}).get("history")}
        data = {"data": {"class": {**det, "primarySection": prim, "sections": secs}}, "_fallback": True}
        path = self.cache_path("GetClass", v)
        path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, "wt") as f:
            json.dump(data, f)
        return data

    def cache_path(self, op: str, variables: dict | None) -> Path:
        key = "_".join(str(variables[k]) for k in sorted(variables)) if variables else "none"
        key = re.sub(r"[^A-Za-z0-9_.-]", "-", key)
        return self.cache / op / f"{key}.json.gz"

    def query(self, op: str, variables: dict | None = None, use_cache: bool = True, attempts: int = 7) -> dict:
        path = self.cache_path(op, variables)
        if use_cache and path.exists():
            with gzip.open(path, "rt") as f:
                return json.load(f)
        body = {"id": hashlib.sha256(QUERIES[op].encode()).hexdigest()}
        if variables is not None:
            body["variables"] = variables
        delay = 2.0
        for attempt in range(attempts):
            self.limiter.wait()
            try:
                r = self._session().post(API, json=body, timeout=90)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                data = r.json()
                if "error" in data:  # persisted-op rejection
                    raise RuntimeError(f"{op}: {data['error']} (run refresh-ops)")
                break
            except RuntimeError:
                raise
            except (requests.RequestException, ValueError) as e:
                if attempt == attempts - 1:
                    raise
                print(f"  retry {op} {variables} after {e}", file=sys.stderr)
                time.sleep(delay)
                delay = min(delay * 2, 60)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt") as f:
            json.dump(data, f)
        tmp.replace(path)
        return data


# --------------------------------------------------------------------------- helpers
def parse_term(s: str) -> tuple[int, str]:
    sem, year = s.strip().split()
    return int(year), sem.capitalize()


def term_key(y: int, s: str) -> int:
    return y * 3 + SEMESTER_ORDER[s]


def course_num(cn: str) -> int:
    m = re.search(r"\d+", cn)
    return int(m.group()) if m else 999


def select_terms(all_terms: list[tuple[int, str]], spec: str, include_summer: bool) -> list[tuple[int, str]]:
    if "-" in spec:
        a, b = (parse_term(x) for x in spec.split("-", 1))
        lo, hi = sorted((term_key(*a), term_key(*b)))
        out = [t for t in all_terms if lo <= term_key(*t) <= hi]
    else:
        wanted = {parse_term(x) for x in spec.split(",")}
        out = [t for t in all_terms if t in wanted]
    if not include_summer:
        out = [t for t in out if t[1] != "Summer"]
    return sorted(set(out), key=lambda t: -term_key(*t))  # newest first


def instructors_of(section: dict | None) -> str:
    names: list[str] = []
    for m in (section or {}).get("meetings") or []:
        for i in m.get("instructors") or []:
            n = " ".join(x for x in (i.get("givenName"), i.get("familyName")) if x).strip()
            if n and n not in names:
                names.append(n)
    return "; ".join(names)


def iso_date(ts: str) -> dt.date:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).date()


# --------------------------------------------------------------------------- fetch
def get_terms(client: Client) -> list[tuple[int, str]]:
    data = client.query("GetTerms", use_cache=False)
    return sorted({(t["year"], t["semester"]) for t in data["data"]["terms"]}, key=lambda t: term_key(*t))


def identities(client: Client, year: int, sem: str, level: str, subjects: set[str] | None) -> list[dict]:
    ids = client.query("GetCatalogClassIdentities", {"year": year, "semester": sem})["data"]["catalogClassIdentities"] or []
    out = []
    for x in ids:
        if subjects and x["subject"] not in subjects:
            continue
        n = course_num(x["courseNumber"])
        if level == "undergrad" and n >= 200:
            continue
        if level == "grad" and n < 200:
            continue
        out.append(x)
    return out


def fetch(args) -> None:
    client = Client(Path(args.cache), args.rps)
    terms = select_terms(get_terms(client), args.terms, args.summer)
    subjects = {s.strip().upper() for s in args.subjects.split(",")} if args.subjects else None
    print("terms:", ", ".join(f"{s} {y}" for y, s in terms), flush=True)
    for y, s in terms:
        client.query("GetEnrollmentTimeframes", {"year": y, "semester": s})
        ids = identities(client, y, s, args.level, subjects)
        todo = []
        for x in ids:
            v = {"year": y, "semester": s, "sessionId": x["sessionId"], "subject": x["subject"],
                 "courseNumber": x["courseNumber"], "number": x["number"]}
            if not client.cache_path("GetClass", v).exists():
                todo.append(v)
        print(f"{s} {y}: {len(ids)} classes, {len(todo)} to fetch", flush=True)
        done = 0
        with ThreadPoolExecutor(args.workers) as ex:
            futs = {ex.submit(client.fetch_class, v): v for v in todo}
            for f in as_completed(futs):
                try:
                    f.result()
                except Exception as e:  # keep going; failures are retried on the next run
                    print(f"  FAILED {futs[f]}: {e}", file=sys.stderr, flush=True)
                done += 1
                if done % 250 == 0:
                    print(f"  {s} {y}: {done}/{len(todo)}", flush=True)


# --------------------------------------------------------------------------- build
TS_COLS = ["term", "course", "section", "instructors", "date", "enrolled", "capacity",
           "waitlisted", "waitlist_capacity", "source"]
SEC_COLS = ["term", "course", "section", "component", "instructors", "capacity", "enrolled",
            "waitlisted", "waitlist_capacity", "reserved_capacity", "source"]


def expand_history(history: list[dict]):
    """Berkeleytime stores run-length-encoded daily snapshots: each entry's values hold for every
    day from startTime to endTime *inclusive* (granularitySeconds=86400)."""
    rows: dict[dt.date, dict] = {}
    for h in sorted(history, key=lambda h: h["startTime"]):
        start = iso_date(h["startTime"])
        end = iso_date(h["endTime"]) if h.get("endTime") else start
        d = start
        while d <= end:
            rows[d] = h
            d += dt.timedelta(days=1)
    return sorted(rows.items())


def parse_class(c: dict) -> tuple[list[list], list[list]]:
    """Pure parse of one GetClass `data.class` payload -> (timeseries rows, sections rows)."""
    term = f"{c['semester']} {c['year']}"
    course = f"{c['subject']} {c['courseNumber']}"
    prim = c.get("primarySection") or {}
    sec_no = prim.get("number") or c["number"]
    instr = instructors_of(prim)
    enr = prim.get("enrollment") or {}
    latest = enr.get("latest") or {}
    sec_rows = [[term, course, sec_no, prim.get("component") or "", instr,
                 latest.get("maxEnroll", ""), latest.get("enrolledCount", ""),
                 latest.get("waitlistedCount", ""), latest.get("maxWaitlist", ""),
                 latest.get("activeReservedMaxCount", ""), SOURCE]]
    for s in c.get("sections") or []:
        sl = (s.get("enrollment") or {}).get("latest") or {}
        sec_rows.append([term, course, s.get("number"), s.get("component") or "",
                         instructors_of(s), sl.get("maxEnroll", ""), sl.get("enrolledCount", ""),
                         sl.get("waitlistedCount", ""), sl.get("maxWaitlist", ""),
                         sl.get("activeReservedMaxCount", ""), SOURCE])
    ts_rows = [[term, course, sec_no, instr, d.isoformat(), h.get("enrolledCount", ""),
                h.get("maxEnroll", ""), h.get("waitlistedCount", ""), h.get("maxWaitlist", ""), SOURCE]
               for d, h in expand_history(enr.get("history") or [])]
    return ts_rows, sec_rows


def build(args) -> None:
    cache = Path(args.cache) / "GetClass"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ts_tmp = out / "timeseries.csv.tmp"
    n_ts = n_sec = n_cls = 0
    min_d, max_d = None, None
    terms: dict[str, set] = {}
    files = sorted(cache.glob("*.json.gz")) if cache.exists() else []
    sec_rows = []
    with open(ts_tmp, "w", newline="") as tf:
        tw = csv.writer(tf)
        tw.writerow(TS_COLS)
        for p in files:
            with gzip.open(p, "rt") as f:
                c = (json.load(f).get("data") or {}).get("class")
            if not c:
                continue
            ts_rows, rows = parse_class(c)
            n_cls += 1
            sec_rows.extend(rows)
            if ts_rows:
                terms.setdefault(ts_rows[0][0], set()).add(ts_rows[0][1])
            for row in ts_rows:
                tw.writerow(row)
                d = dt.date.fromisoformat(row[4])
                n_ts += 1
                min_d = d if min_d is None or d < min_d else min_d
                max_d = d if max_d is None or d > max_d else max_d

    # de-duplicate sections (cross-listed / shared sections can repeat)
    seen, dedup = set(), []
    for r in sec_rows:
        k = (r[0], r[1], str(r[2]))
        if k not in seen:
            seen.add(k)
            dedup.append(r)
    with open(out / "sections.csv", "w", newline="") as sf:
        sw = csv.writer(sf)
        sw.writerow(SEC_COLS)
        sw.writerows(dedup)
    n_sec = len(dedup)

    # gzip timeseries when large; keep only one of .csv / .csv.gz (the loader reads both)
    for stale in (out / "timeseries.csv", out / "timeseries.csv.gz"):
        stale.unlink(missing_ok=True)
    if ts_tmp.stat().st_size > 20 * 1024 * 1024:
        with open(ts_tmp, "rb") as src, gzip.open(out / "timeseries.csv.gz", "wb", compresslevel=9) as dst:
            while chunk := src.read(1 << 20):
                dst.write(chunk)
        ts_tmp.unlink()
        ts_name = "timeseries.csv.gz"
    else:
        ts_tmp.replace(out / "timeseries.csv")
        ts_name = "timeseries.csv"

    # enrollment phase windows as reported by Berkeleytime
    tf_cache = Path(args.cache) / "GetEnrollmentTimeframes"
    tfs = []
    for p in sorted(tf_cache.glob("*.json.gz")) if tf_cache.exists() else []:
        with gzip.open(p, "rt") as f:
            d = json.load(f)
        sem, year = p.name.split(".")[0].split("_")[:2]
        tfs.append({"term": f"{sem} {year}", "timeframes": [
            {k: v for k, v in t.items() if k != "__typename"}
            for t in (d.get("data") or {}).get("enrollmentTimeframes") or []]})
    (out / "timeframes.json").write_text(json.dumps(tfs, indent=1))

    print(f"classes cached: {n_cls}")
    print(f"{ts_name}: {n_ts} rows, dates {min_d}..{max_d}")
    print(f"sections.csv: {n_sec} rows")
    for t in sorted(terms, key=lambda t: term_key(*parse_term(t))):
        print(f"  {t}: {len(terms[t])} courses with history")


# --------------------------------------------------------------------------- refresh-ops
def refresh_ops(args) -> None:
    """Download the live bundle + lazy chunks and recompute minified persisted queries."""
    from graphql import parse, print_ast, strip_ignored_characters, visit, Visitor, REMOVE  # pip install graphql-core

    class DropTypename(Visitor):
        def enter_field(self, node, *_):
            return REMOVE if node.name.value == "__typename" else None

    s = requests.Session()
    s.headers["User-Agent"] = UA
    html = s.get(BASE + "/", timeout=60).text
    seen, queue, src = set(), re.findall(r"/assets/[\w.-]+\.js", html), []
    while queue:
        a = queue.pop()
        if a in seen:
            continue
        seen.add(a)
        js = s.get(BASE + a, timeout=60).text
        src.append(js)
        queue += ["/" + x if not x.startswith("/") else x for x in re.findall(r"/?assets/[\w.-]+\.js", js)]
        time.sleep(0.2)
    found = {}
    for js in src:
        for m in re.finditer(r"`(\s*(?:query|mutation)\s+\w+[\s\S]*?)`", js):
            try:
                doc = visit(parse(m.group(1)), DropTypename())
            except Exception:
                continue
            q = strip_ignored_characters(print_ast(doc))
            name = re.match(r"(?:query|mutation) (\w+)", q)
            if name and name.group(1) in QUERIES:
                found[name.group(1)] = q
    changed = {k: v for k, v in found.items() if QUERIES.get(k) != v}
    print(f"scanned {len(seen)} js files; found {len(found)} known ops; {len(changed)} changed")
    if changed:
        OPS_OVERRIDE.write_text(json.dumps(changed, indent=1))
        print(f"wrote {OPS_OVERRIDE}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("fetch", "build", "all", "refresh-ops"):
        p = sub.add_parser(name)
        p.add_argument("--cache", default=str(DEFAULT_CACHE))
        p.add_argument("--out", default=str(OUT_DIR))
        p.add_argument("--terms", default="Spring 2022-Spring 2027",
                       help='range "Spring 2022-Fall 2026" or list "Fall 2024,Spring 2025"')
        p.add_argument("--summer", action="store_true", help="include Summer terms")
        p.add_argument("--level", choices=["undergrad", "grad", "all"], default="undergrad",
                       help="undergrad = course numbers < 200")
        p.add_argument("--subjects", default="", help="comma-separated subject codes (default: all)")
        p.add_argument("--rps", type=float, default=4.0)
        p.add_argument("--workers", type=int, default=4)
    args = ap.parse_args(argv)
    if args.cmd in ("fetch", "all"):
        fetch(args)
    if args.cmd in ("build", "all"):
        build(args)
    if args.cmd == "refresh-ops":
        refresh_ops(args)


if __name__ == "__main__":
    main()
