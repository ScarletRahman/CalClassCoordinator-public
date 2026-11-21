"""History features: hierarchical, recency-weighted shrinkage estimates keyed by professor.

For a target (course, professor) the estimate of each statistic is built bottom-up:

    global -> department -> course -> + professor effect -> professor-in-this-course

Each level is a weighted mean shrunk toward the level above with a pseudo-count, so a
professor with one past term barely moves the course estimate, while one with five terms
dominates it. The professor effect is how much the professor's classes beat or trail
their course's average across *every* course they taught, which lets a known professor
teaching a new course still carry information.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .terms import FILL_CLASSES

HALF_LIFE_TERMS = 6.0  # a term 6 terms ago (~3 years incl. summers) counts half
K_DEPT, K_COURSE, K_PROF, K_PROF_COURSE = 8.0, 3.0, 3.0, 2.0

BERNOULLI_STATS = ["full_p1", "full_p2", "full_adj"]
# Capacity growth and waitlist behaviour (see data._capacity_waitlist_outcomes):
#   expanded       1 if capacity grew 5%+ after Phase 1 opened
#   log_expansion  log(peak capacity / starting capacity), 0 when it did not grow
#   had_waitlist   1 if a waitlist formed
#   wl_peak_ratio  longest waitlist / starting capacity
#   wl_clear       share of that waitlist that got a seat (only terms with a real waitlist)
EXTRA_BERNOULLI = ["expanded", "had_waitlist"]
EXTRA_STATS = ["expanded", "log_expansion", "had_waitlist", "wl_peak_ratio", "wl_clear"]
STATS = ["log_demand", *BERNOULLI_STATS, "fill_position", *EXTRA_STATS]
DEFAULTS = [0.0, 0.2, 0.35, 0.45, 1.0, 0.18, 0.05, 0.6, 0.1, 0.8]
EXPANSION_THRESHOLD = 1.05
MAX_EXPANSION = 3.0   # cap so one odd term (400 -> 1400 seats) cannot dominate a course's average
MIN_WAITLIST_FOR_CLEAR = 3
SEASON_CODE = {"Spring": 0, "Summer": 1, "Fall": 2}
LEVEL_CODE = {"lower": 0, "upper": 1, "graduate": 2}
LAST = len(FILL_CLASSES) - 1


def add_targets(obs: pd.DataFrame) -> pd.DataFrame:
    obs = obs.copy()
    obs["log_demand"] = np.log(obs["demand_ratio"].clip(0.05, 5.0))
    fc = obs["fill_class"]
    seen = obs["observed_phases"] if "observed_phases" in obs else pd.Series(LAST, index=obs.index)
    for i, s in enumerate(BERNOULLI_STATS):
        # 1 if it filled by the end of phase i; 0 only if we watched that whole phase and it
        # had not filled; otherwise unknown (history ended early, or no daily history).
        obs[s] = np.where(fc <= i, 1.0, np.where(fc.notna() & (seen > i), 0.0, np.nan))
    obs["fill_position"] = obs["fill_position"].where(fc < LAST)
    for col in ["expansion_ratio", "waitlist_peak", "waitlist_cleared", "capacity_start"]:
        if col not in obs:
            obs[col] = np.nan
    ratio = pd.to_numeric(obs["expansion_ratio"], errors="coerce")
    obs["expanded"] = (ratio >= EXPANSION_THRESHOLD).astype(float).where(ratio.notna())
    obs["log_expansion"] = np.log(ratio.clip(1.0, MAX_EXPANSION))
    peak = pd.to_numeric(obs["waitlist_peak"], errors="coerce")
    start = pd.to_numeric(obs["capacity_start"], errors="coerce")
    obs["had_waitlist"] = (peak > 0).astype(float).where(peak.notna())
    obs["wl_peak_ratio"] = (peak / start.where(start > 0)).clip(0, 2.0)
    obs["wl_clear"] = pd.to_numeric(obs["waitlist_cleared"], errors="coerce").where(peak >= MIN_WAITLIST_FOR_CLEAR)
    return obs


@dataclass
class Estimate:
    values: dict[str, float]
    basis: str
    n_prof_course: int
    n_prof: int
    n_course: int
    n_dept: int
    prof_seen: bool
    course_capacity: float
    last_demand: float
    counts: dict[str, int]


def _sums(h: pd.DataFrame, key, cols: list[str]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Weighted value sums and weight sums per group, for each column (NaNs ignored)."""
    vals = h[cols].to_numpy(float)
    w = h["_w"].to_numpy(float)[:, None]
    ok = ~np.isnan(vals)
    num = pd.DataFrame(np.where(ok, vals * w, 0.0), columns=cols, index=h.index)
    den = pd.DataFrame(np.where(ok, w, 0.0), columns=cols, index=h.index)
    keys = [h[k] for k in key] if isinstance(key, list) else h[key]
    return num.groupby(keys).sum(), den.groupby(keys).sum()


class HistoryStats:
    """Shrinkage estimates from past observations (all strictly before the target term).

    Everything is precomputed with group-bys so `estimate` is a handful of dict lookups.
    """

    def __init__(self, history: pd.DataFrame, target_term_key: int):
        h = add_targets(history) if "log_demand" not in history else history.copy()
        h = h.reset_index(drop=True)
        h["_w"] = 0.5 ** ((target_term_key - h["term_key"]) / HALF_LIFE_TERMS)
        defaults = np.array(DEFAULTS)
        self.g = defaults.copy()
        if len(h):
            vals, w = h[STATS].to_numpy(float), h["_w"].to_numpy(float)[:, None]
            ok = ~np.isnan(vals)
            den = np.where(ok, w, 0.0).sum(0)
            num = np.where(ok, vals * w, 0.0).sum(0)
            self.g = np.where(den > 0, num / np.maximum(den, 1e-12), defaults)

        self.dept: dict[str, np.ndarray] = {}
        self.course: dict[str, np.ndarray] = {}
        self.prof: dict[str, np.ndarray] = {}
        self.prof_course: dict[tuple, tuple[np.ndarray, np.ndarray]] = {}
        self.n_dept: dict[str, int] = {}
        self.n_course: dict[str, int] = {}
        self.n_prof: dict[str, int] = {}
        self.n_prof_course: dict[tuple, int] = {}
        self.course_capacity: dict[str, float] = {}
        self.course_last_demand: dict[str, float] = {}
        # Plain counts per course, for the "expanded in 8 of its last 10 terms" sentences.
        self.course_counts: dict[str, dict[str, int]] = {}
        if not len(h):
            return
        cc = h.assign(_wl=h["wl_clear"].notna()).groupby("course").agg(
            expansionTerms=("expanded", "count"), expandedTerms=("expanded", "sum"),
            waitlistTerms=("had_waitlist", "count"), termsWithWaitlist=("had_waitlist", "sum"),
            clearTerms=("_wl", "sum"))
        self.course_counts = {c: {k: int(v) for k, v in r.items()} for c, r in cc.to_dict("index").items()}

        num, den = _sums(h, "dept", STATS)
        d_est = (num.to_numpy() + K_DEPT * self.g) / (den.to_numpy() + K_DEPT)
        self.dept = dict(zip(num.index, d_est))
        self.n_dept = h.groupby("dept").size().to_dict()

        num, den = _sums(h, "course", STATS)
        prior = np.array([self.dept[c.rsplit(" ", 1)[0]] if c.rsplit(" ", 1)[0] in self.dept else self.g
                          for c in num.index])
        c_est = (num.to_numpy() + K_COURSE * prior) / (den.to_numpy() + K_COURSE)
        self.course = dict(zip(num.index, c_est))
        self.n_course = h.groupby("course").size().to_dict()
        self.course_capacity = h.groupby("course")["capacity"].mean().to_dict()
        self.course_last_demand = (h.sort_values("term_key").groupby("course")["demand_ratio"]
                                   .last().to_dict())

        hp = h[h["prof_key"].notna()].copy()
        if len(hp):
            # Professor effect: recency-weighted residual vs. each course's estimate, shrunk to 0.
            ce = np.array([self.course[c] for c in hp["course"]])
            res = [f"_r{i}" for i in range(len(STATS))]
            hp[res] = hp[STATS].to_numpy(float) - ce
            num, den = _sums(hp, "prof_key", res)
            self.prof = dict(zip(num.index, num.to_numpy() / (den.to_numpy() + K_PROF)))
            self.n_prof = hp.groupby("prof_key").size().to_dict()
            num, den = _sums(hp, ["prof_key", "course"], STATS)
            self.prof_course = {k: (n, d) for k, n, d in zip(num.index, num.to_numpy(), den.to_numpy())}
            self.n_prof_course = hp.groupby(["prof_key", "course"]).size().to_dict()

    def _course_arr(self, course: str) -> np.ndarray:
        if course in self.course:
            return self.course[course]
        return self.dept.get(course.rsplit(" ", 1)[0], self.g)

    def course_est(self, course: str) -> dict[str, float]:
        return dict(zip(STATS, self._course_arr(course)))

    def prof_effect(self, prof_key: str | None) -> dict[str, float]:
        if not isinstance(prof_key, str) or prof_key not in self.prof:
            return {s: 0.0 for s in STATS}
        return dict(zip(STATS, self.prof[prof_key]))

    def estimate(self, course: str, prof_key: str | None) -> Estimate:
        if not isinstance(prof_key, str):
            prof_key = None
        base = self._course_arr(course) + self.prof.get(prof_key, 0.0)
        pc = self.prof_course.get((prof_key, course))
        v = base if pc is None else (pc[0] + K_PROF_COURSE * base) / (pc[1] + K_PROF_COURSE)
        vals = dict(zip(STATS, map(float, v)))
        for s in BERNOULLI_STATS:
            vals[s] = float(np.clip(vals[s], 0.01, 0.99))
        vals["fill_position"] = float(np.clip(vals["fill_position"], 0.0, 3.0))
        for s in EXTRA_BERNOULLI:
            vals[s] = float(np.clip(vals[s], 0.01, 0.99))
        vals["log_expansion"] = float(np.clip(vals["log_expansion"], 0.0, np.log(MAX_EXPANSION)))
        vals["wl_peak_ratio"] = float(np.clip(vals["wl_peak_ratio"], 0.0, 2.0))
        vals["wl_clear"] = float(np.clip(vals["wl_clear"], 0.0, 1.0))
        # Cumulative full-by-phase must be non-decreasing.
        vals["full_p2"] = max(vals["full_p2"], vals["full_p1"])
        vals["full_adj"] = max(vals["full_adj"], vals["full_p2"])

        n_pc = self.n_prof_course.get((prof_key, course), 0)
        n_p = self.n_prof.get(prof_key, 0)
        n_c = self.n_course.get(course, 0)
        n_d = self.n_dept.get(course.rsplit(" ", 1)[0], 0)
        basis = ("professor" if n_pc else "professor-other-courses" if n_p else "course" if n_c
                 else "department" if n_d else "global")
        return Estimate(vals, basis, n_pc, n_p, n_c, n_d, n_p > 0,
                        self.course_capacity.get(course, np.nan),
                        self.course_last_demand.get(course, np.nan),
                        self.course_counts.get(course, {}))


FEATURE_COLUMNS = [
    "est_log_demand", "est_full_p1", "est_full_p2", "est_full_adj", "est_fill_position",
    "course_log_demand", "course_full_p1", "prof_eff_log_demand", "prof_eff_full_p1",
    "n_prof_course", "n_prof", "n_course", "n_dept", "prof_seen",
    "log_capacity", "capacity_vs_history", "last_demand", "season", "level",
    "est_expanded", "est_log_expansion", "est_had_waitlist", "est_wl_peak_ratio", "est_wl_clear",
]


def listed_capacity(capacity_start, capacity) -> float:
    """Capacity a student sees when Phase 1 opens; falls back to the final count without daily history.

    Predictions are made from the listed capacity before any expansion, so training has to
    use the same number rather than the end-of-term capacity.
    """
    if capacity_start is not None and not pd.isna(capacity_start) and capacity_start > 0:
        return float(capacity_start)
    return capacity


def feature_row(stats: HistoryStats, course: str, prof_key: str | None, capacity: float,
                season: str, level: str) -> tuple[dict, Estimate]:
    est = stats.estimate(course, prof_key)
    ce = stats.course_est(course)
    pe = stats.prof_effect(prof_key)
    cap = capacity if capacity and capacity > 0 else est.course_capacity
    row = {
        **{f"est_{s}": est.values[s] for s in STATS},
        "course_log_demand": ce["log_demand"], "course_full_p1": ce["full_p1"],
        "prof_eff_log_demand": pe["log_demand"], "prof_eff_full_p1": pe["full_p1"],
        "n_prof_course": est.n_prof_course, "n_prof": est.n_prof, "n_course": est.n_course,
        "n_dept": est.n_dept, "prof_seen": float(est.prof_seen),
        "log_capacity": np.log1p(cap) if cap and not np.isnan(cap) else np.nan,
        "capacity_vs_history": (cap / est.course_capacity
                                if cap and est.course_capacity and not np.isnan(est.course_capacity)
                                else np.nan),
        "last_demand": est.last_demand,
        "season": SEASON_CODE.get(season, 0), "level": LEVEL_CODE.get(level, 0),
    }
    return row, est


def rolling_features(obs: pd.DataFrame) -> pd.DataFrame:
    """Features for every observation using only terms strictly before it (no leakage)."""
    obs = add_targets(obs)
    out = []
    for tk in sorted(obs["term_key"].unique()):
        hist = obs[obs["term_key"] < tk]
        cur = obs[obs["term_key"] == tk]
        stats = HistoryStats(hist, tk)
        for r in cur.itertuples(index=False):
            row, est = feature_row(stats, r.course, r.prof_key,
                                   listed_capacity(r.capacity_start, r.capacity), r.season, r.level)
            row.update({"term": r.term, "term_key": r.term_key, "course": r.course,
                        "prof_key": r.prof_key, "fill_class": r.fill_class,
                        **{s: getattr(r, s) for s in [*BERNOULLI_STATS, *EXTRA_STATS]},
                        "log_demand": r.log_demand, "popularity": r.popularity,
                        "basis": est.basis})
            out.append(row)
    return pd.DataFrame(out)
