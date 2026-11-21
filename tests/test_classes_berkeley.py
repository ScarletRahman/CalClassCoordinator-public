"""Offline tests for watcher.sources.classes_berkeley against saved pages."""
from __future__ import annotations

from datetime import date
from pathlib import Path
from urllib.parse import unquote

import pytest

from watcher.sources.base import SourceError, Target
from watcher.sources.classes_berkeley import (
    ClassesBerkeleySource,
    filter_course,
    has_next_page,
    newest_term,
    normalize_section,
    normalize_term,
    parse_associated_sections,
    parse_detail_page,
    parse_search_page,
    parse_search_total,
    parse_term_facets,
    reserved_from_json,
    section_matches,
    sis_term_code,
    term_sort_key,
)

FIX = Path(__file__).parent / "fixtures"


def load(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


# --------------------------------------------------------------------------- terms

@pytest.mark.parametrize("label,expected", [
    ("Spring 2027", "2027 Spring"),
    ("2026 Fall", "2026 Fall"),
    ("Summer Sessions 2026", "2026 Summer"),
    ("2025 Summer Session C\n8 weeks, June 23 - August 15", "2025 Summer"),
    ("fall 2026", "2026 Fall"),
    ("2272", "2027 Spring"),
    ("2258", "2025 Fall"),
    ("C: June 22-Aug 14", None),
    ("nonsense", None),
])
def test_normalize_term(label, expected):
    assert normalize_term(label) == expected


def test_term_ordering_and_sis_code():
    assert newest_term(["2026 Fall", "2027 Spring", "2026 Summer"]) == "2027 Spring"
    assert term_sort_key("2026 Summer") < term_sort_key("2026 Fall")
    assert sis_term_code("2027 Spring") == "2272"
    assert sis_term_code("2025 Fall") == "2258"


def test_parse_term_facets():
    terms = parse_term_facets(load("cb_search_compsci61a_allterms.html"))
    assert terms["2027 Spring"] == "8589"
    assert terms["2026 Fall"] == "8588"
    assert terms["2026 Summer"] == "8580"      # "Summer Sessions 2026", not a sub-session
    assert terms["2025 Fall"] == "8573"
    assert terms["2016 Fall"] == "7171"        # ids are not chronological...
    assert terms["2017 Spring"] == "7164"
    assert newest_term(terms) == "2027 Spring"  # ...so the default is chosen by name
    assert all(":" not in t for t in terms)


def test_parse_term_facets_on_filtered_page():
    # On a page already filtered to term 8573 the facet hrefs carry two term ids.
    terms = parse_term_facets(load("search_compsci61a.html"))
    assert terms["2027 Spring"] == "8589"
    assert terms["2026 Fall"] == "8588"


# --------------------------------------------------------------------------- sections

def test_section_normalization():
    assert normalize_section("lec 001") == "001 LEC"
    assert normalize_section("001-LEC") == "001 LEC"
    assert section_matches("001 lec", "001 LEC")
    assert section_matches("101L", "101L LAB")
    assert not section_matches("002 LEC", "001 LEC")
    assert section_matches("", "001 LEC")


# --------------------------------------------------------------------------- search

def test_parse_search_page_cards():
    html = load("cb_search_compsci61a_spring2027.html")
    results = parse_search_page(html)
    assert len(results) == 18
    first = results[0]
    assert first.course == "COMPSCI 61A"
    assert first.section == "001 LEC"
    assert first.classNumber == "28320"
    assert first.term == "2027 Spring"
    assert first.title == "The Structure and Interpretation of Computer Programs"
    assert first.instructor == "Kay Ousterhout"
    assert first.url == "https://classes.berkeley.edu/content/2027-spring-compsci-61a-001-lec-001"
    assert first.node_id == "534329"
    assert first.open == 173 and first.has_open_seats is True
    assert parse_search_total(html) == 64
    assert has_next_page(html)


def test_search_card_seat_variants():
    results = {r.course + " " + r.section: r for r in parse_search_page(load("cb_search_math53_quoted_spring2027.html"))}
    full = results["MATH 53 001 LEC"]
    assert full.open == 0 and full.has_open_seats is False
    assert full.to_section().status == "closed"
    assert results["MATH 53 002 LEC"].open == 220
    # "Open Seats" with no number = only reserved seats open
    reserved_only = [r for r in results.values() if r.has_open_seats and r.open == 0]
    assert reserved_only


def test_filter_course_is_exact():
    results = parse_search_page(load("search_compsci61a.html"))
    courses = {r.course for r in results}
    assert "EDUC 161A" in courses  # fuzzy search leaks other courses
    only = filter_course(results, "compsci  61a")
    assert [r.course for r in only] == ["COMPSCI 61A"]
    assert only[0].term == "2025 Fall"


def test_filter_course_multiple_lectures():
    results = parse_search_page(load("cb_search_math53_quoted_spring2027.html"))
    assert [r.section for r in filter_course(results, "MATH 53")] == ["001 LEC", "002 LEC"]


def test_card_term_with_summer_label():
    results = parse_search_page(load("cb_search_compsci61a_allterms.html"))
    assert {r.term for r in results} >= {"2026 Fall", "2027 Spring"}


def test_empty_search_page_is_empty_not_error():
    html = load("cb_search_empty.html")
    assert parse_search_page(html) == []
    assert parse_search_total(html) is None


def test_unrecognized_search_page_raises():
    with pytest.raises(SourceError):
        parse_search_page("<html><body><h1>Maintenance</h1></body></html>")


# --------------------------------------------------------------------------- detail

def test_detail_with_reserved_seats():
    url = "https://classes.berkeley.edu/content/2027-spring-compsci-61a-001-lec-001"
    s = parse_detail_page(load("cb_detail_compsci61a_001_spring2027.html"), url, today=date(2026, 11, 20))
    assert (s.course, s.classNumber, s.section, s.term) == ("COMPSCI 61A", "28320", "001 LEC", "2027 Spring")
    assert s.title == "The Structure and Interpretation of Computer Programs"
    assert s.instructor == "Kay Ousterhout"
    assert (s.enrolled, s.capacity, s.waitlisted, s.waitlistCapacity) == (332, 600, 0, 300)
    assert s.open == 173          # "173 unreserved seats"
    assert s.status == "open"
    assert s.url == url and s.source == "classes.berkeley.edu"
    groups = {r.group: r for r in s.reserved}
    assert len(groups) == 4
    cs_ba = groups["Students declared in the Computer Science BA major"]
    assert (cs_ba.enrolled, cs_ba.capacity, cs_ba.open) == (16, 50, 34)
    assert groups["Students with Enrollment Permission"].open == 29
    assert s.reserved_open == 29 + 34 + 30 + 2
    assert s.open + s.reserved_open == s.capacity - s.enrolled


def test_detail_full_with_waitlist():
    s = parse_detail_page(load("cb_detail_math53_001_spring2027.html"), "u")
    assert (s.course, s.section, s.classNumber) == ("MATH 53", "001 LEC", "21816")
    assert (s.enrolled, s.capacity, s.waitlisted, s.waitlistCapacity) == (400, 400, 46, 50)
    assert s.open == 0
    assert s.reserved == []
    assert s.status == "waitlist"


def test_detail_cross_listed_reserved_only_open():
    s = parse_detail_page(load("cb_detail_datac8_001_spring2027.html"), "u", today=date(2026, 11, 20))
    assert s.course == "DATA C8"
    assert (s.enrolled, s.capacity, s.waitlisted) == (283, 600, 54)
    assert s.open == 0                      # all open seats are reserved
    assert s.status == "open"
    assert [(r.group, r.enrolled, r.capacity) for r in s.reserved] == [
        ("Students with 1-2 Terms in Attendance", 282, 600)]


def test_detail_post_term_no_reserved():
    s = parse_detail_page(load("detail_compsci61a_001_lec.html"), "u")
    assert (s.term, s.classNumber, s.enrolled, s.capacity, s.open) == ("2025 Fall", "28984", 1269, 1400, 131)
    assert s.instructor == "John DeNero, Kay Ousterhout"
    assert s.reserved == []   # 'available' has none; 'history' is ignored


def test_detail_legacy_json_string():
    s = parse_detail_page(load("cb_detail_compsci61a_001_fall2016.html"), "u")
    assert (s.term, s.classNumber, s.enrolled, s.capacity, s.waitlistCapacity, s.open) == (
        "2016 Fall", "27034", 1567, 1690, 500, 123)


def test_detail_html_fallback_without_json():
    html = load("cb_detail_compsci61a_001_spring2027.html")
    html = html.replace('data-drupal-selector="drupal-settings-json"', 'data-x="gone"')
    s = parse_detail_page(html, "u")
    assert (s.enrolled, s.capacity, s.waitlisted, s.waitlistCapacity, s.open) == (332, 600, 0, 300, 173)
    assert s.classNumber == "28320"
    assert len(s.reserved) == 4 and all(r.capacity is None for r in s.reserved)


def test_detail_unrecognized_raises():
    with pytest.raises(SourceError):
        parse_detail_page("<html><body>nope</body></html>", "u")


def test_reserved_from_json_picks_row_in_force():
    rows = [
        {"number": 2, "requirementGroup": {"description": "L&S Undeclared"}, "fromDate": "2027-01-11", "maxEnroll": 1, "enrolledCount": 14},
        {"number": 2, "requirementGroup": {"description": "L&S Undeclared"}, "fromDate": "2026-10-26", "maxEnroll": 14, "enrolledCount": 14},
    ]
    assert [(r.enrolled, r.capacity) for r in reserved_from_json(rows, date(2026, 11, 20))] == [(14, 14)]
    assert [(r.enrolled, r.capacity) for r in reserved_from_json(rows, date(2027, 2, 1))] == [(14, 1)]


# --------------------------------------------------------------------------- associated

def test_parse_associated_sections():
    secs = parse_associated_sections(load("cb_associated_compsci61a_spring2027.html"), term="2027 Spring", title="T")
    assert len(secs) == 55
    lab = next(s for s in secs if s.classNumber == "28321")
    assert (lab.course, lab.section, lab.term) == ("COMPSCI 61A", "101L LAB", "2027 Spring")
    assert (lab.enrolled, lab.capacity, lab.waitlisted, lab.waitlistCapacity, lab.open) == (0, 40, 0, 25, 40)
    assert lab.url == "https://classes.berkeley.edu/content/2027-spring-compsci-61a-101l-lab-101l"
    dis = secs[0]
    assert (dis.section, dis.classNumber) == ("999 DIS", "28492")
    assert len({s.classNumber for s in secs}) == 55


# --------------------------------------------------------------------------- fetch (fake network)

class FakeResponse:
    def __init__(self, text: str, status: int = 200):
        self.text, self.status_code = text, status


class FakeSession:
    """Serves fixtures by URL; records requests."""

    def __init__(self, routes: dict[str, str]):
        self.routes = routes
        self.headers: dict[str, str] = {}
        self.calls: list[str] = []

    def get(self, url, timeout=None):
        self.calls.append(unquote(url))
        for key, fixture in self.routes.items():
            if key.lower() in unquote(url).lower():
                return FakeResponse(load(fixture) if fixture.endswith(".html") else fixture)
        return FakeResponse("not found", 404)


def make_source(routes, **kw):
    sess = FakeSession(routes)
    src = ClassesBerkeleySource(sess, sleep=lambda s: None, **kw)
    return src, sess


ROUTES_61A = {
    # Most specific first.
    'search="compsci 61a"&f[0]=term:8589': "cb_search_compsci61a_spring2027.html",
    "search=28320&f[0]=term:8589": "cb_search_compsci61a_spring2027.html",
    "search=28321&f[0]=term:8589": "cb_search_empty.html",
    "search=compsci 61a&f[0]=term:8589": "cb_search_compsci61a_spring2027.html",
    "search=": "cb_search_compsci61a_allterms.html",
    "/content/2027-spring-compsci-61a-001-lec-001": "cb_detail_compsci61a_001_spring2027.html",
    "/content/2027-spring-compsci-61a-101l-lab-101l": "cb_detail_compsci61a_001_spring2027.html",
    "/sections/associated/534329": "cb_associated_compsci61a_spring2027.html",
}


def test_user_agent_is_set():
    src, sess = make_source({})
    assert "CalClassCoordinator" in sess.headers["User-Agent"]


def test_fetch_course_default_term():
    src, sess = make_source(ROUTES_61A)
    secs = src.fetch(Target(course="COMPSCI 61A"))
    assert [(s.course, s.section, s.classNumber, s.term) for s in secs] == [
        ("COMPSCI 61A", "001 LEC", "28320", "2027 Spring")]
    assert secs[0].reserved and secs[0].source == "classes.berkeley.edu"
    # term lookup, quoted search page 0 (+ page 1, which adds nothing new), detail;
    # no associated-sections call
    assert not any("/sections/associated" in c for c in sess.calls)
    assert len(sess.calls) == 4
    # term ids and the course's section list are cached between fetches: only the detail page
    src.fetch(Target(course="COMPSCI 61A"))
    assert len(sess.calls) == 5 and "/content/" in sess.calls[-1]
    # with the cache off, every fetch searches again
    src2, sess2 = make_source(ROUTES_61A, search_cache_ttl=0)
    src2.fetch(Target(course="COMPSCI 61A"))
    src2.fetch(Target(course="COMPSCI 61A"))
    assert len(sess2.calls) == 7
    assert sum("search=COMPSCI 61A" in c for c in sess.calls) == 1


def test_fetch_by_class_number():
    src, _ = make_source(ROUTES_61A)
    secs = src.fetch(Target(class_number="28320", term="Spring 2027"))
    assert [s.classNumber for s in secs] == ["28320"]
    assert secs[0].open == 173


def test_fetch_secondary_section_via_associated():
    src, sess = make_source(ROUTES_61A)
    secs = src.fetch(Target(course="COMPSCI 61A", section="101L LAB", term="2027 Spring"))
    assert any("/sections/associated/534329" in c for c in sess.calls)
    assert any("101l-lab-101l" in c for c in sess.calls)  # detail fetched for reserved seats
    assert len(secs) == 1


def test_fetch_secondary_class_number_with_course():
    src, _ = make_source(ROUTES_61A, )
    # class # search misses (secondaries aren't indexed), course search + associated finds it
    secs = src.fetch(Target(course="COMPSCI 61A", class_number="28321", term="2027 Spring"))
    assert len(secs) == 1


def test_fetch_include_associated_returns_all_sections():
    src, _ = make_source(ROUTES_61A, include_associated=True)
    secs = src.fetch(Target(course="COMPSCI 61A", term="2027 Spring"))
    assert len(secs) == 56  # 1 lecture + 55 discussion/lab sections
    assert len({s.classNumber for s in secs}) == 56


def test_fetch_secondary_class_number_without_course_raises():
    src, _ = make_source(ROUTES_61A)
    with pytest.raises(SourceError):
        src.fetch(Target(class_number="28321", term="2027 Spring"))


def test_fetch_unknown_term_raises():
    src, _ = make_source(ROUTES_61A)
    with pytest.raises(SourceError):
        src.fetch(Target(course="COMPSCI 61A", term="2031 Fall"))


def test_fetch_http_error_raises():
    src, _ = make_source({})
    with pytest.raises(SourceError):
        src.fetch(Target(course="COMPSCI 61A"))


def test_fetch_course_not_offered_is_empty():
    routes = {
        "term:8589": "cb_search_empty.html",
        "search=": "cb_search_compsci61a_allterms.html",
    }
    src, _ = make_source(routes)
    assert src.fetch(Target(course="STAT C8", term="2027 Spring")) == []


def test_include_flags_strip_reserved_and_waitlist():
    src, _ = make_source(ROUTES_61A)
    s = src.fetch(Target(course="COMPSCI 61A", include_reserved=False, include_waitlist=False))[0]
    assert s.reserved == [] and s.waitlisted is None and s.waitlistCapacity is None
