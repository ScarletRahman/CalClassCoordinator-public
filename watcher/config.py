"""Load watcher.yaml into typed config.

A few production settings can also come from the environment so no secrets
live in YAML (see ``_env_overrides``): SMTP_* / MAIL_FROM build the subscriber
email notifier, DISCORD_AUTO_APPROVE / DISCORD_MAX_CLASSES tune the bot, and
WATCHER_DATA_DIR moves all state (seats, subscriptions, Discord routes).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from watcher.sources.base import Target

MIN_INTERVAL = 30  # seconds; be polite to Berkeley's servers

log = logging.getLogger("watcher")

DEFAULT_ALERT_ON = ["seats_opened", "seats_increased", "reserved_opened", "waitlist_opened", "error"]


@dataclass
class Config:
    targets: list[Target] = field(default_factory=list)
    interval_seconds: int = 60
    jitter_seconds: int = 10
    sources: list[str] = field(default_factory=lambda: ["classes.berkeley.edu", "berkeleytime"])
    term: str = ""
    alert_on: list[str] = field(default_factory=lambda: list(DEFAULT_ALERT_ON))
    notifiers: list[dict[str, Any]] = field(default_factory=lambda: [{"type": "console"}])
    # Notifier template used for subscriptions created through the HTTP API.
    # Its "to" is replaced by each subscriber's email.
    subscription_email: dict[str, Any] | None = None
    data_dir: str = ""
    # Also watch every class that has a channel in the Discord routes file
    # (written by `discord-server` and the Discord bot).
    watch_discord_classes: bool = True
    discord_routes_file: str = "discord_channels.json"
    # Discord bot options (also settable with --auto-approve / --max-classes, or env).
    discord_auto_approve: bool = True
    discord_max_classes: int = 100
    # Polite scraping at scale.
    min_request_gap_seconds: float = 2.0   # minimum gap between requests to one source
    max_targets: int = 300                 # distinct fetches per pass; extra ones rotate
    cooldown_seconds: int = 600            # pause a source after it answers 429/403
    subscriber_cooldown_seconds: int = 600  # max one email per subscriber per class per this
    history_max_bytes: int = 50_000_000    # rotate history.jsonl past this size (keeps one .1)
    # Sources for GET /lookup (the planner's schedule builder), tried in order.
    lookup_sources: list[str] = field(default_factory=lambda: ["classes.berkeley.edu", "berkeleytime"])
    lookup_cache_seconds: int = 300        # how long one course's answer is reused (minimum 60)


def _target(d: dict[str, Any], default_term: str) -> Target:
    if isinstance(d, str):  # shorthand: "COMPSCI 61A" or "28984"
        d = {"class_number": d} if d.strip().isdigit() else {"course": d}
    return Target(
        course=str(d.get("course", "")).upper().strip(),
        term=str(d.get("term", default_term)),
        class_number=str(d.get("class_number", d.get("classNumber", ""))).strip(),
        section=str(d.get("section", "")).upper().strip(),
        include_reserved=bool(d.get("include_reserved", True)),
        include_waitlist=bool(d.get("include_waitlist", True)),
    )


def _truthy(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes", "on")


def smtp_from_env(env: dict[str, str] | None = None) -> dict[str, Any] | None:
    """Subscriber email notifier template from SMTP_HOST, SMTP_PORT, SMTP_USER,
    SMTP_PASSWORD (read at send time, never stored) and MAIL_FROM. None without SMTP_HOST."""
    env = os.environ if env is None else env
    host = env.get("SMTP_HOST", "").strip()
    if not host:
        return None
    user = env.get("SMTP_USER", "").strip() or None
    sender = env.get("MAIL_FROM", "").strip() or user
    if not sender:
        log.warning("SMTP_HOST is set but neither MAIL_FROM nor SMTP_USER is; subscriber emails are off")
        return None
    return {"type": "email", "host": host, "port": int(env.get("SMTP_PORT", "").strip() or 587),
            "user": user, "password_env": "SMTP_PASSWORD", "from": sender}


def load_config(path: str | Path) -> Config:
    raw = yaml.safe_load(Path(path).read_text()) or {}
    term = str(raw.get("term", ""))
    src = raw.get("source", raw.get("sources"))
    if isinstance(src, str):
        src = [src]
    cfg = Config(
        targets=[_target(t, term) for t in raw.get("watch", [])],
        interval_seconds=max(int(raw.get("interval_seconds", 60)), MIN_INTERVAL),
        jitter_seconds=int(raw.get("jitter_seconds", 10)),
        sources=src or Config().sources,
        term=term,
        alert_on=list(raw.get("alert_on", DEFAULT_ALERT_ON)),
        notifiers=list(raw.get("notifiers", [{"type": "console"}])),
        subscription_email=raw.get("subscription_email"),
        data_dir=str(raw.get("data_dir", os.environ.get("WATCHER_DATA_DIR", ""))),
        watch_discord_classes=bool(raw.get("watch_discord_classes", True)),
        discord_routes_file=str(raw.get("discord_routes_file", "discord_channels.json")),
        discord_auto_approve=bool(raw.get("discord_auto_approve", True)),
        discord_max_classes=int(raw.get("discord_max_classes", 100)),
        min_request_gap_seconds=max(float(raw.get("min_request_gap_seconds", 2.0)), 0.0),
        max_targets=max(int(raw.get("max_targets", 300)), 1),
        cooldown_seconds=max(int(raw.get("cooldown_seconds", 600)), 0),
        subscriber_cooldown_seconds=max(int(raw.get("subscriber_cooldown_seconds", 600)), 0),
        history_max_bytes=max(int(raw.get("history_max_bytes", 50_000_000)), 0),
        lookup_sources=[str(x) for x in (raw.get("lookup_sources") or Config().lookup_sources)],
        lookup_cache_seconds=max(int(raw.get("lookup_cache_seconds", 300)), 60),
    )
    _env_overrides(cfg)
    return cfg


def _env_overrides(cfg: Config, env: dict[str, str] | None = None) -> None:
    env = os.environ if env is None else env
    from watcher.discord_setup import resolve_routes_path
    cfg.discord_routes_file = str(resolve_routes_path(cfg.discord_routes_file))
    if cfg.subscription_email is None:
        cfg.subscription_email = smtp_from_env(env)
    if env.get("DISCORD_AUTO_APPROVE", "").strip():
        cfg.discord_auto_approve = _truthy(env["DISCORD_AUTO_APPROVE"])
    if env.get("DISCORD_MAX_CLASSES", "").strip():
        cfg.discord_max_classes = int(env["DISCORD_MAX_CLASSES"])
