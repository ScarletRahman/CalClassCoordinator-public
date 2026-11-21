"""By-professor enrollment model: popularity and when a class fills.

Two layers:
1. `HistoryStats` (features.py): hierarchical shrinkage estimates per professor/course/dept.
   This alone is a usable predictor and is what we fall back to with little data.
2. Gradient-boosted models on top of those estimates (plus capacity, season, level and
   history counts) that learn how much to trust each level:
   - three classifiers for P(full by end of Phase 1 / Phase 2 / Adjustment Period)
   - one regressor for log demand ratio ((enrolled + waitlisted) / capacity)
   They are only used when enough labelled history exists (MIN_TRAIN_ROWS).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor

from .data import (POPULARITY_SATURATION, course_level, department, display_name, normalize_course,
                   professor_key)
from .features import (BERNOULLI_STATS, FEATURE_COLUMNS, HistoryStats, add_targets, feature_row,
                       rolling_features)
from .terms import (FILL_CLASSES, PHASE_NAMES, TermCalendar, calendar_for, normalize_term,
                    parse_term, term_key)

MIN_TRAIN_ROWS = 300
MODEL_VERSION = 2
# Phase 1 unit cap for continuing undergraduates (data/enrollment/calendar/appointments.md).
PHASE1_UNIT_CAP = 13.5


def _gbc() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(max_depth=3, learning_rate=0.06, max_iter=200,
                                          l2_regularization=1.0, min_samples_leaf=20,
                                          early_stopping=False, random_state=0)


def _gbr() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(max_depth=3, learning_rate=0.06, max_iter=200,
                                         l2_regularization=1.0, min_samples_leaf=20,
                                         early_stopping=False, random_state=0)


@dataclass
class Prediction:
    course: str
    professor: str | None
    professorSeenBefore: bool
    warning: str | None
    popularity: float
    expectedFillDate: str | None
    fillsInPhase: str
    pFullByPhase: dict[str, float]
    recommendation: str
    confidence: str
    basis: str
    historyTerms: int
    expectedDemandRatio: float
    capacity: float | None = None
    capacityExpansion: dict | None = None
    waitlist: dict | None = None
    waitRisk: float | None = None
    advice: str | None = None

    def to_dict(self) -> dict:
        return self.__dict__.copy()


@dataclass
class EnrollmentModel:
    observations: pd.DataFrame
    classifiers: dict[str, HistGradientBoostingClassifier] = field(default_factory=dict)
    demand_model: HistGradientBoostingRegressor | None = None
    trained_rows: int = 0
    version: int = MODEL_VERSION
    _stats_cache: dict[int, HistoryStats] = field(default_factory=dict, repr=False)

    # ---------- training ----------
    @classmethod
    def fit(cls, observations: pd.DataFrame, min_train_rows: int = MIN_TRAIN_ROWS) -> "EnrollmentModel":
        obs = add_targets(observations)
        model = cls(observations=obs)
        if obs.empty:
            return model
        feats = rolling_features(observations)
        # The earliest term has no history at all; its features are pure priors, skip it.
        feats = feats[feats["term_key"] > feats["term_key"].min()]
        X = feats[FEATURE_COLUMNS]
        dem = feats["log_demand"].notna()
        if dem.sum() >= min_train_rows:
            model.demand_model = _gbr().fit(X[dem], feats.loc[dem, "log_demand"])
        for s in BERNOULLI_STATS:
            lab = feats[s].notna()
            y = feats.loc[lab, s].astype(int)
            if lab.sum() >= min_train_rows and min(y.sum(), len(y) - y.sum()) >= 15:
                model.classifiers[s] = _gbc().fit(X[lab], y)
        model.trained_rows = int(feats[BERNOULLI_STATS[0]].notna().sum())
        return model

    # ---------- inference ----------
    def _stats(self, tk: int) -> HistoryStats:
        if tk not in self._stats_cache:
            self._stats_cache[tk] = HistoryStats(self.observations[self.observations["term_key"] < tk], tk)
        return self._stats_cache[tk]

    def predict_raw(self, term: str, course: str, professor: str | None,
                    capacity: float | None = None) -> dict:
        course = normalize_course(course)
        tk = term_key(term)
        pk = professor_key(professor)
        stats = self._stats(tk)
        row, est = feature_row(stats, course, pk, capacity or np.nan, parse_term(term)[0],
                               course_level(course))
        X = pd.DataFrame([row])[FEATURE_COLUMNS]
        p = [est.values[s] for s in BERNOULLI_STATS]
        for i, s in enumerate(BERNOULLI_STATS):
            if s in self.classifiers:
                # Blend learned model with the shrinkage estimate; lean on shrinkage
                # when the model has never seen anything like this (no course history).
                w = 0.7 if est.n_course else 0.4
                p[i] = w * float(self.classifiers[s].predict_proba(X)[0, 1]) + (1 - w) * p[i]
        p = list(np.maximum.accumulate(np.clip(p, 0.01, 0.99)))
        log_d = est.values["log_demand"]
        if self.demand_model is not None:
            w = 0.7 if est.n_course else 0.4
            log_d = w * float(self.demand_model.predict(X)[0]) + (1 - w) * log_d
        return {"p_full": p, "log_demand": log_d, "est": est, "course": course, "prof_key": pk}

    def predict(self, term: str, course: str, professor: str | None,
                capacity: float | None = None, calendar: TermCalendar | None = None) -> Prediction:
        raw = self.predict_raw(term, course, professor, capacity)
        est, p = raw["est"], raw["p_full"]
        cal = calendar or calendar_for(term, {})
        names = [ph.name for ph in cal.ordered()]
        p_by = {n: round(float(p[PHASE_NAMES.index(n)]), 3) for n in names}
        fills_in = next((n for n in names if p_by[n] >= 0.5), FILL_CLASSES[-1])

        fill_date = None
        if fills_in != FILL_CLASSES[-1]:
            i = PHASE_NAMES.index(fills_in)
            prev = p[i - 1] if i else 0.0
            # Where inside the phase the cumulative probability crosses 50%, nudged by the
            # historical within-phase position when this professor/course has one.
            frac = float(np.clip((0.5 - prev) / max(p[i] - prev, 1e-6), 0.02, 1.0))
            hist_pos = est.values["fill_position"]
            if int(min(hist_pos, 2.999)) == i and est.n_course:
                frac = 0.5 * frac + 0.5 * (hist_pos - i)
            d = cal.date_at(names.index(fills_in) + frac)
            fill_date = d.isoformat() if d else None

        demand = float(np.exp(raw["log_demand"]))
        popularity = round(float(np.clip(demand / POPULARITY_SATURATION, 0, 1)), 3)
        prof_named = raw["prof_key"] is not None
        warning, confidence = self._warning_confidence(est, prof_named, professor, raw["course"], cal)
        v, n = est.values, est.counts
        cap = capacity if capacity and capacity > 0 else None
        expansion = {"pExpands": round(v["expanded"], 3),
                     "expectedGrowth": round(float(np.exp(v["log_expansion"]) - 1), 3),
                     "pastTerms": n.get("expansionTerms", 0), "pastTermsExpanded": n.get("expandedTerms", 0)}
        ref_cap = cap or (est.course_capacity if not np.isnan(est.course_capacity) else None)
        waitlist = {"pWaitlist": round(v["had_waitlist"], 3),
                    "expectedPeak": int(round(v["wl_peak_ratio"] * ref_cap)) if ref_cap else None,
                    "clearRate": round(v["wl_clear"], 3),
                    "pastTerms": n.get("waitlistTerms", 0), "pastTermsWithWaitlist": n.get("termsWithWaitlist", 0),
                    "pastTermsMeasured": n.get("clearTerms", 0)}
        risk = wait_risk(p, v["wl_clear"])
        return Prediction(
            course=raw["course"], professor=display_name(professor) if prof_named else None,
            professorSeenBefore=bool(est.prof_seen), warning=warning, popularity=popularity,
            expectedFillDate=fill_date, fillsInPhase=fills_in, pFullByPhase=p_by,
            recommendation=_recommend(p, risk), confidence=confidence, basis=est.basis,
            historyTerms=int(est.n_prof_course or est.n_prof or est.n_course),
            expectedDemandRatio=round(demand, 3), capacity=cap, capacityExpansion=expansion,
            waitlist=waitlist, waitRisk=round(risk, 3), advice=_advice(p, expansion, waitlist))

    @staticmethod
    def _warning_confidence(est, prof_named: bool, professor, course: str, cal: TermCalendar):
        notes = []
        if not prof_named:
            notes.append("No professor is listed yet, so this uses the course's history across all professors.")
            conf = "medium" if est.n_course >= 3 else "low"
        elif not est.prof_seen:
            src = {"course": f"{course}'s history under other professors",
                   "department": f"the {department(course)} department average (this course has no history either)",
                   "global": "campus-wide averages (no history for this course or department)"}[est.basis]
            notes.append(f"New professor: no past enrollment data for {display_name(professor)}. "
                         f"This prediction is based on {src}.")
            conf = "medium" if est.n_course >= 4 else "low"
        elif est.n_prof_course == 0:
            notes.append(f"{display_name(professor)} has not taught {course} in our data. This combines "
                         f"the course's history with how their other classes fill.")
            conf = "medium" if est.n_course >= 2 and est.n_prof >= 3 else "low"
        else:
            conf = "high" if est.n_prof_course >= 3 else "medium"
            if est.n_prof_course == 1:
                notes.append(f"Only one past term of {display_name(professor)} teaching {course}.")
        if cal.estimated:
            notes.append("Enrollment phase dates for this term are estimated.")
        return (" ".join(notes) or None), conf

    # ---------- persistence ----------
    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._stats_cache = {}
        joblib.dump(self, path, compress=3)

    @staticmethod
    def load(path: Path) -> "EnrollmentModel":
        return joblib.load(path)


def wait_risk(p: list[float], clear_rate: float) -> float:
    """Chance of ending up without a seat if the class is left for Phase 2.

    The class is full when you get to it with probability p(full by end of Phase 1) plus half
    of what fills during Phase 2 (your appointment falls somewhere inside it); from there the
    waitlist gets you in with probability `clear_rate`.
    """
    full_when_you_arrive = p[0] + 0.5 * (p[1] - p[0])
    return float(np.clip(full_when_you_arrive * (1.0 - clear_rate), 0.0, 1.0))


RISK_PRIORITY, RISK_EARLY = 0.2, 0.1


def _recommend(p: list[float], risk: float | None = None) -> str:
    """Timing advice. A class that fills early but whose waitlist clears is not a priority."""
    if risk is None:
        risk = wait_risk(p, 0.0) * 0.4  # no waitlist information: fall back to fill odds alone
    if risk >= RISK_PRIORITY:
        return "Phase 1 priority"
    if risk >= RISK_EARLY:
        return "Phase 1 or early Phase 2"
    if p[1] >= 0.4 or p[2] >= 0.6:
        return "Phase 2 is fine"
    return "Adjustment period is fine"


def _advice(p: list[float], expansion: dict, waitlist: dict) -> str | None:
    """One sentence on what a full class means here: does waiting on the waitlist work?"""
    if p[1] < 0.5:
        return None
    pct = int(round(waitlist["clearRate"] * 100))
    when = "Phase 1" if p[0] >= 0.5 else "Phase 2"
    own = waitlist["pastTermsMeasured"] >= 2
    src = "in past terms" if own else "in similar classes (this one has little waitlist history)"
    grows = ""
    if expansion["pastTerms"] >= 2 and expansion["pastTermsExpanded"] / expansion["pastTerms"] >= 0.5:
        grows = (f" Seats were added in {expansion['pastTermsExpanded']} of {expansion['pastTerms']} past "
                 f"terms (about +{int(round(expansion['expectedGrowth'] * 100))}% on average).")
    if waitlist["clearRate"] >= 0.85:
        return (f"Likely full in {when}, but about {pct}% of the waitlist got a seat {src}.{grows} "
                f"Waitlisting has usually worked; waitlisted units still count toward your unit cap.")
    if waitlist["clearRate"] >= 0.6:
        return (f"Likely full in {when}. About {pct}% of the waitlist got a seat {src}.{grows} "
                f"The waitlist is a reasonable backup, not a sure thing.")
    return (f"Likely full in {when}, and only about {pct}% of the waitlist got a seat {src}.{grows} "
            f"Enroll as early as you can.")


def predictions_document(model: EnrollmentModel, term: str, offerings: pd.DataFrame,
                         calendars: dict[str, TermCalendar]) -> dict:
    """Build the data/predictions/predictions.json document (see docs/data-contracts.md).

    `offerings` needs columns course, professor and optionally capacity.
    """
    term = normalize_term(term)
    cal = calendar_for(term, calendars)
    preds = []
    for r in offerings.itertuples(index=False):
        cap = getattr(r, "capacity", None)
        cap = None if cap is None or (isinstance(cap, float) and np.isnan(cap)) else float(cap)
        preds.append(model.predict(term, r.course, r.professor, cap, cal).to_dict())
    preds.sort(key=lambda d: (d["course"], d["professor"] or ""))
    return {
        "term": term,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "phases": [{"name": p.name, "start": p.start.isoformat(), "end": p.end.isoformat(),
                    "estimated": p.estimated} for p in cal.ordered()],
        "modelVersion": model.version,
        "phase1UnitCap": PHASE1_UNIT_CAP,
        "predictions": preds,
    }
