"""RateMyProfessors collector: every professor listed for UC Berkeley, and optionally written reviews.

RMP has no documented API. The site itself talks to a GraphQL endpoint with a fixed public
Basic token, which is what this uses. `parse_*` functions are pure and tested offline.
"""
from __future__ import annotations

import base64
import gzip
import json
import time
from pathlib import Path
from typing import Any

import requests

from .names import name_keys

API_URL = "https://www.ratemyprofessors.com/graphql"
SCHOOL_LEGACY_ID = 1072  # University of California Berkeley
SCHOOL_ID = base64.b64encode(f"School-{SCHOOL_LEGACY_ID}".encode()).decode()
USER_AGENT = "Mozilla/5.0 (compatible; CalClassCoordinator class insights)"
AUTH = "Basic dGVzdDp0ZXN0"  # the public token the RMP website ships to every browser

TEACHERS_QUERY = """
query TeacherSearch($query: TeacherSearchQuery!, $first: Int!, $after: String) {
  newSearch {
    teachers(query: $query, first: $first, after: $after) {
      edges {
        node {
          id
          legacyId
          firstName
          lastName
          department
          avgRating
          avgDifficulty
          numRatings
          wouldTakeAgainPercent
          school { name }
        }
      }
      pageInfo { hasNextPage endCursor }
      resultCount
    }
  }
}
"""

RATINGS_QUERY = """
query TeacherRatings($id: ID!, $first: Int!, $after: String) {
  node(id: $id) {
    ... on Teacher {
      ratings(first: $first, after: $after) {
        edges {
          node {
            class
            comment
            date
            clarityRating
            helpfulRating
            difficultyRating
            wouldTakeAgain
            grade
            thumbsUpTotal
            thumbsDownTotal
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""


# ---------------------------------------------------------------- pure parsing


def parse_teachers(resp: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    """One search page -> (professors, cursor for the next page or None)."""
    t = resp["data"]["newSearch"]["teachers"]
    out = []
    for e in t.get("edges") or []:
        n = e["node"]
        wta = n.get("wouldTakeAgainPercent")
        out.append(
            {
                "id": n["id"],
                "legacyId": n.get("legacyId"),
                "name": f"{(n.get('firstName') or '').strip()} {(n.get('lastName') or '').strip()}".strip(),
                "department": n.get("department"),
                "rating": n.get("avgRating") or None,  # RMP reports 0 when there are no ratings
                "difficulty": n.get("avgDifficulty") or None,
                "numRatings": n.get("numRatings") or 0,
                "wouldTakeAgain": None if wta is None or wta < 0 else round(wta, 1),
                "school": (n.get("school") or {}).get("name"),
            }
        )
    page = t.get("pageInfo") or {}
    return out, (page.get("endCursor") if page.get("hasNextPage") else None)


def parse_ratings(resp: dict[str, Any]) -> tuple[list[dict[str, Any]], str | None]:
    r = ((resp.get("data") or {}).get("node") or {}).get("ratings") or {}
    out = []
    for e in r.get("edges") or []:
        n = e["node"]
        c, h = n.get("clarityRating"), n.get("helpfulRating")
        quality = (c + h) / 2 if c and h else (c or h or None)
        out.append(
            {
                "class": (n.get("class") or "").strip() or None,
                "comment": (n.get("comment") or "").strip() or None,
                "date": (n.get("date") or "")[:10] or None,
                "quality": quality,
                "difficulty": n.get("difficultyRating") or None,
                "wouldTakeAgain": {1: True, 0: False}.get(n.get("wouldTakeAgain")),
                "grade": n.get("grade") or None,
                "up": n.get("thumbsUpTotal") or 0,
                "down": n.get("thumbsDownTotal") or 0,
            }
        )
    page = r.get("pageInfo") or {}
    return out, (page.get("endCursor") if page.get("hasNextPage") else None)


def build_index(professors: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """name key -> professors with that key (only ones that have ratings)."""
    idx: dict[str, list[dict[str, Any]]] = {}
    for p in professors:
        if not p.get("numRatings"):
            continue
        for k in name_keys(p["name"]):
            idx.setdefault(k, []).append(p)
    return idx


def _same_first_name(a: str, b: str) -> bool:
    """'josh' ~ 'joshua', 'dan' ~ 'daniel', 'j' ~ 'john'; 'jane' is not 'jack'."""
    a, b = sorted((a, b), key=len)
    return b.startswith(a) and (len(a) >= 3 or len(a) == 1)


def match(index: dict[str, list[dict[str, Any]]], instructor: str) -> dict[str, Any] | None:
    """Find the RMP entry for an instructor name from the schedule of classes.

    Same first and last name wins. Otherwise the last name must match and one first name
    must be the start of the other (Josh / Joshua), and every RMP candidate with that
    initial and last name must pass, so two different 'J. Lee's are never merged. When the
    same person has several RMP pages, the one with the most ratings is used.
    """
    keys = name_keys(instructor)
    if not keys:
        return None
    full = index.get(keys[0])
    if full:
        return max(full, key=lambda p: p["numRatings"])
    first = keys[0].split()[0]
    loose = index.get(keys[1]) or []
    if loose and all(_same_first_name(first, name_keys(p["name"])[0].split()[0]) for p in loose):
        return max(loose, key=lambda p: p["numRatings"])
    return None


# ---------------------------------------------------------------- network


def _post(session: requests.Session, query: str, variables: dict[str, Any]) -> dict[str, Any]:
    last: Exception | None = None
    for attempt in range(5):
        try:
            r = session.post(API_URL, json={"query": query, "variables": variables}, timeout=60)
            r.raise_for_status()
            body = r.json()
            if body.get("errors"):
                raise RuntimeError(json.dumps(body["errors"])[:300])
            return body
        except Exception as e:
            last = e
            time.sleep(3 * 2**attempt)
    raise RuntimeError(f"RateMyProfessors request failed: {last}")


def collect(cache_dir: Path, reviews_for_top: int = 0, page_size: int = 1000, pause: float = 1.0) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers.update({"User-Agent": USER_AGENT, "Authorization": AUTH, "Content-Type": "application/json"})
    professors: list[dict[str, Any]] = []
    cursor: str | None = None
    while True:
        v = {"query": {"text": "", "schoolID": SCHOOL_ID, "fallback": False}, "first": page_size, "after": cursor}
        page, cursor = parse_teachers(_post(s, TEACHERS_QUERY, v))
        professors += page
        print(f"professors: {len(professors)}", flush=True)
        if not cursor or not page:
            break
        time.sleep(pause)
    schools = {p["school"] for p in professors}
    if not professors or any("Berkeley" not in (x or "") for x in schools):
        raise SystemExit(f"unexpected school in results: {schools}")
    (cache_dir / "professors.json").write_text(json.dumps(professors, separators=(",", ":")), encoding="utf-8")

    if reviews_for_top:
        top = sorted(professors, key=lambda p: -p["numRatings"])[:reviews_for_top]
        out = cache_dir / "ratings"
        out.mkdir(exist_ok=True)
        for i, p in enumerate(top):
            f = out / f"{p['legacyId']}.json"
            if f.exists():
                continue
            rows: list[dict[str, Any]] = []
            cur: str | None = None
            while len(rows) < 300:
                page, cur = parse_ratings(_post(s, RATINGS_QUERY, {"id": p["id"], "first": 100, "after": cur}))
                rows += page
                if not cur or not page:
                    break
                time.sleep(pause)
            f.write_text(json.dumps({"legacyId": p["legacyId"], "name": p["name"], "ratings": rows}, separators=(",", ":")), encoding="utf-8")
            if i % 25 == 0:
                print(f"reviews: {i}/{len(top)}", flush=True)
            time.sleep(pause)


def pack(cache_dir: Path, snap_dir: Path) -> int:
    src = cache_dir / "professors.json"
    if not src.exists():
        return 0
    snap_dir.mkdir(parents=True, exist_ok=True)
    professors = json.loads(src.read_text(encoding="utf-8"))
    (snap_dir / "rmp_professors.json").write_text(json.dumps(professors, separators=(",", ":")) + "\n", encoding="utf-8")
    files = sorted((cache_dir / "ratings").glob("*.json")) if (cache_dir / "ratings").exists() else []
    if files:
        with gzip.GzipFile(snap_dir / "rmp_ratings.jsonl.gz", "wb", mtime=0) as raw:
            for f in files:
                raw.write(f.read_bytes().strip() + b"\n")
    return len(professors)


def read_snapshot(snap_dir: Path) -> tuple[list[dict[str, Any]], dict[int, list[dict[str, Any]]]]:
    p = snap_dir / "rmp_professors.json"
    professors = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
    ratings: dict[int, list[dict[str, Any]]] = {}
    r = snap_dir / "rmp_ratings.jsonl.gz"
    if r.exists():
        with gzip.open(r, "rt", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    rec = json.loads(line)
                    ratings[rec["legacyId"]] = rec["ratings"]
    return professors, ratings
