"""Offline tests for the by-professor enrollment predictor, on small synthetic histories."""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("sklearn")

from ml.predictor.data import (build_observations, course_level, normalize_course,  # noqa: E402
                               primary_instructor, professor_key)
from ml.predictor.evaluate import backtest  # noqa: E402
from ml.predictor.features import HistoryStats, rolling_features  # noqa: E402
from ml.predictor.model import EnrollmentModel, _advice, _recommend, predictions_document, wait_risk  # noqa: E402
from ml.predictor.terms import calendar_for, default_calendar, load_calendars, term_key  # noqa: E402

TERMS = [f"{s} {y}" for y in range(2021, 2026) for s in ("Spring", "Fall")]


def make_obs(n_courses=40, seed=0) -> pd.DataFrame:
    """Synthetic history where popularity is driven by a course effect plus a professor effect."""
    rng = np.random.default_rng(seed)
    rows = []
    profs = [f"Pat Teacher{chr(97 + i // 26)}{chr(97 + i % 26)}" for i in range(60)]
    prof_eff = dict(zip(profs, rng.normal(0, 0.35, len(profs))))
    for c in range(n_courses):
        course = f"{'COMPSCI' if c % 2 else 'HISTORY'} {100 + c}"
        course_eff = rng.normal(0.1 if c % 2 else -0.4, 0.3)
        pool = rng.choice(profs, 3, replace=False)
        for t in TERMS:
            prof = rng.choice(pool)
            ld = course_eff + prof_eff[prof] + rng.normal(0, 0.12)
            demand = float(np.exp(ld))
            fc = 0 if ld > 0.25 else 1 if ld > 0.05 else 2 if ld > -0.05 else 3
            rows.append({"term": t, "term_key": term_key(t), "course": course,
                         "dept": course.split()[0], "level": "upper", "season": t.split()[0],
                         "professor": prof, "prof_key": professor_key(prof), "capacity": 100.0,
                         "enrolled": min(100.0, 100 * demand), "waitlisted": max(0.0, 100 * demand - 100),
                         "demand_ratio": demand, "fill_class": float(fc),
                         "fill_position": fc + 0.5 if fc < 3 else np.nan,
                         "popularity": min(demand / 1.3, 1.0), "has_series": True})
    return pd.DataFrame(rows)


def test_name_and_course_normalization():
    assert professor_key("DeNero, John N.") == professor_key("John DeNero") == "john denero"
    assert professor_key("Staff") is None and professor_key("") is None
    assert primary_instructor("The Staff; Hug, Josh") == "Josh Hug"
    assert normalize_course("compsci  61a") == "COMPSCI 61A"
    assert normalize_course("COMPSCI C100") == "COMPSCI C100"
    assert [course_level(c) for c in ("MATH 1A", "MATH 110", "MATH 202A")] == ["lower", "upper", "graduate"]


def test_calendar_positions_and_defaults():
    cal = default_calendar("Fall 2025")
    p1, p2, adj = cal.ordered()
    assert cal.estimated
    assert cal.fill_class_for(p1.start) == 0
    assert cal.fill_class_for(p2.start - timedelta(days=3)) == 1  # gap counts toward next phase
    assert cal.fill_class_for(adj.end + timedelta(days=1)) == 3
    assert 0 <= cal.position(p1.start + timedelta(days=2)) < 1
    assert cal.date_at(1.0) == p2.start
    assert calendar_for("Spring 2026", {}).phase("Phase 1").start.year == 2025


def test_load_calendars_reads_schema(tmp_path):
    f = tmp_path / "phases.json"
    f.write_text('[{"term":"Fall 2024","phases":[{"name":"Phase 1","start":"2024-04-15","end":"2024-05-03"},'
                 '{"name":"Phase 2","start":"2024-07-15","end":"2024-08-16"},'
                 '{"name":"Adjustment Period","start":"2024-08-21","end":"2024-09-18"}]}]')
    cals = load_calendars(f)
    cal = calendar_for("Fall 2024", cals)
    assert not cal.estimated and cal.phase("Phase 2").start == date(2024, 7, 15)


def test_rolling_features_never_use_the_target_term():
    obs = make_obs(6)
    feats = rolling_features(obs)
    first = feats[feats["term_key"] == feats["term_key"].min()]
    assert (first["n_course"] == 0).all() and (first["prof_seen"] == 0).all()
    last = feats[feats["term_key"] == feats["term_key"].max()]
    assert (last["n_course"] == len(TERMS) - 1).all()


def test_professor_shifts_prediction_and_shrinks_with_little_data():
    obs = make_obs(4)
    course = "COMPSCI 101"
    base = obs[obs["course"] != course]
    hot = [{"term": t, "term_key": term_key(t), "course": course, "dept": "COMPSCI", "level": "upper",
            "season": t.split()[0], "professor": p, "prof_key": professor_key(p), "capacity": 100.0,
            "enrolled": 100.0 if p == "Star Teacher" else 55.0, "waitlisted": 60.0 if p == "Star Teacher" else 0.0,
            "demand_ratio": 1.6 if p == "Star Teacher" else 0.55,
            "fill_class": 0.0 if p == "Star Teacher" else 3.0,
            "fill_position": 0.2 if p == "Star Teacher" else np.nan, "popularity": 1.0, "has_series": True,
            # Star's waitlist is long and mostly does not clear, so waiting is a real risk.
            "capacity_start": 100.0, "expansion_ratio": 1.0,
            "waitlist_peak": 60.0 if p == "Star Teacher" else 0.0,
            "waitlist_cleared": 0.2 if p == "Star Teacher" else np.nan}
           for t, p in zip(TERMS, ["Star Teacher", "Quiet Teacher"] * 5)]
    model = EnrollmentModel.fit(pd.concat([base, pd.DataFrame(hot)], ignore_index=True))
    star = model.predict("Spring 2026", course, "Star Teacher")
    quiet = model.predict("Spring 2026", course, "Quiet Teacher")
    new = model.predict("Spring 2026", course, "Never Seen")
    assert star.pFullByPhase["Phase 1"] > 0.6 > quiet.pFullByPhase["Phase 1"]
    assert star.popularity > new.popularity > quiet.popularity
    assert star.fillsInPhase == "Phase 1" and star.expectedFillDate is not None
    assert star.recommendation == "Phase 1 priority" and star.confidence == "high"
    assert quiet.fillsInPhase == "Does not fill" and quiet.expectedFillDate is None
    # A new professor falls back to the course average, between the two known ones.
    assert quiet.pFullByPhase["Phase 1"] < new.pFullByPhase["Phase 1"] < star.pFullByPhase["Phase 1"]


def test_new_professor_warning_and_fallback_levels():
    model = EnrollmentModel.fit(make_obs(8))
    seen = model.predict("Spring 2026", "COMPSCI 101", model.observations.query("course == 'COMPSCI 101'")["professor"].iloc[0])
    assert seen.professorSeenBefore and seen.basis == "professor"
    assert seen.warning is None or "New professor" not in seen.warning

    new = model.predict("Spring 2026", "COMPSCI 101", "Ada Newhire")
    assert not new.professorSeenBefore and new.basis == "course"
    assert new.warning.startswith("New professor") and "Ada Newhire" in new.warning
    assert new.confidence in ("low", "medium")

    new_course = model.predict("Spring 2026", "COMPSCI 199X", "Ada Newhire")
    assert new_course.basis == "department" and new_course.confidence == "low"
    nowhere = model.predict("Spring 2026", "BASKETWEAVING 1", "Ada Newhire")
    assert nowhere.basis == "global" and "campus-wide" in nowhere.warning

    staff = model.predict("Spring 2026", "COMPSCI 101", "Staff")
    assert staff.professor is None and "No professor is listed" in staff.warning

    other = model.observations.query("course != 'COMPSCI 101'")["professor"].iloc[0]
    moved = model.predict("Spring 2026", "COMPSCI 199X", other)
    assert moved.professorSeenBefore and moved.basis == "professor-other-courses"
    assert "has not taught" in moved.warning


def test_probabilities_are_monotone_and_bounded():
    model = EnrollmentModel.fit(make_obs(40), min_train_rows=100)
    assert model.classifiers and model.demand_model is not None
    for r in model.observations.sample(40, random_state=1).itertuples():
        p = model.predict("Spring 2026", r.course, r.professor)
        v = list(p.pFullByPhase.values())
        assert v == sorted(v) and all(0 < x < 1 for x in v)
        assert 0 <= p.popularity <= 1


def test_backtest_beats_base_rate_and_professor_helps():
    m = backtest(make_obs(40), n_test_terms=2, min_train_rows=100)["all"]
    b = m["brier_full_by_Phase 1"]
    assert b["model"] < b["base_rate"]
    assert b["model"] < b["course"]  # professor effect is real in the synthetic data
    assert m["mae_log_demand"]["model"] < m["mae_log_demand"]["course"]


def test_build_observations_from_csv_and_predictions_contract(tmp_path):
    cal = default_calendar("Fall 2024")
    p1 = cal.phase("Phase 1")
    (tmp_path / "bt").mkdir()
    ts = []
    for i in range(10):  # fills on day 4 of Phase 1
        ts.append(["Fall 2024", "COMPSCI 61A", "001", "John DeNero", (p1.start + timedelta(days=i)).isoformat(),
                   min(100, 30 * i), 100, max(0, 30 * i - 100), 50, "berkeleytime"])
        ts.append(["Fall 2024", "HISTORY 7B", "001", "", (p1.start + timedelta(days=i)).isoformat(),
                   5 * i, 100, 0, 50, "berkeleytime"])
    pd.DataFrame(ts, columns=["term", "course", "section", "instructors", "date", "enrolled", "capacity",
                              "waitlisted", "waitlist_capacity", "source"]).to_csv(tmp_path / "bt" / "timeseries.csv", index=False)
    pd.DataFrame([["Fall 2024", "HISTORY 7B", "001", "LEC", "Smith, Jane", 100, 45, 0, 50, 0, "x"],
                  ["Fall 2024", "HISTORY 7B", "101", "DIS", "Some GSI", 30, 30, 5, 5, 0, "x"],
                  ["Spring 2024", "MATH 1A", "001", "LEC", "Staff", 200, 180, 0, 50, 0, "x"]],
                 columns=["term", "course", "section", "component", "instructors", "capacity", "enrolled",
                          "waitlisted", "waitlist_capacity", "reserved_capacity", "source"]).to_csv(tmp_path / "bt" / "sections.csv", index=False)
    obs = build_observations(tmp_path).set_index("course")
    assert set(obs.index) == {"COMPSCI 61A", "HISTORY 7B", "MATH 1A"}
    assert obs.loc["COMPSCI 61A", "fill_class"] == 0 and obs.loc["COMPSCI 61A", "prof_key"] == "john denero"
    assert obs.loc["COMPSCI 61A", "fill_date"] == p1.start + timedelta(days=4)
    assert obs.loc["HISTORY 7B", "fill_class"] == 3 and obs.loc["HISTORY 7B", "prof_key"] == "jane smith"
    assert np.isnan(obs.loc["MATH 1A", "fill_class"]) and pd.isna(obs.loc["MATH 1A", "prof_key"])

    model = EnrollmentModel.fit(obs.reset_index())
    doc = predictions_document(model, "Fall 2025", pd.DataFrame(
        {"course": ["COMPSCI 61A", "COMPSCI 61A"], "professor": ["John DeNero", "New Person"],
         "capacity": [100, np.nan]}), {})
    assert set(doc) >= {"term", "generatedAt", "phases", "predictions"}
    assert [p["name"] for p in doc["phases"]] == ["Phase 1", "Phase 2", "Adjustment Period"]
    required = {"course", "professor", "professorSeenBefore", "warning", "popularity", "expectedFillDate",
                "fillsInPhase", "pFullByPhase", "recommendation", "confidence",
                "capacity", "capacityExpansion", "waitlist", "waitRisk", "advice"}
    for p in doc["predictions"]:
        assert required <= set(p)
    by_prof = {p["professor"]: p for p in doc["predictions"]}
    assert by_prof["John DeNero"]["professorSeenBefore"] and not by_prof["New Person"]["professorSeenBefore"]
    assert by_prof["New Person"]["warning"]


def test_history_stats_recency_weighting():
    obs = make_obs(2)
    c = obs["course"].iloc[0]
    old = obs.copy()
    old.loc[(old["course"] == c) & (old["term_key"] >= term_key("Fall 2024")), "demand_ratio"] = 3.0
    a = HistoryStats(obs, term_key("Spring 2026")).course_est(c)["log_demand"]
    b = HistoryStats(old, term_key("Spring 2026")).course_est(c)["log_demand"]
    assert b > a + 0.2


def _series(course, prof, days, cal):
    """days: list of (enrolled, capacity, waitlisted), one per day from the start of Phase 1."""
    start = cal.phase("Phase 1").start
    return [["Fall 2024", course, "001", prof, (start + timedelta(days=i)).isoformat(), e, c, w, 500, "berkeleytime"]
            for i, (e, c, w) in enumerate(days)]


def test_capacity_expansion_and_waitlist_clearing_from_daily_history(tmp_path):
    cal = default_calendar("Fall 2024")
    n = (cal.phase("Adjustment Period").end - cal.phase("Phase 1").start).days + 3
    grows, stuck, churn = [], [], []
    for i in range(n):
        late = i >= n - 20
        # Fills in week 2, builds a 40-person waitlist, then the department adds 60 seats.
        grows.append((min(100, 10 * i), 100, min(40, max(0, 4 * (i - 10)))) if not late else (150, 160, 0))
        # Fills, 20 wait, nobody ever gets in and they are still waiting at the deadline.
        stuck.append((min(50, 10 * i), 50, min(20, max(0, 2 * (i - 5)))))
        # Stays full while the waitlist drains from 20 to 0: drops refilled, or people giving up.
        churn.append((min(50, 10 * i), 50, min(20, max(0, 2 * (i - 5))) if not late else max(0, 20 - 2 * (i - (n - 20)))))
    (tmp_path / "bt").mkdir()
    cols = ["term", "course", "section", "instructors", "date", "enrolled", "capacity", "waitlisted",
            "waitlist_capacity", "source"]
    rows = _series("COMPSCI 61A", "John DeNero", grows, cal) + _series("HISTORY 190", "Jane Smith", stuck, cal) \
        + _series("MUSIC 20", "Ann Lee", churn, cal)
    pd.DataFrame(rows, columns=cols).to_csv(tmp_path / "bt" / "timeseries.csv", index=False)
    obs = build_observations(tmp_path).set_index("course")

    a = obs.loc["COMPSCI 61A"]
    assert a["capacity_start"] == 100 and a["capacity_max"] == 160 and a["expansion_ratio"] == pytest.approx(1.6)
    assert a["waitlist_peak"] == 40 and a["waitlist_cleared"] == pytest.approx(1.0)
    b = obs.loc["HISTORY 190"]
    assert b["expansion_ratio"] == pytest.approx(1.0)
    assert b["waitlist_peak"] == 20 and b["waitlist_end"] == 20 and b["waitlist_cleared"] == 0
    # Exits we cannot explain count as half an admit.
    assert obs.loc["MUSIC 20", "waitlist_cleared"] == pytest.approx(0.5)

    feats = rolling_features(obs.reset_index())
    assert feats.set_index("course").loc["COMPSCI 61A", "expanded"] == 1


def test_unfinished_term_does_not_count_as_no_expansion(tmp_path):
    cal = default_calendar("Fall 2024")
    (tmp_path / "bt").mkdir()
    cols = ["term", "course", "section", "instructors", "date", "enrolled", "capacity", "waitlisted",
            "waitlist_capacity", "source"]
    rows = _series("MATH 54", "A B", [(10 * i, 200, 0) for i in range(12)], cal)  # history stops in Phase 1
    pd.DataFrame(rows, columns=cols).to_csv(tmp_path / "bt" / "timeseries.csv", index=False)
    obs = build_observations(tmp_path).set_index("course")
    assert obs.loc["MATH 54", "capacity_start"] == 200
    assert np.isnan(obs.loc["MATH 54", "expansion_ratio"]) and np.isnan(obs.loc["MATH 54", "waitlist_peak"])


def test_waitlist_that_clears_lowers_the_priority():
    p = [0.9, 0.97, 0.98]
    assert wait_risk(p, 0.95) < 0.05 < 0.5 < wait_risk(p, 0.4)
    assert _recommend(p, wait_risk(p, 0.4)) == "Phase 1 priority"
    assert _recommend(p, wait_risk(p, 0.95)) == "Phase 2 is fine"
    assert _recommend([0.05, 0.1, 0.2], wait_risk([0.05, 0.1, 0.2], 0.4)) == "Adjustment period is fine"
    grows = {"pExpands": 0.8, "expectedGrowth": 0.3, "pastTerms": 9, "pastTermsExpanded": 7}
    wl = {"clearRate": 0.93, "pastTermsMeasured": 9}
    text = _advice(p, grows, wl)
    assert "93% of the waitlist" in text and "7 of 9 past terms" in text and "usually worked" in text
    assert "Enroll as early as you can" in _advice(p, grows, {"clearRate": 0.4, "pastTermsMeasured": 0})
    assert _advice([0.1, 0.2, 0.3], grows, wl) is None


def test_expansion_and_waitlist_estimates_follow_course_history():
    obs = make_obs(6)
    obs["capacity_start"] = 100.0
    cs = obs["course"].str.startswith("COMPSCI")
    obs["expansion_ratio"] = np.where(cs, 1.4, 1.0)
    obs["waitlist_peak"] = np.where(cs, 50.0, 10.0)
    obs["waitlist_cleared"] = np.where(cs, 0.95, 0.3)
    model = EnrollmentModel.fit(obs)
    grows = model.predict("Spring 2026", "COMPSCI 101", None, 100).to_dict()
    flat = model.predict("Spring 2026", "HISTORY 100", None, 100).to_dict()
    assert grows["capacityExpansion"]["pExpands"] > 0.7 > 0.2 > flat["capacityExpansion"]["pExpands"]
    assert grows["capacityExpansion"]["pastTermsExpanded"] == grows["capacityExpansion"]["pastTerms"] == 10
    assert grows["waitlist"]["clearRate"] > 0.8 > 0.5 > flat["waitlist"]["clearRate"]
    assert grows["waitlist"]["expectedPeak"] > flat["waitlist"]["expectedPeak"]
    assert 0 <= grows["waitRisk"] <= 1 and grows["capacity"] == 100
    # A brand new department falls back to campus-wide rates instead of failing.
    other = model.predict("Spring 2026", "ZZZ 1", "Nobody Known").to_dict()
    assert 0 < other["waitlist"]["clearRate"] < 1 and other["capacityExpansion"]["pastTerms"] == 0
