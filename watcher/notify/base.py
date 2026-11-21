"""Notifier interface. Each channel turns a ChangeEvent into a message."""
from __future__ import annotations

from typing import Protocol

from watcher.models import ChangeEvent


class Notifier(Protocol):
    name: str

    def send(self, event: ChangeEvent) -> None:
        """Deliver one alert. Raise NotifyError on failure."""
        ...


class NotifyError(RuntimeError):
    pass
