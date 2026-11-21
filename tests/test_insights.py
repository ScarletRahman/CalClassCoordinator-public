"""Offline tests for the class insights collectors and rating method."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from insights import berkeleytime as bt
from insights import build, reddit, rmp
from insights.names import compact_code, course_aliases, name_keys

FIX = Path(__file__).parent / "fixtures"


def load(name: str):
    return json.loads((FIX / name).read_text())


# ---------------------------------------------------------------- Berkeleytime parsing


def test_parse_course_follows_renumbering():
    c = bt.parse_course(load("bt_insights_course_eleng16a.json"))
    # ELENG 16A was renumbered; Berkeleytime answers with the course's current name
    assert (c["subject"], c["number"]) == ("ELENG", "66")
    assert 2.0 < c["grade"]["average"] < 4.0
    assert set(c["grade"]["distribution"]) <= set(build.LETTER_ORDER)
    assert c["ratings"]["Difficulty"]["n"] > 0
    assert bt.parse_course({"data": {"course": None}}) is None


def test_parse_classes_newest_first_with_instructors():
    rows = bt.parse_classes(load("bt_insights_classes_eleng16a.json"))
    keys = [(r["year"], {"Spring": 0, "Summer": 1, "Fall": 2}[r["semester"]]) for r in rows]
    assert keys == sorted(keys, reverse=True)
    fall22 = next(r for r in rows if (r["year"], r["semester"]) == (2022, "Fall"))
    assert fall22["subject"] == "EECS"  # the offering keeps the name it had that term
    assert fall22["instructors"] and all(" " in n for n in fall22["instructors"])
    assert fall22["gpa"] and fall22["enrolled"]


def test_parse_exams_counts_distinct_midterm_dates():
    ex = bt.parse_exams(load("bt_insights_exams_eleng16a_2022fall.json"))
    assert ex["midtermDates"] == ["2022-10-10", "2022-11-15"]  # one row per room in the source
    assert len(ex["finalDates"]) == 1


def test_parse_ratings_and_reviews():
    by_prof = bt.parse_instructor_ratings(load("bt_insights_ratings_eleng66.json"))
    assert by_prof and all(p["ratings"] for p in by_prof)
    reviews = bt.parse_reviews(load("bt_insights_reviews_eleng66.json"))
    assert reviews and all(set(r["metrics"]) <= set(bt.RATING_METRICS) for r in reviews)
    assert all(r["grade"] != "n/a" for r in reviews)


def test_pick_exam_classes_spreads_over_instructors():
    mk = lambda y, s, who, n=100: {"year": y, "semester": s, "number": "001", "position": "Past", "instructors": [who], "enrolled": n}
    classes = [mk(2026, "Fall", "A"), mk(2026, "Spring", "A"), mk(2025, "Fall", "A"), mk(2025, "Summer", "B"),
               mk(2025, "Spring", "B"), mk(2024, "Fall", "C", 8), mk(2015, "Fall", "D")]
    picked = bt.pick_exam_classes(classes)
    assert [(c["year"], c["semester"]) for c in picked] == [(2026, "Fall"), (2026, "Spring"), (2025, "Spring")]


def test_query_ids_match_watcher_for_shared_operations():
    from watcher.sources import berkeleytime as wbt

    q = bt.load_queries()
    assert wbt.persisted_id(q["GetClassDetails"]) == "f91a5ed8c1e0a14186c41c0cb4c4ecfa105f35929a402f43e279c59cbb59fc84"
    assert wbt.persisted_id(q["GetCourse"]) == "c3d34f9ffd39827dce61241e71fc4503393668e9d97a3ba470f3ece5eef5c80e"
    assert bt.extract_queries("x=`\n  query GetCourse($a: Int) { a }\n`;y=`query Other { b }`", {"GetCourse"}).keys() == {"GetCourse"}


# ---------------------------------------------------------------- names


def test_course_aliases_and_codes():
    assert course_aliases("COMPSCI 61A")[:2] == ["CS 61A", "CS61A"]
    assert "Data 8" in course_aliases("DATA C8")
    assert compact_code("cs-61a") == compact_code("CS 61A") == "CS61A"


def test_name_keys_drop_accents_middle_names_and_suffixes():
    assert name_keys("Hélène Marie O'Brien-Smith Jr") == ["helene smith", "h smith"]
    assert name_keys("Madonna") == []


# ---------------------------------------------------------------- RateMyProfessors

RMP_PAGE = {"data": {"newSearch": {"teachers": {
    "edges": [
        {"node": {"id": "VGVhY2hlci0x", "legacyId": 1, "firstName": "John ", "lastName": "DeNero", "department": "Computer Science",
                  "avgRating": 4.6, "avgDifficulty": 3.1, "numRatings": 120, "wouldTakeAgainPercent": 92.5, "school": {"name": "University of California Berkeley"}}},
        {"node": {"id": "VGVhY2hlci0y", "legacyId": 2, "firstName": "Jane", "lastName": "Lee", "department": "Math",
                  "avgRating": 3.0, "avgDifficulty": 4.0, "numRatings": 10, "wouldTakeAgainPercent": -1, "school": {"name": "University of California Berkeley"}}},
        {"node": {"id": "VGVhY2hlci0z", "legacyId": 3, "firstName": "Jin", "lastName": "Lee", "department": "Physics",
                  "avgRating": 4.0, "avgDifficulty": 2.0, "numRatings": 5, "wouldTakeAgainPercent": 80, "school": {"name": "University of California Berkeley"}}},
        {"node": {"id": "VGVhY2hlci00", "legacyId": 4, "firstName": "No", "lastName": "Ratings", "department": "Art",
                  "avgRating": 0, "avgDifficulty": 0, "numRatings": 0, "wouldTakeAgainPercent": -1, "school": {"name": "University of California Berkeley"}}},
    ],
    "pageInfo": {"hasNextPage": True, "endCursor": "abc"}, "resultCount": 4}}}}


def test_rmp_parse_and_match():
    profs, cursor = rmp.parse_teachers(RMP_PAGE)
    assert cursor == "abc"
    assert profs[0]["name"] == "John DeNero" and profs[0]["wouldTakeAgain"] == 92.5
    assert profs[1]["wouldTakeAgain"] is None and profs[3]["rating"] is None
    idx = rmp.build_index(profs)
    assert rmp.match(idx, "John S. DeNero")["legacyId"] == 1
    assert rmp.match(idx, "Johnny DeNero")["legacyId"] == 1  # John / Johnny: one name starts the other
    assert rmp.match(idx, "Jonathan DeNero") is None  # same initial is not enough
    assert rmp.match(idx, "Jane Lee")["legacyId"] == 2
    assert rmp.match(idx, "Jack Lee") is None  # two different J. Lees: do not guess
    assert rmp.match(idx, "No Ratings") is None
    assert rmp.SCHOOL_ID == "U2Nob29sLTEwNzI="


def test_rmp_parse_ratings():
    resp = {"data": {"node": {"ratings": {"edges": [
        {"node": {"class": "CS61A", "comment": " Great ", "date": "2025-05-01 00:00:00 +0000 UTC", "clarityRating": 5, "helpfulRating": 4,
                  "difficultyRating": 3, "wouldTakeAgain": 1, "grade": "A", "thumbsUpTotal": 2, "thumbsDownTotal": 0}}],
        "pageInfo": {"hasNextPage": False, "endCursor": None}}}}}
    rows, cursor = rmp.parse_ratings(resp)
    assert cursor is None
    assert rows == [{"class": "CS61A", "comment": "Great", "date": "2025-05-01", "quality": 4.5, "difficulty": 3,
                     "wouldTakeAgain": True, "grade": "A", "up": 2, "down": 0}]


# ---------------------------------------------------------------- Reddit


def test_reddit_mentions_whole_course_only():
    assert reddit.mentions("COMPSCI 61A", "is cs61a hard?")
    assert reddit.mentions("COMPSCI 61A", "taking CS-61A and Math 54")
    assert not reddit.mentions("COMPSCI 61A", "CS 61AS was great")
    assert not reddit.mentions("DATA C8", "data 88 is fun")
    assert reddit.search_query("COMPSCI 61A").startswith('"CS 61A" OR "CS61A"')


def test_reddit_parse_search_and_comments():
    listing = {"data": {"children": [
        {"data": {"id": "a", "title": "CS 61A advice", "selftext": "x" * 3000, "score": 5, "num_comments": 2, "created_utc": 1700000000, "permalink": "/r/berkeley/comments/a/"}},
        {"data": {"id": "b", "title": "Housing", "selftext": "no course here", "score": 99, "num_comments": 1, "created_utc": 1700000000, "permalink": "/r/berkeley/comments/b/"}},
        {"data": {"id": "c", "title": "cs61a midterm", "selftext": "", "score": 50, "num_comments": 9, "created_utc": 1700000000, "permalink": "/r/berkeley/comments/c/"}},
    ]}}
    posts = reddit.parse_search(listing, "COMPSCI 61A")
    assert [p["id"] for p in posts] == ["c", "a"]
    assert len(posts[1]["text"]) == 1500 and posts[0]["url"].endswith("/comments/c/")
    comments = [{}, {"data": {"children": [
        {"kind": "t1", "data": {"body": "low", "score": 1}},
        {"kind": "t1", "data": {"body": "[deleted]", "score": 50}},
        {"kind": "t1", "data": {"body": "top", "score": 10}},
        {"kind": "more", "data": {}},
    ]}}]
    assert [c["text"] for c in reddit.parse_comments(comments)] == ["top", "low"]


# ---------------------------------------------------------------- rating method


def test_gpa_to_difficulty_scale():
    assert build.gpa_to_difficulty(4.0) == 1.0
    assert build.gpa_to_difficulty(3.95) == 1.0
    assert build.gpa_to_difficulty(3.325) == pytest.approx(3.0)
    assert build.gpa_to_difficulty(2.0) == 5.0


def test_blend_needs_evidence_and_shrinks_thin_data():
    assert build.blend([], 3.0, 0.15) == (None, 0.0)
    one = [{"value": 5.0, "weight": 0.35, "reliability": build.reliability(1, 5)}]
    many = [{"value": 5.0, "weight": 0.35, "reliability": build.reliability(300, 5)}]
    v1, e1 = build.blend(one, 3.0, 0.15)
    v2, e2 = build.blend(many, 3.0, 0.15)
    assert 3.0 < v1 < v2 < 5.0 and e1 < e2
    assert build.confidence_label(0.6) == "high" and build.confidence_label(0.3) == "medium" and build.confidence_label(0.1) == "low"


def test_typical_midterms_ignores_terms_without_midterm_rows():
    ex = lambda n: {"midtermDates": [f"2024-0{i + 1}-01" for i in range(n)]}
    assert build.typical_midterms([ex(0), ex(2), ex(1), ex(2)]) == 2
    assert build.typical_midterms([ex(1), ex(2)]) == 1  # tie goes to the newer term
    assert build.typical_midterms([ex(0)]) is None


def _record() -> dict:
    rec = {"course": "ELENG 16A", "found": True, "fetchedAt": "2026-11-20T00:00:00Z"}
    rec.update(bt.parse_course(load("bt_insights_course_eleng16a.json")))
    rec["classes"] = bt.parse_classes(load("bt_insights_classes_eleng16a.json"))
    rec["instructorRatings"] = bt.parse_instructor_ratings(load("bt_insights_ratings_eleng66.json"))
    rec["reviews"] = bt.parse_reviews(load("bt_insights_reviews_eleng66.json"))
    rec["exams"] = [bt.parse_exams(load("bt_insights_exams_eleng16a_2022fall.json"))]
    return rec


def test_course_insight_end_to_end():
    rec = _record()
    prof = rec["classes"][0]["instructors"][0]
    fake_rmp = [{"id": "x", "legacyId": 7, "name": prof, "rating": 4.8, "difficulty": 2.0, "numRatings": 40, "wouldTakeAgain": 95.0}]
    plain = build.course_insight("ELENG 16A", rec, 2026, {}, {}, None, None)
    with_rmp = build.course_insight("ELENG 16A", rec, 2026, rmp.build_index(fake_rmp), {}, None, None)
    assert 1 <= plain["difficulty"] <= 5 and 1 <= plain["shouldTake"] <= 5
    assert plain["midterms"] == 2
    assert plain["grades"]["letter"] in ("B", "B+", "A-")
    assert "Berkeleytime" in plain["sentiment"]
    assert with_rmp["shouldTake"] > plain["shouldTake"]  # a well-rated instructor raises it
    assert with_rmp["difficulty"] < plain["difficulty"]  # and an easy one lowers difficulty
    row = next(p for p in with_rmp["byProfessor"] if p["professor"] == prof)
    assert row["rmp"] == 4.8 and row["rmpUrl"].endswith("/7") and row["wouldTakeAgain"] == 95
    assert not any(k.startswith("_") for p in with_rmp["byProfessor"] for k in p)
    # course-specific RMP reviews override the professor's overall numbers
    mine = {7: [{"class": "EE16A", "quality": 2.0, "difficulty": 5.0}] * 3}
    specific = build.course_insight("ELENG 16A", rec, 2026, rmp.build_index(fake_rmp), mine, None, None)
    row = next(p for p in specific["byProfessor"] if p["professor"] == prof)
    assert row["rmp"] == 2.0 and row["rmpForThisClass"] is True


def test_no_should_take_from_grades_alone():
    rec = _record()
    rec["ratings"], rec["instructorRatings"], rec["reviews"] = {}, [], []
    ins = build.course_insight("ELENG 16A", rec, 2026, {}, {}, None, None)
    assert "difficulty" in ins and "shouldTake" not in ins
    assert build.course_insight("X 1", {"course": "X 1", "found": False}, 2026, {}, {}, None, None) is None


def test_written_summary_feeds_sentiment_signal():
    rec = _record()
    low = build.course_insight("ELENG 16A", rec, 2026, {}, {}, None, {"summary": "Students dislike it.", "sentimentScore": 1, "evidence": 20})
    high = build.course_insight("ELENG 16A", rec, 2026, {}, {}, None, {"summary": "Students love it.", "sentimentScore": 5, "evidence": 20})
    assert low["sentiment"] == "Students dislike it." and low["sentimentWrittenBy"] == "model"
    assert high["shouldTake"] > low["shouldTake"]


def test_committed_dataset_is_current_and_well_formed():
    """data/insights must be exactly what the build produces from the committed snapshots."""
    if not (build.SNAP / "berkeleytime.jsonl.gz").exists():
        pytest.skip("no snapshot committed yet")
    assert build.main(check=True) == 0
    lean = json.loads((build.OUT / "insights.json").read_text())
    ids = {c["id"] for c in json.loads((build.DATA / "courses.json").read_text())}
    assert len(lean) > 1000 and {x["course"] for x in lean} <= ids
    for x in lean:
        assert all(1 <= x[k] <= 5 for k in ("difficulty", "shouldTake") if k in x)
