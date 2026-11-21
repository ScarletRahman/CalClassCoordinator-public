"""Time-ordered backtest: train on terms before T, predict term T, compare to baselines."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .features import BERNOULLI_STATS, EXTRA_BERNOULLI, EXTRA_STATS, add_targets, listed_capacity
from .model import EnrollmentModel
from .terms import PHASE_NAMES


def _brier(p, y) -> float:
    return float(np.mean((np.asarray(p) - np.asarray(y)) ** 2))


def backtest(observations: pd.DataFrame, n_test_terms: int = 3, min_train_rows: int = 300) -> dict:
    """Hold out each of the last n terms in turn, training only on earlier terms.

    Reports Brier score for P(full by end of each phase) and MAE of log demand for:
      model      the full by-professor model
      course     course-only history (professor ignored), same pipeline
      base_rate  the overall historical rate
    plus the same split restricted to professors never seen in training ("new_professor").
    """
    obs = add_targets(observations)
    labelled_terms = sorted(obs.loc[obs["full_p1"].notna(), "term_key"].unique())
    test_terms = labelled_terms[-n_test_terms:] if len(labelled_terms) > n_test_terms else labelled_terms[1:]
    rows = []
    for tk in test_terms:
        train = observations[observations["term_key"] < tk]
        test = obs[obs["term_key"] == tk]
        if train.empty or test.empty:
            continue
        model = EnrollmentModel.fit(train, min_train_rows)
        no_prof = EnrollmentModel.fit(train.assign(prof_key=None, professor=None), min_train_rows)
        tr = add_targets(train)
        base = {s: float(tr[s].mean()) if tr[s].notna().any() else 0.3 for s in BERNOULLI_STATS}
        base_ld = float(tr["log_demand"].mean())
        base_x = {s: float(tr[s].mean()) if tr[s].notna().any() else np.nan for s in EXTRA_STATS}
        for r in test.itertuples(index=False):
            cap = listed_capacity(r.capacity_start, r.capacity)
            m = model.predict_raw(r.term, r.course, r.professor, cap)
            c = no_prof.predict_raw(r.term, r.course, None, cap)
            rec = {"term": r.term, "prof_seen": m["est"].prof_seen, "has_prof": pd.notna(r.prof_key),
                   "log_demand": r.log_demand, "m_ld": m["log_demand"], "c_ld": c["log_demand"],
                   "b_ld": base_ld, "fill_class": r.fill_class}
            for i, s in enumerate(BERNOULLI_STATS):
                rec[f"y_{s}"] = getattr(r, s)
                rec[f"m_{s}"] = m["p_full"][i]
                rec[f"c_{s}"] = c["p_full"][i]
                rec[f"b_{s}"] = base[s]
            for s in EXTRA_STATS:
                rec[f"y_{s}"] = getattr(r, s)
                rec[f"m_{s}"] = m["est"].values[s]
                rec[f"c_{s}"] = c["est"].values[s]
                rec[f"b_{s}"] = base_x[s]
            rows.append(rec)
    df = pd.DataFrame(rows)
    if df.empty:
        return {"rows": 0, "note": "Not enough terms to backtest."}

    def summarize(d: pd.DataFrame) -> dict:
        out = {"rows": int(len(d))}
        for i, s in enumerate(BERNOULLI_STATS):
            lab = d[d[f"y_{s}"].notna()]
            if len(lab):
                out[f"brier_full_by_{PHASE_NAMES[i]}"] = {
                    "rows": int(len(lab)), "actual_rate": round(float(lab[f"y_{s}"].mean()), 4),
                    **{k: round(_brier(lab[f"{p}_{s}"], lab[f"y_{s}"]), 4)
                       for k, p in [("model", "m"), ("course", "c"), ("base_rate", "b")]}}
        lab = d[d["y_full_p1"].notna()]
        if len(lab):
            out["phase1_accuracy_at_0.5"] = {
                k: round(float(((lab[f"{p}_full_p1"] >= 0.5) == (lab["y_full_p1"] == 1)).mean()), 4)
                for k, p in [("model", "m"), ("course", "c"), ("base_rate", "b")]}
        dd = d[d["log_demand"].notna()]
        if len(dd):
            out["mae_log_demand"] = {k: round(float((dd[c] - dd["log_demand"]).abs().mean()), 4)
                                     for k, c in [("model", "m_ld"), ("course", "c_ld"), ("base_rate", "b_ld")]}
        # Capacity growth and waitlists: Brier for the yes/no outcomes, mean absolute error otherwise.
        for s in EXTRA_STATS:
            lab = d[d[f"y_{s}"].notna()]
            if len(lab):
                err = _brier if s in EXTRA_BERNOULLI else (lambda p, y: float(np.mean(np.abs(np.asarray(p) - np.asarray(y)))))
                out[("brier_" if s in EXTRA_BERNOULLI else "mae_") + s] = {
                    "rows": int(len(lab)), "actual_mean": round(float(lab[f"y_{s}"].mean()), 4),
                    **{k: round(err(lab[f"{p}_{s}"], lab[f"y_{s}"]), 4)
                       for k, p in [("model", "m"), ("course", "c"), ("base_rate", "b")]}}
        return out

    return {
        "test_terms": sorted(df["term"].unique().tolist(), key=lambda t: (t.split()[1], t)),
        "all": summarize(df),
        "seen_professor": summarize(df[df["prof_seen"]]),
        "new_professor": summarize(df[df["has_prof"] & ~df["prof_seen"]]),
    }
