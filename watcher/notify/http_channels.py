"""Notifiers that deliver over HTTP: ntfy, Discord, Twilio SMS, generic webhook."""
from __future__ import annotations

from watcher.models import ChangeEvent
from watcher.notify._http import env_secret, post
from watcher.notify.base import NotifyError
from watcher.notify.format import URGENT_KINDS, format_body, format_title, _open_count

NTFY_TAGS = {
    "seats_opened": ["rotating_light", "white_check_mark"],
    "seats_increased": ["chart_with_upwards_trend"],
    "reserved_opened": ["rotating_light", "lock"],
    "waitlist_opened": ["hourglass_flowing_sand"],
    "waitlist_moved": ["arrow_down"],
    "closed": ["no_entry"],
    "new_section": ["new"],
    "error": ["warning"],
}


class NtfyNotifier:
    """Publish to an ntfy topic (https://ntfy.sh or a self-hosted server).

    Uses ntfy's JSON publish endpoint (POST to the server root) so that
    titles with non-ASCII characters are safe.
    """

    name = "ntfy"

    def __init__(
        self,
        topic: str,
        server: str = "https://ntfy.sh",
        token_env: str | None = None,
        priority: str | int | None = None,
        urgent_priority: str | int = 5,
        tags: list[str] | None = None,
        timeout: float = 10.0,
        **_: object,
    ) -> None:
        if not topic:
            raise ValueError("ntfy notifier requires 'topic'")
        self.topic = topic
        self.server = server.rstrip("/")
        self.token_env = token_env
        self.priority = priority
        self.urgent_priority = urgent_priority
        self.extra_tags = list(tags or [])
        self.timeout = timeout

    @property
    def url(self) -> str:
        return f"{self.server}/{self.topic}"

    def payload(self, event: ChangeEvent) -> dict:
        if event.kind in URGENT_KINDS:
            prio = self.urgent_priority
        else:
            prio = self.priority if self.priority is not None else 3
        p = {
            "topic": self.topic,
            "title": format_title(event),
            "message": format_body(event),
            "priority": _ntfy_priority(prio),
            "tags": NTFY_TAGS.get(event.kind, []) + self.extra_tags,
        }
        if event.section.url:
            p["click"] = event.section.url
            p["actions"] = [{"action": "view", "label": "Open class", "url": event.section.url}]
        return p

    def send(self, event: ChangeEvent) -> None:
        headers = {}
        token = env_secret(self.token_env, "ntfy token", required=False) if self.token_env else None
        if token:
            headers["Authorization"] = f"Bearer {token}"
        post(self.server, json=self.payload(event), headers=headers, timeout=self.timeout, what="ntfy")


def _ntfy_priority(p: str | int) -> int:
    names = {"min": 1, "low": 2, "default": 3, "high": 4, "max": 5, "urgent": 5}
    if isinstance(p, str):
        if p.isdigit():
            return int(p)
        return names.get(p.lower(), 3)
    return int(p)


DISCORD_COLORS = {
    "seats_opened": 0x2ECC71,
    "reserved_opened": 0x27AE60,
    "seats_increased": 0x3498DB,
    "waitlist_opened": 0xF1C40F,
    "waitlist_moved": 0xF39C12,
    "closed": 0xE74C3C,
    "new_section": 0x9B59B6,
    "error": 0x95A5A6,
}


# Kinds that ping the class role in a server built by `discord-server`.
PING_KINDS = URGENT_KINDS | {"waitlist_opened"}


class DiscordWebhookNotifier:
    name = "discord"

    def __init__(
        self,
        webhook_url_env: str = "DISCORD_WEBHOOK_URL",
        username: str = "Berkeley Seat Watcher",
        mention: str | None = None,
        timeout: float = 10.0,
        routes_file: str = "discord_channels.json",
        **_: object,
    ) -> None:
        # Written by `python -m watcher discord-setup`; maps each course to the
        # webhook of its own channel. When absent, everything goes to the env webhook.
        self.routes_file = routes_file
        self.webhook_url_env = webhook_url_env
        self.username = username
        self.mention = mention  # e.g. "@everyone" or "<@123>"; only used for urgent kinds
        self.timeout = timeout

    def payload(self, event: ChangeEvent) -> dict:
        s = event.section
        fields = [
            {"name": "Open seats", "value": _str(_open_count(s)), "inline": True},
            {"name": "Enrolled", "value": f"{_str(s.enrolled)}/{_str(s.capacity)}", "inline": True},
        ]
        if s.waitlisted is not None or s.waitlistCapacity is not None:
            fields.append(
                {"name": "Waitlist", "value": f"{_str(s.waitlisted)}/{_str(s.waitlistCapacity)}", "inline": True}
            )
        if s.reserved:
            fields.append({
                "name": "Reserved seats",
                "value": "\n".join(
                    f"{r.group}: {_str(r.open)} open ({_str(r.enrolled)}/{_str(r.capacity)})"
                    for r in s.reserved
                )[:1024],
                "inline": False,
            })
        desc_parts = [x for x in (s.title, s.instructor, s.term, f"Class #{s.classNumber}" if s.classNumber else "") if x]
        embed = {
            "title": format_title(event)[:256],
            "description": "\n".join(filter(None, [" | ".join(desc_parts), event.message]))[:4096],
            "color": DISCORD_COLORS.get(event.kind, 0x95A5A6),
            "fields": fields,
            "footer": {"text": f"{event.kind} | {s.source or 'watcher'}"},
        }
        if s.url:
            embed["url"] = s.url
        if s.fetchedAt:
            embed["timestamp"] = s.fetchedAt
        payload = {"username": self.username, "embeds": [embed]}
        if self.mention and event.kind in URGENT_KINDS:
            payload["content"] = self.mention
        return payload

    def send(self, event: ChangeEvent) -> None:
        from watcher.discord_setup import load_routes, role_for, webhook_for
        routes = load_routes(self.routes_file) or {}
        course = event.section.course
        if event.kind == "error" and routes.get("errors"):
            # A full server (discord-server) keeps watcher errors in the staff-only #bot-log.
            post(routes["errors"], json=self.payload(event), timeout=self.timeout, what="discord")
            return
        url = webhook_for(routes, course) or env_secret(self.webhook_url_env, "discord webhook URL")
        ping = event.kind in PING_KINDS
        errors = []
        targets = [(url, role_for(routes, course) if course in routes.get("courses", {}) else None)]
        if routes.get("feed") and routes["feed"] != url:
            targets.append((routes["feed"], routes.get("all_role")))  # public feed of every class
        elif routes.get("feed"):
            targets[0] = (url, routes.get("all_role"))
        for target, role in targets:
            payload = self.payload(event)
            if role and ping and not self.mention:
                payload["content"] = f"<@&{role}>"
                payload["allowed_mentions"] = {"roles": [str(role)]}
            try:
                post(target, json=payload, timeout=self.timeout, what="discord")
            except NotifyError as e:
                errors.append(str(e))
        if errors:
            raise NotifyError("; ".join(errors))


def _str(v) -> str:
    return "?" if v is None else str(v)


class TwilioSmsNotifier:
    name = "twilio"

    API = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"

    def __init__(
        self,
        to: str | list[str],
        from_: str | None = None,
        account_sid_env: str = "TWILIO_ACCOUNT_SID",
        auth_token_env: str = "TWILIO_AUTH_TOKEN",
        messaging_service_sid: str | None = None,
        timeout: float = 10.0,
        **kw: object,
    ) -> None:
        from_ = from_ or kw.get("from")  # YAML key "from" is natural
        if not to:
            raise ValueError("twilio notifier requires 'to'")
        if not from_ and not messaging_service_sid:
            raise ValueError("twilio notifier requires 'from' or 'messaging_service_sid'")
        self.to = [to] if isinstance(to, str) else list(to)
        self.from_ = from_
        self.messaging_service_sid = messaging_service_sid
        self.account_sid_env = account_sid_env
        self.auth_token_env = auth_token_env
        self.timeout = timeout

    def body(self, event: ChangeEvent) -> str:
        text = format_title(event)
        if event.section.url:
            text += f"\n{event.section.url}"
        return text[:1600]

    def send(self, event: ChangeEvent) -> None:
        sid = env_secret(self.account_sid_env, "twilio account sid")
        token = env_secret(self.auth_token_env, "twilio auth token")
        url = self.API.format(sid=sid)
        errors = []
        for number in self.to:
            data = {"To": number, "Body": self.body(event)}
            if self.messaging_service_sid:
                data["MessagingServiceSid"] = self.messaging_service_sid
            else:
                data["From"] = self.from_
            try:
                post(url, data=data, auth=(sid, token), timeout=self.timeout, what="twilio")
            except NotifyError as e:
                errors.append(f"{number}: {e}")
        if errors:
            raise NotifyError("; ".join(errors))


class WebhookNotifier:
    """Generic JSON POST of event.to_dict()."""

    name = "webhook"

    def __init__(
        self,
        url: str | None = None,
        url_env: str | None = None,
        headers: dict[str, str] | None = None,
        header_envs: dict[str, str] | None = None,
        timeout: float = 10.0,
        **_: object,
    ) -> None:
        if not url and not url_env:
            raise ValueError("webhook notifier requires 'url' or 'url_env'")
        self._url = url
        self.url_env = url_env
        self.headers = dict(headers or {})
        self.header_envs = dict(header_envs or {})  # {"Authorization": "MY_HOOK_TOKEN"}
        self.timeout = timeout

    def payload(self, event: ChangeEvent) -> dict:
        d = event.to_dict()
        d["title"] = format_title(event)
        d["body"] = format_body(event)
        return d

    def send(self, event: ChangeEvent) -> None:
        url = self._url or env_secret(self.url_env, "webhook URL")
        headers = dict(self.headers)
        for header, var in self.header_envs.items():
            headers[header] = env_secret(var, f"webhook header {header}")
        post(url, json=self.payload(event), headers=headers, timeout=self.timeout, what="webhook")
