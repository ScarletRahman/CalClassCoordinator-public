"""Class timetables: when every lecture, discussion and lab meets.

Two jobs share the shapes in this file (contract: docs/schedule.md):

* ``python -m watcher import-schedule --term "2027 Spring"`` downloads a whole
  term from Berkeleytime and writes ``data/schedule/2027-spring.json`` (the
  planner's schedule builder reads it).
* ``watcher.lookup`` answers one course at a time with fresh seat counts.

A course's offering is a list of *classes*. One class is one primary section
(usually the lecture) plus the discussions/labs that belong to it::

    {"number": "001", "units": [4, 4],
     "primary": SECTION, "sections": [SECTION, ...]}

    SECTION = {"classNumber": "28320", "section": "001 LEC", "component": "LEC",
               "instructor": "Kay Ousterhout",
               "meetings": [{"days": [0, 2, 4], "start": "13:00", "end": "13:59",
                             "location": "Dwinelle 155"}],
               "enrolled": 332, "capacity": 600, "waitlisted": 0,
               "waitlistCapacity": 300, "status": "open",
               "open": 173, "reserved": [{"group", "enrolled", "capacity"}]}

``days`` are 0 = Monday ... 6 = Sunday; times are 24-hour local (Pacific).
Fields that are unknown are left out. Everything above the network code is pure.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

import requests

from watcher.models import Section, utcnow_iso
from watcher.sources import berkeleytime as bt
from watcher.sources.base import SourceError

log = logging.getLogger("watcher.schedule")

USER_AGENT = "CalClassCoordinator schedule import"

GET_CATALOG_CLASS_IDENTITIES = """
  query GetCatalogClassIdentities($year: Int!, $semester: Semester!) {
    catalogClassIdentities(year: $year, semester: $semester) {
      subject
      courseNumber
      number
      sessionId
    }
  }
"""

_DAY_INDEX = {"mo": 0, "tu": 1, "we": 2, "th": 3, "fr": 4, "sa": 5, "su": 6}


# --------------------------------------------------------------------------- #
# Small pure helpers
# --------------------------------------------------------------------------- #

def term_slug(term: str) -> str:
    """'2027 Spring' / 'Spring 2027' -> '2027-spring' (the file name)."""
    year, sem = bt.parse_term(term)
    return f"{year}-{sem.lower()}"


def canonical_term(term: str) -> str:
    year, sem = bt.parse_term(term)
    return f"{year} {sem}"


def _hhmm(value: Any) -> str | None:
    """'13:00:00' -> '13:00'; '01:00 pm' -> '13:00'. None when it is not a time."""
    text = str(value or "").strip().lower()
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?m?\.?", text)
    if m:
        hour = int(m.group(1)) % 12 + (12 if m.group(3) == "p" else 0)
        return f"{hour:02d}:{m.group(2)}"
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", text)
    if m and int(m.group(1)) < 24:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    return None


def parse_days_text(text: str) -> list[int]:
    """'Mo, We, Fr' / 'TuTh' -> [0, 2, 4] / [1, 3]."""
    return sorted({_DAY_INDEX[d] for d in re.findall(r"mo|tu|we|th|fr|sa|su", (text or "").lower())})


def parse_time_range(text: str) -> tuple[str, str] | None:
    """'01:00 pm  -  01:59 pm' -> ('13:00', '13:59')."""
    parts = re.split(r"\s+-\s+|\s*–\s*", (text or "").strip())
    if len(parts) != 2:
        return None
    start, end = _hhmm(parts[0]), _hhmm(parts[1])
    return (start, end) if start and end else None


def make_meeting(days: list[int], start: str | None, end: str | None, location: str = "") -> dict[str, Any] | None:
    """A meeting the calendar can draw, or None for placeholders.

    The SIS writes "no set time" as midnight to midnight (or 12:00-12:01 am);
    those are dropped so they are not drawn as a block at midnight.
    """
    if not days or not start or not end or start >= end:
        return None
    if start == "00:00" and end <= "00:01":
        return None
    out: dict[str, Any] = {"days": days, "start": start, "end": end}
    location = re.sub(r"\s+", " ", location or "").strip()
    if location:
        out["location"] = location
    return out


def bt_meetings(meetings: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Berkeleytime ``meetings[]`` (days = 7 booleans, Monday first) -> our meetings."""
    out = []
    for m in meetings or []:
        flags = m.get("days") or []
        days = [i for i, on in enumerate(flags[:7]) if on]
        meeting = make_meeting(days, _hhmm(m.get("startTime")), _hhmm(m.get("endTime")), m.get("location") or "")
        if meeting and meeting not in out:
            out.append(meeting)
    return out


def _drop_empty(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v not in (None, "", [], {})}


def section_dict(sec: Section, *, component: str = "", meetings: list[dict[str, Any]] | None = None,
                 seats: bool = True, **extra: Any) -> dict[str, Any]:
    """One SECTION from a watcher ``Section`` plus its meeting times."""
    if not component:
        component = sec.section.split(" ")[-1] if " " in sec.section else ""
    out: dict[str, Any] = {
        "classNumber": sec.classNumber, "section": sec.section, "component": component,
        "instructor": sec.instructor, "meetings": meetings or [],
    }
    if seats:
        out.update({
            "enrolled": sec.enrolled, "capacity": sec.capacity, "waitlisted": sec.waitlisted,
            "waitlistCapacity": sec.waitlistCapacity, "status": sec.status,
            "open": sec.open,
            "reserved": [{"group": r.group, "enrolled": r.enrolled, "capacity": r.capacity} for r in sec.reserved],
        })
    out.update(extra)
    kept = _drop_empty(out)
    kept.setdefault("meetings", [])
    if seats and sec.open is not None:
        kept["open"] = sec.open  # 0 open seats is information, not "unknown"
    for key in ("enrolled", "capacity", "waitlisted", "waitlistCapacity"):
        if seats and getattr(sec, key) is not None:
            kept[key] = getattr(sec, key)
    return kept


# --------------------------------------------------------------------------- #
# Berkeleytime responses -> one class
# --------------------------------------------------------------------------- #

def class_from_berkeleytime(details: dict[str, Any], sections: dict[str, Any] | None,
                            *, seats: bool = True) -> tuple[str, dict[str, Any]] | None:
    """(course id, CLASS) from a GetClassDetails (+ GetClassSections) response.

    Returns None when the class has no primary section (nothing to schedule).
    """
    cls = bt._data(details).get("class")
    if not cls or not cls.get("primarySection"):
        return None
    parsed = bt.parse_class_response(details, sections)
    raw_primary = cls["primarySection"]
    raw_secondary = (bt._data(sections).get("class") or {}).get("sections") or [] if sections else []

    exams = []
    for e in raw_primary.get("exams") or []:
        exam = _drop_empty({"type": e.get("type"), "date": e.get("date"),
                            "start": _hhmm(e.get("startTime")), "end": _hhmm(e.get("endTime"))})
        if exam.get("date"):
            exams.append(exam)

    primary = section_dict(parsed[0], component=raw_primary.get("component") or "",
                           meetings=bt_meetings(raw_primary.get("meetings")), seats=seats)
    secondary = [
        section_dict(sec, component=raw.get("component") or "", meetings=bt_meetings(raw.get("meetings")), seats=seats)
        for sec, raw in zip(parsed[1:], raw_secondary)
    ]
    secondary = drop_placeholder_sections(secondary)
    units = [cls.get("unitsMin"), cls.get("unitsMax")]
    out = _drop_empty({
        "number": cls.get("number"),
        "sessionId": cls.get("sessionId") if cls.get("sessionId") not in (None, "1") else None,
        "title": ((cls.get("course") or {}).get("title")) or "",
        "units": units if all(isinstance(u, (int, float)) for u in units) else None,
        "exams": exams,
        "url": parsed[0].url,
    })
    out["primary"] = primary
    out["sections"] = secondary
    return f"{cls['subject']} {cls['courseNumber']}".upper(), out


def drop_placeholder_sections(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove the empty shells departments keep in the SIS but do not offer.

    Berkeleytime lists every section, including ones with a limit of 0 and nobody
    enrolled that the official schedule hides (MATH 53 has seven of them). A
    0-seat section is dropped only when a sibling of the same kind has seats, so a
    class whose sections are all still at 0 (not opened yet) keeps them.
    """
    def is_shell(s: dict[str, Any]) -> bool:
        return s.get("capacity") == 0 and not s.get("enrolled") and not s.get("waitlisted")

    real_kinds = {s.get("component") for s in sections if not is_shell(s)}
    return [s for s in sections if not (is_shell(s) and s.get("component") in real_kinds)]


def sort_classes(classes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for c in classes:
        c["sections"] = sorted(c.get("sections") or [], key=lambda s: (s.get("component", ""), s.get("section", "")))
    return sorted(classes, key=lambda c: (c.get("sessionId", ""), c.get("number", "")))


# --------------------------------------------------------------------------- #
# Berkeleytime client that many threads can share
# --------------------------------------------------------------------------- #

class RateLimiter:
    def __init__(self, per_second: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self.interval = 1.0 / per_second
        self._clock, self._sleep = clock, sleep
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = self._clock()
            at = max(now, self._next)
            self._next = at + self.interval
        if at > now:
            self._sleep(at - now)


class BerkeleytimeClient:
    """Persisted-operation POSTs with a shared rate limit and a few retries."""

    def __init__(self, per_second: float = 3.0, timeout: float = 30.0, attempts: int = 4,
                 session_factory: Callable[[], requests.Session] = requests.Session) -> None:
        self.limiter = RateLimiter(per_second)
        self.timeout = timeout
        self.attempts = attempts
        self._session_factory = session_factory
        self._local = threading.local()

    def _session(self) -> requests.Session:
        s = getattr(self._local, "session", None)
        if s is None:
            s = self._local.session = self._session_factory()
            s.headers.update({"User-Agent": USER_AGENT, "Content-Type": "application/json",
                              "Accept": "application/json"})
        return s

    def query(self, document: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"id": bt.persisted_id(document)}
        if variables is not None:
            body["variables"] = variables
        delay = 2.0
        for attempt in range(self.attempts):
            self.limiter.wait()
            try:
                r = self._session().post(bt.API_URL, json=body, timeout=self.timeout)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise SourceError(f"berkeleytime: HTTP {r.status_code}", status=r.status_code)
                try:
                    payload = r.json()
                except ValueError:
                    raise SourceError(f"berkeleytime: HTTP {r.status_code}, non-JSON body",
                                      status=r.status_code) from None
                if r.status_code != 200:
                    # 400 = unknown persisted id (the site changed its queries): retrying won't help.
                    err = payload.get("error") if isinstance(payload, dict) else payload
                    raise SourceError(f"berkeleytime: HTTP {r.status_code}: {err}", status=400)
                return payload
            except (requests.RequestException, SourceError) as e:
                fatal = isinstance(e, SourceError) and e.status == 400
                if fatal or attempt == self.attempts - 1:
                    if isinstance(e, SourceError):
                        raise
                    raise SourceError(f"berkeleytime unavailable: {e}") from e
                time.sleep(delay)
                delay = min(delay * 2, 30)
        raise SourceError("berkeleytime unavailable")  # pragma: no cover

    def class_identities(self, term: str) -> list[dict[str, str]]:
        year, sem = bt.parse_term(term)
        data = bt._data(self.query(GET_CATALOG_CLASS_IDENTITIES, {"year": year, "semester": sem}))
        return data.get("catalogClassIdentities") or []

    def class_pair(self, term: str, ident: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
        """(GetClassDetails, GetClassSections) for one class of a term."""
        year, sem = bt.parse_term(term)
        variables = {"year": year, "semester": sem, "sessionId": ident.get("sessionId") or "1",
                     "subject": ident["subject"], "courseNumber": ident["courseNumber"],
                     "number": ident["number"]}
        return self.query(bt.GET_CLASS_DETAILS, variables), self.query(bt.GET_CLASS_SECTIONS, variables)


GET_TERMS = """
  query GetTerms {
    terms(withCatalogData: true) {
      year
      semester
      temporalPosition
      hasCatalogData
      sessions {
        id
        name
        startDate
        endDate
        temporalPosition
      }
      startDate
      endDate
    }
  }
"""


def upcoming_terms(client: "BerkeleytimeClient") -> list[str]:
    """Current and future terms that have catalog data, oldest first."""
    order = {"Spring": 0, "Summer": 1, "Fall": 2}
    found = set()
    for t in bt._data(client.query(GET_TERMS)).get("terms") or []:
        if t.get("hasCatalogData") and t.get("temporalPosition") in ("Current", "Future"):
            found.add((t["year"], t["semester"]))
    return [f"{y} {s}" for y, s in sorted(found, key=lambda t: (t[0], order.get(t[1], 9)))]


# --------------------------------------------------------------------------- #
# Whole-term import
# --------------------------------------------------------------------------- #

def course_level(course_number: str) -> int:
    m = re.search(r"\d+", course_number or "")
    return int(m.group()) if m else 999


def _cache_file(cache: Path, term: str, ident: dict[str, str]) -> Path:
    key = "_".join([ident["subject"], ident["courseNumber"], ident["number"], ident.get("sessionId") or "1"])
    safe = re.sub(r"[^A-Za-z0-9_.-]", "-", key) + "-" + hashlib.sha1(key.encode()).hexdigest()[:6]
    return cache / term_slug(term) / f"{safe}.json.gz"


def build_term(term: str, pairs: list[tuple[dict[str, Any], dict[str, Any] | None]],
               *, generated_at: str | None = None) -> dict[str, Any]:
    """The contents of ``data/schedule/<term>.json`` from raw response pairs (pure)."""
    courses: dict[str, list[dict[str, Any]]] = {}
    skipped = 0
    for details, sections in pairs:
        try:
            built = class_from_berkeleytime(details, sections)
        except SourceError:
            built = None
        if built is None:
            skipped += 1
            continue
        course, cls = built
        cls.pop("url", None)   # derivable; keeps the file small
        courses.setdefault(course, []).append(cls)
    return {
        "term": canonical_term(term),
        "generatedAt": generated_at or utcnow_iso(),
        "source": "berkeleytime",
        "classCount": sum(len(v) for v in courses.values()),
        "skipped": skipped,
        "courses": {k: sort_classes(courses[k]) for k in sorted(courses)},
    }


def import_term(term: str, out_dir: Path, *, cache: Path | None = None, level: str = "undergrad",
                subjects: set[str] | None = None, per_second: float = 3.0, workers: int = 4,
                client: BerkeleytimeClient | None = None,
                progress: Callable[[str], None] = lambda _msg: None) -> Path | None:
    """Download every class of ``term`` and write ``<out_dir>/<yyyy>-<season>.json``.

    Raw responses are cached under ``cache`` so an interrupted run resumes.
    Returns None (and writes nothing) when the term has no classes yet.
    """
    client = client or BerkeleytimeClient(per_second=per_second)
    idents = []
    for x in client.class_identities(term):
        n = course_level(x["courseNumber"])
        if (level == "undergrad" and n >= 200) or (level == "grad" and n < 200):
            continue
        if subjects and x["subject"].upper() not in subjects:
            continue
        idents.append(x)
    if not idents:
        progress(f"{term}: no classes published yet")
        return None
    progress(f"{term}: {len(idents)} classes")

    def one(ident: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any]]:
        path = _cache_file(cache, term, ident) if cache else None
        if path and path.exists():
            with gzip.open(path, "rt") as f:
                d = json.load(f)
            return d["details"], d["sections"]
        details, sections = client.class_pair(term, ident)
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            with gzip.open(tmp, "wt") as f:
                json.dump({"details": details, "sections": sections}, f)
            tmp.replace(path)
        return details, sections

    pairs: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    failed = 0
    with ThreadPoolExecutor(workers) as pool:
        futures = {pool.submit(one, ident): ident for ident in idents}
        for n, fut in enumerate(as_completed(futures), 1):
            try:
                pairs.append(fut.result())
            except SourceError as e:
                failed += 1
                progress(f"  failed {futures[fut]}: {e}")
            if n % 250 == 0:
                progress(f"  {term}: {n}/{len(idents)}")
    if failed > max(5, len(idents) // 50):
        raise SourceError(f"schedule import: {failed} of {len(idents)} classes failed; not writing {term}")

    data = build_term(term, pairs)
    data["failed"] = failed
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{term_slug(term)}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)
    write_index(out_dir)
    progress(f"{term}: wrote {path} ({data['classCount']} classes, {len(data['courses'])} courses, {failed} failed)")
    return path


def write_index(out_dir: Path) -> None:
    """``index.json``: which terms have a timetable file (the planner reads this first)."""
    terms = []
    for p in sorted(out_dir.glob("*-*.json")):
        try:
            head = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            continue
        terms.append({"term": head["term"], "file": p.name, "generatedAt": head.get("generatedAt"),
                      "courses": len(head.get("courses") or {}), "classes": head.get("classCount")})
    (out_dir / "index.json").write_text(json.dumps({"terms": terms}, indent=1) + "\n", encoding="utf-8")
