"""Sanity checks on the committed class-time files in data/schedule/ (contract: docs/schedule.md)."""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

DIR = Path(__file__).parent.parent / "data" / "schedule"
FILES = sorted(DIR.glob("*-*.json")) if DIR.exists() else []
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

pytestmark = pytest.mark.skipif(not FILES, reason="no class-time files imported yet")


def sections_of(cls):
    return [cls["primary"], *cls["sections"]]


@pytest.fixture(scope="module", params=FILES, ids=lambda p: p.stem)
def term_file(request):
    return json.loads(request.param.read_text(encoding="utf-8")), request.param


def test_index_lists_every_file():
    index = json.loads((DIR / "index.json").read_text())
    assert sorted(t["file"] for t in index["terms"]) == [p.name for p in FILES]
    for t in index["terms"]:
        assert re.fullmatch(r"\d{4} (Spring|Summer|Fall)", t["term"])
        assert t["file"] == t["term"].lower().replace(" ", "-") + ".json"


def test_term_file_shape(term_file):
    data, path = term_file
    assert re.fullmatch(r"\d{4} (Spring|Summer|Fall)", data["term"])
    assert data["classCount"] == sum(len(v) for v in data["courses"].values())
    assert len(data["courses"]) > 500, "a regular term has well over a thousand undergraduate courses"
    assert data.get("failed", 0) <= data["classCount"] // 50
    for course, classes in data["courses"].items():
        assert re.fullmatch(r"[A-Z][A-Z0-9]* [A-Z]*\d+[A-Z0-9]*", course), course
        assert classes
        for cls in classes:
            assert cls["number"]
            for sec in sections_of(cls):
                assert sec["section"] and sec.get("classNumber", "").isdigit(), (course, sec)
                for m in sec["meetings"]:
                    assert m["days"] and all(0 <= d <= 6 for d in m["days"]), (course, sec["section"])
                    assert HHMM.match(m["start"]) and HHMM.match(m["end"]) and m["start"] < m["end"]
                for key in ("enrolled", "capacity", "waitlisted", "waitlistCapacity", "open"):
                    assert sec.get(key) is None or (isinstance(sec[key], int) and sec[key] >= 0)
            assert all("reserved" not in s for s in cls["sections"])


def test_most_lectures_have_a_time(term_file):
    data, _ = term_file
    lectures = [c["primary"] for classes in data["courses"].values() for c in classes
                if c["primary"].get("component") == "LEC"]
    with_time = [p for p in lectures if p["meetings"]]
    assert len(lectures) > 500
    assert len(with_time) / len(lectures) > 0.9


def test_no_empty_shell_sections_next_to_real_ones(term_file):
    data, _ = term_file
    for course, classes in data["courses"].items():
        for cls in classes:
            kinds_with_seats = {s["component"] for s in cls["sections"] if s.get("capacity")}
            for s in cls["sections"]:
                shell = s.get("capacity") == 0 and not s.get("enrolled") and not s.get("waitlisted")
                assert not (shell and s["component"] in kinds_with_seats), (course, s["section"])
