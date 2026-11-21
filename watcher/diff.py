"""Compare two observations of the same section and emit alert events."""
from __future__ import annotations

from watcher.models import ChangeEvent, Section

EVENT_KINDS = (
    "seats_opened",     # unreserved open seats went 0 -> >0
    "seats_increased",  # unreserved open seats went up (already >0)
    "reserved_opened",  # a reserved-seat group went 0 -> >0 open
    "waitlist_opened",  # waitlist went from full to having room
    "waitlist_moved",   # waitlist count dropped (people got in or dropped)
    "closed",           # unreserved open seats went >0 -> 0
    "new_section",      # first time we see this section
    "error",            # source failure (used by the runner)
)


def _label(s: Section) -> str:
    return f"{s.course} {s.section}".strip()


def _open(s: Section) -> int:
    return s.open or 0


def _wl_full(s: Section) -> bool | None:
    if s.waitlisted is None or s.waitlistCapacity is None:
        return None
    # A waitlist with capacity 0 doesn't exist yet, which counts as "no room",
    # so a waitlist being created (0/0 -> 0/50) alerts as waitlist_opened.
    return s.waitlisted >= s.waitlistCapacity


def diff_section(before: Section | None, after: Section, *, include_reserved: bool = True,
                 include_waitlist: bool = True) -> list[ChangeEvent]:
    lbl = _label(after)
    if before is None:
        msg = f"Now watching {lbl}: {_open(after)} open"
        if after.reserved:
            msg += f", {after.reserved_open} reserved open"
        return [ChangeEvent("new_section", after, None, msg)]

    events: list[ChangeEvent] = []
    b, a = _open(before), _open(after)
    if b == 0 and a > 0:
        events.append(ChangeEvent("seats_opened", after, before, f"{lbl}: {a} open seat(s) (was 0)"))
    elif a > b > 0:
        events.append(ChangeEvent("seats_increased", after, before, f"{lbl}: {a} open seats (was {b})"))
    elif b > 0 and a == 0:
        events.append(ChangeEvent("closed", after, before, f"{lbl}: now full (was {b} open)"))

    if include_reserved:
        prev = {r.group: (r.open or 0) for r in before.reserved}
        for r in after.reserved:
            now = r.open or 0
            if now > 0 and prev.get(r.group, 0) == 0:
                events.append(ChangeEvent(
                    "reserved_opened", after, before,
                    f"{lbl}: {now} reserved seat(s) open for {r.group}"))

    if include_waitlist:
        fb, fa = _wl_full(before), _wl_full(after)
        if fb is True and fa is False:
            events.append(ChangeEvent(
                "waitlist_opened", after, before,
                f"{lbl}: waitlist has room ({after.waitlisted}/{after.waitlistCapacity})"))
        elif (before.waitlisted is not None and after.waitlisted is not None
              and after.waitlisted < before.waitlisted):
            events.append(ChangeEvent(
                "waitlist_moved", after, before,
                f"{lbl}: waitlist moved {before.waitlisted} -> {after.waitlisted}"))
    return events
