#!/usr/bin/env python3
"""Download the catalog's own page data files for every program and course.

Each catalog page (https://undergraduate.catalog.berkeley.edu/programs/<id>, /courses/<id>) ships a
`_payload.json` next to it holding the full record the page renders: for a program, its requirement
tree; for a course, title, units, description, breadth areas, American Cultures flag, R&C, AH&I,
prerequisites and cross-listings. This fetches those files with plain GETs and stores a trimmed copy in
data/.cache/catalog/{program_payloads,course_payloads}/.

Needs data/.cache/catalog/programs_list.json and courses_list.json (scripts/scrape_catalog.js).
Usage: python3 scripts/fetch_payloads.py programs|courses [--workers 4] [--limit N] [--force] [--missing]

--missing (courses only) fetches just the listed courses that have no full record in the committed snapshot
data/raw/catalog/courses.json.gz. The site throttles after about 3,000 requests, so this is the way to repair
a snapshot without downloading everything again. The script exits non-zero when any download failed; run it
again until it reports 0 failed before packing (`build_requirements.py --pack` refuses an incomplete set).
"""
import concurrent.futures as cf
import gzip
import json
import os
import sys
import time
import urllib.request

sys.setrecursionlimit(100000)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "data", ".cache", "catalog")
BASE = "https://undergraduate.catalog.berkeley.edu"
WRAP = ("Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef")


def decode(arr):
    """Nuxt payloads are a flat array where objects hold indexes of their values; rebuild the tree."""
    cache = {}

    def res(i):
        if i < 0:
            return None
        if i in cache:
            return cache[i]
        v = arr[i]
        if isinstance(v, dict):
            out = {}
            cache[i] = out
            for k, x in v.items():
                out[k] = res(x)
            return out
        if isinstance(v, list):
            if v and isinstance(v[0], str):
                t = v[0]
                if t in WRAP:
                    r = res(v[1]) if len(v) > 1 else None
                    cache[i] = r
                    return r
                if t == "Set":
                    out = []
                    cache[i] = out
                    out.extend(res(x) for x in v[1:])
                    return out
                if t == "Date":
                    return v[1]
                if t in ("null", "undefined", "NaN"):
                    return None
            out = []
            cache[i] = out
            for x in v:
                out.append(res(x))
            return out
        cache[i] = v
        return v

    return res(0)


def get(url):
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "CalClassCoordinator requirements scraper"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    data = gzip.decompress(data)
                return json.loads(data)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


PROGRAM_KEEP = ["_id", "code", "programGroupId", "catalogDisplayName", "longName", "name", "type", "degreeDesignation",
                "catalogDescription", "college", "level", "departments", "status", "effectiveStartDate",
                "transcriptDescription", "requisites", "requirementLevels", "specializations", "career", "cipCode"]
COURSE_KEEP = ["courseGroupId", "deprecatedCourseGroupId", "code", "subjectCode", "courseNumber", "longName", "name", "description", "career",
               "college", "status", "credits", "crossListedCourses", "requisites", "gradeMode", "courseEquivalencies"]
COURSE_CF = ["approvedBreadthAreas", "americanCulturesRequirement", "universityRequirements", "courseProposetToMeetThe",
             "foreignLanguageAcquisitionLevelOfInstruction", "catalogAttributes", "formerCodeCatalogDisplay",
             "customOfferingPhrase", "creditRestrictionCourses", "restrictionTextFromCms", "termsOffered"]


def one(kind, ident):
    out = os.path.join(CACHE, f"{kind}_payloads", f"{ident}.json")
    data = decode(get(f"{BASE}/{kind}s/{ident}/_payload.json"))
    rec = next(iter((data.get("data") or {}).values()), None) or {}
    obj = rec.get(kind)
    if not obj:
        raise RuntimeError("payload has no " + kind)
    if kind == "program":
        slim = {k: obj.get(k) for k in PROGRAM_KEEP}
        cfs = obj.get("customFields") or {}
        slim["tags"] = {k: v for k, v in cfs.items() if isinstance(v, list) and all(isinstance(x, str) for x in v)}
    else:
        slim = {k: obj.get(k) for k in COURSE_KEEP}
        cfs = obj.get("customFields") or {}
        slim["customFields"] = {k: cfs.get(k) for k in COURSE_CF if k in cfs}
        slim["departments"] = [d.get("id") if isinstance(d, dict) else d for d in (obj.get("departments") or [])]
    with open(out, "w", encoding="utf-8") as f:
        json.dump(slim, f)
    return ident


def main():
    kind = {"programs": "program", "courses": "course"}[sys.argv[1]]
    arg = lambda n, d: (sys.argv[sys.argv.index("--" + n) + 1] if "--" + n in sys.argv else d)  # noqa: E731
    workers, limit, force = int(arg("workers", 2)), int(arg("limit", 0)), "--force" in sys.argv
    lst = json.load(open(os.path.join(CACHE, f"{kind}s_list.json"), encoding="utf-8"))
    key = "programGroupId" if kind == "program" else "courseGroupId"
    ids = list(dict.fromkeys(str(x.get(key) or x.get("code")) for x in lst))
    os.makedirs(os.path.join(CACHE, f"{kind}_payloads"), exist_ok=True)
    if not force:
        ids = [i for i in ids if not os.path.exists(os.path.join(CACHE, f"{kind}_payloads", f"{i}.json"))]
    if "--missing" in sys.argv and kind == "course":
        snap = os.path.join(ROOT, "data", "raw", "catalog", "courses.json.gz")
        with gzip.open(snap, "rt", encoding="utf-8") as f:
            rich = {str(c["courseGroupId"]) for c in json.load(f) if "breadth" in c}
        ids = [i for i in ids if i not in rich]
    if limit:
        ids = ids[:limit]
    print(f"{len(ids)} {kind} payloads to fetch", flush=True)
    ok = bad = 0
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(one, kind, i): i for i in ids}
        for fut in cf.as_completed(futs):
            try:
                fut.result()
                ok += 1
            except Exception as e:  # noqa: BLE001
                bad += 1
                print("FAILED", futs[fut], str(e)[:100], flush=True)
            if (ok + bad) % 250 == 0:
                print(f"{ok + bad}/{len(ids)} done, {bad} failed", flush=True)
    print(f"finished: {ok} ok, {bad} failed", flush=True)
    if bad:
        sys.exit(f"{bad} {kind} downloads failed; run again to retry them")


if __name__ == "__main__":
    main()
