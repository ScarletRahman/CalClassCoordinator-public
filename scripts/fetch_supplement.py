#!/usr/bin/env python3
"""Fill in courses that the enrollment data knows but the current catalog no longer publishes.

The catalog (undergraduate.catalog.berkeley.edu) lists only courses that are active in the catalog year.
Students still have retired or renumbered courses on their transcripts (EECS 16A, COMPSCI 88, ...), and the
enrollment history and predictions refer to them. This script finds every undergraduate course id
(number below 200) that appears in data/enrollment/{berkeleytime,classes}/sections.csv or
data/predictions/predictions.json but not in the catalog snapshot, asks Berkeleytime for its title, units
and description (one `GetClass` request per course, for the latest term it was offered), and writes
data/raw/supplement/courses.json. scripts/build_requirements.py merges that file for ids the catalog
lacks and marks those records `"source": "berkeleytime"`.

Usage: python3 scripts/fetch_supplement.py [--rps 2] [--limit N]
Existing entries are kept, so a re-run only asks for courses that are new. Needs `requests` and network
access to berkeleytime.com.
"""
import csv
import gzip
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
OUT = os.path.join(ROOT, "data", "raw", "supplement", "courses.json")
SECTIONS = os.path.join(ROOT, "data", "enrollment", "berkeleytime", "sections.csv")
CLASSES = os.path.join(ROOT, "data", "enrollment", "classes", "sections.csv")
PREDICTIONS = os.path.join(ROOT, "data", "predictions", "predictions.json")
SEASON = {"Spring": 0, "Summer": 1, "Fall": 2}


def undergraduate(cid):
    digits = re.sub(r"\D", "", cid.rsplit(" ", 1)[-1])
    return bool(digits) and int(digits) < 200


def catalog_ids():
    with gzip.open(os.path.join(ROOT, "data", "raw", "catalog", "courses.json.gz"), "rt", encoding="utf-8") as f:
        return {f"{c['subjectCode']} {c['courseNumber']}".upper().strip() for c in json.load(f)}


def wanted():
    """course id -> (term, section) of the latest term it was offered ("" when only predictions know it)."""
    have = catalog_ids()
    latest = {}
    rows = []
    for path in (SECTIONS, CLASSES):
        if os.path.exists(path):
            with open(path, encoding="utf-8", newline="") as f:
                rows += list(csv.DictReader(f))
    if True:
        for r in rows:
            cid = r["course"].upper().strip()
            if cid in have or not undergraduate(cid):
                continue
            season, year = r["term"].split(" ")
            key = (int(year), SEASON.get(season, 0), r["component"] == "LEC", -int(re.sub(r"\D", "", r["section"]) or 0))
            if cid not in latest or key > latest[cid][0]:
                latest[cid] = (key, r["term"], r["section"])
    out = {cid: (term, section) for cid, (_, term, section) in latest.items()}
    if os.path.exists(PREDICTIONS):
        with open(PREDICTIONS, encoding="utf-8") as f:
            for p in json.load(f).get("predictions", []):
                cid = p["course"].upper().strip()
                if cid not in have and undergraduate(cid):
                    out.setdefault(cid, ("", ""))
    return out


def record(cid, term, data):
    """Pure: one GetClass `data.class` payload -> supplement record."""
    course = data.get("course") or {}
    # the title the class had when it was offered under this id; the course-level title is the lineage's current one
    return {"id": cid, "title": (data.get("title") or course.get("title") or "").strip(),
            "unitsMin": data.get("unitsMin"), "unitsMax": data.get("unitsMax"),
            "description": (course.get("description") or data.get("description") or "").strip(),
            "lastOffered": term, "source": "berkeleytime"}


def main():
    from pathlib import Path

    from ml.scrapers.berkeleytime import DEFAULT_CACHE, Client
    arg = lambda n, d: (sys.argv[sys.argv.index("--" + n) + 1] if "--" + n in sys.argv else d)  # noqa: E731
    existing = {}
    if os.path.exists(OUT):
        with open(OUT, encoding="utf-8") as f:
            existing = {c["id"]: c for c in json.load(f)}
    todo = {cid: v for cid, v in wanted().items() if cid not in existing}
    have = catalog_ids()
    existing = {cid: c for cid, c in existing.items() if cid not in have}  # the catalog has it again: drop ours
    print(f"{len(existing)} supplement courses on file, {len(todo)} to look up", flush=True)
    client = Client(Path(arg("cache", str(DEFAULT_CACHE))), float(arg("rps", 2)))
    failed = []
    for n, (cid, (term, section)) in enumerate(sorted(todo.items())):
        if int(arg("limit", 0)) and n >= int(arg("limit", 0)):
            break
        if not term:
            failed.append(f"{cid}: only in the predictions file, no term to look it up in")
            continue
        season, year = term.split(" ")
        subject, number = cid.rsplit(" ", 1)
        data = None
        for session in ("1", "6W1", "8W", "6W2", "10W", "3W1", "12W"):  # regular session first, then the summer sessions
            v = {"year": int(year), "semester": season, "sessionId": session, "subject": subject, "courseNumber": number, "number": section}
            try:
                data = (client.query("GetClass", v, attempts=2).get("data") or {}).get("class")
            except Exception as e:  # noqa: BLE001
                data = None
                err = str(e)[:80]
            if data or season != "Summer":
                break
        if not data:
            failed.append(f"{cid} ({term} {section}): not found" + (f" [{err}]" if "err" in dir() else ""))
            continue
        existing[cid] = record(cid, term, data)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("[\n" + ",\n".join(json.dumps(existing[k], ensure_ascii=False, sort_keys=True) for k in sorted(existing)) + "\n]\n")
    print(f"wrote {len(existing)} courses to {OUT}")
    if failed:
        # Not fatal here: build_requirements.py --strict fails if a course the predictions use is still missing.
        print(f"{len(failed)} not resolved (Berkeleytime has no record):\n  " + "\n  ".join(failed))


if __name__ == "__main__":
    main()
