"""Name and course-code normalization shared by the collectors and the build."""
from __future__ import annotations

import re
import unicodedata

# How students write subjects on Reddit and RateMyProfessors, by catalog subject code.
NICKNAMES: dict[str, list[str]] = {
    "COMPSCI": ["CS"],
    "ELENG": ["EE", "EECS"],
    "EECS": ["EECS", "EE", "CS"],
    "DATA": ["Data", "DS"],
    "STAT": ["Stat", "Stats"],
    "MATH": ["Math"],
    "PHYSICS": ["Physics"],
    "CHEM": ["Chem"],
    "ECON": ["Econ"],
    "MCELLBI": ["MCB"],
    "INTEGBI": ["IB"],
    "BIOLOGY": ["Bio"],
    "BIOENG": ["BioE"],
    "MECENG": ["ME", "MechE"],
    "CIVENG": ["CE", "CEE"],
    "INDENG": ["IEOR", "IE"],
    "MATSCI": ["MSE"],
    "NUCENG": ["NE"],
    "CHMENG": ["CBE", "ChemE"],
    "ENGIN": ["E", "Engin"],
    "UGBA": ["UGBA", "Haas"],
    "POLSCI": ["Poli Sci", "PS"],
    "PSYCH": ["Psych"],
    "SOCIOL": ["Soc"],
    "ANTHRO": ["Anthro"],
    "PHILOS": ["Phil"],
    "ASTRON": ["Astro"],
    "LINGUIS": ["Ling"],
    "COGSCI": ["CogSci", "Cog Sci"],
    "PBHLTH": ["PH", "Public Health"],
    "NUSCTX": ["NST"],
    "ENVECON": ["EEP"],
    "LS": ["L&S"],
    "INFO": ["Info"],
    "HISTORY": ["History"],
    "ENGLISH": ["English"],
    "GEOG": ["Geog"],
    "EPS": ["EPS"],
    "ESPM": ["ESPM"],
    "MEDIAST": ["Media Studies"],
    "LEGALST": ["Legal Studies"],
    "ETHSTD": ["Ethnic Studies"],
    "GWS": ["GWS"],
    "PLANTBI": ["PMB"],
    "COLWRIT": ["College Writing", "CW"],
}

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "phd"}


def fold(s: str) -> str:
    """Lowercase ASCII letters only, accents removed: 'Peña-Núñez' -> 'pena nunez'."""
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z]+", " ", s.lower()).strip()


def name_keys(full_name: str) -> list[str]:
    """Match keys for a person, most specific first: 'first last', then 'f last'.

    Middle names and suffixes are dropped; the last name is the final word.
    """
    parts = [p for p in fold(full_name).split() if p not in _SUFFIXES]
    if len(parts) < 2:
        return []
    first, last = parts[0], parts[-1]
    return [f"{first} {last}", f"{first[0]} {last}"]


def course_aliases(course: str) -> list[str]:
    """Ways students write a course id: 'COMPSCI 61A' -> ['CS 61A', 'CS61A', 'COMPSCI 61A']."""
    subject, _, number = course.rpartition(" ")
    short = re.sub(r"^[CNHW](?=\d)", "", number)  # 'C8' -> '8', as in 'Data 8'
    out: list[str] = []
    for nick in NICKNAMES.get(subject, []) + [subject]:
        for num in dict.fromkeys([short, number]):
            for form in (f"{nick} {num}", f"{nick}{num}"):
                if form not in out:
                    out.append(form)
    return out


def compact_code(text: str) -> str:
    """'CS 61A', 'cs61a', 'COMPSCI-61A' -> 'CS61A' style key for comparing class codes."""
    return re.sub(r"[^A-Z0-9]", "", text.upper())
