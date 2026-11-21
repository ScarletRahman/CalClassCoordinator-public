from __future__ import annotations

import sys
from datetime import datetime

from watcher.models import ChangeEvent
from watcher.notify.format import format_title, URGENT_KINDS


class ConsoleNotifier:
    name = "console"

    def __init__(self, verbose: bool = False, stream=None, **_: object) -> None:
        self.verbose = verbose
        self.stream = stream

    def send(self, event: ChangeEvent) -> None:
        stream = self.stream or sys.stdout
        mark = "!!" if event.kind in URGENT_KINDS else "--"
        ts = datetime.now().strftime("%H:%M:%S")
        line = f"[{ts}] {mark} {event.kind}: {format_title(event)}"
        if event.section.url:
            line += f"  {event.section.url}"
        print(line, file=stream, flush=True)
        if self.verbose and event.message:
            print(f"    {event.message}", file=stream, flush=True)
