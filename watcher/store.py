"""Persistence: latest seat snapshot, change history, and alert subscriptions.

Files (all under ``data/seats/`` by default, JSON so web/ can read them):
- latest.json        Snapshot.to_json() for every watched section (contract for web/)
- history.jsonl      one line per observed change event (useful for data/ ML);
                     rotated to history.jsonl.1 past ``history_max_bytes`` (one old file kept)
- subscriptions.json list of subscriptions created via POST /subscriptions
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from watcher.models import ChangeEvent, Section, Snapshot, utcnow_iso

DEFAULT_DIR = Path(os.environ.get("WATCHER_DATA_DIR", Path(__file__).resolve().parent.parent / "data" / "seats"))


HISTORY_MAX_BYTES = 50_000_000


def norm_email(email: Any) -> str:
    return str(email or "").strip().lower()


class Store:
    def __init__(self, root: Path | str = DEFAULT_DIR, history_max_bytes: int = HISTORY_MAX_BYTES):
        self.root = Path(root)
        self.history_max_bytes = history_max_bytes
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    # ---- latest snapshot -------------------------------------------------
    @property
    def latest_path(self) -> Path:
        return self.root / "latest.json"

    def load_latest(self) -> dict[str, Section]:
        if not self.latest_path.exists():
            return {}
        data = json.loads(self.latest_path.read_text())
        out = {}
        for d in data.get("sections", []):
            s = Section.from_dict(d)
            out[s.key] = s
        return out

    def save_latest(self, sections: dict[str, Section]) -> Snapshot:
        terms = sorted({s.term for s in sections.values() if s.term})
        snap = Snapshot(term=terms[-1] if len(terms) == 1 else ",".join(terms),
                        sections=sorted(sections.values(), key=lambda s: (s.course, s.section)))
        self._atomic_write(self.latest_path, snap.to_json())
        return snap

    # ---- history ---------------------------------------------------------
    def append_events(self, events: list[ChangeEvent]) -> None:
        if not events:
            return
        path = self.history_path
        with self._lock:
            self._rotate_history(path)
            with open(path, "a") as f:
                for e in events:
                    f.write(json.dumps({"at": utcnow_iso(), **e.to_dict()}) + "\n")

    @property
    def history_path(self) -> Path:
        return self.root / "history.jsonl"

    def _rotate_history(self, path: Path) -> None:
        if self.history_max_bytes <= 0:
            return
        try:
            if path.stat().st_size >= self.history_max_bytes:
                os.replace(path, path.with_name(path.name + ".1"))
        except FileNotFoundError:
            pass

    # ---- subscriptions ---------------------------------------------------
    @property
    def subs_path(self) -> Path:
        return self.root / "subscriptions.json"

    def load_subscriptions(self) -> list[dict[str, Any]]:
        if not self.subs_path.exists():
            return []
        return json.loads(self.subs_path.read_text())

    def add_subscription(self, sub: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            subs = self.load_subscriptions()
            key = (norm_email(sub.get("email")), str(sub.get("classNumber")))
            subs = [s for s in subs if (norm_email(s.get("email")), str(s.get("classNumber"))) != key]
            sub = {**sub, "email": key[0], "classNumber": key[1], "createdAt": utcnow_iso()}
            subs.append(sub)
            self._atomic_write(self.subs_path, subs)
        return sub

    def remove_subscription(self, email: str, class_number: str) -> bool:
        with self._lock:
            subs = self.load_subscriptions()
            email = norm_email(email)
            kept = [s for s in subs
                    if not (norm_email(s.get("email")) == email and str(s.get("classNumber")) == str(class_number))]
            self._atomic_write(self.subs_path, kept)
        return len(kept) != len(subs)

    def subscriptions_for(self, email: str) -> list[dict[str, Any]]:
        email = norm_email(email)
        return [s for s in self.load_subscriptions() if norm_email(s.get("email")) == email]

    # ---- util ------------------------------------------------------------
    def _atomic_write(self, path: Path, obj: Any) -> None:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, indent=2))
        os.replace(tmp, path)
