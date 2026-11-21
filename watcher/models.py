"""Core data types shared by every part of the watcher.

The JSON shape produced by ``Snapshot.to_json()`` is the contract consumed by
``web/`` (see docs/data-contracts.md). Only ever add fields; never rename.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


@dataclass
class ReservedSeat:
    """One reserved-seat group, e.g. "Computer Science Majors"."""

    group: str
    enrolled: int | None = None
    capacity: int | None = None

    @property
    def open(self) -> int | None:
        if self.enrolled is None or self.capacity is None:
            return None
        return max(self.capacity - self.enrolled, 0)


@dataclass
class Section:
    """Seat state of one class section at one moment."""

    course: str                    # "COMPSCI 61A"
    classNumber: str               # "28984" (the 5-digit class #, unique per term)
    section: str                   # "001 LEC"
    term: str = ""                 # "2026 Spring"
    title: str = ""
    instructor: str = ""
    enrolled: int | None = None
    capacity: int | None = None
    waitlisted: int | None = None
    waitlistCapacity: int | None = None
    open: int | None = None        # unreserved open seats as shown by the source
    reserved: list[ReservedSeat] = field(default_factory=list)
    status: str = ""               # "open" | "closed" | "waitlist" | "" (unknown)
    url: str = ""
    source: str = ""               # "classes.berkeley.edu" | "berkeleytime"
    fetchedAt: str = field(default_factory=utcnow_iso)

    @property
    def key(self) -> str:
        return f"{self.term}|{self.classNumber}"

    @property
    def reserved_open(self) -> int:
        return sum(r.open or 0 for r in self.reserved)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Section":
        d = dict(d)
        d["reserved"] = [ReservedSeat(**r) for r in d.get("reserved", [])]
        known = cls.__dataclass_fields__
        return cls(**{k: v for k, v in d.items() if k in known})


@dataclass
class Snapshot:
    term: str
    sections: list[Section]
    updatedAt: str = field(default_factory=utcnow_iso)

    def to_json(self) -> dict[str, Any]:
        return {
            "updatedAt": self.updatedAt,
            "term": self.term,
            "sections": [s.to_dict() for s in self.sections],
        }


@dataclass
class ChangeEvent:
    """Something alert-worthy happened to a section."""

    kind: str          # see diff.EVENT_KINDS
    section: Section
    before: Section | None
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "message": self.message,
            "section": self.section.to_dict(),
            "before": self.before.to_dict() if self.before else None,
        }
