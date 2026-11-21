"""Alert channels. Build them from config with ``build_notifiers``.

Example YAML::

    notify:
      - type: console
      - type: desktop
      - type: ntfy
        topic: my-secret-cal-seats
      - type: discord
        webhook_url_env: DISCORD_WEBHOOK_URL
      - type: email
        host: smtp.gmail.com
        user: me@gmail.com
        to: me@berkeley.edu
        password_env: SMTP_PASSWORD
"""
from __future__ import annotations

from typing import Any, Iterable

from watcher.notify.base import Notifier, NotifyError
from watcher.notify.console import ConsoleNotifier
from watcher.notify.desktop import DesktopNotifier
from watcher.notify.format import format_body, format_title
from watcher.notify.http_channels import (
    DiscordWebhookNotifier,
    NtfyNotifier,
    TwilioSmsNotifier,
    WebhookNotifier,
)
from watcher.notify.smtp_email import EmailNotifier

REGISTRY: dict[str, type] = {
    "console": ConsoleNotifier,
    "desktop": DesktopNotifier,
    "ntfy": NtfyNotifier,
    "discord": DiscordWebhookNotifier,
    "email": EmailNotifier,
    "smtp": EmailNotifier,
    "twilio": TwilioSmsNotifier,
    "sms": TwilioSmsNotifier,
    "webhook": WebhookNotifier,
}


def build_notifier(cfg: dict[str, Any]) -> Notifier:
    cfg = dict(cfg)
    kind = str(cfg.pop("type", "")).strip().lower()
    cls = REGISTRY.get(kind)
    if cls is None:
        raise ValueError(f"unknown notifier type {kind!r}; expected one of {sorted(REGISTRY)}")
    enabled = cfg.pop("enabled", True)
    if not enabled:
        return None  # type: ignore[return-value]
    if "from" in cfg and "from_" not in cfg:
        cfg["from_"] = cfg.pop("from")
    try:
        return cls(**cfg)
    except TypeError as e:  # missing/invalid keys in YAML
        raise ValueError(f"bad config for notifier {kind!r}: {e}") from e


def build_notifiers(config_list: Iterable[dict[str, Any]] | None) -> list[Notifier]:
    """Turn ``[{"type": "ntfy", "topic": "..."}, ...]`` into notifier instances.

    Entries with ``enabled: false`` are skipped. Unknown types raise ValueError.
    """
    out = []
    for cfg in config_list or []:
        if not isinstance(cfg, dict):
            raise ValueError(f"notifier config must be a mapping, got {cfg!r}")
        n = build_notifier(cfg)
        if n is not None:
            out.append(n)
    return out


__all__ = [
    "Notifier", "NotifyError", "build_notifier", "build_notifiers", "format_title", "format_body",
    "ConsoleNotifier", "DesktopNotifier", "NtfyNotifier", "DiscordWebhookNotifier",
    "EmailNotifier", "TwilioSmsNotifier", "WebhookNotifier", "REGISTRY",
]
