"""Load scraped enrollment data and turn it into one observation per (term, course, professor)."""
from __future__ import annotations

import re
import unicodedata
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from .terms import FILL_CLASSES, TermCalendar, calendar_for, load_calendars, normalize_term, term_key

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data" / "enrollment"

# A section counts as "full" once enrollment reaches this share of capacity.
FULL_THRESHOLD = 0.97
# Demand ratio (enrolled + waitlisted) / capacity that maps to popularity 1.0.
POPULARITY_SATURATION = 1.3
# Capacity growth (peak / start-of-Phase-1) that counts as "the class expanded".
EXPANSION_THRESHOLD = 1.05
# Starting capacity is the median over the first days of Phase 1, so a department still
# setting the class up on day one does not read as an expansion.
CAPACITY_START_DAYS = 7
MIN_START_CAPACITY = 10

_STAFF = {"", "staff", "the staff", "tba", "tbd", "instructor tba", "nan", "none"}
PRIMARY_COMPONENTS = {"LEC", "SEM", "STD", "IND", "COL", "WOR", "FLD", "CLC", ""}


def normalize_course(course: str) -> str:
    c = re.sub(r"\s+", " ", str(course).strip().upper())
    m = re.match(r"^(.*?)\s*([A-Z]{0,2}\d+[A-Z]*)$", c)
    if m and m.group(1):
        return f"{m.group(1).strip()} {m.group(2)}"
    return c


def department(course: str) -> str:
    return normalize_course(course).rsplit(" ", 1)[0]


def course_level(course: str) -> str:
    num = normalize_course(course).rsplit(" ", 1)[-1]
    digits = re.sub(r"\D", "", num)
    n = int(digits) if digits else 0
    if n >= 200:
        return "graduate"
    if n >= 100:
        return "upper"
    return "lower"


def professor_key(name: str | None) -> str | None:
    """Canonical key so 'DeNero, John N.' and 'John DeNero' match."""
    if name is None or (isinstance(name, float) and np.isnan(name)):
        return None
    s = unicodedata.normalize("NFKD", str(name)).encode("ascii", "ignore").decode()
    s = re.sub(r"\b(prof(essor)?|dr|mr|ms|mrs)\.?\s+", "", s, flags=re.I).strip()
    if s.lower() in _STAFF:
        return None
    if "," in s:
        last, first = [p.strip() for p in s.split(",", 1)]
        s = f"{first} {last}"
    parts = [p for p in re.split(r"[\s.]+", s.lower()) if p]
    parts = [p for p in parts if len(p) > 1 or len(parts) <= 2]  # drop middle initials
    if not parts:
        return None
    if len(parts) > 2:
        parts = [parts[0], parts[-1]]
    return " ".join(re.sub(r"[^a-z\-']", "", p) for p in parts)


def display_name(name: str | None) -> str | None:
    if name is None or (isinstance(name, float) and np.isnan(name)):
        return None
    s = str(name).strip()
    if "," in s:
        last, first = [p.strip() for p in s.split(",", 1)]
        s = f"{first} {last}"
    return s or None


def primary_instructor(instructors: str | float | None) -> str | None:
    if instructors is None or (isinstance(instructors, float) and np.isnan(instructors)):
        return None
    for part in re.split(r";|\|", str(instructors)):
        if professor_key(part):
            return display_name(part)
    return None


def _read_csvs(name: str, data_dir: Path) -> pd.DataFrame:
    frames = []
    for sub in sorted(p for p in data_dir.iterdir() if p.is_dir()) if data_dir.exists() else []:
        for fname in (f"{name}.csv", f"{name}.csv.gz"):
            path = sub / fname
            if path.exists():
                df = pd.read_csv(path, dtype=str, keep_default_na=False)
                df["_dir"] = sub.name
                frames.append(df)
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def _num(s: pd.Series) -> pd.Series:
    return pd.to_numeric(s, errors="coerce")


def load_sections(data_dir: Path = DATA_DIR) -> pd.DataFrame:
    df = _read_csvs("sections", data_dir)
    if df.empty:
        return df
    df["term"] = df["term"].map(_safe_term)
    df = df[df["term"].notna()].copy()
    df["course"] = df["course"].map(normalize_course)
    for col in ["capacity", "enrolled", "waitlisted", "waitlist_capacity", "reserved_capacity"]:
        df[col] = _num(df[col]) if col in df else np.nan
    df["component"] = df.get("component", "").astype(str).str.upper().str.strip()
    return df


def load_timeseries(data_dir: Path = DATA_DIR) -> pd.DataFrame:
    df = _read_csvs("timeseries", data_dir)
    if df.empty:
        return df
    df["term"] = df["term"].map(_safe_term)
    df = df[df["term"].notna()].copy()
    df["course"] = df["course"].map(normalize_course)
    df["date"] = pd.to_datetime(df["date"], errors="coerce").dt.date
    for col in ["enrolled", "capacity", "waitlisted", "waitlist_capacity"]:
        df[col] = _num(df[col]) if col in df else np.nan
    return df[df["date"].notna()]


def _safe_term(t: str) -> str | None:
    try:
        return normalize_term(t)
    except ValueError:
        return None


def norm_section(s) -> str:
    s = str(s).strip()
    return s.zfill(3) if s.isdigit() else s


def _dedupe_sections(sections: pd.DataFrame) -> pd.DataFrame:
    """Both sources list the same sections; keep one row each (first directory wins)."""
    return sections.drop_duplicates(["term", "course", "section"], keep="first")


def _series_outcomes(series: pd.DataFrame, calendars: dict) -> pd.DataFrame:
    """Per (term, course, prof_key): when the class first filled and its peak demand."""
    series = series.assign(prof_key=series["prof_key"].fillna(""))
    keys = ["term", "course", "prof_key"]
    daily = (series.groupby(keys + ["date"], sort=True)[["enrolled", "capacity", "waitlisted"]]
             .sum(min_count=1).reset_index())
    daily = daily[daily["capacity"] > 0]
    # Snapshots before Phase 1 opens are leftovers from the previous offering
    # (last term's counts sit on the record until the rollover), so drop them.
    p1_start = {t: calendar_for(t, calendars).ordered()[0].start for t in daily["term"].unique()}
    daily = daily[daily["date"] >= daily["term"].map(p1_start)]
    daily["waitlisted"] = daily["waitlisted"].fillna(0)
    daily["demand"] = (daily["enrolled"] + daily["waitlisted"]) / daily["capacity"]
    daily["full"] = (daily["enrolled"] >= FULL_THRESHOLD * daily["capacity"]) | (daily["waitlisted"] > 0)
    g = daily.groupby(keys, sort=False)
    out = g.agg(capacity=("capacity", "last"), enrolled=("enrolled", "last"),
                waitlisted=("waitlisted", "last"), demand_ratio=("demand", "max"),
                first_snapshot=("date", "first"), last_snapshot=("date", "last"),
                n_days=("date", "size"))
    out["fill_date"] = daily[daily["full"]].groupby(keys, sort=False)["date"].first()
    out = out.reset_index()
    prof = series[series["professor"].notna()].groupby(keys)["professor"].first()
    out = out.merge(prof.reset_index(), on=keys, how="left")
    fc, fp = [], []
    for term, d in zip(out["term"], out["fill_date"]):
        cal = calendar_for(term, calendars)
        if pd.isna(d):
            fc.append(len(FILL_CLASSES) - 1)
            fp.append(np.nan)
        else:
            fc.append(cal.fill_class_for(d))
            fp.append(cal.position(d))
    out["fill_class"], out["fill_position"] = fc, fp
    # How many phases the history fully covers; later phases are censored (unknown).
    out["observed_phases"] = [
        sum(last >= ph.end - timedelta(days=3) for ph in calendar_for(t, calendars).ordered())
        for t, last in zip(out["term"], out["last_snapshot"])]
    # A series that starts after Phase 1 ended, or already full on its first day well into
    # enrollment, cannot tell us in which phase the class filled.
    late = [d > calendar_for(t, calendars).ordered()[0].end for t, d in zip(out["term"], out["first_snapshot"])]
    out.loc[late, ["fill_class", "fill_position"]] = np.nan
    out = out.merge(_capacity_waitlist_outcomes(daily, keys, calendars, p1_start), on=keys, how="left")
    # Whether capacity grew or the waitlist cleared is only known once the add/drop
    # deadline has passed; a class that already expanded stays a known "yes".
    done = out["observed_phases"] >= np.array(
        [len(calendar_for(t, calendars).ordered()) for t in out["term"]])
    grew = out["expansion_ratio"] >= EXPANSION_THRESHOLD
    out.loc[~done & ~grew, "expansion_ratio"] = np.nan
    out.loc[~done, ["waitlist_peak", "waitlist_end", "waitlist_cleared"]] = np.nan
    out["has_series"] = True
    out["prof_key"] = out["prof_key"].replace("", None)
    return out


def _capacity_waitlist_outcomes(daily: pd.DataFrame, keys: list[str], calendars: dict,
                                p1_start: dict) -> pd.DataFrame:
    """Per class: capacity at the start of Phase 1, how far it grew, and what the waitlist did.

    `waitlist_cleared` estimates the share of the students on the waitlist at its longest
    who had a seat by the add/drop deadline. Individual students are not visible, only daily
    totals, so it sits between two bounds counted from the days after the peak:
      low   the waitlist shrank and enrollment rose that day (certainly admitted)
      high  as low, plus every exit from the waitlist while the class stayed full (a drop is
            refilled from the waitlist automatically, but some of those exits are students
            giving up)
    The estimate is the midpoint, so an exit we cannot explain counts as half an admit.
    """
    terms = daily["term"].unique()
    adj_end = {t: calendar_for(t, calendars).ordered()[-1].end for t in terms}
    d = daily[daily["date"] <= daily["term"].map(adj_end)]
    week1 = d[d["date"] < d["term"].map({t: p1_start[t] + timedelta(days=CAPACITY_START_DAYS) for t in terms})]
    g = d.groupby(keys, sort=False)
    out = g.agg(capacity_max=("capacity", "max"), _first_cap=("capacity", "first"))
    out["capacity_start"] = week1.groupby(keys, sort=False)["capacity"].median()
    out["capacity_start"] = out["capacity_start"].fillna(out["_first_cap"])
    out["expansion_ratio"] = (out["capacity_max"] / out["capacity_start"]).clip(lower=1.0)
    # A handful of classes open Phase 1 with a placeholder capacity (1 seat); that is setup, not growth.
    out.loc[out["capacity_start"] < MIN_START_CAPACITY, "expansion_ratio"] = np.nan

    w = d.copy()
    gw = w.groupby(keys, sort=False)
    w["_dw"] = gw["waitlisted"].diff()
    w["_de"] = gw["enrolled"].diff()
    peak = w.loc[gw["waitlisted"].idxmax(), keys + ["date", "waitlisted"]].rename(
        columns={"date": "_peak_date", "waitlisted": "waitlist_peak"})
    w = w.merge(peak, on=keys, how="left")
    drop = (-w["_dw"]).clip(lower=0).fillna(0)
    still_full = w["enrolled"] >= FULL_THRESHOLD * w["capacity"]
    low = np.minimum(drop, w["_de"].clip(lower=0).fillna(0))
    w["_admitted"] = (low + np.where(still_full, drop, low)) / 2
    w.loc[w["date"] <= w["_peak_date"], "_admitted"] = 0.0
    gw = w.groupby(keys, sort=False)
    admitted, stranded = gw["_admitted"].sum(), gw["waitlisted"].last()
    peak = peak.set_index(keys)["waitlist_peak"]
    out["waitlist_peak"] = peak
    out["waitlist_end"] = stranded.where(peak > 0)
    out["waitlist_cleared"] = (admitted / peak.where(peak > 0)).clip(upper=1.0)
    return out.drop(columns="_first_cap").reset_index()


OBS_COLUMNS = ["term", "term_key", "course", "dept", "level", "season", "professor", "prof_key",
               "capacity", "enrolled", "waitlisted", "demand_ratio", "popularity", "fill_class",
               "fill_position", "fill_date", "observed_phases", "has_series",
               "capacity_start", "capacity_max", "expansion_ratio", "waitlist_peak", "waitlist_end", "waitlist_cleared"]


def build_observations(data_dir: Path = DATA_DIR, through_term: str | None = None) -> pd.DataFrame:
    """One row per (term, course, primary professor) with outcome labels.

    fill_class is 0..3 (index into FILL_CLASSES) or NaN when no daily history exists.
    Terms after `through_term` (e.g. ones still enrolling) are dropped.
    """
    calendars = load_calendars(data_dir / "calendar" / "phases.json")
    sections = load_sections(data_dir)
    series = load_timeseries(data_dir)
    frames = []

    if not sections.empty:
        sections["section"] = sections["section"].map(norm_section)
        sections = _dedupe_sections(sections)

    if not series.empty:
        series = series.copy()
        series["section"] = series["section"].map(norm_section)
        if not sections.empty:
            meta = sections[["term", "course", "section", "instructors", "component"]].rename(
                columns={"instructors": "_instr"})
            series = series.merge(meta, on=["term", "course", "section"], how="left")
            series["instructors"] = series["instructors"].where(series["instructors"] != "", series["_instr"].fillna(""))
            series["component"] = series["component"].fillna("")
        else:
            series["component"] = ""
        series = series[series["component"].isin(PRIMARY_COMPONENTS)]
        # If both ALL and per-section rows exist for a course, keep per-section rows.
        is_all = series["section"] == "ALL"
        with_sections = set(map(tuple, series.loc[~is_all, ["term", "course"]].drop_duplicates().values))
        drop = is_all & pd.Series([(t, c) in with_sections for t, c in zip(series["term"], series["course"])],
                                  index=series.index)
        series = series[~drop]
        uniq = {i: primary_instructor(i) for i in series["instructors"].unique()}
        series["professor"] = series["instructors"].map(uniq)
        series["prof_key"] = series["professor"].map({v: professor_key(v) for v in set(uniq.values())})
        frames.append(_series_outcomes(series, calendars))

    if not sections.empty:
        prim = sections[sections["component"].isin(PRIMARY_COMPONENTS)].copy()
        prim["professor"] = prim["instructors"].map(primary_instructor)
        prim["prof_key"] = prim["professor"].map(professor_key).fillna("")
        agg = prim.groupby(["term", "course", "prof_key"]).agg(
            professor=("professor", "first"), capacity=("capacity", "sum"),
            enrolled=("enrolled", lambda x: x.sum(min_count=1)), waitlisted=("waitlisted", "sum")).reset_index()
        agg = agg[(agg["capacity"] > 0) & agg["enrolled"].notna()]
        agg["demand_ratio"] = (agg["enrolled"] + agg["waitlisted"]) / agg["capacity"]
        agg["fill_class"] = np.nan
        agg["fill_position"] = np.nan
        agg["observed_phases"] = 0
        agg["has_series"] = False
        agg["prof_key"] = agg["prof_key"].replace("", None)
        frames.append(agg)

    if not frames:
        return pd.DataFrame(columns=OBS_COLUMNS)
    df = pd.concat(frames, ignore_index=True)
    # Prefer the row built from daily history when both exist.
    df["_k"] = df["prof_key"].fillna("")
    df = df.sort_values("has_series", ascending=False).drop_duplicates(["term", "course", "_k"])
    df["term_key"] = df["term"].map(term_key)
    if through_term:
        df = df[df["term_key"] <= term_key(through_term)]
    df["dept"] = df["course"].map(department)
    df["level"] = df["course"].map(course_level)
    df["season"] = df["term"].str.split().str[0]
    df["popularity"] = (df["demand_ratio"] / POPULARITY_SATURATION).clip(0, 1)
    for col, empty in [("fill_date", pd.NaT), ("capacity_start", np.nan), ("capacity_max", np.nan),
                       ("expansion_ratio", np.nan), ("waitlist_peak", np.nan), ("waitlist_end", np.nan),
                       ("waitlist_cleared", np.nan)]:
        if col not in df:
            df[col] = empty
    return df[OBS_COLUMNS].sort_values(["term_key", "course"]).reset_index(drop=True)
