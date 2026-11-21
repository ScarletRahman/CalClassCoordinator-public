"""Berkeleytime collector: grades, student ratings, written reviews, exams and instructors.

Network code is in `Client` and `collect_*`; everything named `parse_*` is pure and is
tested offline against saved responses in tests/fixtures/.

Berkeleytime only accepts persisted operations (see docs/berkeleytime-api.md), so the query
texts in bt_queries.json are copied verbatim from the site bundle. If the site redeploys
with changed queries, run `python -m insights refresh-queries`.
"""
from __future__ import annotations

import gzip
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Iterable

import requests

from watcher.sources.berkeleytime import API_URL, SITE_URL, persisted_id

USER_AGENT = "CalClassCoordinator class insights"
QUERIES_PATH = Path(__file__).with_name("bt_queries.json")
RATING_METRICS = ("Difficulty", "Workload", "Usefulness", "Attendance", "Recording")
_SEM_ORDER = {"Spring": 0, "Summer": 1, "Fall": 2}


def load_queries() -> dict[str, str]:
    return json.loads(QUERIES_PATH.read_text(encoding="utf-8"))


def extract_queries(bundle_js: str, names: Iterable[str]) -> dict[str, str]:
    """Pull the named query texts out of the site's JS bundle."""
    found: dict[str, str] = {}
    for text in re.findall(r"`\s*((?:query|mutation)\s+\w+[^`]*)`", bundle_js):
        name = re.match(r"\w+\s+(\w+)", text).group(1)  # type: ignore[union-attr]
        if name in names:
            found[name] = text
    return found


# ---------------------------------------------------------------- pure parsing


def instructor_name(i: dict[str, Any]) -> str:
    return " ".join(p for p in ((i.get("givenName") or "").strip(), (i.get("familyName") or "").strip()) if p)


def _instructors(meetings: list[dict[str, Any]] | None) -> list[str]:
    names: list[str] = []
    for m in meetings or []:
        for i in m.get("instructors") or []:
            n = instructor_name(i)
            if n and n not in names:
                names.append(n)
    return names


def _metrics(agg: dict[str, Any] | None) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for m in (agg or {}).get("metrics") or []:
        if m.get("count"):
            out[m["metricName"]] = {"n": m["count"], "avg": round(m["weightedAverage"], 3)}
    return out


def parse_course(resp: dict[str, Any]) -> dict[str, Any] | None:
    """GetCourse -> identity, overall grade distribution, overall student ratings."""
    c = (resp.get("data") or {}).get("course")
    if not c:
        return None
    gd = c.get("gradeDistribution") or {}
    dist = {d["letter"]: d["count"] for d in gd.get("distribution") or [] if d.get("count")}
    return {
        "courseId": c.get("courseId"),
        "subject": c.get("subject"),
        "number": c.get("number"),
        "title": c.get("title"),
        "finalExam": c.get("finalExam"),
        "gradingBasis": c.get("gradingBasis"),
        "grade": {"average": round(gd["average"], 3) if gd.get("average") else None, "distribution": dist},
        "ratings": _metrics(c.get("aggregatedRatings")),
    }


def parse_classes(resp: dict[str, Any]) -> list[dict[str, Any]]:
    """GetCourseWithInstructor -> one row per past/current offering, newest first."""
    c = (resp.get("data") or {}).get("course") or {}
    rows = []
    for k in c.get("classes") or []:
        ps = k.get("primarySection") or {}
        latest = ((ps.get("enrollment") or {}).get("latest")) or {}
        gpa = (k.get("gradeDistribution") or {}).get("average")
        rows.append(
            {
                "year": k["year"],
                "semester": k["semester"],
                "number": k["number"],
                "sessionId": k.get("sessionId") or "1",
                "subject": k.get("subject"),
                "courseNumber": k.get("courseNumber"),
                "position": (k.get("term") or {}).get("temporalPosition"),
                "instructors": _instructors(ps.get("meetings")),
                "enrolled": latest.get("enrolledCount"),
                "gpa": round(gpa, 3) if gpa else None,
            }
        )
    rows.sort(key=lambda r: (r["year"], _SEM_ORDER.get(r["semester"], 0), r["number"]), reverse=True)
    return rows


def parse_instructor_ratings(resp: dict[str, Any]) -> list[dict[str, Any]]:
    """GetClassRatingsData -> student ratings split by instructor."""
    c = (resp.get("data") or {}).get("course") or {}
    out = []
    for row in c.get("instructorAggregatedRatings") or []:
        name = instructor_name(row.get("instructor") or {})
        metrics = _metrics(row.get("aggregatedRatings"))
        if name and metrics:
            out.append({"professor": name, "ratings": metrics})
    return out


def parse_reviews(resp: dict[str, Any]) -> list[dict[str, Any]]:
    """GetClassReviews -> one row per student rating; text fields are None when not written."""
    out = []
    for u in ((resp.get("data") or {}).get("classReviews") or {}).get("users") or []:
        for k in u.get("classes") or []:
            grade = k.get("reviewerGrade")
            out.append(
                {
                    "year": k.get("year"),
                    "semester": k.get("semester"),
                    "professor": k.get("professorName") or None,
                    "metrics": {m["metricName"]: m["value"] for m in k.get("metrics") or []},
                    "title": (k.get("reviewTitle") or "").strip() or None,
                    "text": (k.get("reviewContent") or "").strip() or None,
                    "grade": None if not grade or grade == "n/a" else grade,
                    "helpful": k.get("helpfulCount") or 0,
                    "updated": (k.get("lastUpdated") or "")[:10] or None,
                }
            )
    return out


def parse_exams(resp: dict[str, Any]) -> dict[str, Any] | None:
    """GetClassDetails -> distinct midterm dates and whether a final is scheduled.

    The registrar lists one exam row per room, so dates are de-duplicated.
    """
    k = (resp.get("data") or {}).get("class")
    if not k:
        return None
    ps = k.get("primarySection") or {}
    exams = ps.get("exams") or []
    mids = sorted({e["date"] for e in exams if e.get("type") == "MID" and e.get("date")})
    fins = sorted({e["date"] for e in exams if e.get("type") == "FIN" and e.get("date")})
    return {
        "year": k["year"],
        "semester": k["semester"],
        "number": k["number"],
        "instructors": _instructors(ps.get("meetings")),
        "component": ps.get("component"),
        "midtermDates": mids,
        "finalDates": fins,
        "finalExam": k.get("finalExam"),
    }


def pick_exam_classes(classes: list[dict[str, Any]], limit: int = 6, since_year: int = 2018) -> list[dict[str, Any]]:
    """Choose which offerings to ask exam data for: recent regular-term ones, spread over instructors."""
    pool = [
        c
        for c in classes
        if c["semester"] in ("Fall", "Spring")
        and c["year"] >= since_year
        and c["position"] != "Future"
        and c["instructors"]
        and (c["enrolled"] is None or c["enrolled"] >= 20)  # small seminars have no scheduled exams
    ]
    picked: list[dict[str, Any]] = []
    per_instr: dict[str, int] = {}
    for c in pool:  # newest first
        key = c["instructors"][0]
        if per_instr.get(key, 0) >= 2:
            continue
        per_instr[key] = per_instr.get(key, 0) + 1
        picked.append(c)
        if len(picked) >= limit:
            break
    return picked


def split_course_id(course: str) -> tuple[str, str]:
    subject, _, number = course.rpartition(" ")
    return subject, number


def site_url(subject: str, number: str) -> str:
    return f"{SITE_URL}/catalog?q={subject}%20{number}"


# ---------------------------------------------------------------- network


class Client:
    """Thread-safe client with a global rate limit and retries."""

    def __init__(self, rate_per_sec: float = 3.0, timeout: float = 60.0) -> None:
        self.queries = load_queries()
        self.ids = {name: persisted_id(text) for name, text in self.queries.items()}
        self.timeout = timeout
        self._interval = 1.0 / rate_per_sec
        self._lock = threading.Lock()
        self._next = 0.0
        self._local = threading.local()

    def _session(self) -> requests.Session:
        s = getattr(self._local, "s", None)
        if s is None:
            s = requests.Session()
            s.headers.update({"User-Agent": USER_AGENT, "Content-Type": "application/json"})
            self._local.s = s
        return s

    def _wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            at = max(now, self._next)
            self._next = at + self._interval
        if at > now:
            time.sleep(at - now)

    def run(self, name: str, variables: dict[str, Any] | None = None, tries: int = 5) -> dict[str, Any]:
        body: dict[str, Any] = {"id": self.ids[name]}
        if variables:
            body["variables"] = variables
        last: Exception | None = None
        for attempt in range(tries):
            self._wait()
            try:
                r = self._session().post(API_URL, data=json.dumps(body), timeout=self.timeout)
                if r.status_code == 400:
                    raise RuntimeError(f"{name}: {r.text[:200]} (query ids may be stale; run refresh-queries)")
                if r.status_code >= 429:
                    raise requests.HTTPError(f"HTTP {r.status_code}")
                r.raise_for_status()
                return r.json()
            except RuntimeError:
                raise
            except Exception as e:  # network errors, 5xx, bad JSON
                last = e
                time.sleep(min(60, 3 * 2**attempt))
        raise RuntimeError(f"{name} failed after {tries} tries: {last}")


def collect_course(client: Client, course: str, exams: bool = True) -> dict[str, Any]:
    """Everything Berkeleytime knows about one course, as a compact record."""
    subject, number = split_course_id(course)
    v = {"subject": subject, "number": number}
    rec: dict[str, Any] = {"course": course, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    info = parse_course(client.run("GetCourse", v))
    if info is None:
        rec["found"] = False
        return rec
    rec["found"] = True
    rec.update(info)
    rec["classes"] = parse_classes(client.run("GetCourseWithInstructor", {**v, "includeFormerNames": True}))
    rec["instructorRatings"] = []
    rec["reviews"] = []
    if info["ratings"]:
        # ratings are stored under the course's current Berkeleytime name
        rv = {"subject": info["subject"], "courseNumber": info["number"]}
        rec["instructorRatings"] = parse_instructor_ratings(
            client.run("GetClassRatingsData", {**rv, "courseNumberTyped": info["number"]})
        )
        rec["reviews"] = parse_reviews(client.run("GetClassReviews", rv))
    rec["exams"] = []
    if exams:
        for k in pick_exam_classes(rec["classes"]):
            try:
                ex = parse_exams(
                    client.run(
                        "GetClassDetails",
                        {
                            "year": k["year"],
                            "semester": k["semester"],
                            "sessionId": k["sessionId"],
                            "subject": k["subject"] or info["subject"],
                            "courseNumber": k["courseNumber"] or info["number"],
                            "number": k["number"],
                        },
                    )
                )
            except RuntimeError:
                ex = None
            if ex:
                rec["exams"].append(ex)
    return rec


def collect_all(courses: list[str], cache_dir: Path, workers: int = 4, rate: float = 3.0, exams: bool = True) -> None:
    """Fetch every course into cache_dir/<course>.json. Safe to stop and re-run; done courses are skipped."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    client = Client(rate_per_sec=rate)
    todo = [c for c in courses if not cache_path(cache_dir, c).exists()]
    print(f"{len(courses) - len(todo)} cached, {len(todo)} to fetch", flush=True)
    done = 0
    lock = threading.Lock()

    def work(course: str) -> None:
        nonlocal done
        try:
            rec = collect_course(client, course, exams=exams)
            tmp = cache_path(cache_dir, course).with_suffix(".tmp")
            tmp.write_text(json.dumps(rec, separators=(",", ":")), encoding="utf-8")
            tmp.rename(cache_path(cache_dir, course))
        except Exception as e:
            print(f"FAILED {course}: {e}", flush=True)
        with lock:
            done += 1
            if done % 100 == 0:
                print(f"{done}/{len(todo)}", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, todo))


def cache_path(cache_dir: Path, course: str) -> Path:
    return cache_dir / (re.sub(r"[^A-Za-z0-9]+", "_", course) + ".json")


def pack(courses: list[str], cache_dir: Path, out: Path) -> int:
    """Write the cached records into one gzipped JSON-lines snapshot that is committed."""
    have = [p for p in (cache_path(cache_dir, c) for c in courses) if p.exists()]
    if not have:  # nothing collected on this machine: leave any existing snapshot alone
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(out, "wb", mtime=0) as raw:
        for p in have:
            raw.write(p.read_bytes().strip() + b"\n")
    return len(have)


def read_snapshot(path: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return out
    with gzip.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                rec = json.loads(line)
                out[rec["course"]] = rec
    return out
