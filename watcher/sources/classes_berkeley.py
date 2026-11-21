"""Seat source that scrapes https://classes.berkeley.edu (the official class schedule).

The site is server-rendered Drupal. What each page type gives us:

* Search page ``/search/class?search=<q>&f[0]=term:<termId>`` (18 cards per page,
  ``&page=N`` paginates): one ``article.st`` card per *primary* section (usually
  the lecture) with course, section, class #, title, instructors, detail link and
  "N Unreserved Seats". The sidebar "term" facet maps Drupal term ids to term
  names ("Spring 2027" -> 8589). No enrolled/capacity/waitlist numbers.
* Detail page ``/content/<year>-<season>-<subject>-<num>-<sec>-<type>-<sec>``:
  everything. ``drupalSettings.ucb.enrollment.available`` is the SIS enrollment
  JSON (status, enrolledCount, maxEnroll, waitlistedCount, maxWaitlist,
  openReserved, seatReservations[]) and the "Current Enrollment" HTML block shows
  the same numbers plus "N unreserved seats" / "N reserved for <group>" lines.
* Associated sections fragment ``/sections/associated/<nodeId>`` (what the detail
  page loads via XHR): discussion/lab sections of a primary with class #,
  enrolled, limit, waitlisted, waitlist limit (no reserved-seat breakdown).

Parsing functions are pure (HTML in, data out) so they are tested offline against
``tests/fixtures/cb_*.html``; ``ClassesBerkeleySource`` does the networking.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Callable, Iterable
from urllib.parse import quote, urljoin

import requests
from bs4 import BeautifulSoup, Tag

from watcher.models import ReservedSeat, Section, utcnow_iso
from watcher.sources.base import SourceError, Target

BASE_URL = "https://classes.berkeley.edu"
SOURCE_NAME = "classes.berkeley.edu"
USER_AGENT = "CalClassCoordinator seat watcher"

SEASONS = {"spring": 0, "summer": 1, "fall": 2}
_SIS_SEASON_DIGIT = {"spring": "2", "summer": "5", "fall": "8"}
_SIS_DIGIT_SEASON = {v: k for k, v in _SIS_SEASON_DIGIT.items()}


# --------------------------------------------------------------------------- #
# Small normalizers
# --------------------------------------------------------------------------- #

def _clean(text: str | None) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _int(text: Any) -> int | None:
    if text is None:
        return None
    if isinstance(text, int):
        return text
    m = re.search(r"-?\d[\d,]*", str(text))
    return int(m.group(0).replace(",", "")) if m else None


def normalize_course(course: str) -> str:
    """'compsci  61a' -> 'COMPSCI 61A'; 'L & S C30T' keeps its inner spaces."""
    return _clean(course).upper()


def normalize_term(label: str) -> str | None:
    """Turn any term label the site uses into the canonical "2027 Spring".

    Handles "Spring 2027", "2026 Fall", "Summer Sessions 2026",
    "2025 Summer Session C 8 weeks, June 23 - ...", "fall 2026" and SIS term
    codes such as "2272". Returns None for labels that aren't a term
    (e.g. summer sub-session facets "C: June 22-Aug 14").
    """
    text = _clean(label).lower()
    if re.fullmatch(r"2\d{3}", text):  # SIS code: 2 + yy + season digit
        season = _SIS_DIGIT_SEASON.get(text[3])
        if season:
            return f"20{text[1:3]} {season.capitalize()}"
        return None
    season = next((s for s in SEASONS if re.search(rf"\b{s}\b", text)), None)
    year = re.search(r"\b(19|20)\d{2}\b", text)
    if not season or not year:
        return None
    return f"{year.group(0)} {season.capitalize()}"


def term_sort_key(term: str) -> tuple[int, int]:
    """Chronological sort key for a canonical term name ("2027 Spring")."""
    year, season = term.split()
    return int(year), SEASONS[season.lower()]


def sis_term_code(term: str) -> str:
    """'2027 Spring' -> '2272' (the code classes.berkeley.edu puts in data-term)."""
    year, season = term.split()
    return f"2{year[2:]}{_SIS_SEASON_DIGIT[season.lower()]}"


def normalize_section(section: str) -> str:
    """'001 lec' / 'LEC 001' / '001-LEC' -> '001 LEC'. A bare '001' stays '001'."""
    tokens = [t for t in re.split(r"[\s\-]+", section.upper()) if t]
    if len(tokens) == 2 and re.fullmatch(r"[A-Z]{3}", tokens[0]) and re.search(r"\d", tokens[1]):
        tokens.reverse()
    return " ".join(tokens)


def section_matches(wanted: str, actual: str) -> bool:
    """Does the user's section filter match a section like '001 LEC'?

    '001 LEC' matches exactly; a bare number ('001', '101L') matches any type.
    """
    if not wanted:
        return True
    w, a = normalize_section(wanted), normalize_section(actual)
    if w == a:
        return True
    return " " not in w and a.split(" ")[0] == w


# --------------------------------------------------------------------------- #
# Search page
# --------------------------------------------------------------------------- #

@dataclass
class SearchResult:
    """One card from the search page (a primary section; partial data)."""

    course: str
    section: str          # "001 LEC"
    classNumber: str
    term: str             # canonical "2027 Spring"
    title: str
    instructor: str
    url: str              # absolute detail-page URL
    node_id: str          # Drupal node id, used for /sections/associated/<id>
    open: int | None      # unreserved open seats as shown on the card
    has_open_seats: bool | None  # "Open Seats" vs "No Open Seats"

    def to_section(self) -> Section:
        if self.has_open_seats is None:
            status = ""
        else:
            status = "open" if self.has_open_seats else "closed"
        return Section(
            course=self.course, classNumber=self.classNumber, section=self.section,
            term=self.term, title=self.title, instructor=self.instructor,
            open=self.open, status=status, url=self.url, source=SOURCE_NAME,
        )


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


def _is_search_page(soup: BeautifulSoup) -> bool:
    return soup.select_one(".view-id-sections") is not None or bool(soup.select("article.st"))


def parse_search_page(html: str, base_url: str = BASE_URL) -> list[SearchResult]:
    """Parse every class card on a search results page.

    Returns [] for a genuine "no results" page; raises SourceError if the page
    doesn't look like a classes.berkeley.edu search page or a card can't be read.
    """
    soup = _soup(html)
    if not _is_search_page(soup):
        raise SourceError("classes.berkeley.edu: unrecognized search page (no sections view)")
    results = []
    for card in soup.select("article.st"):
        link = card.select_one(".st--section-name-wraper a[href], .st--section-name-wrapper a[href]")
        name = card.select_one(".st--section-name")
        if link is None or name is None:
            raise SourceError("classes.berkeley.edu: search card without course name/link")
        counts = [_clean(c.get_text()) for c in card.select(".st--section-count")]
        code = _clean(card.select_one(".st--section-code").get_text()) if card.select_one(".st--section-code") else ""
        section = _clean(f"{counts[0] if counts else ''} {code}")

        class_number = ""
        for num in card.select(".st--section-number"):
            n = _int(num.get_text())
            if n is not None:
                class_number = str(n)
                break

        term_el = card.select_one(".st--term-year")
        term = normalize_term(term_el.get_text(" ")) if term_el else None
        if not term:  # fall back to the URL slug: /content/2027-spring-...
            m = re.search(r"/content/(\d{4})-(spring|summer|fall)-", link["href"])
            term = f"{m.group(1)} {m.group(2).capitalize()}" if m else ""

        title_el = card.select_one(".st--title h2, .st--title")
        instr_el = card.select_one(".st--instructors")

        seats_el = card.select_one(".st--seats")
        open_seats: int | None = None
        has_open: bool | None = None
        if seats_el is not None:
            txt = _clean(seats_el.get_text(" ")).lower()
            if "no open seats" in txt:
                has_open, open_seats = False, 0
            elif "open seats" in txt:
                has_open = True
                m = re.search(r"(\d[\d,]*)\s+unreserved", txt)
                # "Open Seats" with no number: only reserved seats are open.
                open_seats = int(m.group(1).replace(",", "")) if m else 0

        results.append(SearchResult(
            course=normalize_course(name.get_text()),
            section=section,
            classNumber=class_number,
            term=term,
            title=_clean(title_el.get_text(" ")) if title_el else "",
            instructor=_clean(instr_el.get_text(" ")) if instr_el else "",
            url=urljoin(base_url, link["href"]),
            node_id=card.get("data-history-node-id", ""),
            open=open_seats,
            has_open_seats=has_open,
        ))
    return results


def parse_search_total(html: str) -> int | None:
    """'Search found 64 items' -> 64 (None when the header is absent, e.g. 0 hits)."""
    header = _soup(html).select_one(".view-header")
    return _int(header.get_text()) if header else None


def has_next_page(html: str) -> bool:
    return _soup(html).select_one(".pager__item--next a[href]") is not None


def parse_term_facets(html: str) -> dict[str, str]:
    """Map canonical term name -> Drupal term facet id from the search sidebar.

    E.g. {"2027 Spring": "8589", "2026 Fall": "8588", "2026 Summer": "8580", ...}.
    Summer sub-session facets ("C: June 22-Aug 14") are skipped. Ids are not
    chronological (Fall 2016 = 7171 > Spring 2017 = 7164), so order by term name.
    """
    terms: dict[str, str] = {}
    for a in _soup(html).select('a[href*="term%3A"], a[data-drupal-facet-item-id^="term-"]'):
        term_id = a.get("data-drupal-facet-item-value")
        if not term_id:
            ids = re.findall(r"term%3A(\d+)", a["href"])
            if not ids:
                continue
            term_id = ids[-1]  # on a filtered page the new facet is appended last
        label = _clean(a.get_text(" "))
        label = re.sub(r"\(\s*\d[\d,]*\s*\)\s*$", "", label).strip()
        if ":" in label:  # summer sub-session
            continue
        name = normalize_term(label)
        if name and name not in terms:
            terms[name] = term_id
    return terms


def newest_term(terms: Iterable[str]) -> str | None:
    terms = list(terms)
    return max(terms, key=term_sort_key) if terms else None


def filter_course(results: Iterable[SearchResult], course: str) -> list[SearchResult]:
    """Keep only cards for exactly this course (search is fuzzy: 61A matches DUTCH 161AC)."""
    want = normalize_course(course)
    return [r for r in results if r.course == want]


# --------------------------------------------------------------------------- #
# Detail page
# --------------------------------------------------------------------------- #

def _drupal_settings(soup: BeautifulSoup) -> dict[str, Any]:
    el = soup.select_one('script[data-drupal-selector="drupal-settings-json"]')
    if el is None or not el.string:
        return {}
    try:
        return json.loads(el.string)
    except ValueError:
        return {}


def _enrollment_status(settings: dict[str, Any]) -> dict[str, Any] | None:
    """Return the SIS ``enrollmentStatus`` dict for the currently-applicable numbers.

    Modern pages: ucb.enrollment.available.enrollmentStatus. Old pages (≈2016-2019)
    store the raw SIS API response as a JSON *string*.
    """
    enr = (settings.get("ucb") or {}).get("enrollment")
    if isinstance(enr, str):
        try:
            enr = json.loads(enr)
        except ValueError:
            return None
        try:
            secs = enr["apiResponse"]["response"]["classSections"]
            return secs[0].get("enrollmentStatus") if secs else None
        except (KeyError, TypeError, IndexError):
            return None
    if not isinstance(enr, dict):
        return None
    for key in ("available", "history"):
        block = enr.get(key)
        if isinstance(block, dict) and isinstance(block.get("enrollmentStatus"), dict):
            return block["enrollmentStatus"]
    return None


def reserved_from_json(reservations: list[dict[str, Any]], today: date | None = None) -> list[ReservedSeat]:
    """Collapse SIS seatReservations into one ReservedSeat per reservation number.

    SIS lists one row per (number, fromDate); the row in force is the one with
    the latest fromDate that isn't in the future (rows dated later are future
    releases, often maxEnroll=1 meaning "reservation lifted").
    """
    today_s = (today or date.today()).isoformat()
    best: dict[Any, dict[str, Any]] = {}
    future: dict[Any, dict[str, Any]] = {}
    for r in reservations or []:
        key = r.get("number", (r.get("requirementGroup") or {}).get("code"))
        frm = r.get("fromDate") or ""
        bucket = best if frm <= today_s else future
        cur = bucket.get(key)
        if bucket is best:
            if cur is None or frm > (cur.get("fromDate") or ""):
                bucket[key] = r
        elif cur is None or frm < (cur.get("fromDate") or ""):
            bucket[key] = r
    for key, r in future.items():  # nothing in force yet: show the earliest upcoming
        best.setdefault(key, r)
    out = []
    for key in sorted(best, key=lambda k: (str(type(k)), k)):
        r = best[key]
        out.append(ReservedSeat(
            group=_clean((r.get("requirementGroup") or {}).get("description") or str(key)),
            enrolled=_int(r.get("enrolledCount")),
            capacity=_int(r.get("maxEnroll")),
        ))
    return out


def _parse_enrollment_html(section: Tag | None) -> dict[str, Any]:
    """Numbers from the 'Current Enrollment' block (fallback / unreserved count)."""
    out: dict[str, Any] = {"reserved": []}
    if section is None:
        return out
    labels = {
        "total open seats": "total_open", "enrolled": "enrolled", "waitlisted": "waitlisted",
        "capacity": "capacity", "waitlist max": "waitlistCapacity",
    }
    for strong in section.find_all("strong"):
        key = labels.get(_clean(strong.get_text()).rstrip(":").lower())
        if not key:
            continue
        # "<div><strong>Enrolled:</strong> 1269</div>" or "<strong>..:</strong> <span>131</span>"
        rest = _clean(strong.parent.get_text(" ")).replace(_clean(strong.get_text(" ")), "", 1)
        val = _int(rest)
        if val is None:
            sib = strong.find_next_sibling()
            val = _int(sib.get_text()) if sib is not None else None
        out[key] = val
    for det in section.select(".details"):
        txt = _clean(det.get_text(" "))
        m = re.match(r"(\d[\d,]*)\s+unreserved seats", txt, re.I)
        if m:
            out["unreserved"] = int(m.group(1).replace(",", ""))
            continue
        m = re.match(r"(\d[\d,]*)\s+reserved for\s+(.+)", txt, re.I)
        if m:
            out["reserved"].append((m.group(2), int(m.group(1).replace(",", ""))))
        elif "no reserved seats" in txt.lower():
            out["no_reserved"] = True
    return out


def _status(code: str, total_open: int | None, waitlisted: int | None, wl_cap: int | None) -> str:
    if total_open is None and not code:
        return ""
    if code.upper() == "W":
        return "waitlist"
    if code.upper() != "C" and (total_open is None or total_open > 0):
        return "open"
    if wl_cap and (waitlisted or 0) < wl_cap:
        return "waitlist"
    return "closed"


def parse_detail_page(html: str, url: str = "", today: date | None = None) -> Section:
    """Parse a /content/... class detail page into a full Section."""
    soup = _soup(html)
    art = soup.select_one("article.sf")
    name_el = soup.select_one(".sf--title--name")
    if art is None or name_el is None:
        raise SourceError(f"classes.berkeley.edu: unrecognized detail page {url!r}")
    settings = _drupal_settings(soup)

    counts = [_clean(c.get_text()) for c in soup.select(".sf--title .sf--title--count")]
    code_el = soup.select_one(".sf--title--code")
    section = _clean(f"{counts[0] if counts else ''} {code_el.get_text() if code_el else ''}")

    term_el = soup.select_one(".sf--title--term")
    term = normalize_term(term_el.get_text(" ")) if term_el else None
    if not term:
        td = ((settings.get("ucb") or {}).get("termDetails") or {}).get("sessionDescription", "")
        term = normalize_term(td) or ""
    if not term:
        dt = soup.select_one("[data-term]")
        term = normalize_term(dt["data-term"]) if dt else ""

    class_number = ""
    for el in soup.select(".sf--section-number"):
        if "class #" in el.get_text().lower():
            n = _int(el.get_text())
            class_number = str(n) if n is not None else ""
            break

    title_el = soup.select_one(".sf--course-title")
    instr_el = soup.select_one(".sf--instructors")

    html_nums = _parse_enrollment_html(soup.select_one("section.current-enrollment"))
    status_json = _enrollment_status(settings)

    if status_json:
        enrolled = _int(status_json.get("enrolledCount"))
        capacity = _int(status_json.get("maxEnroll"))
        waitlisted = _int(status_json.get("waitlistedCount"))
        wl_cap = _int(status_json.get("maxWaitlist"))
        open_reserved = _int(status_json.get("openReserved")) or 0
        code = ((status_json.get("status") or {}).get("code")) or ""
        reserved = reserved_from_json(status_json.get("seatReservations") or [], today)
        if not class_number and status_json.get("id"):
            class_number = str(status_json["id"])
    else:
        enrolled = html_nums.get("enrolled")
        capacity = html_nums.get("capacity")
        waitlisted = html_nums.get("waitlisted")
        wl_cap = html_nums.get("waitlistCapacity")
        open_reserved = sum(n for _, n in html_nums["reserved"])
        code = ""
        # HTML only shows open seats per group, not enrolled/capacity.
        reserved = [ReservedSeat(group=_clean(g)) for g, _ in html_nums["reserved"]]

    if enrolled is None and capacity is None and "total_open" not in html_nums:
        raise SourceError(f"classes.berkeley.edu: no enrollment numbers on {url!r}")

    if capacity is not None and enrolled is not None:
        total_open = max(capacity - enrolled, 0)
    else:
        total_open = html_nums.get("total_open")
    if "unreserved" in html_nums:
        open_unreserved = html_nums["unreserved"]
    elif total_open is not None:
        open_unreserved = max(total_open - open_reserved, 0)
    else:
        open_unreserved = None

    return Section(
        course=normalize_course(name_el.get_text()),
        classNumber=class_number,
        section=section,
        term=term,
        title=_clean(title_el.get_text(" ")) if title_el else "",
        instructor=_clean(instr_el.get_text(" ")) if instr_el else "",
        enrolled=enrolled,
        capacity=capacity,
        waitlisted=waitlisted,
        waitlistCapacity=wl_cap,
        open=open_unreserved,
        reserved=reserved,
        status=_status(code, total_open, waitlisted, wl_cap),
        url=url,
        source=SOURCE_NAME,
    )


def detail_node_id(html: str) -> str:
    art = _soup(html).select_one("article.sf[data-history-node-id]")
    return art["data-history-node-id"] if art else ""


# --------------------------------------------------------------------------- #
# Associated (secondary) sections fragment
# --------------------------------------------------------------------------- #

def parse_associated_sections(html: str, term: str = "", title: str = "",
                              base_url: str = BASE_URL) -> list[Section]:
    """Parse /sections/associated/<nodeId> (discussions/labs of a primary section).

    Gives class #, enrolled, limit, waitlist. No reserved breakdown or instructor;
    fetch the section's detail page (``url``) for those.
    """
    soup = _soup(html)
    blocks = soup.select(".detail-class-associated-sections-flex")
    if not blocks and _clean(soup.get_text()):
        # Non-empty fragment we can't read (an empty fragment means "no sections").
        if "Class #" in soup.get_text():
            raise SourceError("classes.berkeley.edu: unrecognized associated-sections fragment")
    out = []
    for blk in blocks:
        link = blk.select_one(".section-header a[href]")
        if link is None:
            raise SourceError("classes.berkeley.edu: associated section without header link")
        header = _clean(link.get_text())          # "COMPSCI 61A 101L"
        first = link.find_parent(class_="detail-class-associated-sections-section")
        lines = [_clean(d.get_text(" ")) for d in first.find_all("div", recursive=False)] if first else []
        section, class_number = "", ""
        for ln in lines:
            if ln.lower().startswith("class #"):
                class_number = str(_int(ln) or "")
            elif not section and re.fullmatch(r"\S+ [A-Z]{3}", ln):
                section = ln
        sec_num = section.split(" ")[0] if section else header.rsplit(" ", 1)[-1]
        course = header[: -len(sec_num)].strip() if header.endswith(sec_num) else header

        nums: dict[str, int | None] = {}
        for lab in blk.select(".detail-label"):
            key = _clean(lab.get_text()).rstrip(":").lower()
            nums[key] = _int(lab.next_sibling) if lab.next_sibling else None
        enrolled = nums.get("enrolled")
        capacity = nums.get("enrollment limit")
        waitlisted = nums.get("waitlisted")
        wl_cap = nums.get("waitlist limit")
        total_open = nums.get("open seats")
        if total_open is None and enrolled is not None and capacity is not None:
            total_open = max(capacity - enrolled, 0)
        out.append(Section(
            course=normalize_course(course),
            classNumber=class_number,
            section=section,
            term=term,
            title=title,
            enrolled=enrolled,
            capacity=capacity,
            waitlisted=waitlisted,
            waitlistCapacity=wl_cap,
            open=total_open,
            status=_status("", total_open, waitlisted, wl_cap),
            url=urljoin(base_url, link["href"]),
            source=SOURCE_NAME,
        ))
    return out


# --------------------------------------------------------------------------- #
# Meeting times (for the schedule builder; shapes in docs/schedule.md)
# --------------------------------------------------------------------------- #

def parse_detail_meetings(html: str) -> list[dict[str, Any]]:
    """Meeting times on a detail page: [{"days": [0, 2, 4], "start": "13:00", "end": "13:59", "location"}]."""
    from watcher.schedule import make_meeting, parse_days_text, parse_time_range

    out: list[dict[str, Any]] = []
    for blk in _soup(html).select(".sf--meeting-details"):
        days_el, time_el, loc_el = (blk.select_one(sel) for sel in
                                    (".sf--meeting-days", ".sf--meeting-time", ".sf--location"))
        times = parse_time_range(_clean(time_el.get_text(" "))) if time_el else None
        meeting = make_meeting(parse_days_text(days_el.get_text(" ")) if days_el else [],
                               times[0] if times else None, times[1] if times else None,
                               _clean(loc_el.get_text(" ")) if loc_el else "")
        if meeting and meeting not in out:
            out.append(meeting)
    return out


def parse_associated_meetings(html: str) -> dict[str, list[dict[str, Any]]]:
    """Class # -> meetings for every block of a /sections/associated/<nodeId> fragment."""
    from watcher.schedule import make_meeting, parse_days_text, parse_time_range

    out: dict[str, list[dict[str, Any]]] = {}
    for blk in _soup(html).select(".detail-class-associated-sections-flex"):
        m = re.search(r"Class #:\s*(\d+)", _clean(blk.get_text(" ")))
        if not m:
            continue
        vals: dict[str, str] = {}
        for lab in blk.select(".detail-label"):
            vals[_clean(lab.get_text()).rstrip(":").lower()] = _clean(str(lab.next_sibling or ""))
        times = parse_time_range(vals.get("time", ""))
        meeting = make_meeting(parse_days_text(vals.get("days", "")), times[0] if times else None,
                               times[1] if times else None, vals.get("place", ""))
        out[m.group(1)] = [meeting] if meeting else []
    return out


# --------------------------------------------------------------------------- #
# Network source
# --------------------------------------------------------------------------- #

class ClassesBerkeleySource:
    """Source for the watcher: ``fetch(Target) -> list[Section]``.

    * ``class_number`` target: searches the class # (works for primary sections);
      if not found and ``course`` is set, looks through the course's associated
      (discussion/lab) sections.
    * ``course`` target: every primary section of the course (exact match on the
      course name), filtered by ``section``. Discussion/lab sections are added when
      ``include_associated=True`` or when ``section`` names one that isn't a primary.
    * Term: ``target.term`` ("2026 Spring", "Spring 2026", "2262"), else the
      newest term listed in the search facets (the one currently enrolling).

    Every matched primary costs one detail-page request (that's where enrolled,
    capacity, waitlist and reserved seats live).
    """

    name = SOURCE_NAME

    def __init__(self, session: requests.Session | None = None, *, base_url: str = BASE_URL,
                 timeout: float = 20.0, min_interval: float = 1.0, max_pages: int = 5,
                 include_associated: bool = False, term_cache_ttl: float = 6 * 3600,
                 search_cache_ttl: float = 1800,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic) -> None:
        self.session = session or requests.Session()
        self.session.headers.setdefault("User-Agent", USER_AGENT)
        if self.session.headers.get("User-Agent", "").startswith("python-requests"):
            self.session.headers["User-Agent"] = USER_AGENT
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.min_interval = min_interval
        self.max_pages = max_pages
        self.include_associated = include_associated
        self.term_cache_ttl = term_cache_ttl
        self.search_cache_ttl = search_cache_ttl
        self._search_cache: dict[tuple[str, str], tuple[float, list[SearchResult]]] = {}
        self._sleep = sleep
        self._clock = clock
        self._last_request = float("-inf")
        self._terms: dict[str, str] = {}
        self._terms_at = float("-inf")

    # -- HTTP -------------------------------------------------------------- #

    def _get(self, path_or_url: str) -> str:
        url = path_or_url if path_or_url.startswith("http") else self.base_url + path_or_url
        wait = self._last_request + self.min_interval - self._clock()
        if wait > 0:
            self._sleep(wait)
        self._last_request = self._clock()
        try:
            resp = self.session.get(url, timeout=self.timeout)
        except requests.RequestException as e:
            raise SourceError(f"classes.berkeley.edu: request failed for {url}: {e}") from e
        if resp.status_code != 200:
            raise SourceError(f"classes.berkeley.edu: HTTP {resp.status_code} for {url}",
                              status=resp.status_code)
        return resp.text

    def _search_url(self, query: str, term_id: str = "", page: int = 0) -> str:
        url = f"/search/class?search={quote(query)}"
        if term_id:
            url += f"&f%5B0%5D=term%3A{term_id}"
        if page:
            url += f"&page={page}"
        return url

    # -- terms ------------------------------------------------------------- #

    def known_terms(self) -> dict[str, str]:
        return dict(self._terms)

    def _refresh_terms(self, seed_query: str) -> None:
        html = self._get(self._search_url(seed_query))
        if not _is_search_page(_soup(html)):
            raise SourceError("classes.berkeley.edu: unrecognized search page while loading terms")
        self._terms.update(parse_term_facets(html))
        self._terms_at = self._clock()

    def resolve_term(self, term: str, seed_query: str) -> tuple[str, str]:
        """Return (canonical term name, Drupal term id)."""
        stale = self._clock() - self._terms_at > self.term_cache_ttl
        want = normalize_term(term) if term else None
        if term and not want:
            raise SourceError(f"classes.berkeley.edu: can't understand term {term!r}")
        if stale or not self._terms or (want and want not in self._terms):
            self._refresh_terms(seed_query)
        if not self._terms:
            raise SourceError(f"classes.berkeley.edu: no terms found searching {seed_query!r}")
        if want is None:
            want = newest_term(self._terms)
        if want not in self._terms:
            raise SourceError(
                f"classes.berkeley.edu: term {want!r} not offered for {seed_query!r}; "
                f"known terms: {', '.join(sorted(self._terms, key=term_sort_key, reverse=True)[:6])}")
        return want, self._terms[want]

    # -- search ------------------------------------------------------------ #

    def search_course(self, course: str, term_id: str) -> list[SearchResult]:
        """All primary-section cards for exactly ``course`` in a term.

        The list of a course's sections rarely changes, so it is remembered for
        ``search_cache_ttl`` seconds. A pass over a course then costs only its
        detail pages, which is what lets many classes be watched politely.
        """
        key = (course, term_id)
        hit = self._search_cache.get(key)
        if hit and self._clock() - hit[0] < self.search_cache_ttl:
            return list(hit[1])
        found = self._search_course(course, term_id)
        if found:
            self._search_cache[key] = (self._clock(), list(found))
        return found

    def _search_course(self, course: str, term_id: str) -> list[SearchResult]:
        for query in (f'"{course}"', course):
            found: list[SearchResult] = []
            for page in range(self.max_pages):
                html = self._get(self._search_url(query, term_id, page))
                have = {f.classNumber for f in found}
                new = [m for m in filter_course(parse_search_page(html, self.base_url), course)
                       if m.classNumber not in have]
                found.extend(new)
                # Results are relevance-ranked: exact matches come first, so stop at
                # the first page that adds none. Single-match pages also stop early
                # when the result count fits on the page.
                if not new or not has_next_page(html):
                    break
            if found:
                return found
        return []

    def search_class_number(self, class_number: str, term_id: str) -> list[SearchResult]:
        html = self._get(self._search_url(class_number, term_id))
        return [r for r in parse_search_page(html, self.base_url) if r.classNumber == class_number]

    def fetch_detail(self, url: str) -> tuple[Section, str]:
        html = self._get(url)
        return parse_detail_page(html, url), detail_node_id(html)

    def fetch_associated(self, node_id: str, term: str, title: str) -> list[Section]:
        if not node_id:
            return []
        return parse_associated_sections(self._get(f"/sections/associated/{node_id}"),
                                         term=term, title=title, base_url=self.base_url)

    # -- Source protocol ---------------------------------------------------- #

    def fetch(self, target: Target) -> list[Section]:
        if not target.class_number and not target.course:
            raise SourceError("classes.berkeley.edu: target needs a course or class_number")
        seed = normalize_course(target.course) if target.course else target.class_number
        term, term_id = self.resolve_term(target.term, seed)

        primaries: list[SearchResult] = []
        if target.class_number:
            primaries = self.search_class_number(target.class_number, term_id)
        if not primaries and target.course:
            primaries = self.search_course(target.course, term_id)
        # Guard against the term filter being ignored (would watch the wrong term).
        primaries = [p for p in primaries if not p.term or p.term == term]
        if not primaries:
            if target.class_number and not target.course:
                raise SourceError(
                    f"classes.berkeley.edu: class #{target.class_number} not found in {term} "
                    "(discussion/lab class numbers need the course set too)")
            return []  # course genuinely not offered / no matching section

        want_cn = target.class_number
        want_sec = target.section if not want_cn else ""
        out: list[Section] = []
        seen: set[str] = set()

        def keep(s: Section) -> bool:
            if s.classNumber in seen:
                return False
            if want_cn:
                return s.classNumber == want_cn
            return section_matches(want_sec, s.section)

        primary_hit = any(keep(Section(course=p.course, classNumber=p.classNumber, section=p.section))
                          for p in primaries)
        need_associated = self.include_associated or not primary_hit

        for p in primaries:
            p_matches = keep(Section(course=p.course, classNumber=p.classNumber, section=p.section))
            if not p_matches and not need_associated:
                continue
            detail, node_id = self.fetch_detail(p.url)
            detail.term = detail.term or term
            if not detail.instructor:
                detail.instructor = p.instructor
            if p_matches:
                out.append(self._finish(detail, target))
                seen.add(detail.classNumber)
            if need_associated:
                for sec in self.fetch_associated(node_id or p.node_id, detail.term, detail.title):
                    if not keep(sec):
                        continue
                    if want_cn or want_sec:  # specific secondary: get reserved seats too
                        sec, _ = self.fetch_detail(sec.url)
                        sec.term = sec.term or detail.term
                    out.append(self._finish(sec, target))
                    seen.add(sec.classNumber)
            if want_cn and want_cn in seen:
                break
        return out

    @staticmethod
    def _finish(s: Section, target: Target) -> Section:
        if not target.include_reserved:
            s.reserved = []
        if not target.include_waitlist:
            s.waitlisted = s.waitlistCapacity = None
        s.fetchedAt = utcnow_iso()
        return s
