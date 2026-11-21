"""Offline tests for watcher.notify (no network, no SMTP, no subprocess)."""
from __future__ import annotations

import base64
import io
from unittest import mock

import pytest
import requests

from watcher.models import ChangeEvent, ReservedSeat, Section
from watcher.notify import (
    ConsoleNotifier,
    DesktopNotifier,
    DiscordWebhookNotifier,
    EmailNotifier,
    NotifyError,
    NtfyNotifier,
    TwilioSmsNotifier,
    WebhookNotifier,
    build_notifiers,
    format_body,
    format_title,
)
from watcher.notify import desktop as desktop_mod

URL = "https://classes.berkeley.edu/content/2026-spring-compsci-61a-001-lec-001"


def sec(**kw) -> Section:
    base = dict(
        course="COMPSCI 61A", classNumber="28984", section="001 LEC", term="2026 Spring",
        title="The Structure and Interpretation of Computer Programs", instructor="John DeNero",
        enrolled=497, capacity=500, waitlisted=12, waitlistCapacity=100, open=3,
        reserved=[ReservedSeat("Computer Science Majors", 40, 50)], status="open", url=URL,
        source="classes.berkeley.edu", fetchedAt="2026-01-10T08:00:00Z",
    )
    base.update(kw)
    return Section(**base)


def ev(kind="seats_opened", before=None, **kw) -> ChangeEvent:
    if before is None and kind == "seats_opened":
        before = sec(open=0, enrolled=500)
    return ChangeEvent(kind=kind, section=sec(**kw), before=before, message="3 seats opened")


def ok_response(status=200, text="ok"):
    r = mock.Mock(spec=requests.Response)
    r.status_code = status
    r.text = text
    return r


# ---------------------------------------------------------------- format
def test_title_seats_opened():
    assert format_title(ev()) == "COMPSCI 61A 001 LEC: 3 open seats (was 0)"


def test_title_singular_and_no_before():
    e = ChangeEvent("seats_increased", sec(open=1), None, "")
    assert format_title(e) == "COMPSCI 61A 001 LEC: 1 open seat"


def test_title_open_derived_from_capacity_when_missing():
    e = ChangeEvent("seats_opened", sec(open=None, enrolled=95, capacity=100), sec(open=None, enrolled=100, capacity=100), "")
    assert format_title(e) == "COMPSCI 61A 001 LEC: 5 open seats (was 0)"


def test_title_reserved_and_waitlist():
    assert format_title(ev("reserved_opened")) == "COMPSCI 61A 001 LEC: 10 reserved seats open"
    e = ChangeEvent("waitlist_moved", sec(waitlisted=10), sec(waitlisted=12), "")
    assert format_title(e) == "COMPSCI 61A 001 LEC: waitlist moved, waitlist 10/100 (was 12)"
    e = ChangeEvent("closed", sec(open=0), sec(open=2), "")
    assert format_title(e) == "COMPSCI 61A 001 LEC: 0 open seats (was 2)"


def test_title_unknowns_dont_crash():
    e = ChangeEvent("error", Section(course="", classNumber="12345", section=""), None, "boom")
    assert "12345" in format_title(e)
    s = Section(course="X 1", classNumber="1", section="001 LEC")
    for kind in ("seats_opened", "waitlist_opened", "new_section", "weird_kind"):
        format_title(ChangeEvent(kind, s, s, ""))
        format_body(ChangeEvent(kind, s, s, ""))


def test_body_contents():
    body = format_body(ev())
    assert "COMPSCI 61A 001 LEC - The Structure" in body
    assert "class #28984" in body and "John DeNero" in body
    assert "Open (unreserved): 3  Enrolled: 497/500" in body
    assert "Computer Science Majors: 10 open (40/50)" in body
    assert "Waitlist: 12/100" in body
    assert body.rstrip().endswith(URL)


# ---------------------------------------------------------------- build
def test_build_notifiers():
    ns = build_notifiers([
        {"type": "console"},
        {"type": "ntfy", "topic": "t"},
        {"type": "discord"},
        {"type": "email", "to": "a@b.c", "from": "me@x.y"},
        {"type": "twilio", "to": "+15550001111", "from": "+15550002222"},
        {"type": "webhook", "url": "https://example.com/h"},
        {"type": "desktop"},
        {"type": "ntfy", "topic": "off", "enabled": False},
    ])
    assert [n.name for n in ns] == ["console", "ntfy", "discord", "email", "twilio", "webhook", "desktop"]
    assert ns[3].from_ == "me@x.y"


def test_build_unknown_type():
    with pytest.raises(ValueError):
        build_notifiers([{"type": "pigeon"}])
    with pytest.raises(ValueError):
        build_notifiers([{"type": "ntfy"}])  # missing required key
    assert build_notifiers(None) == []


# ---------------------------------------------------------------- console
def test_console():
    buf = io.StringIO()
    ConsoleNotifier(stream=buf, verbose=True).send(ev())
    out = buf.getvalue()
    assert "!! seats_opened: COMPSCI 61A 001 LEC: 3 open seats (was 0)" in out
    assert URL in out and "3 seats opened" in out


# ---------------------------------------------------------------- ntfy
def test_ntfy_payload_urgent():
    with mock.patch("requests.post", return_value=ok_response()) as p:
        NtfyNotifier(topic="cal-seats").send(ev())
    url = p.call_args.args[0]
    body = p.call_args.kwargs["json"]
    assert url == "https://ntfy.sh"
    assert body["topic"] == "cal-seats"
    assert body["title"] == "COMPSCI 61A 001 LEC: 3 open seats (was 0)"
    assert body["priority"] == 5
    assert body["click"] == URL
    assert "rotating_light" in body["tags"]
    assert "Authorization" not in p.call_args.kwargs["headers"]


def test_ntfy_non_urgent_custom_server_and_token(monkeypatch):
    monkeypatch.setenv("NTFY_TOKEN", "tk_abc")
    n = NtfyNotifier(topic="x", server="https://ntfy.example.com/", token_env="NTFY_TOKEN",
                     priority="low", tags=["cal"])
    with mock.patch("requests.post", return_value=ok_response()) as p:
        n.send(ev("waitlist_moved", before=sec(waitlisted=15)))
    assert p.call_args.args[0] == "https://ntfy.example.com"
    assert p.call_args.kwargs["json"]["priority"] == 2
    assert p.call_args.kwargs["json"]["tags"][-1] == "cal"
    assert p.call_args.kwargs["headers"]["Authorization"] == "Bearer tk_abc"
    assert ev("reserved_opened") and n.payload(ev("reserved_opened"))["priority"] == 5


def test_ntfy_http_error_raises():
    with mock.patch("requests.post", return_value=ok_response(500, "nope")):
        with pytest.raises(NotifyError, match="HTTP 500"):
            NtfyNotifier(topic="x").send(ev())
    with mock.patch("requests.post", side_effect=requests.ConnectionError("down")):
        with pytest.raises(NotifyError, match="down"):
            NtfyNotifier(topic="x").send(ev())


# ---------------------------------------------------------------- discord
def test_discord_payload(monkeypatch):
    monkeypatch.setenv("MY_HOOK", "https://discord.com/api/webhooks/1/abc")
    n = DiscordWebhookNotifier(webhook_url_env="MY_HOOK", mention="@here")
    with mock.patch("requests.post", return_value=ok_response(204, "")) as p:
        n.send(ev())
    assert p.call_args.args[0] == "https://discord.com/api/webhooks/1/abc"
    body = p.call_args.kwargs["json"]
    assert body["content"] == "@here"
    embed = body["embeds"][0]
    assert embed["title"] == "COMPSCI 61A 001 LEC: 3 open seats (was 0)"
    assert embed["url"] == URL
    fields = {f["name"]: f["value"] for f in embed["fields"]}
    assert fields["Open seats"] == "3"
    assert fields["Enrolled"] == "497/500"
    assert fields["Waitlist"] == "12/100"
    assert "Computer Science Majors: 10 open" in fields["Reserved seats"]
    # non-urgent: no mention
    assert "content" not in n.payload(ev("closed"))


def test_discord_missing_env(monkeypatch):
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    with pytest.raises(NotifyError, match="DISCORD_WEBHOOK_URL"):
        DiscordWebhookNotifier().send(ev())


# ---------------------------------------------------------------- twilio
def test_twilio_payload(monkeypatch):
    monkeypatch.setenv("TWILIO_ACCOUNT_SID", "AC123")
    monkeypatch.setenv("TWILIO_AUTH_TOKEN", "secret")
    n = TwilioSmsNotifier(to=["+15550001111", "+15550003333"], from_="+15550002222")
    with mock.patch("requests.post", return_value=ok_response(201)) as p:
        n.send(ev())
    assert p.call_count == 2
    call = p.call_args_list[0]
    assert call.args[0] == "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"
    assert call.kwargs["auth"] == ("AC123", "secret")
    assert call.kwargs["data"]["To"] == "+15550001111"
    assert call.kwargs["data"]["From"] == "+15550002222"
    assert call.kwargs["data"]["Body"].startswith("COMPSCI 61A 001 LEC: 3 open seats")
    assert URL in call.kwargs["data"]["Body"]


def test_twilio_requires_from():
    with pytest.raises(ValueError):
        TwilioSmsNotifier(to="+1555")


# ---------------------------------------------------------------- webhook
def test_webhook_payload(monkeypatch):
    monkeypatch.setenv("HOOK_TOKEN", "Bearer zzz")
    n = WebhookNotifier(url="https://example.com/hook", headers={"X-A": "1"},
                        header_envs={"Authorization": "HOOK_TOKEN"})
    e = ev()
    with mock.patch("requests.post", return_value=ok_response()) as p:
        n.send(e)
    body = p.call_args.kwargs["json"]
    assert body["kind"] == "seats_opened"
    assert body["section"] == e.section.to_dict()
    assert body["before"]["open"] == 0
    assert body["title"] == format_title(e)
    assert p.call_args.kwargs["headers"] == {"X-A": "1", "Authorization": "Bearer zzz"}


# ---------------------------------------------------------------- email
def test_email_starttls(monkeypatch):
    monkeypatch.setenv("SMTP_PASSWORD", "pw")
    n = EmailNotifier(to=["a@berkeley.edu"], host="smtp.example.com", port=587,
                      user="me@example.com")
    with mock.patch("smtplib.SMTP") as SMTP:
        n.send(ev())
    SMTP.assert_called_once_with("smtp.example.com", 587, timeout=20.0)
    smtp = SMTP.return_value.__enter__.return_value
    smtp.starttls.assert_called_once()
    smtp.login.assert_called_once_with("me@example.com", "pw")
    msg = smtp.send_message.call_args.args[0]
    assert msg["Subject"] == "[Seat Watcher] COMPSCI 61A 001 LEC: 3 open seats (was 0)"
    assert msg["From"] == "me@example.com" and msg["To"] == "a@berkeley.edu"
    assert "Waitlist: 12/100" in msg.get_content()


def test_email_missing_password(monkeypatch):
    monkeypatch.delenv("SMTP_PASSWORD", raising=False)
    with pytest.raises(NotifyError):
        EmailNotifier(to="a@b.c", user="me@x.y").send(ev())


def test_email_smtp_error(monkeypatch):
    import smtplib
    monkeypatch.setenv("SMTP_PASSWORD", "pw")
    with mock.patch("smtplib.SMTP", side_effect=smtplib.SMTPConnectError(421, "busy")):
        with pytest.raises(NotifyError):
            EmailNotifier(to="a@b.c", user="me@x.y").send(ev())


# ---------------------------------------------------------------- desktop
def test_desktop_windows_toast(monkeypatch):
    n = DesktopNotifier()
    n.system = "Windows"
    monkeypatch.setattr(desktop_mod.shutil, "which", lambda x: r"C:\ps\powershell.exe" if "powershell" in x else None)
    with mock.patch.object(desktop_mod.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")) as run:
        n.send(ev(title="Tom's & <Jerry>"))
    cmd = run.call_args.args[0]
    assert cmd[0].endswith("powershell.exe") and "-EncodedCommand" in cmd
    script = base64.b64decode(cmd[-1]).decode("utf-16-le")
    assert "ToastNotificationManager" in script
    assert "COMPSCI 61A 001 LEC: 3 open seats (was 0)" in script
    assert URL in script and 'activationType="protocol"' in script


def test_desktop_toast_xml_escapes():
    xml = desktop_mod.windows_toast_xml("A & B <c>", "it's", "https://x/?a=1&b=2")
    assert "A &amp; B &lt;c&gt;" in xml and "a=1&amp;b=2" in xml
    script = desktop_mod.windows_toast_script("<t>it's</t>")
    assert "it''s" in script


def test_desktop_linux_notify_send(monkeypatch):
    n = DesktopNotifier()
    n.system = "Linux"
    monkeypatch.setattr(n, "_plyer", mock.Mock(side_effect=NotifyError("no plyer")))
    monkeypatch.setattr(desktop_mod.shutil, "which", lambda x: "/usr/bin/notify-send" if x == "notify-send" else None)
    with mock.patch.object(desktop_mod.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
        n.send(ev())
    cmd = run.call_args.args[0]
    assert cmd[0] == "/usr/bin/notify-send" and "critical" in cmd


def test_desktop_unavailable_raises(monkeypatch):
    n = DesktopNotifier()
    n.system = "Linux"
    monkeypatch.setattr(n, "_plyer", mock.Mock(side_effect=NotifyError("no plyer")))
    monkeypatch.setattr(desktop_mod.shutil, "which", lambda x: None)
    with pytest.raises(NotifyError, match="unavailable"):
        n.send(ev())


def test_post_errors_do_not_leak_webhook_url(monkeypatch):
    import requests
    from watcher.notify import _http
    from watcher.notify.base import NotifyError

    url = "https://discord.com/api/webhooks/123/SECRETTOKEN"

    def boom(u, **kw):
        raise requests.ConnectionError(f"Max retries exceeded with url: /api/webhooks/123/SECRETTOKEN ({u})")

    monkeypatch.setattr(_http.requests, "post", boom)
    with pytest.raises(NotifyError) as ei:
        _http.post(url, what="discord")
    assert "SECRETTOKEN" not in str(ei.value)
