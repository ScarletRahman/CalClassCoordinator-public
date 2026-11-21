"""Fallback seat source: berkeleytime.com's GraphQL API.

berkeleytime only accepts *persisted* operations: the POST body is
``{"id": <sha256>, "variables": {...}}`` where the id is the SHA-256 of the
operation text after removing ``__typename`` fields, ``graphql.print`` and
``graphql.stripIgnoredCharacters``. The query texts below are copied verbatim
from the site's JS bundle; ``persisted_id()`` reproduces the hashing in pure
Python. See docs/berkeleytime-api.md for details.

Data freshness: berkeleytime snapshots enrollment from the SIS every ~15
minutes (``granularitySeconds: 900``), so this source lags
classes.berkeley.edu by up to ~15 min. Use it as a fallback, not primary.
"""
from __future__ import annotations

import hashlib
import re
import time
from typing import Any

import requests

from watcher.models import ReservedSeat, Section
from watcher.sources.base import SourceError, Target

API_URL = "https://berkeleytime.com/api/graphql"
SITE_URL = "https://berkeleytime.com"
USER_AGENT = "CalClassCoordinator seat watcher"

# --------------------------------------------------------------------------
# Operations (verbatim from https://berkeleytime.com/assets/index-*.js)
# --------------------------------------------------------------------------

GET_COURSE_WITH_INSTRUCTOR = """
  query GetCourseWithInstructor(
    $subject: String!
    $number: CourseNumber!
    $includeFormerNames: Boolean = false
  ) {
    course(subject: $subject, number: $number) {
      classes(includeFormerNames: $includeFormerNames) {
        year
        semester
        number
        subject
        courseNumber
        sessionId
        anyPrintInScheduleOfClasses
        term {
          temporalPosition
        }
        primarySection {
          enrollment {
            latest {
              enrolledCount
            }
          }
          startDate
          meetings {
            instructors {
              familyName
              givenName
            }
          }
          number
        }
        gradeDistribution {
          average
        }
      }
    }
  }
"""

GET_CLASS_DETAILS = """
  query GetClassDetails(
    $year: Int!
    $semester: Semester!
    $sessionId: SessionIdentifier!
    $subject: String!
    $courseNumber: CourseNumber!
    $number: ClassNumber!
  ) {
    class(
      year: $year
      semester: $semester
      sessionId: $sessionId
      subject: $subject
      courseNumber: $courseNumber
      number: $number
    ) {
      year
      semester
      subject
      sessionId
      courseNumber
      courseId
      number
      unitsMax
      unitsMin
      finalExam
      decal {
        title
      }
      course {
        title
        description
        requirements
        aggregatedRatings(metricNames: [Attendance, Recording]) {
          metrics {
            metricName
            count
            weightedAverage
            categories {
              value
              count
            }
          }
        }
        gradeDistribution {
          average
          pnpPercentage
        }
      }
      primarySection {
        sectionId
        component
        sectionAttributes(attributeCode: "NOTE") {
          attribute {
            code
            formalDescription
          }
          value {
            description
            formalDescription
          }
        }
        exams {
          date
          startTime
          endTime
          location
          type
        }
        enrollment {
          latest {
            endTime
            enrolledCount
            maxEnroll
            waitlistedCount
            maxWaitlist
            activeReservedMaxCount
            seatReservationCount {
              enrolledCount
              maxEnroll
              requirementGroup {
                description
              }
              isValid
            }
          }
        }
        meetings {
          days
          location
          endTime
          startTime
          instructors {
            familyName
            givenName
          }
        }
      }
      decal {
        syllabus
        description
        syllabusUrl
        applicationUrl
        applicationDueDate
        instructors {
          name
          email
        }
      }
    }
  }
"""

GET_CLASS_SECTIONS = """
  query GetClassSections(
    $year: Int!
    $semester: Semester!
    $sessionId: SessionIdentifier!
    $subject: String!
    $courseNumber: CourseNumber!
    $number: ClassNumber!
  ) {
    class(
      year: $year
      semester: $semester
      sessionId: $sessionId
      subject: $subject
      courseNumber: $courseNumber
      number: $number
    ) {
      sections {
        sectionId
        number
        component
        meetings {
          days
          location
          endTime
          startTime
          instructors {
            familyName
            givenName
          }
        }
        enrollment {
          latest {
            enrolledCount
            maxEnroll
            waitlistedCount
            maxWaitlist
          }
        }
      }
    }
  }
"""

# Full enrollment time series for one section (~1 MB for a big class).
# Not used by the watcher's polling loop; exposed for the ML/history thread.
GET_ENROLLMENT = """
  query GetEnrollment(
    $year: Int!
    $semester: Semester!
    $sessionId: SessionIdentifier
    $subject: String!
    $courseNumber: CourseNumber!
    $sectionNumber: SectionNumber!
  ) {
    enrollment(
      year: $year
      semester: $semester
      sessionId: $sessionId
      subject: $subject
      courseNumber: $courseNumber
      sectionNumber: $sectionNumber
    ) {
      year
      semester
      sessionId
      sectionId
      subject
      courseNumber
      sectionNumber
      history {
        startTime
        endTime
        granularitySeconds
        status
        enrolledCount
        waitlistedCount
        reservedCount
        minEnroll
        maxEnroll
        maxWaitlist
        openReserved
        activeReservedMaxCount
        seatReservationCount {
          maxEnroll
          enrolledCount
          requirementGroup {
            description
          }
          isValid
        }
      }
    }
  }
"""

GET_ENROLLMENT_TIMEFRAMES = """
  query GetEnrollmentTimeframes($year: Int!, $semester: Semester!) {
    enrollmentTimeframes(year: $year, semester: $semester) {
      phase
      isAdjustment
      group
      startDate
      endDate
      startEventSummary
    }
  }
"""

# --------------------------------------------------------------------------
# Persisted-query id (pure-Python port of print + stripIgnoredCharacters)
# --------------------------------------------------------------------------

_TOKEN_RE = re.compile(
    r'"""(?:\\"""|[^"]|"(?!""))*"""'          # block string
    r'|"(?:\\.|[^"\\\n])*"'                   # string
    r"|\.\.\."                                # spread
    r"|[!$&()\:=@\[\]{|}]"                    # punctuators
    r"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?"      # numbers
    r"|[_A-Za-z][_0-9A-Za-z]*"                # names
)
_IGNORED_RE = re.compile(r"(?:[\s,﻿]|#[^\n\r]*)+")
_PUNCT = set("!$&():=@[]{|}") | {"..."}


def canonicalize(query: str) -> str:
    """Equivalent of stripIgnoredCharacters(print(dropTypename(parse(q)))).

    Exact for the operations used here (no block strings, no anonymous
    shorthand queries). ``__typename`` selections are dropped, matching
    the site's client which removes the fields Apollo adds.
    """
    tokens: list[str] = []
    pos = 0
    while pos < len(query):
        m = _IGNORED_RE.match(query, pos)
        if m:
            pos = m.end()
            continue
        m = _TOKEN_RE.match(query, pos)
        if not m:
            raise ValueError(f"unexpected character {query[pos]!r} at {pos}")
        tokens.append(m.group(0))
        pos = m.end()
    tokens = [t for t in tokens if t != "__typename"]
    out = []
    prev_non_punct = False
    for t in tokens:
        non_punct = t not in _PUNCT
        if prev_non_punct and (non_punct or t == "..."):
            out.append(" ")
        out.append(t)
        prev_non_punct = non_punct
    return "".join(out)


def persisted_id(query: str) -> str:
    return hashlib.sha256(canonicalize(query).encode()).hexdigest()


# --------------------------------------------------------------------------
# Pure parsing helpers (offline-testable)
# --------------------------------------------------------------------------

_SEMESTERS = {"spring": "Spring", "summer": "Summer", "fall": "Fall"}
_SEM_ORDER = {"Spring": 0, "Summer": 1, "Fall": 2}


def parse_term(term: str) -> tuple[int, str]:
    """"2027 Spring" / "Spring 2027" / "2027-spring" -> (2027, "Spring")."""
    parts = re.split(r"[\s/_-]+", term.strip())
    year = next((int(p) for p in parts if p.isdigit() and len(p) == 4), None)
    sem = next((_SEMESTERS[p.lower()] for p in parts if p.lower() in _SEMESTERS), None)
    if year is None or sem is None:
        raise SourceError(f"berkeleytime: cannot parse term {term!r}")
    return year, sem


def parse_course(course: str) -> tuple[str, str]:
    """"COMPSCI 61A" -> ("COMPSCI", "61A"); multiword subjects keep spaces."""
    parts = course.strip().upper().split()
    if len(parts) < 2:
        raise SourceError(f"berkeleytime: cannot parse course {course!r}")
    return " ".join(parts[:-1]), parts[-1]


def _data(resp: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(resp, dict):
        raise SourceError("berkeleytime: response is not a JSON object")
    if resp.get("errors"):
        msg = "; ".join(str(e.get("message", e)) for e in resp["errors"])
        raise SourceError(f"berkeleytime: GraphQL error: {msg}")
    if "error" in resp:
        raise SourceError(f"berkeleytime: {resp['error']}")
    data = resp.get("data")
    if not isinstance(data, dict):
        raise SourceError("berkeleytime: response has no data")
    return data


def _instructors(meetings: list[dict[str, Any]] | None) -> str:
    names: list[str] = []
    for m in meetings or []:
        for i in m.get("instructors") or []:
            name = " ".join(p for p in (i.get("givenName"), i.get("familyName")) if p)
            if name and name not in names:
                names.append(name)
    return ", ".join(names)


def _status(open_total: int | None, waitlisted: int | None, wl_cap: int | None) -> str:
    if open_total is None:
        return ""
    if open_total > 0:
        return "open"
    if wl_cap and (waitlisted or 0) < wl_cap:
        return "waitlist"
    return "closed"


def _class_url(year: int, semester: str, subject: str, course_number: str, number: str) -> str:
    return f"{SITE_URL}/catalog/{year}/{semester}/{subject}/{course_number}/{number}"


def _build_section(
    *,
    course: str,
    term: str,
    title: str,
    url: str,
    sec: dict[str, Any],
    component: str,
    number: str,
    include_reserved: bool,
) -> Section:
    latest = ((sec.get("enrollment") or {}).get("latest")) or {}
    enrolled = latest.get("enrolledCount")
    capacity = latest.get("maxEnroll")
    waitlisted = latest.get("waitlistedCount")
    wl_cap = latest.get("maxWaitlist")

    reserved: list[ReservedSeat] = []
    if include_reserved:
        for r in latest.get("seatReservationCount") or []:
            # isValid=false groups are expired reservations (seats released).
            if not r.get("isValid"):
                continue
            reserved.append(
                ReservedSeat(
                    group=((r.get("requirementGroup") or {}).get("description") or "").strip(),
                    enrolled=r.get("enrolledCount"),
                    capacity=r.get("maxEnroll"),
                )
            )

    open_total = None
    unreserved_open = None
    if enrolled is not None and capacity is not None:
        open_total = max(capacity - enrolled, 0)
        unreserved_open = max(open_total - sum(r.open or 0 for r in reserved), 0)

    return Section(
        course=course,
        classNumber=str(sec.get("sectionId") or ""),
        section=f"{number} {component}".strip(),
        term=term,
        title=title,
        instructor=_instructors(sec.get("meetings")),
        enrolled=enrolled,
        capacity=capacity,
        waitlisted=waitlisted,
        waitlistCapacity=wl_cap,
        open=unreserved_open,
        reserved=reserved,
        status=_status(open_total, waitlisted, wl_cap),
        url=url,
        source="berkeleytime",
    )


def parse_class_response(
    details: dict[str, Any],
    sections: dict[str, Any] | None = None,
    *,
    include_reserved: bool = True,
) -> list[Section]:
    """Turn a GetClassDetails response (+ optional GetClassSections response)
    into Sections: the primary section first, then secondaries (DIS/LAB/...).

    Secondary sections never carry reserved-seat data on berkeleytime.
    """
    cls = _data(details).get("class")
    if not cls:
        raise SourceError("berkeleytime: class not found")
    year, semester = cls["year"], cls["semester"]
    subject, course_number, number = cls["subject"], cls["courseNumber"], cls["number"]
    course = f"{subject} {course_number}"
    term = f"{year} {semester}"
    title = ((cls.get("course") or {}).get("title")) or ""
    url = _class_url(year, semester, subject, course_number, number)

    out: list[Section] = []
    primary = cls.get("primarySection")
    if primary:
        out.append(
            _build_section(
                course=course, term=term, title=title, url=url, sec=primary,
                component=primary.get("component") or "", number=number,
                include_reserved=include_reserved,
            )
        )
    if sections is not None:
        scls = _data(sections).get("class") or {}
        for sec in scls.get("sections") or []:
            out.append(
                _build_section(
                    course=course, term=term, title=title, url=url, sec=sec,
                    component=sec.get("component") or "", number=sec.get("number") or "",
                    include_reserved=include_reserved,
                )
            )
    return out


def parse_course_classes(resp: dict[str, Any]) -> list[dict[str, Any]]:
    """GetCourseWithInstructor -> list of {year, semester, sessionId, number,
    subject, courseNumber, temporalPosition} for every class offering."""
    course = _data(resp).get("course")
    if not course:
        raise SourceError("berkeleytime: course not found")
    out = []
    for c in course.get("classes") or []:
        out.append(
            {
                "year": c["year"],
                "semester": c["semester"],
                "sessionId": c.get("sessionId") or "1",
                "number": c["number"],
                "subject": c.get("subject"),
                "courseNumber": c.get("courseNumber"),
                "temporalPosition": ((c.get("term") or {}).get("temporalPosition")) or "",
            }
        )
    return out


def pick_default_term(classes: list[dict[str, Any]]) -> tuple[int, str] | None:
    """Earliest Future term the course is offered in, else the Current one."""
    def key(c: dict[str, Any]) -> tuple[int, int]:
        return (c["year"], _SEM_ORDER.get(c["semester"], 9))

    for pos in ("Future", "Current"):
        cand = sorted((c for c in classes if c["temporalPosition"] == pos), key=key)
        if cand:
            return cand[0]["year"], cand[0]["semester"]
    return None


def _matches_section(s: Section, flt: str) -> bool:
    return " ".join(s.section.upper().split()) == " ".join(flt.upper().split())


# --------------------------------------------------------------------------
# Network source
# --------------------------------------------------------------------------


class BerkeleytimeSource:
    name = "berkeleytime"

    def __init__(
        self,
        session: requests.Session | None = None,
        timeout: float = 20.0,
        min_interval: float = 1.0,
    ) -> None:
        self.session = session or requests.Session()
        self.session.headers.update(
            {"User-Agent": USER_AGENT, "Content-Type": "application/json", "Accept": "application/json"}
        )
        self.timeout = timeout
        self.min_interval = min_interval
        self._last_request = 0.0

    # -- low level -----------------------------------------------------
    def query(self, document: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST a persisted operation and return the decoded JSON."""
        wait = self.min_interval - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        body: dict[str, Any] = {"id": persisted_id(document)}
        if variables is not None:
            body["variables"] = variables
        try:
            r = self.session.post(API_URL, json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise SourceError(f"berkeleytime unavailable: {e}") from e
        finally:
            self._last_request = time.monotonic()
        try:
            payload = r.json()
        except ValueError:
            raise SourceError(f"berkeleytime: HTTP {r.status_code}, non-JSON body",
                              status=r.status_code if r.status_code != 200 else None) from None
        if r.status_code != 200:
            err = payload.get("error") if isinstance(payload, dict) else None
            raise SourceError(f"berkeleytime: HTTP {r.status_code}: {err or payload}", status=r.status_code)
        _data(payload)  # raise on GraphQL errors
        return payload

    # -- convenience for other threads ----------------------------------
    def enrollment_history(
        self, course: str, term: str, section_number: str = "001", session_id: str = "1"
    ) -> dict[str, Any]:
        """Raw GetEnrollment response (full time series, can be ~1 MB)."""
        subject, cn = parse_course(course)
        year, sem = parse_term(term)
        return self.query(
            GET_ENROLLMENT,
            {"year": year, "semester": sem, "sessionId": session_id, "subject": subject,
             "courseNumber": cn, "sectionNumber": section_number},
        )

    def enrollment_timeframes(self, term: str) -> dict[str, Any]:
        year, sem = parse_term(term)
        return self.query(GET_ENROLLMENT_TIMEFRAMES, {"year": year, "semester": sem})

    # -- Source protocol -------------------------------------------------
    def fetch(self, target: Target) -> list[Section]:
        if not target.course:
            raise SourceError("berkeleytime: target.course is required (no lookup by class number alone)")
        subject, course_number = parse_course(target.course)

        classes = parse_course_classes(
            self.query(GET_COURSE_WITH_INSTRUCTOR, {"subject": subject, "number": course_number})
        )
        if target.term:
            year, semester = parse_term(target.term)
        else:
            picked = pick_default_term(classes)
            if picked is None:
                raise SourceError(f"berkeleytime: {target.course} has no current/future offering")
            year, semester = picked
        offerings = [c for c in classes if c["year"] == year and c["semester"] == semester]
        if not offerings:
            raise SourceError(f"berkeleytime: {target.course} not offered in {year} {semester}")

        results: list[Section] = []
        for off in offerings:
            variables = {
                "year": year, "semester": semester, "sessionId": off["sessionId"],
                "subject": subject, "courseNumber": course_number, "number": off["number"],
            }
            details = self.query(GET_CLASS_DETAILS, variables)
            primary = parse_class_response(details, include_reserved=target.include_reserved)
            if self._satisfied(primary, target):
                results.extend(self._filter(primary, target))
                if target.class_number or target.section:
                    continue
            sections = self.query(GET_CLASS_SECTIONS, variables)
            secondary = parse_class_response(details, sections, include_reserved=target.include_reserved)[len(primary):]
            results.extend(self._filter(secondary, target))

        if (target.class_number or target.section) and not results:
            raise SourceError(f"berkeleytime: no section matching {target} found")
        if not target.include_waitlist:
            for s in results:
                s.waitlisted = s.waitlistCapacity = None
        return results

    @staticmethod
    def _filter(sections: list[Section], target: Target) -> list[Section]:
        out = sections
        if target.class_number:
            out = [s for s in out if s.classNumber == str(target.class_number)]
        if target.section:
            out = [s for s in out if _matches_section(s, target.section)]
        return out

    def _satisfied(self, primary: list[Section], target: Target) -> bool:
        """True if the primary section alone answers the target (or no filter)."""
        if not target.class_number and not target.section:
            return True
        return bool(self._filter(primary, target))
