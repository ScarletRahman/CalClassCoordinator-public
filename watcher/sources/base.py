"""Source interface: something that turns a watch target into Section objects."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from watcher.models import Section


@dataclass
class Target:
    """What the user asked to watch.

    Either ``class_number`` (most precise) or ``course`` (watch every section of
    the course, optionally filtered to ``section``, e.g. "001 LEC").
    """

    course: str = ""             # "COMPSCI 61A"
    term: str = ""               # "2026 Spring"; empty = source default (current/next term)
    class_number: str = ""       # "28984"
    section: str = ""            # optional filter, "001 LEC"
    include_reserved: bool = True
    include_waitlist: bool = True


class Source(Protocol):
    name: str

    def fetch(self, target: Target) -> list[Section]:
        """Return current seat state for every section matching ``target``.

        Must raise ``SourceError`` on network/parse failure rather than
        returning stale or empty data silently.
        """
        ...


class SourceError(RuntimeError):
    """A source could not answer. ``status`` is the HTTP status when the server answered
    with an error code (the runner pauses a source that says 429 or 403)."""

    def __init__(self, *args: object, status: int | None = None) -> None:
        super().__init__(*args)
        self.status = status
