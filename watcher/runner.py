"""The polling loop: fetch every target, diff against the last snapshot, alert.

One pass (``poll_once``):

1. Collect interests: config targets, Discord classes, and one per HTTP subscription.
2. Group them by what is actually fetched (a class number, or a course[+section]),
   so 500 subscribers to one class cost one request, not 500. A class-number or
   section target whose course is already fetched whole this pass reuses those
   sections when it finds itself in them.
3. Fetch each group once, at most ``max_targets`` per pass (the rest rotate in on
   later passes), with ``min_request_gap_seconds`` between requests to a source.
   A source that answers 429/403 is paused for ``cooldown_seconds``; a target that
   keeps failing is skipped for 2, 4, 8... passes (capped at 30 minutes).
4. Diff each distinct section once and fan the events out: global notifiers once,
   each subscriber's own email (at most once per class per ``subscriber_cooldown_seconds``).
"""
from __future__ import annotations

import json
import logging
import math
import os
import random
import threading
import time
from dataclasses import dataclass, field, replace
from typing import Any, Callable

from watcher.config import Config
from watcher.diff import diff_section
from watcher.models import ChangeEvent, Section, utcnow_iso
from watcher.sources.base import Source, SourceError, Target
from watcher.store import Store

log = logging.getLogger("watcher")

ERROR_ALERT_AFTER = 3          # consecutive failures before an "error" alert
BACKOFF_CAP_SECONDS = 30 * 60  # longest a failing target is skipped
PAUSE_STATUSES = (403, 429)    # source is telling us to slow down
RESERVED_KINDS = {"reserved_opened"}
WAITLIST_KINDS = {"waitlist_opened", "waitlist_moved"}


def make_source(name: str) -> Source:
    if name == "classes.berkeley.edu":
        from watcher.sources.classes_berkeley import ClassesBerkeleySource
        return ClassesBerkeleySource()
    if name == "berkeleytime":
        from watcher.sources.berkeleytime import BerkeleytimeSource
        return BerkeleytimeSource()
    raise ValueError(f"unknown source {name!r}")


def _matches(target: Target, s: Section) -> bool:
    if target.class_number:
        return s.classNumber == target.class_number
    return s.course == target.course and (not target.section or s.section == target.section)


def _wait(stop: threading.Event, seconds: float) -> None:
    """Default sleep between requests: wakes early on stop. Tests patch this out."""
    stop.wait(seconds)


class CoolingDown(SourceError):
    """Every source is paused (or just answered 429/403): not the target's fault, so it
    does not count toward the target's failures or backoff."""


def manage_line() -> str:
    url = os.environ.get("APP_URL", "").strip()
    return f"Manage or stop alerts: {url}" if url else "Manage or stop alerts in the CalClassCoordinator app."


@dataclass
class Interest:
    """Someone who wants to hear about a target. ``notif`` None = the global notifiers."""

    target: Target
    notif: list[dict] | None = None

    @property
    def key(self) -> str:
        return json.dumps(self.notif, sort_keys=True) if self.notif else ""

    @property
    def email(self) -> str:
        return str((self.notif or [{}])[0].get("to", "")) if self.notif else ""


@dataclass
class Group:
    """Everything interested in one distinct fetch."""

    key: tuple[str, str, str, str]
    target: Target
    interests: list[Interest] = field(default_factory=list)
    parent: tuple | None = None      # course group whose results this one reuses
    children: list["Group"] = field(default_factory=list)

    @property
    def label(self) -> str:
        kind, term, a, b = self.key
        return a if kind == "cn" else f"{a} {b}".strip()


def fetch_key(t: Target) -> tuple[str, str, str, str]:
    if t.class_number:
        return ("cn", t.term, t.class_number, "")
    return ("course", t.term, t.course, t.section)


class Watcher:
    def __init__(self, cfg: Config, store: Store | None = None,
                 sources: list[Source] | None = None,
                 notifier_factory: Callable[[list[dict]], list] | None = None, *,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] | None = None):
        self.cfg = cfg
        hist = getattr(cfg, "history_max_bytes", 50_000_000)
        self.store = store or (Store(cfg.data_dir, history_max_bytes=hist) if cfg.data_dir
                               else Store(history_max_bytes=hist))
        self.sources = sources if sources is not None else [make_source(n) for n in cfg.sources]
        if notifier_factory is None:
            from watcher.notify import build_notifiers
            notifier_factory = build_notifiers
        self._build = notifier_factory
        self.notifiers = notifier_factory(cfg.notifiers)
        self.state: dict[str, Section] = self.store.load_latest()
        self._stop = threading.Event()
        self._clock = clock
        self._sleep = sleep or (lambda s: _wait(self._stop, s))
        # politeness
        self._fetch_lock = threading.RLock()      # one outbound fetch at a time (poll loop + bot)
        self._last_request: dict[str, float] = {}  # source name -> clock() after its last fetch
        self._cool_until: dict[str, float] = {}    # source name -> clock() when it may be used again
        # per-target failure tracking (key = Group.label-ish string)
        self._errors: dict[str, int] = {}
        self._skip_until: dict[str, int] = {}      # tkey -> first pass number it may run again
        self._pass_no = 0
        self._rotate = 0
        # subscriber email state
        self._sub_notifiers: dict[str, list] = {}
        self._sub_last_sent: dict[tuple[str, str], float] = {}
        # health
        self._started = clock()
        self._last_pass_end: float | None = None
        self._last_pass_secs = 0.0
        self._last_activity = self._started
        self.last_poll_at: str | None = None
        self.last_poll_ok: bool | None = None
        self.last_target_count = 0

    # ---- targets -----------------------------------------------------------
    def all_targets(self) -> list[tuple[Target, list[dict] | None]]:
        """Config targets plus one per HTTP subscription (with its own notifier)."""
        out: list[tuple[Target, list[dict] | None]] = [(t, None) for t in self.cfg.targets]
        if self.cfg.watch_discord_classes:
            # Classes members added through the Discord bot (they exist as channels in the
            # routes file). Read every pass so new ones are picked up without a restart.
            from watcher.discord_setup import watched_courses
            have = {t.course for t in self.cfg.targets if t.course and not t.section}
            out += [(Target(course=c, term=self.cfg.term), None)
                    for c in watched_courses(self.cfg.discord_routes_file) if c not in have]
        tmpl = self.cfg.subscription_email
        for sub in self.store.load_subscriptions():
            t = Target(course=str(sub.get("course", "")), term=sub.get("term", self.cfg.term),
                       class_number=str(sub["classNumber"]),
                       include_reserved=bool(sub.get("includeReserved", True)))
            notif = [{**tmpl, "to": sub["email"]}] if tmpl and sub.get("email") else None
            out.append((t, notif))
        return out

    def plan(self) -> list[Group]:
        """Group interests by distinct fetch; attach reusable groups to their course group.

        Returns the top-level groups (each fetched on its own); reusing groups hang
        off their parent's ``children``.
        """
        groups: dict[tuple, Group] = {}
        for t, notif in self.all_targets():
            k = fetch_key(t)
            g = groups.get(k)
            if g is None:
                # Fetch everything; per-interest flags filter events, not data.
                g = groups[k] = Group(k, replace(t, include_reserved=True, include_waitlist=True))
            elif t.course and not g.target.course:
                g.target = replace(g.target, course=t.course)
            g.interests.append(Interest(t, notif))
        known: dict[str, str] = {}
        for s in self.state.values():
            known.setdefault(s.classNumber, s.course)
        top: list[Group] = []
        for k, g in sorted(groups.items()):
            kind, term, a, b = k
            course = (g.target.course or known.get(a, "")) if kind == "cn" else (a if b else "")
            parent = groups.get(("course", term, course, "")) if course else None
            if parent is not None and parent is not g:
                g.parent = parent.key
                parent.children.append(g)
            else:
                top.append(g)
        return top

    # ---- fetching ----------------------------------------------------------
    def _pace(self, name: str) -> None:
        gap = float(getattr(self.cfg, "min_request_gap_seconds", 0) or 0)
        last = self._last_request.get(name)
        if gap > 0 and last is not None:
            wait = last + gap - self._clock()
            if wait > 0:
                self._sleep(wait)

    def fetch(self, target: Target) -> list[Section]:
        if target.class_number and not target.course:
            # Some sources (Berkeleytime) can't look up by class number alone;
            # reuse the course we learned from an earlier successful poll.
            known = [s for s in self.state.values() if s.classNumber == target.class_number]
            if known:
                target = replace(target, course=known[0].course, term=target.term or known[0].term)
        with self._fetch_lock:
            last: Exception | None = None
            hard_fail = False  # a real failure, not "the source asked us to slow down"
            for src in self.sources:
                name = getattr(src, "name", type(src).__name__)
                until = self._cool_until.get(name, 0.0)
                if until > self._clock():
                    last = SourceError(f"{name} paused for {until - self._clock():.0f}s more")
                    continue
                self._pace(name)
                try:
                    secs = src.fetch(target)
                    return [s for s in secs if _matches(target, s)]
                except SourceError as e:  # try the next source
                    status = getattr(e, "status", None)
                    if status in PAUSE_STATUSES and self.cfg.cooldown_seconds > 0:
                        self._cool_until[name] = self._clock() + self.cfg.cooldown_seconds
                        log.warning("%s answered HTTP %s: pausing all requests to it for %ds",
                                    name, status, self.cfg.cooldown_seconds)
                    else:
                        hard_fail = True
                        log.warning("%s failed for %s: %s", name, target, e)
                    last = e
                finally:
                    self._last_request[name] = self._clock()
            if not hard_fail:
                raise CoolingDown(f"all sources paused: {last}")
            raise SourceError(f"all sources failed: {last}")

    # ---- one pass ----------------------------------------------------------
    def _backoff_passes(self, failures: int) -> int:
        cap = max(1, math.ceil(BACKOFF_CAP_SECONDS / max(self.cfg.interval_seconds, 1)))
        return min(2 ** failures, cap)

    def _select(self, top: list[Group]) -> list[Group]:
        """Drop groups in backoff; cap the rest at max_targets, rotating fairly."""
        ready = [g for g in top if self._skip_until.get(g.label, 0) <= self._pass_no]
        cap = max(int(getattr(self.cfg, "max_targets", 0) or len(ready) or 1), 1)
        if len(ready) <= cap:
            return ready
        log.warning("%d distinct targets exceed max_targets=%d; polling %d this pass, the rest in turn",
                    len(ready), cap, cap)
        start = self._rotate % len(ready)
        self._rotate = start + cap
        return [ready[(start + i) % len(ready)] for i in range(cap)]

    def _failed(self, g: Group, e: SourceError) -> ChangeEvent | None:
        tkey = g.label
        n = self._errors[tkey] = self._errors.get(tkey, 0) + 1
        self._skip_until[tkey] = self._pass_no + 1 + self._backoff_passes(n)
        if n != ERROR_ALERT_AFTER:  # alert once after 3 consecutive failures, not every poll
            return None
        t = g.target
        err = Section(course=t.course, classNumber=t.class_number, section=t.section, term=t.term)
        ev = ChangeEvent("error", err, None, f"Watcher can't read {tkey}: {e}")
        self._send_global([ev])  # never to subscribers
        return ev

    def _ok(self, g: Group) -> None:
        self._errors.pop(g.label, None)
        self._skip_until.pop(g.label, None)

    def poll_once(self) -> list[ChangeEvent]:
        started = self._clock()
        self._pass_no += 1
        top = self.plan()
        self.last_target_count = sum(1 + len(g.children) for g in top)
        seen: dict[str, tuple[Section, list[Interest]]] = {}
        all_events: list[ChangeEvent] = []
        attempted = succeeded = 0

        def collect(sections: list[Section], interests: list[Interest]) -> None:
            for s in sections:
                entry = seen.get(s.key)
                if entry is None:
                    seen[s.key] = (s, list(interests))
                else:
                    seen[s.key] = (s, entry[1] + interests)

        def run(g: Group) -> list[Section] | None:
            nonlocal attempted, succeeded
            try:
                attempted += 1
                secs = self.fetch(g.target)
            except CoolingDown:
                attempted -= 1
                return None
            except SourceError as e:
                ev = self._failed(g, e)
                if ev:
                    all_events.append(ev)
                return None
            finally:
                self._last_activity = self._clock()
            succeeded += 1
            self._ok(g)
            collect(secs, g.interests)
            return secs

        for g in self._select(top):
            if self._stop.is_set():
                break  # shutting down: save what we have, don't start new requests
            secs = run(g)
            for child in g.children:
                if secs is not None:
                    hit = [s for s in secs if _matches(child.target, s)]
                    if hit:  # reused the course fetch: no extra request
                        self._ok(child)
                        collect(hit, child.interests)
                        continue
                if self._skip_until.get(child.label, 0) > self._pass_no:
                    continue
                if secs is None and g.label in self._errors:
                    continue  # the course itself is failing; don't hammer it per section
                run(child)

        for s, interests in seen.values():
            before = self.state.get(s.key)
            evs = diff_section(before, s)
            self.state[s.key] = s
            if before is None and s.open:
                # First sight of a section that already has seats: worth telling.
                evs.append(ChangeEvent("seats_opened", s, None,
                                       f"{s.course} {s.section}: {s.open} open seat(s) right now"))
            all_events.extend(evs)
            self._fan_out(s, evs, interests)
        self.store.save_latest(self.state)
        self.store.append_events([e for e in all_events if e.kind != "error"])
        self._prune_subscriber_cache(top)
        now = self._clock()
        self._last_pass_end, self._last_pass_secs = now, now - started
        self.last_poll_at = utcnow_iso()
        self.last_poll_ok = attempted == 0 or succeeded > 0
        return all_events

    # ---- alerts ------------------------------------------------------------
    @staticmethod
    def _allowed(e: ChangeEvent, t: Target) -> bool:
        if e.kind in RESERVED_KINDS and not t.include_reserved:
            return False
        if e.kind in WAITLIST_KINDS and not t.include_waitlist:
            return False
        return True

    def _fan_out(self, s: Section, evs: list[ChangeEvent], interests: list[Interest]) -> None:
        evs = [e for e in evs if e.kind in self.cfg.alert_on]
        if not evs:
            return
        glob = [i.target for i in interests if i.notif is None]
        self._send_global([e for e in evs if any(self._allowed(e, t) for t in glob)])
        by_sub: dict[str, list[Interest]] = {}
        for i in interests:
            if i.notif:
                by_sub.setdefault(i.key, []).append(i)
        now = self._clock()
        cool = float(getattr(self.cfg, "subscriber_cooldown_seconds", 0) or 0)
        for key, ints in by_sub.items():
            mine = [e for e in evs if any(self._allowed(e, i.target) for i in ints)]
            if not mine:
                continue
            who = (ints[0].email or key, s.classNumber)
            last = self._sub_last_sent.get(who)
            if last is not None and now - last < cool:
                log.info("not emailing %s about #%s again yet (cooldown)", "subscriber", s.classNumber)
                continue
            # One email per class per pass: the first (most important) event; the body
            # lists open, reserved and waitlist seats anyway.
            if self._send(self._subscriber_notifiers(ints[0].notif), mine[:1]):
                self._sub_last_sent[who] = now

    def _subscriber_notifiers(self, conf: list[dict]) -> list:
        key = json.dumps(conf, sort_keys=True)
        hit = self._sub_notifiers.get(key)
        if hit is None:
            try:
                hit = self._build(conf)
            except Exception as ex:
                log.error("bad subscriber notifier config: %s", ex)
                return []
            footer = manage_line()
            for n in hit:
                if hasattr(n, "footer"):
                    n.footer = footer
            self._sub_notifiers[key] = hit
        return hit

    def _prune_subscriber_cache(self, top: list[Group]) -> None:
        live = {i.key for g in top for gg in [g, *g.children] for i in gg.interests if i.notif}
        for k in [k for k in self._sub_notifiers if k not in live]:
            del self._sub_notifiers[k]

    def _send_global(self, events: list[ChangeEvent]) -> None:
        self._send(self.notifiers, [e for e in events if e.kind in self.cfg.alert_on])

    @staticmethod
    def _send(notifiers: list, events: list[ChangeEvent]) -> bool:
        sent = False
        for e in events:
            for n in notifiers:
                try:
                    n.send(e)
                    sent = True
                except Exception as ex:  # one bad channel must not stop the others
                    log.error("notifier %s failed: %s", getattr(n, "name", n), ex)
        return sent

    # ---- health ------------------------------------------------------------
    def stale_after(self) -> float:
        return max(5 * self.cfg.interval_seconds, 600, 2 * self._last_pass_secs)

    def health(self) -> tuple[bool, dict[str, Any]]:
        """(healthy, body). Unhealthy when no pass finished and no fetch completed
        within max(5 x interval, 10 min, 2 x last pass) - including right after startup."""
        now = self._clock()
        ref = max(self._last_pass_end or self._started, self._last_activity)
        ok = now - ref <= self.stale_after() and not self._stop.is_set()
        return ok, {"ok": ok, "lastPollAt": self.last_poll_at, "lastPollOk": self.last_poll_ok,
                    "targets": self.last_target_count}

    # ---- loop --------------------------------------------------------------
    def run_forever(self) -> None:
        log.info("watching %d target(s) every ~%ds", len(self.all_targets()), self.cfg.interval_seconds)
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                evs = self.poll_once()
                log.info("poll done: %d sections, %d events", len(self.state), len(evs))
            except Exception:
                self.last_poll_ok = False
                log.exception("poll crashed; will retry")
            delay = self.cfg.interval_seconds + random.uniform(0, self.cfg.jitter_seconds)
            self._stop.wait(max(delay - (time.monotonic() - started), 1))

    def stop(self) -> None:
        self._stop.set()
