"""Offline tests for the berkeleytime GraphQL source."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from watcher.sources import berkeleytime as bt
from watcher.sources.base import SourceError, Target

FIX = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIX / name).read_text())


DETAILS = "bt_class_details_cs61a_2027spring_001.json"
SECTIONS = "bt_class_sections_cs61a_2027spring_001.json"
COURSE = "bt_course_classes_cs61a.json"

# Hashes computed with graphql-js 16 (print + stripIgnoredCharacters), exactly
# as the site's client does; verified live against berkeleytime.com.
KNOWN_IDS = {
    "GET_COURSE_WITH_INSTRUCTOR": "2e5bd7f134a8e007e7a6c2fa41a2d18b0dea3028df5f4f45942fa1d0c7205bf3",
    "GET_CLASS_DETAILS": "f91a5ed8c1e0a14186c41c0cb4c4ecfa105f35929a402f43e279c59cbb59fc84",
    "GET_CLASS_SECTIONS": "643db8cbc7198c777fe68fefae29a5154093126014ecbced23a276047706fdea",
    "GET_ENROLLMENT": "6b4e761f02e20db683488a9928ee2b8c6d07dbddab14851410cd0e94e2585382",
    "GET_ENROLLMENT_TIMEFRAMES": "f11827caca4ffa25bba5d4ee7bf22c0fa6724af5e7bd975ec74f5c4f89ffdcca",
}


@pytest.mark.parametrize("const,expected", KNOWN_IDS.items())
def test_persisted_ids_match_graphql_js(const, expected):
    assert bt.persisted_id(getattr(bt, const)) == expected


def test_canonicalize_drops_typename_and_whitespace():
    q = "query A($x: Int!) {\n  a(x: $x) { b __typename ...F }\n}"
    assert bt.canonicalize(q) == "query A($x:Int!){a(x:$x){b ...F}}"


def test_parse_primary_with_reserved():
    secs = bt.parse_class_response(load(DETAILS))
    assert len(secs) == 1
    s = secs[0]
    assert s.course == "COMPSCI 61A"
    assert s.term == "2027 Spring"
    assert s.section == "001 LEC"
    assert s.classNumber == "28320"
    assert s.instructor == "Kay Ousterhout"
    assert (s.enrolled, s.capacity, s.waitlisted, s.waitlistCapacity) == (332, 600, 0, 300)
    assert s.source == "berkeleytime"
    assert s.status == "open"
    assert s.url.startswith("https://berkeleytime.com/catalog/2027/Spring/COMPSCI/61A/001")
    assert len(s.reserved) == 5
    groups = {r.group: (r.enrolled, r.capacity) for r in s.reserved}
    assert groups["Students declared in the Computer Science BA major"] == (16, 50)
    assert s.reserved_open == 29 + 0 + 34 + 30 + 2
    # unreserved open = total open (268) minus still-open reserved seats (95)
    assert s.open == 268 - 95


def test_parse_without_reserved():
    s = bt.parse_class_response(load(DETAILS), include_reserved=False)[0]
    assert s.reserved == []
    assert s.open == 268


def test_parse_with_secondary_sections():
    secs = bt.parse_class_response(load(DETAILS), load(SECTIONS))
    assert len(secs) == 7
    by = {s.section: s for s in secs}
    assert by["101 DIS"].classNumber == "28338"
    assert by["101 DIS"].capacity == 24 and by["101 DIS"].status == "open"
    assert by["101L LAB"].capacity == 40
    # zero-capacity, zero-waitlist section is closed
    assert by["103 DIS"].status == "closed"
    assert all(s.reserved == [] for s in secs[1:])


def test_expired_reservations_ignored():
    d = load(DETAILS)
    for r in d["data"]["class"]["primarySection"]["enrollment"]["latest"]["seatReservationCount"]:
        r["isValid"] = False
    s = bt.parse_class_response(d)[0]
    assert s.reserved == [] and s.open == 268


def test_missing_enrollment_gives_unknowns():
    d = load(DETAILS)
    d["data"]["class"]["primarySection"]["enrollment"] = None
    s = bt.parse_class_response(d)[0]
    assert s.enrolled is None and s.open is None and s.status == ""


def test_errors_raise():
    with pytest.raises(SourceError):
        bt.parse_class_response({"errors": [{"message": "boom"}]})
    with pytest.raises(SourceError):
        bt.parse_class_response({"data": {"class": None}})
    with pytest.raises(SourceError):
        bt.parse_class_response({"error": "Invalid persisted operation request"})


def test_course_classes_and_default_term():
    classes = bt.parse_course_classes(load(COURSE))
    assert {"year": 2027, "semester": "Spring"}.items() <= classes[-1].items()
    assert bt.pick_default_term(classes) == (2027, "Spring")
    current_only = [c for c in classes if c["temporalPosition"] != "Future"]
    assert bt.pick_default_term(current_only) == (2026, "Fall")


@pytest.mark.parametrize("raw,expected", [
    ("2027 Spring", (2027, "Spring")), ("Fall 2026", (2026, "Fall")), ("2026-summer", (2026, "Summer")),
])
def test_parse_term(raw, expected):
    assert bt.parse_term(raw) == expected


def test_parse_course():
    assert bt.parse_course("compsci 61a") == ("COMPSCI", "61A")
    assert bt.parse_course("MEC ENG C85") == ("MEC ENG", "C85")
    with pytest.raises(SourceError):
        bt.parse_course("COMPSCI")


class FakeResp:
    def __init__(self, payload, status=200):
        self._p, self.status_code = payload, status

    def json(self):
        return self._p


class FakeSession:
    """Routes persisted-query ids to fixture payloads."""

    def __init__(self):
        self.headers = {}
        self.calls = []
        self.routes = {
            KNOWN_IDS["GET_COURSE_WITH_INSTRUCTOR"]: load(COURSE),
            KNOWN_IDS["GET_CLASS_DETAILS"]: load(DETAILS),
            KNOWN_IDS["GET_CLASS_SECTIONS"]: load(SECTIONS),
        }

    def post(self, url, json=None, timeout=None):
        assert url == bt.API_URL and timeout
        self.calls.append(json)
        if json["id"] not in self.routes:
            return FakeResp({"error": "Invalid persisted operation request"}, 400)
        return FakeResp(self.routes[json["id"]])


def make_source():
    sess = FakeSession()
    return bt.BerkeleytimeSource(session=sess, min_interval=0), sess


def test_fetch_whole_course_default_term():
    src, sess = make_source()
    secs = src.fetch(Target(course="COMPSCI 61A"))
    assert len(secs) == 7
    assert sess.headers["User-Agent"].startswith("CalClassCoordinator")
    assert sess.calls[1]["variables"]["year"] == 2027
    assert sess.calls[1]["variables"]["semester"] == "Spring"


def test_fetch_lecture_only_skips_sections_query():
    src, sess = make_source()
    secs = src.fetch(Target(course="COMPSCI 61A", term="2027 Spring", section="001 lec"))
    assert [s.classNumber for s in secs] == ["28320"]
    assert len(sess.calls) == 2


def test_fetch_by_class_number_secondary():
    src, _ = make_source()
    secs = src.fetch(Target(course="COMPSCI 61A", term="Spring 2027", class_number="28321"))
    assert [s.section for s in secs] == ["101L LAB"]


def test_fetch_errors():
    src, _ = make_source()
    with pytest.raises(SourceError):
        src.fetch(Target(class_number="28320"))
    with pytest.raises(SourceError):
        src.fetch(Target(course="COMPSCI 61A", term="2030 Fall"))
    with pytest.raises(SourceError):
        src.fetch(Target(course="COMPSCI 61A", term="2027 Spring", class_number="99999"))


def test_http_error_raises():
    src, sess = make_source()
    sess.routes = {}
    with pytest.raises(SourceError, match="HTTP 400"):
        src.fetch(Target(course="COMPSCI 61A"))
