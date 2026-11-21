"""Auto-configure a Discord server for seat alerts.

    python -m watcher discord-setup [-c watcher.yaml] [--guild ID] [--dry-run]

Using a bot token from the DISCORD_BOT_TOKEN environment variable, this creates
(or reuses) in the server:

    Seat Alerts            (category)
      #all-alerts          (catch-all: errors and classes without their own channel)
      #sociol-167          (one channel per course in watcher.yaml)

and one webhook per channel, then writes the webhook URLs to a local routes
file (discord_channels.json, gitignored) that the ``discord`` notifier reads.

The bot is only used for this setup step. Alerts are posted through the
webhooks, so the bot does not need to stay online. Bot permissions needed:
View Channels, Manage Channels, Manage Webhooks.

Safe to re-run: existing channels and webhooks with the same names are reused.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

import requests

API = "https://discord.com/api/v10"
CATEGORY_NAME = "Seat Alerts"
DEFAULT_CHANNEL = "all-alerts"
WEBHOOK_NAME = "Berkeley Seat Watcher"
ROUTES_FILE = "discord_channels.json"
TYPE_TEXT, TYPE_CATEGORY = 0, 4


class DiscordSetupError(RuntimeError):
    pass


class DiscordForbidden(DiscordSetupError):
    """403: the bot lacks a permission (or its role is too low) for this call."""


class DiscordNotFound(DiscordSetupError):
    """404: the channel, role or message no longer exists."""


def channel_name(course: str) -> str:
    """'COMPSCI 61A' -> 'compsci-61a' (Discord text channel naming rules)."""
    name = re.sub(r"[^a-z0-9]+", "-", course.lower()).strip("-")
    return name[:100] or "class"


class DiscordAPI:
    def __init__(self, token: str, session: requests.Session | None = None, timeout: float = 15.0):
        self.s = session or requests.Session()
        self.headers = {"Authorization": f"Bot {token}",
                        "User-Agent": "CalClassCoordinator (seat watcher setup, 0.1)"}
        self.timeout = timeout

    def call(self, method: str, path: str, **kw: Any) -> Any:
        for _ in range(6):
            try:
                r = self.s.request(method, API + path, headers=self.headers, timeout=self.timeout, **kw)
            except requests.RequestException as e:
                raise DiscordSetupError(f"Discord request failed: {type(e).__name__}") from None
            if r.status_code == 429:  # rate limited: wait as told, then retry
                time.sleep(min(float(r.json().get("retry_after", 1)), 10))
                continue
            if r.status_code == 401:
                raise DiscordSetupError("Discord rejected the bot token (401). Check DISCORD_BOT_TOKEN.")
            if r.status_code == 403:
                raise DiscordForbidden(
                    f"Discord refused {method} {path} (403). The bot needs View Channels, "
                    "Manage Channels and Manage Webhooks in this server "
                    "(and Manage Roles for discord-server / discord-bot).")
            if r.status_code == 404:
                raise DiscordNotFound(f"Discord says {method} {path} does not exist (404).")
            if r.status_code >= 400:
                raise DiscordSetupError(f"Discord error {r.status_code} on {method} {path}: {r.text[:200]}")
            return r.json() if r.content else None
        raise DiscordSetupError("Discord kept rate limiting; try again in a minute.")


def pick_guild(api: DiscordAPI, guild_id: str | None) -> dict:
    guilds = api.call("GET", "/users/@me/guilds")
    if guild_id:
        hit = [g for g in guilds if str(g["id"]) == str(guild_id)]
        if not hit:
            raise DiscordSetupError(f"The bot is not in server {guild_id}. Invite it first.")
        return hit[0]
    if not guilds:
        raise DiscordSetupError("The bot is not in any server yet. Invite it with its OAuth2 URL first.")
    if len(guilds) > 1:
        names = ", ".join(f"{g['name']} ({g['id']})" for g in guilds)
        raise DiscordSetupError(f"The bot is in several servers; pass --guild ID. Servers: {names}")
    return guilds[0]


def _ensure_channel(api: DiscordAPI, guild_id: str, channels: list[dict], name: str, type_: int,
                    parent_id: str | None, topic: str, dry_run: bool, log: list[str]) -> dict:
    for c in channels:
        if c["type"] == type_ and c["name"].lower() == name.lower() and (
                type_ == TYPE_CATEGORY or c.get("parent_id") == parent_id):
            log.append(f"reuse   {'category' if type_ == TYPE_CATEGORY else '#'}{name}")
            return c
    log.append(f"create  {'category ' if type_ == TYPE_CATEGORY else '#'}{name}")
    if dry_run:
        return {"id": f"dry-{name}", "name": name, "type": type_, "parent_id": parent_id}
    body: dict[str, Any] = {"name": name, "type": type_}
    if parent_id:
        body["parent_id"] = parent_id
    if topic and type_ == TYPE_TEXT:
        body["topic"] = topic
    c = api.call("POST", f"/guilds/{guild_id}/channels", json=body)
    channels.append(c)
    return c


def ensure_webhook(api: DiscordAPI, channel: dict, dry_run: bool, log: list[str]) -> str:
    if dry_run or str(channel["id"]).startswith("dry-"):
        return "(dry run)"
    for h in api.call("GET", f"/channels/{channel['id']}/webhooks"):
        if h.get("name") == WEBHOOK_NAME and h.get("token"):
            return f"https://discord.com/api/webhooks/{h['id']}/{h['token']}"
    h = api.call("POST", f"/channels/{channel['id']}/webhooks", json={"name": WEBHOOK_NAME})
    log.append(f"webhook #{channel['name']}")
    return f"https://discord.com/api/webhooks/{h['id']}/{h['token']}"


def setup(courses: list[str], *, token: str, guild_id: str | None = None, dry_run: bool = False,
          api: DiscordAPI | None = None) -> tuple[dict, list[str]]:
    """Create/reuse channels and webhooks. Returns (routes, log lines)."""
    api = api or DiscordAPI(token)
    log: list[str] = []
    guild = pick_guild(api, guild_id)
    gid = str(guild["id"])
    log.append(f"server  {guild['name']}")
    channels = api.call("GET", f"/guilds/{gid}/channels")
    cat = _ensure_channel(api, gid, channels, CATEGORY_NAME, TYPE_CATEGORY, None, "", dry_run, log)
    default = _ensure_channel(api, gid, channels, DEFAULT_CHANNEL, TYPE_TEXT, cat["id"],
                              "Seat watcher: errors and classes without their own channel", dry_run, log)
    routes: dict[str, Any] = {"guild_id": gid, "guild_name": guild["name"],
                              "default": ensure_webhook(api, default, dry_run, log), "courses": {}}
    for course in sorted(set(c for c in courses if c)):
        ch = _ensure_channel(api, gid, channels, channel_name(course), TYPE_TEXT, cat["id"],
                             f"Seat alerts for {course}", dry_run, log)
        routes["courses"][course] = ensure_webhook(api, ch, dry_run, log)
    return routes, log


def resolve_routes_path(path: str | Path = ROUTES_FILE) -> Path:
    """Where the routes file really lives.

    A relative path is taken inside ``$WATCHER_DATA_DIR`` when that is set (the
    server's mounted volume, so the bot's state survives redeploys) and relative
    to the working directory otherwise (the owner's PC). Absolute paths are kept.
    """
    p = Path(path)
    data_dir = os.environ.get("WATCHER_DATA_DIR", "").strip()
    if data_dir and not p.is_absolute():
        return Path(data_dir) / p
    return p


def write_routes(routes: dict, path: str | Path = ROUTES_FILE) -> Path:
    path = resolve_routes_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(routes, indent=2))
    os.replace(tmp, path)
    return path


def load_routes(path: str | Path = ROUTES_FILE) -> dict | None:
    p = resolve_routes_path(path)
    if not p.exists():
        return None
    return json.loads(p.read_text())


def webhook_for(routes: dict | None, course: str) -> str | None:
    if not routes:
        return None
    return routes.get("courses", {}).get(course) or routes.get("default")


def role_for(routes: dict | None, course: str) -> str | None:
    """Role to ping for a course (set by ``discord-server``); None when there is none."""
    return (routes or {}).get("roles", {}).get(course)


def watched_courses(path: str | Path = ROUTES_FILE) -> list[str]:
    """Courses that have a Discord channel; the watcher polls these too."""
    try:
        return sorted((load_routes(path) or {}).get("courses", {}))
    except (OSError, ValueError):
        return []
