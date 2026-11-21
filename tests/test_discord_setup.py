"""Offline tests for Discord auto-setup, using a fake Discord API."""
import pytest

from watcher import discord_setup as ds
from watcher.models import ChangeEvent, Section


class FakeAPI:
    def __init__(self, guilds=None, channels=None, deny=False):
        self.guilds = guilds if guilds is not None else [{"id": "1", "name": "My Server"}]
        self.channels = channels or []
        self.hooks = {}
        self.calls = []
        self.n = 100

    def call(self, method, path, **kw):
        self.calls.append((method, path, kw.get("json")))
        if path == "/users/@me/guilds":
            return self.guilds
        if method == "GET" and path.endswith("/channels"):
            return list(self.channels)
        if method == "POST" and path.endswith("/channels"):
            self.n += 1
            c = {"id": str(self.n), **kw["json"]}
            self.channels.append(c)
            return c
        cid = path.split("/")[2]
        if method == "GET" and path.endswith("/webhooks"):
            return self.hooks.get(cid, [])
        if method == "POST" and path.endswith("/webhooks"):
            h = {"id": f"h{cid}", "token": f"tok{cid}", "name": kw["json"]["name"]}
            self.hooks.setdefault(cid, []).append(h)
            return h
        raise AssertionError(path)


def test_channel_name():
    assert ds.channel_name("COMPSCI 61A") == "compsci-61a"
    assert ds.channel_name("DATA C8") == "data-c8"
    assert ds.channel_name("L & S C30T") == "l-s-c30t"


def test_setup_creates_category_channels_webhooks():
    api = FakeAPI()
    routes, log = ds.setup(["SOCIOL 167", "COMPSCI 61A", "SOCIOL 167"], token="t", api=api)
    names = [(c["name"], c["type"]) for c in api.channels]
    assert names == [("Seat Alerts", 4), ("all-alerts", 0), ("compsci-61a", 0), ("sociol-167", 0)]
    cat = api.channels[0]["id"]
    assert all(c["parent_id"] == cat for c in api.channels[1:])
    assert set(routes["courses"]) == {"SOCIOL 167", "COMPSCI 61A"}
    assert routes["default"].startswith("https://discord.com/api/webhooks/h")
    assert len({routes["default"], *routes["courses"].values()}) == 3


def test_setup_is_idempotent():
    api = FakeAPI()
    r1, _ = ds.setup(["SOCIOL 167"], token="t", api=api)
    n, k = len(api.channels), len(api.calls)
    r2, log = ds.setup(["SOCIOL 167"], token="t", api=api)
    assert len(api.channels) == n and r1 == r2
    assert not [m for m, p, _ in api.calls[k:] if m == "POST"]
    assert any(line.startswith("reuse") for line in log)


def test_dry_run_changes_nothing():
    api = FakeAPI()
    routes, log = ds.setup(["SOCIOL 167"], token="t", api=api, dry_run=True)
    assert api.channels == [] and not [c for c in api.calls if c[0] == "POST"]
    assert any("create" in line for line in log)


def test_guild_selection():
    with pytest.raises(ds.DiscordSetupError, match="not in any server"):
        ds.setup([], token="t", api=FakeAPI(guilds=[]))
    two = [{"id": "1", "name": "A"}, {"id": "2", "name": "B"}]
    with pytest.raises(ds.DiscordSetupError, match="--guild"):
        ds.setup([], token="t", api=FakeAPI(guilds=two))
    routes, _ = ds.setup([], token="t", guild_id="2", api=FakeAPI(guilds=two))
    assert routes["guild_name"] == "B"
    with pytest.raises(ds.DiscordSetupError, match="not in server"):
        ds.setup([], token="t", guild_id="9", api=FakeAPI(guilds=two))


def test_api_errors_never_include_token(monkeypatch):
    class R:
        status_code = 403
        text = "Missing Permissions"
        content = b"x"

    class S:
        def request(self, *a, **k):
            return R()

    with pytest.raises(ds.DiscordSetupError) as ei:
        ds.DiscordAPI("SECRET-TOKEN", session=S()).call("GET", "/x")
    assert "Manage Webhooks" in str(ei.value) and "SECRET-TOKEN" not in str(ei.value)


def test_notifier_routes_by_course(tmp_path, monkeypatch):
    from watcher.notify import http_channels as hc
    f = ds.write_routes({"default": "https://d/default", "courses": {"SOCIOL 167": "https://d/soc"}},
                        tmp_path / "routes.json")
    sent = []
    monkeypatch.setattr(hc, "post", lambda url, **kw: sent.append(url))
    n = hc.DiscordWebhookNotifier(routes_file=str(f))
    n.send(ChangeEvent("seats_opened", Section(course="SOCIOL 167", classNumber="1", section="002 LEC"), None, "m"))
    n.send(ChangeEvent("seats_opened", Section(course="MATH 53", classNumber="2", section="001 LEC"), None, "m"))
    assert sent == ["https://d/soc", "https://d/default"]
    # no routes file -> falls back to the env webhook
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "https://d/env")
    hc.DiscordWebhookNotifier(routes_file=str(tmp_path / "none.json")).send(
        ChangeEvent("seats_opened", Section(course="X 1", classNumber="3", section="001 LEC"), None, "m"))
    assert sent[-1] == "https://d/env"
