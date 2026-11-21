"""Offline tests for ml/scrapers/classes_berkeley.py parse functions."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures" / "classes_berkeley"
spec = importlib.util.spec_from_file_location("cb", ROOT / "ml" / "scrapers" / "classes_berkeley.py")
cb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cb)


def test_parse_terms():
    terms = cb.parse_terms((FIX / "listing_compsci.html").read_text())
    assert terms["Fall 2026"] == "8588"
    assert terms["Spring 2027"] == "8589"
    assert terms["Fall 2018"] == "7181"
    assert cb.wanted_terms(terms, "Fall 2018", "Spring 2019", {"Fall", "Spring"}) == ["Fall 2018", "Spring 2019"]


def test_parse_listing():
    total, rows = cb.parse_listing((FIX / "listing_compsci.html").read_text())
    assert total == 1732
    assert len(rows) == 18
    r = rows[0]
    assert r["url"] == "/content/2021-fall-compsci-c8-001-lec-001"
    assert r["course"] == "COMPSCI C8"
    assert (r["section"], r["component"], r["class_number"]) == ("001", "LEC", "26222")
    assert r["instructors"] == "Ani Adhikari; David Wagner"


def test_parse_detail_counts_and_reserved():
    ucb = cb.parse_detail((FIX / "detail_2021_fall_cs61a.html").read_text())
    es = ucb["enrollment"]["available"]["enrollmentStatus"]
    assert (es["enrolledCount"], es["maxEnroll"], es["maxWaitlist"]) == (1666, 1900, 500)
    res = ucb["enrollment"]["history"]["enrollmentStatus"]["seatReservations"]
    rc = cb.reserved_capacity(res)
    assert rc is not None and rc >= 550  # peak, not the post-release value of 1
    assert ucb["termDetails"]["enrollmentPhases"][0]["phase_dates"]["value"] == "2021-04-26"


def test_crosslisted_has_combination():
    ucb = cb.parse_detail((FIX / "detail_2021_fall_cs_c8_crosslisted.html").read_text())
    comb = ucb["enrollment"]["available"]["combination"]
    assert comb["enrolledCountCombinedSections"] == 1436
    assert comb["maxEnrollCombinedSections"] == 1440


def test_reserved_capacity_peak_per_group():
    res = [{"number": 1, "requirementGroup": {"code": "A"}, "maxEnroll": 550},
           {"number": 1, "requirementGroup": {"code": "A"}, "maxEnroll": 1},
           {"number": 2, "requirementGroup": {"code": "B"}, "maxEnroll": 40}]
    assert cb.reserved_capacity(res) == 590
    assert cb.reserved_capacity([]) is None
