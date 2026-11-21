"""Term parsing, ordering, and enrollment-phase lookup."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

SEASON_ORDER = {"Spring": 0, "Summer": 1, "Fall": 2}
PHASE_NAMES = ["Phase 1", "Phase 2", "Adjustment Period"]
# Ordinal outcome classes for "when does it fill".
FILL_CLASSES = ["Phase 1", "Phase 2", "Adjustment Period", "Does not fill"]


def parse_term(term: str) -> tuple[str, int]:
    m = re.match(r"^\s*(Spring|Summer|Fall)\s+(\d{4})\s*$", str(term), re.I)
    if not m:
        raise ValueError(f"Unrecognized term: {term!r}")
    return m.group(1).capitalize(), int(m.group(2))


def term_key(term: str) -> int:
    season, year = parse_term(term)
    return year * 3 + SEASON_ORDER[season]


def normalize_term(term: str) -> str:
    season, year = parse_term(term)
    return f"{season} {year}"


@dataclass
class Phase:
    name: str
    start: date
    end: date
    estimated: bool = False


@dataclass
class TermCalendar:
    term: str
    phases: list[Phase]
    estimated: bool = False
    source: str = ""
    notes: list[str] = field(default_factory=list)

    def phase(self, name: str) -> Phase | None:
        for p in self.phases:
            if p.name.lower() == name.lower():
                return p
        return None

    def ordered(self) -> list[Phase]:
        out = [self.phase(n) for n in PHASE_NAMES]
        return [p for p in out if p is not None]

    def fill_class_for(self, d: date) -> int:
        """Index into FILL_CLASSES for a class that first filled on date d."""
        for i, p in enumerate(self.ordered()):
            if d <= p.end:
                return PHASE_NAMES.index(p.name)
        return len(FILL_CLASSES) - 1

    def position(self, d: date) -> float:
        """Continuous phase position: 0..1 inside Phase 1, 1..2 Phase 2, 2..3 Adjustment.

        Gaps between phases map to the end of the earlier phase.
        """
        phases = self.ordered()
        for i, p in enumerate(phases):
            if d <= p.end:
                if d < p.start:
                    return float(i)
                span = max((p.end - p.start).days, 1)
                return i + (d - p.start).days / span
        return float(len(phases))

    def date_at(self, pos: float) -> date | None:
        phases = self.ordered()
        if not phases:
            return None
        i = min(int(pos), len(phases) - 1)
        frac = min(max(pos - i, 0.0), 1.0)
        p = phases[i]
        return p.start + timedelta(days=round((p.end - p.start).days * frac))


def _d(s: str) -> date:
    return date.fromisoformat(s[:10])


def default_calendar(term: str) -> TermCalendar:
    """Typical Berkeley phase windows, used when a term's real calendar is unknown."""
    season, year = parse_term(term)
    if season == "Fall":
        ph = [Phase("Phase 1", date(year, 4, 14), date(year, 5, 2), True),
              Phase("Phase 2", date(year, 7, 15), date(year, 8, 15), True),
              Phase("Adjustment Period", date(year, 8, 20), date(year, 9, 17), True)]
    elif season == "Spring":
        ph = [Phase("Phase 1", date(year - 1, 10, 21), date(year - 1, 11, 8), True),
              Phase("Phase 2", date(year - 1, 11, 18), date(year, 1, 10), True),
              Phase("Adjustment Period", date(year, 1, 13), date(year, 2, 7), True)]
    else:  # Summer has a single long window; model it as Phase 1 only.
        ph = [Phase("Phase 1", date(year, 2, 10), date(year, 5, 15), True),
              Phase("Adjustment Period", date(year, 5, 16), date(year, 6, 15), True)]
    return TermCalendar(normalize_term(term), ph, estimated=True,
                        notes=["Phase dates estimated from the typical Berkeley calendar."])


def load_calendars(path: Path) -> dict[str, TermCalendar]:
    if not path.exists():
        return {}
    raw = json.loads(path.read_text())
    out: dict[str, TermCalendar] = {}
    for entry in raw:
        try:
            term = normalize_term(entry["term"])
        except (KeyError, ValueError):
            continue
        phases = []
        add_drop = None
        for p in entry.get("phases", []):
            name = str(p.get("name", "")).strip().lower()
            if not p.get("start") or not p.get("end"):
                continue
            if name == "add/drop deadline":
                add_drop = _d(p["end"])
                continue
            # Exact names only: "Phase 1 New Undergrads" and "Phase 1.5" are extra windows
            # for other populations and must not replace the continuing-student phases.
            canon = next((n for n in PHASE_NAMES if n.lower() == name), None)
            if canon is None:
                continue
            phases.append(Phase(canon, _d(p["start"]), _d(p["end"]), bool(p.get("estimated"))))
        # Since 2023 the registrar's "Adjustment Period" event runs to ~week 10 (late-change
        # window). Cap it at the add/drop deadline so the phase means the same thing every term.
        if add_drop:
            for ph in phases:
                if ph.name == "Adjustment Period" and ph.start <= add_drop < ph.end:
                    ph.end = add_drop
        if phases:
            out[term] = TermCalendar(term, phases, any(p.estimated for p in phases),
                                     entry.get("source", ""), [entry["notes"]] if entry.get("notes") else [])
    return out


def calendar_for(term: str, calendars: dict[str, TermCalendar]) -> TermCalendar:
    term = normalize_term(term)
    cal = calendars.get(term)
    if cal is None:
        return default_calendar(term)
    # Fill missing phases from the default pattern.
    if len(cal.ordered()) < len(default_calendar(term).ordered()):
        have = {p.name for p in cal.phases}
        extra = [p for p in default_calendar(term).phases if p.name not in have]
        cal = TermCalendar(term, cal.phases + extra, True, cal.source,
                           cal.notes + ["Some phase dates estimated."])
    return cal
