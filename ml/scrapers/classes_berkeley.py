#!/usr/bin/env python3
"""Scraper for https://classes.berkeley.edu/ (UCB Class Search, Drupal 11).

Produces data/enrollment/classes/sections.csv in the format described in
data/enrollment/SCHEMA.md, plus two sidecar files:
  - sections_extra.csv : class number, status, title, units, cross-listing
                         ("combination") totals and seat-reservation detail
  - term_phases.json   : enrollment phase windows listed on class pages

How the site works (discovered Nov 2026):
  * Search listing (server rendered, 18 results/page, `page=N` 0-based):
      /search/class?f[0]=term:<TERM_ID>&page=N
    Term ids come from the `term` facet (e.g. Fall 2026 = 8588). The listing
    shows primary-ish sections only (LEC/SEM/LAB/GRP/IND...; no DIS), each with
    course, section, component, class number and instructors.
  * Class page: /content/<year>-<season>-<subject>-<number>-<sec>-<comp>-<sec>
    Enrollment numbers are embedded in the drupal-settings JSON at
    `ucb.enrollment.{available,history}.enrollmentStatus` (enrolledCount,
    maxEnroll, waitlistedCount, maxWaitlist, reservedCount, openReserved,
    seatReservations[]) and `...combination` for cross-listed classes.

Stages (all resumable; raw HTML is cached gzip'd under --cache):
  list    enumerate listing pages for every term in range
  detail  fetch class pages (priority subjects first)
  build   write CSV/JSON outputs from cache

Usage:
  python3 ml/scrapers/classes_berkeley.py --stage all
  python3 ml/scrapers/classes_berkeley.py --stage detail --subjects COMPSCI,DATA
"""
from __future__ import annotations

import argparse
import csv
import gzip
import html as htmllib
import json
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from bs4 import BeautifulSoup

try:
    import lxml  # noqa: F401
    PARSER = "lxml"
except ImportError:  # pragma: no cover
    PARSER = "html.parser"

BASE = "https://classes.berkeley.edu"
REPO = Path(__file__).resolve().parents[2]
OUT_DIR = REPO / "data" / "enrollment" / "classes"
DEFAULT_CACHE = Path("/tmp/claude-0/cbcache/raw")
PER_PAGE = 18
UA = "CalClassCoordinator/0.1 (enrollment history scraper)"
HARD_TIMEOUT = 60
CURL = shutil.which("curl")

PRIORITY = ["COMPSCI", "DATA", "STAT", "MATH", "EECS", "ECON", "PHYSICS", "CHEM",
            "BIOLOGY", "MCELLBI", "PSYCH", "UGBA", "ENGLISH", "HISTORY", "POLSCI",
            "SOCIOL"]

SCHEMA_COLS = ["term", "course", "section", "component", "instructors", "capacity",
               "enrolled", "waitlisted", "waitlist_capacity", "reserved_capacity", "source"]
EXTRA_COLS = ["term", "course", "section", "component", "class_number", "title", "units",
              "status", "reserved_enrolled", "open_reserved", "min_enroll",
              "combination_id", "combination_desc", "combined_enrolled",
              "combined_capacity", "combined_waitlisted", "combined_waitlist_capacity",
              "combined_sections", "reservations_json", "snapshot", "url"]


# ---------------------------------------------------------------- HTTP ----
class Fetcher:
    def __init__(self, rate: float):
        self.min_gap = 1.0 / rate
        self.lock = threading.Lock()
        self.next_t = 0.0

    @staticmethod
    def _fetch(url: str) -> tuple[int, str]:
        """One GET with a hard wall-clock limit.

        Uses curl rather than requests: through the sandbox HTTPS proxy, requests
        connections occasionally stalled for many minutes despite read timeouts
        (bytes trickling in), freezing worker threads. curl --max-time is a hard bound.
        """
        if CURL:
            try:
                p = subprocess.run([CURL, "-sS", "--compressed", "-A", UA, "--max-time", str(HARD_TIMEOUT),
                                    "-o", "-", "-w", "\n%{http_code}", url],
                                   capture_output=True, timeout=HARD_TIMEOUT + 15)
            except subprocess.TimeoutExpired:
                return -1, ""
            out = p.stdout.decode("utf-8", "replace")
            body, _, code = out.rpartition("\n")
            try:
                return int(code), body
            except ValueError:
                return -1, ""
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=(10, HARD_TIMEOUT))
            return r.status_code, r.text
        except requests.RequestException:
            return -1, ""

    def _wait(self):
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next_t)
            self.next_t = t + self.min_gap
        if t > now:
            time.sleep(t - now)

    def get(self, url: str) -> tuple[int, str]:
        delay = 2.0
        for attempt in range(6):
            self._wait()
            code, body = self._fetch(url)
            if code in (200, 404):
                return code, body
            print(f"[http] {code} {url} (attempt {attempt + 1})", file=sys.stderr, flush=True)
            if code not in (-1, 0, 429, 500, 502, 503, 504):
                return code, ""
            time.sleep(delay)
            delay = min(delay * 2, 120)
        return -1, ""


def cache_read(p: Path) -> str | None:
    if p.exists():
        with gzip.open(p, "rt", encoding="utf-8") as f:
            return f.read()
    return None


def cache_write(p: Path, text: str):
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        f.write(text)
    tmp.replace(p)


# ---------------------------------------------------------------- terms ---
TERM_RE = re.compile(r"^(Fall|Spring|Summer)\s+(?:Sessions\s+)?(\d{4})$")


def parse_terms(html: str) -> dict[str, str]:
    """Return {'Fall 2026': '8588', ...} from the term facet."""
    out = {}
    soup = BeautifulSoup(html, PARSER)
    for a in soup.select("a[data-drupal-facet-item-id^=term-]"):
        label = a.select_one(".facet-item__value")
        if not label:
            continue
        name = " ".join(label.get_text().split())
        m = TERM_RE.match(name)
        if m:
            out[f"{m.group(1)} {m.group(2)}"] = a["data-drupal-facet-item-value"]
    return out


def term_key(t: str) -> tuple[int, int]:
    s, y = t.split()
    return int(y), {"Spring": 0, "Summer": 1, "Fall": 2}[s]


def wanted_terms(all_terms: dict[str, str], first: str, last: str, seasons) -> list[str]:
    lo, hi = term_key(first), term_key(last)
    return sorted([t for t in all_terms if lo <= term_key(t) <= hi and t.split()[0] in seasons],
                  key=term_key)


# ---------------------------------------------------------------- listing -
def parse_listing(html: str) -> tuple[int, list[dict]]:
    total = 0
    m = re.search(r"Search found\s+([\d,]+)\s+items", html)
    if m:
        total = int(m.group(1).replace(",", ""))
    # Pages are ~700 KB, mostly facet links; parse only the results block (much faster).
    i = html.find('class="view-content"')
    j = html.find('<nav class="pager', i) if i >= 0 else -1
    soup = BeautifulSoup(html[i:j] if i >= 0 and j > i else html, PARSER)
    rows = []
    for art in soup.select("article.st"):
        a = art.select_one(".st--section-name-wraper a[href^='/content/']")
        if not a:
            continue
        name = a.select_one(".st--section-name")
        counts = [s.get_text(strip=True) for s in a.select(".st--section-count")]
        code = a.select_one(".st--section-code")
        num = art.select_one(".st--section-number")
        instr = art.select_one(".st--instructors")
        title = art.select_one(".st--title h2")
        units = art.select_one(".st--details-unit")
        term_year = art.select_one(".st--term-year")
        instructors = ""
        if instr:
            raw = " ".join(instr.get_text(" ").split())
            parts = [p.strip() for p in raw.split(",") if p.strip()]
            instructors = "; ".join(parts)
        rows.append({
            "url": a["href"],
            "term_label": " ".join(term_year.get_text().split()) if term_year else "",
            "course": " ".join(name.get_text().split()) if name else "",
            "section": counts[-1] if counts else "",
            "component": code.get_text(strip=True) if code else "",
            "class_number": (num.get_text(strip=True).lstrip("#") if num else ""),
            "instructors": instructors,
            "title": " ".join(title.get_text().split()) if title else "",
            "units": " ".join(units.get_text().replace("Units:", "").split()) if units else "",
        })
    return total, rows


def stage_list(f: Fetcher, cache: Path, terms: dict[str, str], wanted: list[str], workers: int):
    for t in wanted:
        tid = terms[t]
        d = cache / "list" / tid
        first = d / "p0.html.gz"
        html = cache_read(first)
        if html is None:
            st, html = f.get(f"{BASE}/search/class?f%5B0%5D=term%3A{tid}")
            if st != 200:
                print(f"[list] {t}: page 0 failed ({st})", file=sys.stderr)
                continue
            cache_write(first, html)
        total, _ = parse_listing(html)
        pages = (total + PER_PAGE - 1) // PER_PAGE
        todo = [p for p in range(1, pages) if not (d / f"p{p}.html.gz").exists()]
        print(f"[list] {t} (id {tid}): {total} items, {pages} pages, {len(todo)} to fetch", flush=True)

        def job(p):
            st, h = f.get(f"{BASE}/search/class?f%5B0%5D=term%3A{tid}&page={p}")
            if st == 200 and ("views-row" in h or "view-content" in h):
                cache_write(d / f"p{p}.html.gz", h)
                return True
            return False

        with ThreadPoolExecutor(workers) as ex:
            fails = sum(1 for ok in ex.map(job, todo) if not ok)
        if fails:
            print(f"[list] {t}: {fails} pages failed; re-run to retry", file=sys.stderr)


def load_listing(cache: Path, terms: dict[str, str], wanted: list[str]) -> list[dict]:
    rows, seen = [], set()
    for t in wanted:
        d = cache / "list" / terms[t]
        if not d.exists():
            continue
        pages = sorted(d.glob("p*.html.gz"), key=lambda x: int(x.name[1:].split(".")[0]))
        idx = cache / "list" / f"{terms[t]}.rows.json"
        term_rows = None
        if idx.exists():
            saved = json.loads(idx.read_text())
            if saved.get("pages") == len(pages):
                term_rows = saved["rows"]
        if term_rows is None:
            term_rows = []
            for p in pages:
                term_rows.extend(parse_listing(cache_read(p))[1])
            idx.write_text(json.dumps({"pages": len(pages), "rows": term_rows}))
        for r in term_rows:
            if r["url"] in seen:
                continue
            seen.add(r["url"])
            r["term"] = t
            rows.append(r)
    return rows


def subj_of(course: str) -> str:
    return course.rsplit(" ", 1)[0] if " " in course else course


# Independent/group study and similar components: fetched last.
LOW_COMPONENTS = {"IND", "GRP", "COL", "SLF", "VOL", "INT", "CON"}


def priority_order(rows: list[dict]) -> list[dict]:
    """Fetch order: priority subjects' scheduled classes, then all subjects' scheduled
    classes, then independent/group study (IND/GRP/COL...) last; newest terms first."""
    rank = {s: i for i, s in enumerate(PRIORITY)}

    def key(r):
        low = r["component"] in LOW_COMPONENTS
        pri = subj_of(r["course"]) in rank
        tier = 0 if pri and not low else (1 if not low else 2)
        y, s = term_key(r["term"])
        return (tier, rank.get(subj_of(r["course"]), len(rank)) if tier == 0 else 0, -y, -s)

    return sorted(rows, key=key)


# ---------------------------------------------------------------- detail --
def detail_path(cache: Path, url: str) -> Path:
    slug = url.rsplit("/", 1)[-1]
    return cache / "detail" / slug[:4] / f"{slug}.html.gz"


def stage_detail(f: Fetcher, cache: Path, rows: list[dict], workers: int, limit: int | None):
    todo = [r for r in priority_order(rows) if not detail_path(cache, r["url"]).exists()]
    if limit:
        todo = todo[:limit]
    print(f"[detail] {len(rows)} sections listed, {len(todo)} to fetch", flush=True)
    done = 0
    t0 = time.time()

    def job(r):
        st, h = f.get(BASE + r["url"])
        if st == 200:
            cache_write(detail_path(cache, r["url"]), h)
        elif st == 404:
            cache_write(detail_path(cache, r["url"]), "<!-- 404 -->")
        return st

    with ThreadPoolExecutor(workers) as ex:
        futs = [ex.submit(job, r) for r in todo]
        for fu in as_completed(futs):
            done += 1
            if done % 500 == 0:
                rate = done / (time.time() - t0)
                print(f"[detail] {done}/{len(todo)} ({rate:.1f}/s, eta {(len(todo)-done)/rate/60:.0f} min)",
                      flush=True)


SETTINGS_RE = re.compile(
    r'<script type="application/json" data-drupal-selector="drupal-settings-json">(.*?)</script>', re.S)


def parse_detail(html: str) -> dict | None:
    m = SETTINGS_RE.search(html)
    if not m:
        return None
    try:
        return json.loads(m.group(1)).get("ucb", {})
    except json.JSONDecodeError:
        return None


def reserved_capacity(res: list[dict]) -> int | None:
    """Sum over reservation groups of the peak seats reserved for that group.

    Each reservation `number` can appear several times with different
    `fromDate`s (e.g. 550 seats from Phase 1, then cut to 1 when reserved
    seats are released at the start of the adjustment period). We take the
    max per number, i.e. the peak number of reserved seats.
    """
    if not res:
        return None
    peak: dict = {}
    for r in res:
        k = (r.get("number"), (r.get("requirementGroup") or {}).get("code"))
        peak[k] = max(peak.get(k, 0), int(r.get("maxEnroll") or 0))
    return sum(peak.values())


def _int(v):
    return "" if v is None else int(v)


# ---------------------------------------------------------------- build ---
def stage_build(cache: Path, rows: list[dict], out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    phases: dict[str, list] = {}
    n_ok = n_missing = n_nodata = 0
    rows = sorted(rows, key=lambda r: (term_key(r["term"]), r["course"], r["component"], r["section"]))
    with open(out_dir / "sections.csv", "w", newline="") as fo, \
            open(out_dir / "sections_extra.csv", "w", newline="") as fx:
        w = csv.DictWriter(fo, SCHEMA_COLS)
        wx = csv.DictWriter(fx, EXTRA_COLS)
        w.writeheader()
        wx.writeheader()
        for r in rows:
            html = cache_read(detail_path(cache, r["url"]))
            if html is None:
                n_missing += 1
                continue
            ucb = parse_detail(html) or {}
            enr = ucb.get("enrollment") or {}
            if r["term"] not in phases:
                ph = (ucb.get("termDetails") or {}).get("enrollmentPhases")
                if ph:
                    phases[r["term"]] = ph
            snap = "available" if enr.get("available") else ("history" if enr.get("history") else "")
            base = {"term": r["term"], "course": r["course"], "section": r["section"],
                    "component": r["component"]}
            out = dict(base, instructors=r["instructors"], source="classes.berkeley.edu",
                       capacity="", enrolled="", waitlisted="", waitlist_capacity="",
                       reserved_capacity="")
            extra = dict(base, class_number=r["class_number"], title=r["title"], units=r["units"],
                         url=BASE + r["url"], snapshot=snap)
            if snap:
                n_ok += 1
                es = enr[snap].get("enrollmentStatus") or {}
                res = es.get("seatReservations")
                if not res:
                    for alt in ("available", "history"):
                        res = ((enr.get(alt) or {}).get("enrollmentStatus") or {}).get("seatReservations")
                        if res:
                            break
                rc = reserved_capacity(res or [])
                out.update(capacity=_int(es.get("maxEnroll")), enrolled=_int(es.get("enrolledCount")),
                           waitlisted=_int(es.get("waitlistedCount")),
                           waitlist_capacity=_int(es.get("maxWaitlist")),
                           reserved_capacity="" if rc is None else rc)
                comb = enr[snap].get("combination") or {}
                extra.update(status=(es.get("status") or {}).get("description", ""),
                             reserved_enrolled=_int(es.get("reservedCount")),
                             open_reserved=_int(es.get("openReserved")),
                             min_enroll=_int(es.get("minEnroll")),
                             combination_id=comb.get("id", ""),
                             combination_desc=comb.get("description", ""),
                             combined_enrolled=_int(comb.get("enrolledCountCombinedSections")),
                             combined_capacity=_int(comb.get("maxEnrollCombinedSections")),
                             combined_waitlisted=_int(comb.get("waitlistedCountCombinedSections")),
                             combined_waitlist_capacity=_int(comb.get("maxWaitlistCombinedSections")),
                             combined_sections=";".join(map(str, comb.get("combinedSections") or [])),
                             reservations_json=json.dumps(res, separators=(",", ":")) if res else "")
            else:
                n_nodata += 1
            w.writerow(out)
            wx.writerow(extra)
    with open(out_dir / "term_phases.json", "w") as fp:
        json.dump([{"term": t, "phases": [{"name": p.get("phase_name"),
                                           "start": (p.get("phase_dates") or {}).get("value"),
                                           "end": (p.get("phase_dates") or {}).get("value2")}
                                          for p in ph],
                    "source": "classes.berkeley.edu (ucb.termDetails.enrollmentPhases)"}
                   for t, ph in sorted(phases.items(), key=lambda kv: term_key(kv[0]))], fp, indent=1)
    print(f"[build] rows with enrollment data: {n_ok}; pages without data (404/empty): {n_nodata}; "
          f"not yet fetched: {n_missing}")


# ---------------------------------------------------------------- main ----
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", choices=["list", "detail", "build", "all"], default="all")
    ap.add_argument("--first", default="Fall 2018")
    ap.add_argument("--last", default="Spring 2027")
    ap.add_argument("--seasons", default="Fall,Spring")
    ap.add_argument("--subjects", default="", help="comma list; restrict detail/build to these subjects")
    ap.add_argument("--rate", type=float, default=4.0, help="max requests/second (global)")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=None, help="max detail pages this run")
    ap.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    ap.add_argument("--out", type=Path, default=OUT_DIR)
    a = ap.parse_args()

    f = Fetcher(a.rate)
    idx = a.cache / "terms.html.gz"
    html = cache_read(idx)
    if html is None:
        st, html = f.get(f"{BASE}/search/class")
        if st != 200:
            sys.exit(f"cannot load search page ({st})")
        cache_write(idx, html)
    terms = parse_terms(html)
    wanted = wanted_terms(terms, a.first, a.last, set(a.seasons.split(",")))
    print(f"terms: {', '.join(wanted)}", flush=True)

    if a.stage in ("list", "all"):
        stage_list(f, a.cache, terms, wanted, a.workers)
    rows = load_listing(a.cache, terms, wanted)
    if a.subjects:
        keep = {s.strip().upper() for s in a.subjects.split(",")}
        rows = [r for r in rows if subj_of(r["course"]) in keep]
    if a.stage in ("detail", "all"):
        stage_detail(f, a.cache, rows, a.workers, a.limit)
    if a.stage in ("build", "all"):
        stage_build(a.cache, rows, a.out)


if __name__ == "__main__":
    main()
