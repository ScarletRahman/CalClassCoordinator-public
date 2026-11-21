"""Combine the collected snapshots into data/insights/ and compute the two ratings.

Everything here is pure and deterministic: same snapshots in, same files out. The scoring
method is described for the owner in OWNER_NOTES.md ("Class insights") and for users in
data/insights/REPORT.md, which this script writes.
"""
from __future__ import annotations

import json
import re
import shutil
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from . import berkeleytime as bt
from . import reddit, rmp
from .names import compact_code, course_aliases, name_keys

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = DATA / "insights"
SNAP = OUT / "raw"

GRADE_POINTS = {"A+": 4.0, "A": 4.0, "A-": 3.7, "B+": 3.3, "B": 3.0, "B-": 2.7, "C+": 2.3, "C": 2.0, "C-": 1.7,
                "D+": 1.3, "D": 1.0, "D-": 0.7, "F": 0.0}
LETTER_ORDER = list(GRADE_POINTS) + ["P", "NP", "S", "U"]

# Weights of each signal. A signal's weight is multiplied by its reliability (0..1), which
# grows with the number of students behind it: n / (n + HALF[signal]).
DIFFICULTY_WEIGHTS = {"studentDifficulty": 0.35, "grades": 0.35, "workload": 0.15, "rmpDifficulty": 0.15}
SHOULD_TAKE_WEIGHTS = {"usefulness": 0.40, "teaching": 0.30, "sentiment": 0.15, "grades": 0.10, "workload": 0.05}
HALF = {"students": 5, "graded": 50, "rmp": 10, "teaching": 20, "sentiment": 4}
PRIOR_WEIGHT = 0.15  # pull toward the neutral value when evidence is thin
PRIOR = {"difficulty": 3.0, "shouldTake": 3.5}
MIN_EVIDENCE = 0.05  # below this total (weight x reliability) no rating is given
PROF_PRIOR_WEIGHT = 0.25  # professors are pulled toward their course's rating
RECENT_YEARS = 5
MAX_PROFESSORS = 8


# ---------------------------------------------------------------- scoring helpers


def clamp(x: float, lo: float = 1.0, hi: float = 5.0) -> float:
    return max(lo, min(hi, x))


def gpa_to_difficulty(gpa: float) -> float:
    """Average grade -> 1..5. A 3.95 average is 1 (easiest), 3.33 is 3, 2.7 (B-) or lower is 5."""
    return clamp(1 + 4 * (3.95 - gpa) / (3.95 - 2.70))


def reliability(n: float, half: float) -> float:
    return n / (n + half) if n > 0 else 0.0


def blend(signals: list[dict[str, Any]], prior: float, prior_weight: float) -> tuple[float | None, float]:
    """Weighted mean of signals with a prior. Returns (value or None, evidence 0..1).

    Each signal is {"value": 1..5, "weight": w, "reliability": r}. Evidence is the share of
    the total possible weight that is actually backed by data.
    """
    got = sum(s["weight"] * s["reliability"] for s in signals)
    if got < MIN_EVIDENCE:
        return None, 0.0
    total = sum(s["weight"] * s["reliability"] * s["value"] for s in signals) + prior_weight * prior
    return clamp(total / (got + prior_weight)), got


def confidence_label(evidence: float) -> str:
    return "high" if evidence >= 0.5 else "medium" if evidence >= 0.2 else "low"


def gpa_letter(gpa: float) -> str:
    return min(("A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D"), key=lambda k: abs(GRADE_POINTS[k] - gpa))


def grade_summary(grade: dict[str, Any] | None) -> dict[str, Any] | None:
    if not grade or not grade.get("average"):
        return None
    dist = grade.get("distribution") or {}
    letters = sum(v for k, v in dist.items() if k in GRADE_POINTS)
    total = sum(dist.values())
    out: dict[str, Any] = {"average": round(grade["average"], 2), "letter": gpa_letter(grade["average"]), "students": total}
    if letters:
        out["pctA"] = round(100 * sum(dist.get(k, 0) for k in ("A+", "A", "A-")) / letters)
        out["pctBelowB"] = round(100 * sum(v for k, v in dist.items() if GRADE_POINTS.get(k, 9) < 2.7) / letters)
    if total:
        out["pctPassNoPass"] = round(100 * sum(dist.get(k, 0) for k in ("P", "NP", "S", "U")) / total)
    out["distribution"] = [{"letter": k, "count": dist[k]} for k in LETTER_ORDER if dist.get(k)]
    return out


def term_key(c: dict[str, Any]) -> tuple[int, int]:
    return c["year"], {"Spring": 0, "Summer": 1, "Fall": 2}.get(c["semester"], 0)


def term_name(c: dict[str, Any]) -> str:
    return f"{c['year']} {c['semester']}"


def typical_midterms(exams: list[dict[str, Any]]) -> int | None:
    """Most common number of scheduled midterms, counting only terms where the registrar listed any.

    Many terms list only the final, so a term without midterm rows says nothing. Ties go to
    the more recent term's count. None when no term lists a midterm.
    """
    counts = [len(e["midtermDates"]) for e in exams if e.get("midtermDates")]  # newest first
    if not counts:
        return None
    best = max(Counter(counts).values())
    return next(c for c in counts if Counter(counts)[c] == best)


# ---------------------------------------------------------------- per course


def _students(rec: dict[str, Any], metric: str) -> tuple[float | None, int]:
    m = (rec.get("ratings") or {}).get(metric)
    return (m["avg"], m["n"]) if m else (None, 0)


def recent_classes(rec: dict[str, Any], now_year: int) -> list[dict[str, Any]]:
    return [c for c in rec.get("classes") or [] if c["year"] >= now_year - RECENT_YEARS + 1]


def professor_rows(rec, course, now_year, rmp_index, rmp_ratings, course_scores) -> list[dict[str, Any]]:
    by_prof: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in recent_classes(rec, now_year):
        for name in c["instructors"]:
            by_prof[name].append(c)
    exams_by_prof: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for e in rec.get("exams") or []:
        for name in e["instructors"]:
            exams_by_prof[name].append(e)
    bt_by_key = {}
    for row in rec.get("instructorRatings") or []:
        keys = name_keys(row["professor"])
        if keys:
            bt_by_key[keys[0]] = row["ratings"]
    codes = {compact_code(a) for a in course_aliases(course)}

    rows = []
    for name, classes in by_prof.items():
        past = [c for c in classes if c["position"] != "Future"]
        future = [c for c in classes if c["position"] == "Future"]
        row: dict[str, Any] = {"professor": name.title() if name.islower() else name, "terms": len({term_name(c) for c in past})}
        if past:
            row["lastTaught"] = term_name(max(past, key=term_key))
        if future:
            row["teachingNext"] = term_name(min(future, key=term_key))
        gpas = [(c["gpa"], c["enrolled"] or 30) for c in past if c.get("gpa")]
        diff_signals, take_signals = [], []
        if gpas:
            n = sum(w for _, w in gpas)
            gpa = sum(g * w for g, w in gpas) / n
            row["gpa"] = round(gpa, 2)
            r = reliability(n, HALF["graded"])
            diff_signals.append({"value": gpa_to_difficulty(gpa), "weight": DIFFICULTY_WEIGHTS["grades"], "reliability": r})
            take_signals.append({"value": 6 - gpa_to_difficulty(gpa), "weight": SHOULD_TAKE_WEIGHTS["grades"], "reliability": r})
        mids = typical_midterms(exams_by_prof.get(name, []))
        if mids is not None:
            row["midterms"] = mids
        keys = name_keys(name)
        sr = bt_by_key.get(keys[0]) if keys else None
        if sr and "Difficulty" in sr:
            n = sr["Difficulty"]["n"]
            r = reliability(n, HALF["students"])
            row["studentCount"] = n
            row["studentDifficulty"] = round(sr["Difficulty"]["avg"], 1)
            diff_signals.append({"value": sr["Difficulty"]["avg"], "weight": DIFFICULTY_WEIGHTS["studentDifficulty"], "reliability": r})
            if "Workload" in sr:
                diff_signals.append({"value": sr["Workload"]["avg"], "weight": DIFFICULTY_WEIGHTS["workload"], "reliability": r})
                take_signals.append({"value": 6 - sr["Workload"]["avg"], "weight": SHOULD_TAKE_WEIGHTS["workload"], "reliability": r})
            if "Usefulness" in sr:
                row["studentUsefulness"] = round(sr["Usefulness"]["avg"], 1)
                take_signals.append({"value": sr["Usefulness"]["avg"], "weight": SHOULD_TAKE_WEIGHTS["usefulness"], "reliability": r})
        hit = rmp.match(rmp_index, name)
        if hit:
            quality, difficulty, n = hit["rating"], hit["difficulty"], hit["numRatings"]
            # prefer what RMP reviewers said about this professor in this very course
            mine = [x for x in rmp_ratings.get(hit["legacyId"], []) if x.get("class") and compact_code(x["class"]) in codes]
            q = [x["quality"] for x in mine if x.get("quality")]
            if len(q) >= 3:
                quality, n = statistics.fmean(q), len(q)
                d = [x["difficulty"] for x in mine if x.get("difficulty")]
                difficulty = statistics.fmean(d) if d else difficulty
                row["rmpForThisClass"] = True
            if quality:
                row["rmp"] = round(quality, 1)
                row["rmpCount"] = n
                row["rmpUrl"] = f"https://www.ratemyprofessors.com/professor/{hit['legacyId']}"
                if hit.get("wouldTakeAgain") is not None:
                    row["wouldTakeAgain"] = round(hit["wouldTakeAgain"])
                take_signals.append({"value": quality, "weight": SHOULD_TAKE_WEIGHTS["teaching"], "reliability": reliability(n, HALF["rmp"])})
                row["_rmp"] = (quality, n)
            if difficulty:
                row["rmpDifficulty"] = round(difficulty, 1)
                diff_signals.append({"value": difficulty, "weight": DIFFICULTY_WEIGHTS["rmpDifficulty"], "reliability": reliability(n, HALF["rmp"])})
        d, _ = blend(diff_signals, course_scores.get("difficulty") or PRIOR["difficulty"], PROF_PRIOR_WEIGHT)
        if d is not None:
            row["difficulty"] = round(d, 1)
        # a professor's "should I take it" needs something about the teaching, not grades alone
        if any(s["weight"] in (SHOULD_TAKE_WEIGHTS["usefulness"], SHOULD_TAKE_WEIGHTS["teaching"]) for s in take_signals):
            t, _ = blend(take_signals, course_scores.get("shouldTake") or PRIOR["shouldTake"], PROF_PRIOR_WEIGHT)
            if t is not None:
                row["shouldTake"] = round(t, 1)
        row["_sort"] = (1 if future else 0, term_key(max(classes, key=term_key)), len(classes))
        rows.append(row)
    rows.sort(key=lambda r: r["_sort"], reverse=True)
    return rows[:MAX_PROFESSORS]


def teaching_signal(rec, now_year, rmp_index) -> tuple[float, int] | None:
    """RMP quality of the people who taught the course recently, weighted by how often they taught it."""
    weights: dict[str, int] = Counter()
    for c in recent_classes(rec, now_year):
        for name in c["instructors"]:
            weights[name] += 1
    num = den = n_total = 0.0
    for name, w in weights.items():
        hit = rmp.match(rmp_index, name)
        if hit and hit.get("rating"):
            num += w * hit["rating"]
            den += w
            n_total += hit["numRatings"]
    return (num / den, int(n_total)) if den else None


def rmp_course_reviews(rec, course, now_year, rmp_index, rmp_ratings) -> list[dict[str, Any]]:
    """RateMyProfessors reviews written about this course, from the professors who teach it."""
    codes = {compact_code(a) for a in course_aliases(course)}
    names = {n for c in rec.get("classes") or [] for n in c["instructors"]}
    out, seen = [], set()
    for name in sorted(names):
        hit = rmp.match(rmp_index, name)
        if not hit or hit["legacyId"] in seen:
            continue
        seen.add(hit["legacyId"])
        for x in rmp_ratings.get(hit["legacyId"], []):
            if x.get("class") and x.get("comment") and compact_code(x["class"]) in codes:
                out.append({**x, "professor": name})
    return out


def pick_reviews(rec: dict[str, Any], rmp_reviews: list[dict[str, Any]] | None = None, limit: int = 4) -> list[dict[str, Any]]:
    """Written reviews worth showing: Berkeleytime first (most helpful, then newest), then RateMyProfessors."""
    cut = lambda t: t if len(t) <= 500 else t[:497].rsplit(" ", 1)[0] + "…"
    rows = [r for r in rec.get("reviews") or [] if r.get("text") and len(r["text"]) >= 40]
    rows.sort(key=lambda r: (-r["helpful"], -(r["year"] or 0), r["text"]))
    out = []
    for r in rows[:limit]:
        item = {"text": cut(r["text"]), "term": f"{r['year']} {r['semester']}", "source": "Berkeleytime"}
        for k in ("title", "professor", "grade"):
            if r.get(k):
                item[k] = r[k]
        out.append(item)
    extra = [r for r in rmp_reviews or [] if len(r["comment"]) >= 40]
    extra.sort(key=lambda r: (r["up"] - r["down"], r.get("date") or "", r["comment"]), reverse=True)
    for r in extra[: max(2, limit - len(out))]:
        item = {"text": cut(r["comment"]), "source": "RateMyProfessors", "professor": r["professor"]}
        if r.get("date"):
            item["date"] = r["date"]
        if r.get("grade") and r["grade"] in GRADE_POINTS:
            item["grade"] = r["grade"]
        out.append(item)
    return out


def sentence(rec: dict[str, Any], grades: dict[str, Any] | None, midterms: int | None) -> str | None:
    parts = []
    d, n = _students(rec, "Difficulty")
    if n:
        w, _ = _students(rec, "Workload")
        u, _ = _students(rec, "Usefulness")
        bits = [f"{d:.1f}/5 for difficulty"]
        if w:
            bits.append(f"{w:.1f}/5 for workload")
        if u:
            bits.append(f"{u:.1f}/5 for usefulness")
        who = "1 student on Berkeleytime rates" if n == 1 else f"{n} students on Berkeleytime rate"
        parts.append(f"{who} it {', '.join(bits[:-1]) + ' and ' + bits[-1] if len(bits) > 1 else bits[0]}.")
    if grades:
        s = f"The average grade is {grades['letter']} ({grades['average']:.2f})"
        if grades.get("pctA") is not None:
            s += f", with {grades['pctA']}% of letter grades in the A range"
        parts.append(s + ".")
    if midterms is not None:
        parts.append(f"It usually has {midterms} scheduled midterm{'s' if midterms != 1 else ''}.")
    rec_m = (rec.get("ratings") or {}).get("Recording")
    att = (rec.get("ratings") or {}).get("Attendance")
    if rec_m and rec_m["n"] >= 3:
        parts.append("Lectures are usually recorded." if rec_m["avg"] >= 0.6 else "Lectures are usually not recorded." if rec_m["avg"] <= 0.3 else "")
    if att and att["n"] >= 3 and att["avg"] >= 0.6:
        parts.append("Attendance is usually required.")
    return " ".join(p for p in parts if p) or None


def course_insight(course, rec, now_year, rmp_index, rmp_ratings, reddit_rec, written) -> dict[str, Any] | None:
    """Full insight for one course, or None when nothing is known."""
    if not rec or not rec.get("found"):
        return None
    grades = grade_summary(rec.get("grade"))
    d_avg, d_n = _students(rec, "Difficulty")
    w_avg, w_n = _students(rec, "Workload")
    u_avg, u_n = _students(rec, "Usefulness")
    teach = teaching_signal(rec, now_year, rmp_index)

    diff: list[dict[str, Any]] = []
    take: list[dict[str, Any]] = []
    if d_n:
        diff.append({"name": "studentDifficulty", "label": f"Student difficulty rating ({d_n} on Berkeleytime)", "value": d_avg,
                     "reliability": reliability(d_n, HALF["students"])})
    if grades:
        gd = gpa_to_difficulty(grades["average"])
        r = reliability(grades["students"], HALF["graded"])
        diff.append({"name": "grades", "label": f"Average grade {grades['letter']} ({grades['average']:.2f})", "value": gd, "reliability": r})
        take.append({"name": "grades", "label": "Grades are forgiving" if gd < 2.75 else "Grades are tough" if gd > 3.25 else "Grades are about average", "value": 6 - gd, "reliability": r})
    if w_n:
        r = reliability(w_n, HALF["students"])
        diff.append({"name": "workload", "label": f"Student workload rating ({w_n})", "value": w_avg, "reliability": r})
        take.append({"name": "workload", "label": "Workload is light" if w_avg < 2.75 else "Workload is heavy" if w_avg > 3.25 else "Workload is about average", "value": 6 - w_avg, "reliability": r})
    if u_n:
        take.append({"name": "usefulness", "label": f"Student usefulness rating ({u_n} on Berkeleytime)", "value": u_avg,
                     "reliability": reliability(u_n, HALF["students"])})
    if teach:
        take.append({"name": "teaching", "label": f"RateMyProfessors rating of recent instructors ({teach[1]} ratings)", "value": teach[0],
                     "reliability": reliability(teach[1], HALF["teaching"])})
    rmp_diff = _rmp_difficulty(rec, now_year, rmp_index)
    if rmp_diff:
        diff.append({"name": "rmpDifficulty", "label": f"RateMyProfessors difficulty of recent instructors ({rmp_diff[1]} ratings)",
                     "value": rmp_diff[0], "reliability": reliability(rmp_diff[1], HALF["teaching"])})
    if written and written.get("sentimentScore") is not None:
        take.append({"name": "sentiment", "label": f"Tone of written student reviews ({written.get('evidence', 0)} on file)",
                     "value": clamp(float(written["sentimentScore"])), "reliability": reliability(written.get("evidence", 0), HALF["sentiment"])})
    for s in diff:
        s["weight"] = DIFFICULTY_WEIGHTS[s["name"]]
    for s in take:
        s["weight"] = SHOULD_TAKE_WEIGHTS[s["name"]]

    difficulty, d_ev = blend(diff, PRIOR["difficulty"], PRIOR_WEIGHT)
    # "should I take it" needs an opinion signal; grades and workload alone do not make a class worth taking
    has_opinion = any(s["name"] in ("usefulness", "teaching", "sentiment") for s in take)
    should, t_ev = blend(take, PRIOR["shouldTake"], PRIOR_WEIGHT) if has_opinion else (None, 0.0)

    exams = rec.get("exams") or []
    midterms = typical_midterms(exams)
    out: dict[str, Any] = {"course": course}
    if difficulty is not None:
        out["difficulty"] = round(difficulty, 1)
    if should is not None:
        out["shouldTake"] = round(should, 1)
    out["confidence"] = {k: confidence_label(v) for k, v, ok in (("difficulty", d_ev, difficulty), ("shouldTake", t_ev, should)) if ok is not None}
    fmt = lambda sigs: [{"label": s["label"], "value": round(s["value"], 1), "weight": round(s["weight"] * s["reliability"], 3)} for s in sigs]
    out["signals"] = {"difficulty": fmt(diff), "shouldTake": fmt(take) if has_opinion else []}
    if written and written.get("summary"):
        out["sentiment"] = written["summary"]
        out["sentimentWrittenBy"] = "model"
    else:
        s = sentence(rec, grades, midterms)
        if s:
            out["sentiment"] = s
    if midterms is None and written and isinstance(written.get("midterms"), int):
        midterms = written["midterms"]  # stated in student reviews; the registrar lists none
        out["midtermsSource"] = "reviews"
    if midterms is not None:
        out["midterms"] = midterms
    if rec.get("finalExam"):
        out["finalExam"] = rec["finalExam"]
    if grades:
        out["grades"] = grades
    if d_n:
        sr: dict[str, Any] = {"count": d_n, "difficulty": round(d_avg, 1)}
        if w_n:
            sr["workload"] = round(w_avg, 1)
        if u_n:
            sr["usefulness"] = round(u_avg, 1)
        for key, metric in (("recordedPct", "Recording"), ("attendanceRequiredPct", "Attendance")):
            m = (rec.get("ratings") or {}).get(metric)
            if m:
                sr[key] = round(100 * m["avg"])
        out["studentRatings"] = sr
    profs = professor_rows(rec, course, now_year, rmp_index, rmp_ratings, out)
    for p in profs:
        p.pop("_sort", None)
        p.pop("_rmp", None)
    if profs:
        out["byProfessor"] = profs
    reviews = pick_reviews(rec, rmp_course_reviews(rec, course, now_year, rmp_index, rmp_ratings))
    if reviews:
        out["reviews"] = reviews
    if reddit_rec and reddit_rec.get("posts"):
        out["reddit"] = [{"title": p["title"], "url": p["url"], "score": p["score"], "date": p["created"]} for p in reddit_rec["posts"][:5]]
    sources = [bt.site_url(rec["subject"], rec["number"])]
    if any("rmpUrl" in p for p in profs):
        sources.append(f"https://www.ratemyprofessors.com/school/{rmp.SCHOOL_LEGACY_ID}")
    if out.get("reddit"):
        sources.append(f"https://www.reddit.com/r/{reddit.SUBREDDIT}/search/?q={course_aliases(course)[0].replace(' ', '%20')}&restrict_sr=1")
    out["sources"] = sources
    has_content = any(k in out for k in ("difficulty", "shouldTake", "grades", "byProfessor", "studentRatings", "reviews", "reddit"))
    return out if has_content else None


def _rmp_difficulty(rec, now_year, rmp_index) -> tuple[float, int] | None:
    weights: dict[str, int] = Counter()
    for c in recent_classes(rec, now_year):
        for name in c["instructors"]:
            weights[name] += 1
    num = den = n_total = 0.0
    for name, w in weights.items():
        hit = rmp.match(rmp_index, name)
        if hit and hit.get("difficulty"):
            num += w * hit["difficulty"]
            den += w
            n_total += hit["numRatings"]
    return (num / den, int(n_total)) if den else None


# ---------------------------------------------------------------- whole dataset


def popularity(rec: dict[str, Any]) -> float:
    """Rough size of the audience: recent enrollment plus Berkeleytime rating count."""
    enrolled = [c["enrolled"] or 0 for c in (rec.get("classes") or [])[:6]]
    return (max(enrolled) if enrolled else 0) + 5 * ((rec.get("ratings") or {}).get("Difficulty") or {}).get("n", 0)


def popular_courses(top: int) -> list[str]:
    """Most popular course ids, from the Berkeleytime snapshot or, before it exists, a saved list."""
    snap = bt.read_snapshot(SNAP / "berkeleytime.jsonl.gz")
    if snap:
        ranked = sorted((c for c, r in snap.items() if r.get("found")), key=lambda c: (-popularity(snap[c]), c))
        return ranked[:top]
    saved = SNAP / "popular_courses.json"
    return json.loads(saved.read_text(encoding="utf-8"))[:top] if saved.exists() else []


def build() -> dict[str, str]:
    """Returns {relative path: file text} for everything under data/insights/ that is generated."""
    courses = [c["id"] for c in json.loads((DATA / "courses.json").read_text(encoding="utf-8"))]
    snap = bt.read_snapshot(SNAP / "berkeleytime.jsonl.gz")
    professors, rmp_ratings = rmp.read_snapshot(SNAP)
    rmp_index = rmp.build_index(professors)
    reddit_snap = reddit.read_snapshot(SNAP / "reddit.jsonl.gz")
    written_path = OUT / "summaries.json"
    written = json.loads(written_path.read_text(encoding="utf-8")) if written_path.exists() else {}
    fetched = sorted(r["fetchedAt"] for r in snap.values() if r.get("fetchedAt"))
    now_year = int(fetched[-1][:4]) if fetched else 2026

    full: dict[str, dict[str, Any]] = {}
    for course in courses:
        ins = course_insight(course, snap.get(course), now_year, rmp_index, rmp_ratings, reddit_snap.get(course), written.get(course))
        if ins:
            full[course] = ins

    files: dict[str, str] = {}
    lean = [
        {k: v for k, v in (("course", c), ("difficulty", i.get("difficulty")), ("shouldTake", i.get("shouldTake")),
                           ("confidence", i["confidence"].get("difficulty") or i["confidence"].get("shouldTake"))) if v is not None}
        for c, i in full.items()
        if "difficulty" in i or "shouldTake" in i
    ]
    files["insights.json"] = "[\n" + ",\n".join(json.dumps(x, separators=(",", ":")) for x in lean) + "\n]\n"
    by_subject: dict[str, dict[str, Any]] = defaultdict(dict)
    for c, i in full.items():
        by_subject[c.rpartition(" ")[0]][c] = i
    for subject, items in sorted(by_subject.items()):
        files[f"details/{subject}.json"] = json.dumps(items, indent=1, ensure_ascii=False) + "\n"
    files["REPORT.md"] = report(courses, snap, full, professors, reddit_snap, written, fetched)
    return files


def report(courses, snap, full, professors, reddit_snap, written, fetched) -> str:
    n = len(courses)
    have = lambda k: sum(1 for i in full.values() if k in i)
    conf = Counter(i["confidence"].get("difficulty") for i in full.values() if "difficulty" in i)
    profs = [p for i in full.values() for p in i.get("byProfessor", [])]
    ranked = sorted((c for c in full if c in snap), key=lambda c: -popularity(snap[c]))[:300]
    hardest = sorted((c for c in ranked if full[c].get("confidence", {}).get("difficulty") == "high"), key=lambda c: -full[c]["difficulty"])
    best = sorted((c for c in ranked if full[c].get("confidence", {}).get("shouldTake") in ("high", "medium")), key=lambda c: -full[c]["shouldTake"])
    row = lambda c: f"| {c} | {full[c].get('difficulty', '–')} | {full[c].get('shouldTake', '–')} | {full[c].get('grades', {}).get('average', '–')} | {full[c].get('midterms', '–')} |"
    head = "| Class | Difficulty | Should I take it | Avg GPA | Midterms |\n|---|---|---|---|---|"
    lines = [
        "# Class insights report",
        "",
        "Generated by `python -m insights build`. Do not edit by hand.",
        "",
        f"Berkeleytime data collected {fetched[0][:10] if fetched else 'never'} to {fetched[-1][:10] if fetched else 'never'}.",
        "",
        "## Coverage",
        "",
        "| | Classes | Share of catalog |",
        "|---|---|---|",
        f"| In the catalog (`data/courses.json`) | {n} | 100% |",
        f"| Found on Berkeleytime | {sum(1 for c in courses if snap.get(c, {}).get('found'))} | {pct(sum(1 for c in courses if snap.get(c, {}).get('found')), n)} |",
        f"| With any insight | {len(full)} | {pct(len(full), n)} |",
        f"| With a difficulty rating | {have('difficulty')} | {pct(have('difficulty'), n)} |",
        f"| With a \"should I take it\" rating | {have('shouldTake')} | {pct(have('shouldTake'), n)} |",
        f"| With grade distribution | {have('grades')} | {pct(have('grades'), n)} |",
        f"| With Berkeleytime student ratings | {have('studentRatings')} | {pct(have('studentRatings'), n)} |",
        f"| With written student reviews | {have('reviews')} | {pct(have('reviews'), n)} |",
        f"| With a typical midterm count | {have('midterms')} | {pct(have('midterms'), n)} |",
        f"| With per-professor rows | {have('byProfessor')} | {pct(have('byProfessor'), n)} |",
        f"| With Reddit threads | {have('reddit')} | {pct(have('reddit'), n)} |",
        f"| With a model-written summary | {sum(1 for i in full.values() if i.get('sentimentWrittenBy'))} | {pct(sum(1 for i in full.values() if i.get('sentimentWrittenBy')), n)} |",
        "",
        f"Difficulty confidence: {conf.get('high', 0)} high, {conf.get('medium', 0)} medium, {conf.get('low', 0)} low.",
        "",
        f"Professor rows: {len(profs)}, of which {sum(1 for p in profs if 'rmp' in p)} matched a RateMyProfessors page, "
        f"{sum(1 for p in profs if 'midterms' in p)} have a midterm count and {sum(1 for p in profs if 'gpa' in p)} have their own average grade.",
        f"RateMyProfessors snapshot: {len(professors)} professors. Reddit snapshot: {len(reddit_snap)} classes searched.",
        "",
        "## How the ratings are computed",
        "",
        "Both ratings run from 1 to 5. Each is a weighted average of the signals below. A signal's weight is multiplied by its",
        "reliability, n / (n + half), where n is the number of students behind it, so thin evidence counts for less. A neutral prior",
        f"({PRIOR['difficulty']} for difficulty, {PRIOR['shouldTake']} for should-take, weight {PRIOR_WEIGHT}) keeps one or two ratings from producing an extreme score.",
        "",
        "| Difficulty signal | Weight | Half |",
        "|---|---|---|",
        f"| Berkeleytime student difficulty rating | {DIFFICULTY_WEIGHTS['studentDifficulty']} | {HALF['students']} ratings |",
        f"| Average grade, mapped so 3.95 = 1, 3.33 = 3, 2.70 or lower = 5 | {DIFFICULTY_WEIGHTS['grades']} | {HALF['graded']} graded students |",
        f"| Berkeleytime student workload rating | {DIFFICULTY_WEIGHTS['workload']} | {HALF['students']} ratings |",
        f"| RateMyProfessors difficulty of recent instructors | {DIFFICULTY_WEIGHTS['rmpDifficulty']} | {HALF['teaching']} ratings |",
        "",
        "| Should-I-take-it signal | Weight | Half |",
        "|---|---|---|",
        f"| Berkeleytime student usefulness rating | {SHOULD_TAKE_WEIGHTS['usefulness']} | {HALF['students']} ratings |",
        f"| RateMyProfessors quality of recent instructors | {SHOULD_TAKE_WEIGHTS['teaching']} | {HALF['teaching']} ratings |",
        f"| Forgiving grades (6 minus the grade difficulty) | {SHOULD_TAKE_WEIGHTS['grades']} | {HALF['graded']} graded students |",
        f"| Manageable workload (6 minus workload) | {SHOULD_TAKE_WEIGHTS['workload']} | {HALF['students']} ratings |",
        f"| Tone of written student reviews, scored by a model | {SHOULD_TAKE_WEIGHTS['sentiment']} | {HALF['sentiment']} texts |",
        "",
        "A class gets no \"should I take it\" rating from grades and workload alone; it needs at least one opinion signal.",
        "Confidence is the share of the total weight that is backed by data: high at 50% or more, medium at 20% or more, else low.",
        "Per-professor ratings use the same signals restricted to that professor and are pulled toward the class rating.",
        "",
        "## Sanity check: hardest of the 300 most popular classes (high confidence)",
        "",
        head,
        *[row(c) for c in hardest[:15]],
        "",
        "## Sanity check: easiest of the 300 most popular classes (high confidence)",
        "",
        head,
        *[row(c) for c in hardest[::-1][:15]],
        "",
        "## Sanity check: highest \"should I take it\" among the 300 most popular classes",
        "",
        head,
        *[row(c) for c in best[:15]],
        "",
    ]
    return "\n".join(lines)


def pct(a: int, b: int) -> str:
    return f"{100 * a / b:.0f}%" if b else "0%"


def main(check: bool = False) -> int:
    files = build()
    stale = [p for p, text in files.items() if not (OUT / p).exists() or (OUT / p).read_text(encoding="utf-8") != text]
    old = [p for p in (OUT / "details").glob("*.json") if f"details/{p.name}" not in files] if (OUT / "details").exists() else []
    if check:
        if stale or old:
            print("data/insights is out of date; run python -m insights build:", stale[:5], [p.name for p in old][:5])
            return 1
        return 0
    for p in old:
        p.unlink()
    for rel, text in files.items():
        path = OUT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    print(f"wrote {len(files)} files, {len(stale)} changed")
    return 0


# ---------------------------------------------------------------- model-written summaries


def review_bundles(min_texts: int = 5, parts: int = 10) -> list[list[dict[str, Any]]]:
    """Group the written reviews of well-reviewed classes into files for a model to summarize."""
    snap = bt.read_snapshot(SNAP / "berkeleytime.jsonl.gz")
    professors, ratings = rmp.read_snapshot(SNAP)
    index = rmp.build_index(professors)
    titles = {c["id"]: c["title"] for c in json.loads((DATA / "courses.json").read_text(encoding="utf-8"))}
    items = []
    for course, rec in snap.items():
        if not rec.get("found"):
            continue
        own = [x for x in rec.get("reviews") or [] if x.get("text") and len(x["text"]) >= 40]
        own.sort(key=lambda x: (-x["helpful"], -(x["year"] or 0), x["text"]))
        theirs = [x for x in rmp_course_reviews(rec, course, 0, index, ratings) if len(x["comment"]) >= 40]
        theirs.sort(key=lambda x: (x.get("date") or "", x["comment"]), reverse=True)
        if len(own) + len(theirs) < min_texts:
            continue
        texts = [{"src": "Berkeleytime", "term": f"{x['year']} {x['semester']}",
                  "text": (f"{x['title']}: " if x.get("title") else "") + x["text"][:700]} for x in own[:20]]
        texts += [{"src": "RateMyProfessors", "date": (x.get("date") or "")[:4], "text": x["comment"][:500]} for x in theirs[:20]]
        items.append({"course": course, "title": titles.get(course), "evidence": len(own) + len(theirs), "texts": texts,
                      "_pop": popularity(rec)})
    items.sort(key=lambda i: (-i.pop("_pop"), i["course"]))
    return [items[k::parts] for k in range(parts)]


def merge_summaries(out_files: list[Path]) -> int:
    """Validate model output files ({course: {summary, sentimentScore, midterms}}) and write summaries.json."""
    evidence = {i["course"]: i["evidence"] for part in review_bundles() for i in part}
    merged: dict[str, dict[str, Any]] = {}
    for f in out_files:
        for course, row in json.loads(f.read_text(encoding="utf-8")).items():
            summary = " ".join(str(row.get("summary") or "").split()).replace("—", ", ")
            score = row.get("sentimentScore")
            if course not in evidence or not summary or len(summary) > 600 or not isinstance(score, (int, float)) or not 1 <= score <= 5:
                print(f"skipped {course} in {f.name}")
                continue
            item: dict[str, Any] = {"summary": summary, "sentimentScore": round(float(score), 1), "evidence": evidence[course]}
            if isinstance(row.get("midterms"), int) and not isinstance(row["midterms"], bool) and 0 <= row["midterms"] <= 6:
                item["midterms"] = row["midterms"]
            merged[course] = item
    text = json.dumps(dict(sorted(merged.items())), indent=1, ensure_ascii=False) + "\n"
    (OUT / "summaries.json").write_text(text, encoding="utf-8")
    return len(merged)
