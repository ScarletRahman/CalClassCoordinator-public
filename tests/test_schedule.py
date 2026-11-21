"""Offline tests for class times (watcher.schedule) and the live lookup (watcher.lookup)."""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from watcher import schedule
from watcher.lookup import (LookupService, NotOffered, clean_course, clean_term, lookup_berkeleytime,
                            lookup_classes_berkeley)
from watcher.server import serve
from watcher.sources import berkeleytime as bt
from watcher.sources.base import SourceError
from watcher.sources.classes_berkeley import (ClassesBerkeleySource, parse_associated_meetings,
                                              parse_detail_meetings)
from watcher.store import Store

FIX = Path(__file__).parent / "fixtures"


def load(name: str):
    return json.loads((FIX / name).read_text())


def text(name: str) -> str:
    return (FIX / name).read_text(encoding="utf-8")


# ---- small helpers ---------------------------------------------------------

@pytest.mark.parametrize("raw,expected", [
    ("13:00:00", "13:00"), ("08:05", "08:05"), ("01:00 pm", "13:00"), ("12:00 am", "00:00"),
    ("12:30 PM", "12:30"), ("5:00 pm", "17:00"), ("", None), (None, None), ("25:00", None), ("noon", None),
])
def test_hhmm(raw, expected):
    assert schedule._hhmm(raw) == expected


def test_days_and_time_ranges():
    assert schedule.parse_days_text("Mo, We, Fr") == [0, 2, 4]
    assert schedule.parse_days_text("TuTh") == [1, 3]
    assert schedule.parse_days_text("Su") == [6]
    assert schedule.parse_days_text("") == []
    assert schedule.parse_time_range("01:00 pm  -  01:59 pm") == ("13:00", "13:59")
    assert schedule.parse_time_range("5:00 pm - 6:29 pm") == ("17:00", "18:29")
    assert schedule.parse_time_range("TBA") is None


def test_make_meeting_drops_placeholders():
    assert schedule.make_meeting([0], "13:00", "13:59", " Dwinelle   155 ") == {
        "days": [0], "start": "13:00", "end": "13:59", "location": "Dwinelle 155"}
    assert schedule.make_meeting([], "13:00", "13:59") is None           # no days
    assert schedule.make_meeting([6], "00:00", "00:01") is None          # SIS "no set time"
    assert schedule.make_meeting([0], "00:00", "00:00") is None
    assert schedule.make_meeting([0], "14:00", "13:00") is None          # ends before it starts
    assert "location" not in schedule.make_meeting([0], "09:00", "10:00")


def test_term_names():
    assert schedule.term_slug("Spring 2027") == "2027-spring"
    assert schedule.canonical_term("2026-fall") == "2026 Fall"
    assert clean_term("spring 2027") == "2027 Spring"
    with pytest.raises(ValueError):
        clean_term("next year")


@pytest.mark.parametrize("raw,expected", [
    ("compsci  61a", "COMPSCI 61A"), ("LS C70T", "LS C70T"), ("ENGLISH R1A", "ENGLISH R1A"),
    ("MATH 53", "MATH 53"), ("AFRICAM H195", "AFRICAM H195"),
])
def test_clean_course(raw, expected):
    assert clean_course(raw) == expected


@pytest.mark.parametrize("raw", ["", "61A", "COMPSCI", "COMPSCI 61A; DROP", "x" * 60, "../etc 1", "A_B 1"])
def test_clean_course_rejects(raw):
    with pytest.raises(ValueError):
        clean_course(raw)


# ---- Berkeleytime -> class -------------------------------------------------

def test_class_from_berkeleytime_cs61a():
    course, cls = schedule.class_from_berkeleytime(
        load("bt_class_details_cs61a_2027spring_001.json"), load("bt_class_sections_cs61a_2027spring_001.json"))
    assert course == "COMPSCI 61A"
    assert cls["number"] == "001" and cls["units"] == [4, 4]
    assert "sessionId" not in cls                      # regular session is left out
    p = cls["primary"]
    assert p["section"] == "001 LEC" and p["component"] == "LEC" and p["classNumber"].isdigit()
    assert p["instructor"] == "Kay Ousterhout"
    assert p["meetings"] == [{"days": [0, 2, 4], "start": "13:00", "end": "13:59", "location": "Dwinelle 155"}]
    assert p["capacity"] > 0 and isinstance(p["open"], int) and p["reserved"]
    assert all(s["component"] in ("DIS", "LAB") for s in cls["sections"])
    assert all("reserved" not in s for s in cls["sections"])
    for s in cls["sections"]:
        for m in s["meetings"]:
            assert m["start"] < m["end"] and all(0 <= d <= 6 for d in m["days"])


def test_placeholder_sections_are_dropped_like_the_official_schedule():
    pair = load("bt_class_pair_math53_2027spring_001.json")
    raw = pair["sections"]["data"]["class"]["sections"]
    assert len(raw) == 17                               # Berkeleytime lists 7 empty shells
    course, cls = schedule.class_from_berkeleytime(pair["details"], pair["sections"])
    assert course == "MATH 53"
    assert [s["section"] for s in cls["sections"]] == [f"{n} DIS" for n in range(101, 111)]
    full = cls["sections"][0]
    assert full["capacity"] == 40 and full["open"] == 0   # 0 open seats is kept, not dropped as "empty"


def test_placeholders_kept_when_no_section_has_seats_yet():
    secs = [{"component": "DIS", "capacity": 0, "enrolled": 0}, {"component": "DIS", "capacity": 0}]
    assert schedule.drop_placeholder_sections(secs) == secs
    mixed = secs + [{"component": "LAB", "capacity": 0}, {"component": "DIS", "capacity": 30, "enrolled": 2}]
    assert schedule.drop_placeholder_sections(mixed) == [mixed[2], mixed[3]]


def test_class_without_primary_is_skipped():
    assert schedule.class_from_berkeleytime({"data": {"class": {"primarySection": None}}}, None) is None
    assert schedule.class_from_berkeleytime({"data": {"class": None}}, None) is None


def test_build_term_and_import(tmp_path):
    cs = (load("bt_class_details_cs61a_2027spring_001.json"), load("bt_class_sections_cs61a_2027spring_001.json"))
    m = load("bt_class_pair_math53_2027spring_001.json")

    class FakeClient:
        calls = 0

        def class_identities(self, term):
            return [{"subject": "COMPSCI", "courseNumber": "61A", "number": "001", "sessionId": "1"},
                    {"subject": "MATH", "courseNumber": "53", "number": "001", "sessionId": "1"},
                    {"subject": "MATH", "courseNumber": "202A", "number": "001", "sessionId": "1"}]  # grad: skipped

        def class_pair(self, term, ident):
            FakeClient.calls += 1
            return cs if ident["subject"] == "COMPSCI" else (m["details"], m["sections"])

    said = []
    path = schedule.import_term("Spring 2027", tmp_path / "out", cache=tmp_path / "cache",
                                client=FakeClient(), progress=said.append)
    data = json.loads(path.read_text())
    assert path.name == "2027-spring.json" and data["term"] == "2027 Spring"
    assert list(data["courses"]) == ["COMPSCI 61A", "MATH 53"] and data["classCount"] == 2
    assert data["failed"] == 0 and data["source"] == "berkeleytime"
    assert "url" not in data["courses"]["MATH 53"][0]
    index = json.loads((tmp_path / "out" / "index.json").read_text())
    assert index["terms"] == [{"term": "2027 Spring", "file": "2027-spring.json",
                               "generatedAt": data["generatedAt"], "courses": 2, "classes": 2}]
    assert FakeClient.calls == 2

    # A second run is answered from the cache: no new requests.
    schedule.import_term("Spring 2027", tmp_path / "out", cache=tmp_path / "cache", client=FakeClient())
    assert FakeClient.calls == 2


def test_import_refuses_to_write_a_mostly_failed_term(tmp_path):
    class Broken:
        def class_identities(self, term):
            return [{"subject": "MATH", "courseNumber": str(n), "number": "001", "sessionId": "1"} for n in range(1, 21)]

        def class_pair(self, term, ident):
            raise SourceError("berkeleytime: HTTP 503")

    with pytest.raises(SourceError):
        schedule.import_term("2027 Spring", tmp_path, client=Broken())
    assert not (tmp_path / "2027-spring.json").exists()


def test_import_of_unpublished_term_writes_nothing(tmp_path):
    class Empty:
        def class_identities(self, term):
            return []

    assert schedule.import_term("2027 Fall", tmp_path, client=Empty()) is None
    assert not list(tmp_path.iterdir())


def test_persisted_ids_match_the_site():
    # The ML scraper holds the minified query texts taken from the site's bundle; the ids must
    # agree or Berkeleytime answers "Invalid persisted operation request".
    import hashlib

    from ml.scrapers.berkeleytime import QUERIES
    for name, document in (("GetCatalogClassIdentities", schedule.GET_CATALOG_CLASS_IDENTITIES),
                           ("GetTerms", schedule.GET_TERMS)):
        assert bt.persisted_id(document) == hashlib.sha256(QUERIES[name].encode()).hexdigest()


# ---- classes.berkeley.edu meeting times ------------------------------------

def test_cb_detail_meetings():
    assert parse_detail_meetings(text("cb_detail_compsci61a_001_spring2027.html")) == [
        {"days": [0, 2, 4], "start": "13:00", "end": "13:59", "location": "Dwinelle 155"}]
    assert parse_detail_meetings(text("cb_detail_math53_001_spring2027.html")) == [
        {"days": [1, 3], "start": "14:00", "end": "15:29", "location": "Undergrad Academic Bldg 100"}]


def test_cb_associated_meetings():
    times = parse_associated_meetings(text("cb_associated_compsci61a_spring2027.html"))
    assert len(times) == 55
    assert times["28327"] == [{"days": [0], "start": "17:00", "end": "18:29",
                               "location": "The Gateway Building B1016"}]
    assert times["28492"] == []        # "Su 12:00 am - 12:01 am" is the SIS's "no set time"


class FakeCB(ClassesBerkeleySource):
    """Serves the saved pages; counts requests."""

    def __init__(self, pages: dict[str, str], status: int | None = None):
        super().__init__(min_interval=0)
        self.pages, self.status, self.requests = pages, status, []

    def _get(self, path_or_url: str) -> str:
        self.requests.append(path_or_url)
        if self.status:
            raise SourceError(f"classes.berkeley.edu: HTTP {self.status}", status=self.status)
        for key, html in self.pages.items():
            if key in path_or_url:
                return html
        raise SourceError(f"classes.berkeley.edu: HTTP 404 for {path_or_url}", status=404)


def cb_pages() -> dict[str, str]:
    return {
        "/sections/associated/": text("cb_associated_compsci61a_spring2027.html"),
        "/content/": text("cb_detail_compsci61a_001_spring2027.html"),
        "/search/class": text("cb_search_compsci61a_spring2027.html"),
    }


def test_lookup_classes_berkeley():
    src = FakeCB(cb_pages())
    classes = lookup_classes_berkeley(src, "COMPSCI 61A", "2027 Spring")
    assert len(classes) == 1
    c = classes[0]
    assert c["number"] == "001" and c["primary"]["section"] == "001 LEC"
    assert c["primary"]["meetings"][0]["days"] == [0, 2, 4]
    assert c["primary"]["enrolled"] == 332 and c["primary"]["capacity"] == 600 and c["primary"]["reserved"]
    assert len(c["sections"]) == 55
    lab = next(s for s in c["sections"] if s["classNumber"] == "28327")
    assert lab["component"] == "LAB" and lab["meetings"][0]["start"] == "17:00" and lab["open"] == 36
    # terms page + search + one detail page + one sections fragment: nothing per section
    assert len(src.requests) <= 5


def test_lookup_classes_berkeley_refuses_many_lectures():
    with pytest.raises(SourceError, match="too many"):
        lookup_classes_berkeley(FakeCB(cb_pages()), "COMPSCI 61A", "2027 Spring", max_classes=0)


# ---- Berkeleytime lookup ----------------------------------------------------

class FakeBT:
    def __init__(self):
        self.pairs = 0

    def query(self, document, variables=None):
        assert document == bt.GET_COURSE_WITH_INSTRUCTOR
        if variables["subject"] != "MATH":
            return {"data": {"course": None}}
        return load("bt_course_classes_math53.json")

    def class_pair(self, term, ident):
        self.pairs += 1
        pair = load("bt_class_pair_math53_2027spring_001.json")
        pair["details"]["data"]["class"]["number"] = ident["number"]
        return pair["details"], pair["sections"]


def test_lookup_berkeleytime_skips_classes_the_schedule_hides():
    client = FakeBT()
    classes = lookup_berkeleytime(client, "MATH 53", "2027 Spring")
    assert [c["number"] for c in classes] == ["001", "002"]    # 003 is not printed in the schedule
    assert client.pairs == 2
    assert classes[0]["url"].startswith("https://berkeleytime.com/catalog/2027/Spring/MATH/53/")


def test_lookup_berkeleytime_not_offered():
    with pytest.raises(NotOffered):
        lookup_berkeleytime(FakeBT(), "MATH 53", "2031 Spring")
    with pytest.raises(NotOffered):
        lookup_berkeleytime(FakeBT(), "NOPE 1", "2027 Spring")


# ---- LookupService: cache, shared fetches, cool-off -------------------------

class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def service(fetchers, sources=("classes.berkeley.edu", "berkeleytime"), **kw):
    clock = Clock()
    return LookupService(list(sources), fetchers=fetchers, clock=clock, **kw), clock


def test_service_caches_hits_and_misses():
    calls = []

    def cb(course, term):
        calls.append((course, term))
        if course == "MATH 1":
            raise NotOffered("no")
        return [{"number": "001"}]

    svc, clock = service({"classes.berkeley.edu": cb, "berkeleytime": cb}, sources=["classes.berkeley.edu"])
    first = svc.lookup("compsci 61a", "Spring 2027")
    assert first["course"] == "COMPSCI 61A" and first["term"] == "2027 Spring"
    assert first["source"] == "classes.berkeley.edu" and first["cached"] is False and first["classes"]
    again = svc.lookup("COMPSCI 61A", "2027 Spring")
    assert again["cached"] is True and again["fetchedAt"] == first["fetchedAt"]
    assert len(calls) == 1
    clock.now += 301
    assert svc.lookup("COMPSCI 61A", "2027 Spring")["cached"] is False and len(calls) == 2

    assert svc.lookup("MATH 1", "2027 Spring") is None
    clock.now += 600
    assert svc.lookup("MATH 1", "2027 Spring") is None
    assert calls.count(("MATH 1", "2027 Spring")) == 1          # "not offered" is remembered for 30 min
    clock.now += 1300
    svc.lookup("MATH 1", "2027 Spring")
    assert calls.count(("MATH 1", "2027 Spring")) == 2


def test_service_falls_back_and_leaves_a_refusing_source_alone():
    asked = {"cb": 0, "bt": 0}

    def cb(course, term):
        asked["cb"] += 1
        raise SourceError("classes.berkeley.edu: HTTP 403", status=403)

    def btf(course, term):
        asked["bt"] += 1
        return [{"number": "001"}]

    svc, clock = service({"classes.berkeley.edu": cb, "berkeleytime": btf})
    assert svc.lookup("COMPSCI 61A", "2027 Spring")["source"] == "berkeleytime"
    assert svc.lookup("MATH 53", "2027 Spring")["source"] == "berkeleytime"
    assert asked == {"cb": 1, "bt": 2}            # after one 403 the site is not asked again
    clock.now += 6 * 3600 + 1
    svc.lookup("MATH 54", "2027 Spring")
    assert asked["cb"] == 2                        # ...until the cool-off has passed


def test_service_errors_are_not_retried_on_every_click():
    n = {"calls": 0}

    def down(course, term):
        n["calls"] += 1
        raise SourceError("berkeleytime unavailable")

    svc, clock = service({"berkeleytime": down}, sources=["berkeleytime"])
    for _ in range(3):
        with pytest.raises(SourceError):
            svc.lookup("COMPSCI 61A", "2027 Spring")
    assert n["calls"] == 1
    clock.now += 61
    with pytest.raises(SourceError):
        svc.lookup("COMPSCI 61A", "2027 Spring")
    assert n["calls"] == 2


def test_service_not_offered_on_one_source_still_asks_the_next():
    def cb(course, term):
        raise NotOffered("not listed")

    svc, _ = service({"classes.berkeley.edu": cb, "berkeleytime": lambda c, t: [{"number": "001"}]})
    assert svc.lookup("COMPSCI 61A", "2027 Spring")["source"] == "berkeleytime"


def test_service_shares_one_fetch_between_simultaneous_requests():
    started, release = threading.Event(), threading.Event()
    n = {"calls": 0}

    def slow(course, term):
        n["calls"] += 1
        started.set()
        release.wait(5)
        return [{"number": "001"}]

    svc, _ = service({"berkeleytime": slow}, sources=["berkeleytime"])
    results = []
    threads = [threading.Thread(target=lambda: results.append(svc.lookup("COMPSCI 61A", "2027 Spring")))
               for _ in range(6)]
    for t in threads:
        t.start()
    assert started.wait(5)
    release.set()
    for t in threads:
        t.join(5)
    assert n["calls"] == 1 and len(results) == 6
    assert sorted(r["cached"] for r in results) == [False] + [True] * 5


def test_service_ignores_unknown_source_names():
    assert LookupService(["nope"]).sources == ["berkeleytime"]
    assert LookupService(["berkeleytime", "x"]).sources == ["berkeleytime"]


# ---- GET /lookup ------------------------------------------------------------

def call(url, token=None):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@pytest.fixture
def api(tmp_path):
    def fetch(course, term):
        if course == "MATH 1":
            raise NotOffered("no")
        if course == "MATH 2":
            raise SourceError("berkeleytime unavailable: secret-internal-detail")
        return [{"number": "001", "primary": {"classNumber": "1", "section": "001 LEC"}, "sections": []}]

    svc = LookupService(["berkeleytime"], fetchers={"berkeleytime": fetch})
    httpd = serve(Store(tmp_path), "127.0.0.1", 0, token="s3cret", lookup=svc)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def test_api_lookup(api):
    assert call(api + "/lookup?course=COMPSCI%2061A&term=2027%20Spring")[0] == 401
    code, body = call(api + "/lookup?course=compsci%2061a&term=Spring%202027", "s3cret")
    assert code == 200 and body["course"] == "COMPSCI 61A" and body["term"] == "2027 Spring"
    assert body["classes"][0]["primary"]["section"] == "001 LEC" and body["source"] == "berkeleytime"
    assert call(api + "/lookup?course=MATH%201&term=2027%20Spring", "s3cret") == (404, {"error": "not offered"})
    code, body = call(api + "/lookup?course=MATH%202&term=2027%20Spring", "s3cret")
    assert code == 502 and "secret" not in json.dumps(body)
    assert call(api + "/lookup?course=&term=2027%20Spring", "s3cret")[0] == 400
    assert call(api + "/lookup?course=COMPSCI%2061A&term=soon", "s3cret")[0] == 400
    assert call(api + "/lookup?course=" + "A" * 80 + "%201&term=2027%20Spring", "s3cret")[0] == 400


def test_api_lookup_disabled_without_a_service(tmp_path):
    httpd = serve(Store(tmp_path), "127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        assert call(f"http://127.0.0.1:{httpd.server_address[1]}/lookup?course=MATH%2053&term=2027%20Spring")[0] == 404
    finally:
        httpd.shutdown()
