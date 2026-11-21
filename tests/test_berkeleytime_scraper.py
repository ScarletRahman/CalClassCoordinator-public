"""Offline tests for ml/scrapers/berkeleytime.py parse functions."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures" / "berkeleytime"
spec = importlib.util.spec_from_file_location("bt", ROOT / "ml" / "scrapers" / "berkeleytime.py")
bt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bt)


def test_persisted_id_matches_bundle_hash():
    # id the Berkeleytime web client sends for GetClass (sha256 of minified query, derived from its JS bundle)
    assert hashlib.sha256(bt.QUERIES["GetClass"].encode()).hexdigest() == "79775dae18f1f702ad5c0d177254b33b973f126c5e21750cb7b5569ec5146a87"


def test_parse_class_timeseries_and_sections():
    c = json.loads((FIX / "getclass_compsci61a_fa24.json").read_text())["data"]["class"]
    ts, secs = bt.parse_class(c)
    assert bt.TS_COLS == ["term", "course", "section", "instructors", "date", "enrolled", "capacity",
                          "waitlisted", "waitlist_capacity", "source"]
    # run-length entries are inclusive: 04-04..04-22 (19 days) + 4 single days + 04-27..04-28 (2 days)
    assert len(ts) == 25
    assert ts[0] == ["Fall 2024", "COMPSCI 61A", "001", "John DeNero", "2024-04-04", 0, 1300, 0, 500, "berkeleytime"]
    assert ts[18][4] == "2024-04-22" and ts[19][4:6] == ["2024-04-23", 24]
    assert ts[-1][4:6] == ["2024-04-28", 67]
    assert len({r[4] for r in ts}) == len(ts)
    prim = secs[0]
    assert prim[:5] == ["Fall 2024", "COMPSCI 61A", "001", "LEC", "John DeNero"]
    assert prim[5:10] == [1375, 1210, 0, 500, 0]
    assert [(s[2], s[3]) for s in secs[1:]] == [("101L", "LAB"), ("102", "DIS")]


def test_select_terms_newest_first_without_summer():
    terms = [(2024, "Spring"), (2024, "Summer"), (2024, "Fall"), (2025, "Spring")]
    assert bt.select_terms(terms, "Spring 2024-Fall 2024", False) == [(2024, "Fall"), (2024, "Spring")]
    assert bt.select_terms(terms, "Fall 2024,Spring 2025", False) == [(2025, "Spring"), (2024, "Fall")]
