"""Reddit collector: r/berkeley posts and top comments that mention a course.

Uses Reddit's API with an app's client id and secret when REDDIT_CLIENT_ID and
REDDIT_CLIENT_SECRET are set (about 100 requests a minute). Without them it falls back to
the public .json pages, which Reddit limits to roughly 10 requests a minute and blocks
from most cloud IP ranges. `parse_*` functions are pure and tested offline.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import requests

from .names import compact_code, course_aliases

SUBREDDIT = "berkeley"
USER_AGENT = "python:CalClassCoordinator.insights:v0.1 (class planner research)"


# ---------------------------------------------------------------- pure parsing


def search_query(course: str) -> str:
    """'COMPSCI 61A' -> '"CS 61A" OR "CS61A" OR "COMPSCI 61A"' (at most four forms)."""
    return " OR ".join(f'"{a}"' for a in course_aliases(course)[:4])


def mentions(course: str, text: str) -> bool:
    """True when the text names the course as a whole token ('CS 61A', not 'CS 61AS')."""
    hay = text.upper()
    for alias in course_aliases(course):
        pat = r"(?<![A-Z0-9])" + r"\s*[- ]?\s*".join(map(re.escape, re.findall(r"[A-Z&]+|\d+[A-Z]*", alias.upper()))) + r"(?![A-Z0-9])"
        if re.search(pat, hay):
            return True
    return False


def parse_search(resp: dict[str, Any], course: str) -> list[dict[str, Any]]:
    """Search listing -> posts that really mention the course, best score first."""
    out = []
    for ch in ((resp.get("data") or {}).get("children")) or []:
        d = ch.get("data") or {}
        text = f"{d.get('title') or ''}\n{d.get('selftext') or ''}"
        if d.get("over_18") or not mentions(course, text):
            continue
        out.append(
            {
                "id": d.get("id"),
                "title": (d.get("title") or "").strip(),
                "text": (d.get("selftext") or "").strip()[:1500] or None,
                "score": d.get("score") or 0,
                "comments": d.get("num_comments") or 0,
                "created": time.strftime("%Y-%m-%d", time.gmtime(d.get("created_utc") or 0)),
                "url": "https://www.reddit.com" + (d.get("permalink") or ""),
            }
        )
    out.sort(key=lambda p: (-p["score"], p["id"] or ""))
    return out


def parse_comments(resp: list[Any], limit: int = 8) -> list[dict[str, Any]]:
    """Comment page -> top-level comments, best score first."""
    if not isinstance(resp, list) or len(resp) < 2:
        return []
    out = []
    for ch in ((resp[1].get("data") or {}).get("children")) or []:
        d = ch.get("data") or {}
        body = (d.get("body") or "").strip()
        if ch.get("kind") != "t1" or not body or body in ("[deleted]", "[removed]") or d.get("stickied"):
            continue
        out.append({"text": body[:1200], "score": d.get("score") or 0})
    out.sort(key=lambda c: -c["score"])
    return out[:limit]


# ---------------------------------------------------------------- network


class Client:
    def __init__(self) -> None:
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": USER_AGENT})
        cid, secret = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
        self.base = "https://www.reddit.com"
        self.pause = 6.5
        if cid and secret:
            r = self.s.post(
                "https://www.reddit.com/api/v1/access_token",
                auth=(cid, secret),
                data={"grant_type": "client_credentials"},
                timeout=30,
            )
            r.raise_for_status()
            self.s.headers["Authorization"] = f"bearer {r.json()['access_token']}"
            self.base = "https://oauth.reddit.com"
            self.pause = 0.7

    def get(self, path: str, params: dict[str, Any]) -> Any:
        suffix = "" if self.base.startswith("https://oauth") else ".json"
        last: Exception | None = None
        for attempt in range(4):
            time.sleep(self.pause)
            try:
                r = self.s.get(f"{self.base}{path}{suffix}", params={**params, "raw_json": 1}, timeout=30)
                if r.status_code == 429:
                    time.sleep(60)
                    raise requests.HTTPError("rate limited")
                r.raise_for_status()
                return r.json()
            except Exception as e:
                last = e
                time.sleep(5 * 2**attempt)
        raise RuntimeError(f"Reddit request failed: {last}")


def collect(courses: list[str], cache_dir: Path, comment_posts: int = 2) -> None:
    """Search each course and fetch top comments for its best posts. Resumable."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    client = Client()
    for i, course in enumerate(courses):
        f = cache_dir / (compact_code(course) + ".json")
        if f.exists():
            continue
        listing = client.get(
            f"/r/{SUBREDDIT}/search",
            {"q": search_query(course), "restrict_sr": 1, "sort": "relevance", "t": "all", "limit": 50},
        )
        posts = parse_search(listing, course)[:15]
        for p in posts[:comment_posts]:
            p["topComments"] = parse_comments(client.get(f"/r/{SUBREDDIT}/comments/{p['id']}", {"sort": "top", "limit": 20}))
        f.write_text(json.dumps({"course": course, "fetchedAt": time.strftime("%Y-%m-%d"), "posts": posts}, separators=(",", ":")), encoding="utf-8")
        if i % 10 == 0:
            print(f"reddit: {i}/{len(courses)}", flush=True)


def pack(cache_dir: Path, out: Path) -> int:
    files = sorted(cache_dir.glob("*.json")) if cache_dir.exists() else []
    if not files:
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(out, "wb", mtime=0) as raw:
        for f in files:
            raw.write(f.read_bytes().strip() + b"\n")
    return len(files)


def read_snapshot(path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if path.exists():
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    rec = json.loads(line)
                    out[rec["course"]] = rec
    return out
