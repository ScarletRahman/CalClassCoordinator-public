"""CLI for the by-professor enrollment predictor.

  python -m ml.predictor build   [--term "Spring 2027"]   # train, backtest, write predictions.json
  python -m ml.predictor predict "COMPSCI 61A" "John DeNero" [--term "Spring 2027"]
  python -m ml.predictor backtest
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from .data import (DATA_DIR, PRIMARY_COMPONENTS, REPO_ROOT, build_observations, load_sections,
                   norm_section, primary_instructor, professor_key)
from .evaluate import backtest
from .model import EnrollmentModel, predictions_document
from .terms import calendar_for, load_calendars, normalize_term, term_key

MODEL_PATH = REPO_ROOT / "data" / "models" / "enrollment_model.joblib"
PRED_PATH = REPO_ROOT / "data" / "predictions" / "predictions.json"
METRICS_PATH = REPO_ROOT / "data" / "models" / "backtest_metrics.json"
OBS_PATH = DATA_DIR / "observations.csv"


def offerings_for(term: str, data_dir: Path = DATA_DIR, observations: pd.DataFrame | None = None) -> pd.DataFrame:
    """Courses and professors listed for a term (from scraped sections).

    Pass `observations` (from build_observations) so capacity is the one the class had when
    Phase 1 opened: seats may already have been added in a term that is enrolling now, and
    the model is trained on starting capacity.
    """
    sec = load_sections(data_dir)
    if sec.empty:
        return pd.DataFrame(columns=["course", "professor", "capacity"])
    sec = sec[(sec["term"] == normalize_term(term)) & sec["component"].isin(PRIMARY_COMPONENTS)].copy()
    sec["section"] = sec["section"].map(norm_section)
    sec = sec.drop_duplicates(["term", "course", "section"])  # same section from both sources
    sec["professor"] = sec["instructors"].map(primary_instructor)
    sec["_k"] = sec["professor"].map(professor_key).fillna("")
    out = sec.groupby(["course", "_k"]).agg(professor=("professor", "first"),
                                            capacity=("capacity", lambda x: x.sum(min_count=1)))
    out = out.reset_index()
    if observations is not None and len(observations) and "capacity_start" in observations:
        obs = observations[(observations["term"] == normalize_term(term)) & observations["capacity_start"].notna()]
        start = {(c, k if isinstance(k, str) else ""): v
                 for c, k, v in zip(obs["course"], obs["prof_key"], obs["capacity_start"])}
        out["capacity"] = [start.get((c, k), cap) for c, k, cap in zip(out["course"], out["_k"], out["capacity"])]
    return out[["course", "professor", "capacity"]]


def latest_listed_term(data_dir: Path = DATA_DIR) -> str | None:
    sec = load_sections(data_dir)
    if sec.empty:
        return None
    fs = sec[~sec["term"].str.startswith("Summer")]
    return max(fs["term"].unique(), key=term_key) if len(fs) else None


def cmd_build(args) -> None:
    obs = build_observations()
    if obs.empty:
        raise SystemExit("No enrollment data under data/enrollment/. Run the scrapers first.")
    obs.to_csv(OBS_PATH, index=False)
    term = args.term or latest_listed_term()
    # Never train on the term being predicted.
    train = obs[obs["term_key"] < term_key(term)]
    metrics = backtest(train)
    METRICS_PATH.parent.mkdir(parents=True, exist_ok=True)
    METRICS_PATH.write_text(json.dumps(metrics, indent=2))
    model = EnrollmentModel.fit(train)
    model.save(MODEL_PATH)
    calendars = load_calendars(DATA_DIR / "calendar" / "phases.json")
    doc = predictions_document(model, term, offerings_for(term, observations=obs), calendars)
    PRED_PATH.parent.mkdir(parents=True, exist_ok=True)
    PRED_PATH.write_text(json.dumps(doc, indent=1))
    n_new = sum(1 for p in doc["predictions"] if p["professor"] and not p["professorSeenBefore"])
    print(f"{len(train)} training observations ({int(train['fill_class'].notna().sum())} with fill timing), "
          f"{train['prof_key'].nunique()} professors, {train['course'].nunique()} courses")
    print(f"Wrote {len(doc['predictions'])} predictions for {term} ({n_new} with new-professor warnings)")
    print(json.dumps(metrics.get("all", metrics), indent=2))


def cmd_predict(args) -> None:
    model = EnrollmentModel.load(MODEL_PATH)
    calendars = load_calendars(DATA_DIR / "calendar" / "phases.json")
    term = args.term or latest_listed_term()
    pred = model.predict(term, args.course, args.professor, args.capacity, calendar_for(term, calendars))
    print(json.dumps({"term": term, **pred.to_dict()}, indent=2))


def cmd_backtest(args) -> None:
    print(json.dumps(backtest(build_observations(), args.terms), indent=2))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="python -m ml.predictor", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="train, backtest and write predictions.json")
    b.add_argument("--term")
    b.set_defaults(fn=cmd_build)
    p = sub.add_parser("predict", help="predict one class")
    p.add_argument("course")
    p.add_argument("professor", nargs="?")
    p.add_argument("--term")
    p.add_argument("--capacity", type=float)
    p.set_defaults(fn=cmd_predict)
    t = sub.add_parser("backtest", help="time-ordered backtest against baselines")
    t.add_argument("--terms", type=int, default=3)
    t.set_defaults(fn=cmd_backtest)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
