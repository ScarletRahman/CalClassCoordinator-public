"""Shared message formatting for every notifier."""
from __future__ import annotations

from watcher.models import ChangeEvent, Section

KIND_LABELS = {
    "seats_opened": "SEATS OPEN",
    "seats_increased": "More seats",
    "reserved_opened": "Reserved seats open",
    "waitlist_opened": "Waitlist open",
    "waitlist_moved": "Waitlist moved",
    "closed": "Closed",
    "new_section": "New section",
    "error": "Watcher error",
}

URGENT_KINDS = {"seats_opened", "reserved_opened"}


def _n(v: int | None) -> str:
    return "?" if v is None else str(v)


def section_label(section: Section) -> str:
    return " ".join(p for p in (section.course, section.section) if p).strip() or section.classNumber


def _open_count(s: Section | None) -> int | None:
    if s is None:
        return None
    if s.open is not None:
        return s.open
    if s.enrolled is not None and s.capacity is not None:
        return max(s.capacity - s.enrolled, 0)
    return None


def format_title(event: ChangeEvent) -> str:
    s, b = event.section, event.before
    label = section_label(s)
    kind = event.kind
    if kind in ("seats_opened", "seats_increased", "closed"):
        now = _open_count(s)
        was = _open_count(b)
        seats = f"{_n(now)} open seat{'' if now == 1 else 's'}"
        if b is not None:
            seats += f" (was {_n(was)})"
        return f"{label}: {seats}"
    if kind == "reserved_opened":
        return f"{label}: {s.reserved_open} reserved seat{'' if s.reserved_open == 1 else 's'} open"
    if kind in ("waitlist_opened", "waitlist_moved"):
        wl = f"waitlist {_n(s.waitlisted)}/{_n(s.waitlistCapacity)}"
        if b is not None and b.waitlisted != s.waitlisted:
            wl += f" (was {_n(b.waitlisted)})"
        return f"{label}: {KIND_LABELS[kind].lower()}, {wl}"
    if kind == "new_section":
        return f"{label}: new section ({_n(_open_count(s))} open)"
    if kind == "error":
        return f"{label}: watcher error"
    return f"{label}: {KIND_LABELS.get(kind, kind)}"


def reserved_lines(section: Section) -> list[str]:
    lines = []
    for r in section.reserved:
        lines.append(f"  - {r.group}: {_n(r.open)} open ({_n(r.enrolled)}/{_n(r.capacity)})")
    return lines


def format_body(event: ChangeEvent) -> str:
    s = event.section
    lines: list[str] = []
    head = f"{s.course} {s.section}".strip()
    if s.title:
        head += f" - {s.title}"
    lines.append(head)
    meta = [x for x in (s.term, f"class #{s.classNumber}" if s.classNumber else "", s.instructor) if x]
    if meta:
        lines.append(" | ".join(meta))
    if event.message:
        lines.append(event.message)
    lines.append(
        f"Open (unreserved): {_n(_open_count(s))}  Enrolled: {_n(s.enrolled)}/{_n(s.capacity)}"
    )
    if s.reserved:
        lines.append("Reserved seats:")
        lines.extend(reserved_lines(s))
    if s.waitlisted is not None or s.waitlistCapacity is not None:
        lines.append(f"Waitlist: {_n(s.waitlisted)}/{_n(s.waitlistCapacity)}")
    if s.url:
        lines.append(s.url)
    return "\n".join(lines)
