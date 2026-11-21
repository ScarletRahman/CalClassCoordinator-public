"""Live lookup of one course: its lectures, discussions/labs, times and seats.

The planner calls this (``GET /lookup`` on the watcher API) when a student adds a
class to their weekly schedule. Answer shape: docs/schedule.md.

Being polite matters more here than in the poll loop, because the number of
lookups follows the number of students:

* answers are cached per (course, term): 5 minutes for a hit, 30 for "not offered";
* concurrent requests for the same course wait for one fetch instead of each
  starting their own;
* a source that answers 403/429 is left alone for ``cooldown`` seconds;
* classes.berkeley.edu costs two slow pages per lecture, so it is only used for
  courses with at most ``max_cb_classes`` lectures; bigger ones go to Berkeleytime.
"""
from __future__ import annotations

import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from watcher import schedule
from watcher.models import utcnow_iso
from watcher.sources import berkeleytime as bt
from watcher.sources.base import SourceError

log = logging.getLogger("watcher.lookup")

COURSE_RE = re.compile(r"^[A-Z][A-Z0-9&,/ -]{0,24} [A-Z]{0,3}\d{1,3}[A-Z]{0,4}$")
KNOWN_SOURCES = ("classes.berkeley.edu", "berkeleytime")


class NotOffered(SourceError):
    """The source answered, and the course has no classes in that term."""


def clean_course(course: str) -> str:
    """'compsci  61a' -> 'COMPSCI 61A'; raises ValueError for anything that isn't a course id."""
    text = re.sub(r"\s+", " ", course or "").strip().upper()
    if not COURSE_RE.fullmatch(text):
        raise ValueError("course must look like 'COMPSCI 61A'")
    return text


def clean_term(term: str) -> str:
    try:
        return schedule.canonical_term(term)
    except SourceError:
        raise ValueError("term must look like '2027 Spring'") from None


# --------------------------------------------------------------------------- #
# Sources
# --------------------------------------------------------------------------- #

def lookup_berkeleytime(client: schedule.BerkeleytimeClient, course: str, term: str,
                        *, workers: int = 4, max_classes: int = 60) -> list[dict[str, Any]]:
    subject, number = bt.parse_course(course)
    year, sem = bt.parse_term(term)
    try:
        resp = client.query(bt.GET_COURSE_WITH_INSTRUCTOR, {"subject": subject, "number": number})
        offerings = bt.parse_course_classes(resp)
    except SourceError as e:
        if "course not found" in str(e):
            raise NotOffered(f"berkeleytime: {course} is not a course it knows") from None
        raise
    # Classes the official schedule does not print (empty shells) are not offered to students.
    hidden = {(c.get("year"), c.get("semester"), c.get("number"), c.get("sessionId") or "1")
              for c in (bt._data(resp).get("course") or {}).get("classes") or []
              if c.get("anyPrintInScheduleOfClasses") is False}
    mine = [o for o in offerings if o["year"] == year and o["semester"] == sem
            and (o["year"], o["semester"], o["number"], o["sessionId"]) not in hidden][:max_classes]
    if not mine:
        raise NotOffered(f"berkeleytime: {course} has no classes in {term}")

    def one(off: dict[str, Any]) -> dict[str, Any] | None:
        ident = {"subject": subject, "courseNumber": number, "number": off["number"],
                 "sessionId": off["sessionId"]}
        built = schedule.class_from_berkeleytime(*client.class_pair(term, ident))
        return built[1] if built else None

    with ThreadPoolExecutor(min(workers, len(mine))) as pool:
        classes = [c for c in pool.map(one, mine) if c]
    if not classes:
        raise NotOffered(f"berkeleytime: {course} has no scheduled classes in {term}")
    return schedule.sort_classes(classes)


def lookup_classes_berkeley(src: Any, course: str, term: str, *, max_classes: int = 3) -> list[dict[str, Any]]:
    """``src`` is a ``ClassesBerkeleySource``. Two page loads per lecture."""
    from watcher.sources import classes_berkeley as cb

    term_name, term_id = src.resolve_term(term, course)
    primaries = [p for p in src.search_course(course, term_id) if not p.term or p.term == term_name]
    if not primaries:
        raise NotOffered(f"classes.berkeley.edu: {course} has no classes in {term_name}")
    if len(primaries) > max_classes:
        raise SourceError(f"classes.berkeley.edu: {course} has {len(primaries)} lectures; "
                          "too many page loads for one lookup")
    classes = []
    for p in primaries:
        html = src._get(p.url)
        detail = cb.parse_detail_page(html, p.url)
        detail.instructor = detail.instructor or p.instructor
        node_id = cb.detail_node_id(html) or p.node_id
        secondary_html = src._get(f"/sections/associated/{node_id}") if node_id else ""
        times = cb.parse_associated_meetings(secondary_html) if secondary_html else {}
        secondary = cb.parse_associated_sections(secondary_html, term=term_name, title=detail.title,
                                                 base_url=src.base_url) if secondary_html else []
        classes.append({
            "number": detail.section.split(" ")[0],
            "title": detail.title,
            "url": p.url,
            "primary": schedule.section_dict(detail, meetings=cb.parse_detail_meetings(html)),
            "sections": [schedule.section_dict(s, meetings=times.get(s.classNumber, [])) for s in secondary],
        })
    return schedule.sort_classes(classes)


# --------------------------------------------------------------------------- #
# Service
# --------------------------------------------------------------------------- #

class LookupService:
    def __init__(self, sources: list[str] | None = None, *, ttl: float = 300.0, miss_ttl: float = 1800.0,
                 error_ttl: float = 60.0, cooldown: float = 6 * 3600.0, max_entries: int = 3000, max_cb_classes: int = 3,
                 fetchers: dict[str, Callable[[str, str], list[dict[str, Any]]]] | None = None,
                 clock: Callable[[], float] = time.monotonic) -> None:
        names = [s for s in (sources or list(KNOWN_SOURCES)) if s in KNOWN_SOURCES]
        self.sources = names or ["berkeleytime"]
        self.ttl, self.miss_ttl, self.cooldown = ttl, miss_ttl, cooldown
        self.error_ttl = error_ttl
        self._errors: dict[tuple[str, str], tuple[float, str]] = {}
        self.max_entries = max_entries
        self.max_cb_classes = max_cb_classes
        self._clock = clock
        self._fetchers = fetchers
        self._cache: dict[tuple[str, str], tuple[float, dict[str, Any] | None]] = {}
        self._paused_until: dict[str, float] = {}
        self._lock = threading.Lock()
        self._inflight: dict[tuple[str, str], threading.Lock] = {}
        self._cb_lock = threading.Lock()   # the classes.berkeley.edu client is not thread-safe
        self._cb: Any = None
        self._bt: schedule.BerkeleytimeClient | None = None

    # -- sources ------------------------------------------------------------ #

    def _fetch(self, source: str, course: str, term: str) -> list[dict[str, Any]]:
        if self._fetchers is not None:
            return self._fetchers[source](course, term)
        if source == "berkeleytime":
            if self._bt is None:
                self._bt = schedule.BerkeleytimeClient(per_second=5.0, timeout=15.0, attempts=2)
            return lookup_berkeleytime(self._bt, course, term)
        with self._cb_lock:
            if self._cb is None:
                from watcher.sources.classes_berkeley import ClassesBerkeleySource
                self._cb = ClassesBerkeleySource(min_interval=1.0)
            return lookup_classes_berkeley(self._cb, course, term, max_classes=self.max_cb_classes)

    def _fresh(self, course: str, term: str) -> dict[str, Any] | None:
        """Ask the sources in order. None = not offered. Raises SourceError when none answers."""
        errors: list[str] = []
        not_offered = False
        for source in self.sources:
            if self._clock() < self._paused_until.get(source, 0.0):
                errors.append(f"{source}: paused after it refused requests")
                continue
            try:
                classes = self._fetch(source, course, term)
            except NotOffered:
                not_offered = True
                continue   # another source may know a class this one doesn't list
            except SourceError as e:
                if e.status in (403, 429):
                    self._paused_until[source] = self._clock() + self.cooldown
                    log.warning("lookup: %s answered %s; not asking it for %.0f min",
                                source, e.status, self.cooldown / 60)
                errors.append(str(e))
                continue
            return {"course": course, "term": term, "source": source,
                    "fetchedAt": utcnow_iso(), "classes": classes}
        if not_offered:
            return None
        raise SourceError("; ".join(errors) or "no lookup source configured")

    # -- public ------------------------------------------------------------- #

    def lookup(self, course: str, term: str) -> dict[str, Any] | None:
        """Sections, times and seats of ``course`` in ``term`` (None = not offered).

        Raises ValueError for a malformed course/term and SourceError when no
        source could answer.
        """
        key = (clean_course(course), clean_term(term))
        hit = self._cached(key)
        if hit is not None:
            return hit[0]
        with self._lock:
            gate = self._inflight.setdefault(key, threading.Lock())
        with gate:
            hit = self._cached(key)   # someone else fetched it while we waited
            if hit is not None:
                return hit[0]
            failed = self._errors.get(key)
            if failed and self._clock() - failed[0] < self.error_ttl:
                raise SourceError(failed[1])   # don't retry a failing source on every click
            try:
                result = self._fresh(*key)
                self._errors.pop(key, None)
            except SourceError as e:
                if len(self._errors) >= self.max_entries:
                    self._errors.clear()
                self._errors[key] = (self._clock(), str(e))
                raise
            finally:
                with self._lock:
                    self._inflight.pop(key, None)
            with self._lock:
                if len(self._cache) >= self.max_entries:
                    for old in sorted(self._cache, key=lambda k: self._cache[k][0])[: self.max_entries // 10]:
                        del self._cache[old]
                self._cache[key] = (self._clock(), result)
            return dict(result, cached=False) if result else None

    def _cached(self, key: tuple[str, str]) -> tuple[dict[str, Any] | None] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        at, result = entry
        if self._clock() - at > (self.ttl if result else self.miss_ttl):
            return None
        return (dict(result, cached=True) if result else None,)
