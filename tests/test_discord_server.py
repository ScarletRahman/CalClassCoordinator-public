"""Offline tests for the full Discord server build and the opt-in bot, against a fake Discord."""
import json
import re
import struct

import pytest

from watcher import discord_bot as db
from watcher import discord_server as srv
from watcher import discord_setup as ds
from watcher.models import ChangeEvent, Section

GID, BOT = "1", "900"
ALL = srv.invite_permissions()


class FakeDiscord:
    """Enough of the REST API to build a server and answer interactions."""

    def __init__(self, bot_perms=ALL, everyone=(1 << 10) | (1 << 11) | (1 << 17)):
        self.roles = [{"id": GID, "name": "@everyone", "permissions": str(everyone)},
                      {"id": "50", "name": "SeatBot", "permissions": str(bot_perms), "managed": True}]
        self.channels, self.hooks, self.messages = [], {}, {}
        self.member_roles = {BOT: {"50"}}
        self.calls, self.callbacks, self.edits, self.commands = [], [], [], None
        self.guild_patch = None
        self.n = 1000

    def _id(self):
        self.n += 1
        return str(self.n)

    def call(self, method, path, **kw):
        body = kw.get("json")
        self.calls.append((method, path, body))
        parts = path.strip("/").split("/")
        if path == "/users/@me/guilds":
            return [{"id": GID, "name": "Cal Seats"}]
        if path == "/users/@me":
            return {"id": BOT}
        if path == "/applications/@me":
            return {"id": BOT}
        if path == "/gateway/bot":
            return {"url": "wss://gw"}
        if parts[0] == "applications":
            self.commands = body
            return body
        if parts[0] == "interactions":
            self.callbacks.append(body)
            return None
        if parts[0] == "webhooks":
            self.edits.append(body)
            return {}
        if parts[0] == "guilds":
            if len(parts) == 2:
                self.guild_patch = body
                return {}
            if parts[2] == "roles":
                if method == "GET":
                    return [dict(r) for r in self.roles]
                if method == "POST":
                    if int(body["permissions"]) & ~self.bot_perms():
                        raise ds.DiscordForbidden("403")
                    r = {"id": self._id(), **body}
                    self.roles.append(r)
                    return dict(r)
                role = next((r for r in self.roles if r["id"] == parts[3]), None)
                if role is None:
                    raise ds.DiscordNotFound("404")
                if method == "DELETE":
                    self.roles.remove(role)
                    return None
                role.update(body)
                return dict(role)
            if parts[2] == "channels":
                if method == "GET":
                    return [dict(c) for c in self.channels]
                if method == "PATCH":
                    for item in body:
                        next(c for c in self.channels if c["id"] == item["id"])["position"] = item["position"]
                    return None
                self._check_overwrites(body)
                c = {"id": self._id(), "position": len(self.channels), **body}
                self.channels.append(c)
                return dict(c)
            if parts[2] == "members":
                if len(parts) == 4:
                    return {"roles": sorted(self.member_roles.get(parts[3], set()))}
                roles = self.member_roles.setdefault(parts[3], set())
                if not any(r["id"] == parts[5] for r in self.roles):
                    raise ds.DiscordNotFound("404")
                (roles.add if method == "PUT" else roles.discard)(parts[5])
                return None
        if parts[0] == "channels":
            ch = next((c for c in self.channels if c["id"] == parts[1]), None)
            if ch is None:
                raise ds.DiscordNotFound("404")
            if len(parts) == 2:
                if method == "DELETE":
                    self.channels.remove(ch)
                    return None
                self._check_overwrites(body)
                ch.update(body)
                return dict(ch)
            if parts[2] == "webhooks":
                if method == "GET":
                    return self.hooks.get(ch["id"], [])
                h = {"id": "h" + ch["id"], "token": "tok" + ch["id"], "name": body["name"]}
                self.hooks.setdefault(ch["id"], []).append(h)
                return h
            if parts[2] == "messages":
                msgs = self.messages.setdefault(ch["id"], {})
                if method == "POST":
                    mid = self._id()
                    msgs[mid] = body
                    return {"id": mid}
                if parts[3] not in msgs:
                    raise ds.DiscordNotFound("404")
                msgs[parts[3]] = body
                return {"id": parts[3]}
        raise AssertionError(f"unhandled {method} {path}")

    def bot_perms(self):
        ids = self.member_roles[BOT] | {GID}
        n = 0
        for r in self.roles:
            if r["id"] in ids:
                n |= int(r["permissions"])
        return n

    def _check_overwrites(self, body):
        for o in (body or {}).get("permission_overwrites", []):
            if (int(o["allow"]) | int(o["deny"])) & ~self.bot_perms():
                raise ds.DiscordForbidden("403 overwrite outside bot permissions")

    # helpers for assertions
    def chan(self, name):
        return next(c for c in self.channels if c["name"] == name)

    def role(self, name):
        return next(r for r in self.roles if r["name"] == name)

    def ow(self, name, target):
        return next(o for o in self.chan(name)["permission_overwrites"] if o["id"] == target)


@pytest.fixture
def built(tmp_path):
    api = FakeDiscord()
    routes, log = srv.setup_server(["SOCIOL 167", "COMPSCI 61A"], api=api)
    path = tmp_path / "discord_channels.json"
    ds.write_routes(routes, path)
    return api, routes, str(path)


# ---- server build ----------------------------------------------------------
def test_builds_whole_layout(built):
    api, routes, _ = built
    cats = [c["name"] for c in sorted((c for c in api.channels if c["type"] == 4), key=lambda c: c["position"])]
    assert cats == ["📌 START HERE", "💬 COMMUNITY", "🔔 ALERTS", "📚 COMPSCI", "📚 SOCIOL", "🛡️ STAFF"]
    for name in ("welcome", "rules", "how-it-works", "announcements", "get-alerts", "general",
                 "enrollment-help", "feedback", "all-alerts", "mod-chat", "class-requests", "bot-log",
                 "compsci-61a", "sociol-167"):
        assert api.chan(name)["type"] == 0
    assert api.chan("sociol-167")["parent_id"] == api.chan("📚 SOCIOL")["id"]
    assert {r["name"] for r in api.roles} >= {"Admin", "Moderator", "Every Alert", "SOCIOL 167", "COMPSCI 61A"}
    assert set(routes["courses"]) == set(routes["roles"]) == {"SOCIOL 167", "COMPSCI 61A"}
    assert routes["feed"] == routes["default"] != routes["errors"]
    assert routes["all_role"] == api.role("Every Alert")["id"]


def test_permissions(built):
    api, routes, _ = built
    view, send = srv.VIEW, srv.SEND
    # info channels: everyone can read, nobody but staff and the bot can write
    assert int(api.ow("rules", GID)["deny"]) & send and not int(api.ow("rules", GID)["deny"]) & view
    assert int(api.ow("rules", BOT)["allow"]) & send
    assert int(api.ow("announcements", api.role("Moderator")["id"])["allow"]) & send
    # staff channels are hidden
    assert int(api.ow("mod-chat", GID)["deny"]) & view
    assert int(api.ow("mod-chat", api.role("Moderator")["id"])["allow"]) & view
    # class channels: hidden unless you hold the class role; read-only
    assert int(api.ow("sociol-167", GID)["deny"]) & view and int(api.ow("sociol-167", GID)["deny"]) & send
    assert int(api.ow("sociol-167", api.role("SOCIOL 167")["id"])["allow"]) & view
    assert not any(o["id"] == api.role("COMPSCI 61A")["id"] for o in api.chan("sociol-167")["permission_overwrites"])
    assert int(api.ow("sociol-167", BOT)["allow"]) & view
    # community channels are left open
    assert not api.chan("general").get("permission_overwrites")
    # server-wide: no @everyone pings from members, notifications on mentions only
    assert not int(api.role("@everyone")["permissions"]) & srv.P["Mention Everyone"]
    assert api.guild_patch == {"default_message_notifications": 1}
    # staff roles hold moderation powers but class roles hold none and can't be pinged by members
    assert int(api.role("Moderator")["permissions"]) & srv.P["Kick Members"]
    assert int(api.role("Admin")["permissions"]) & srv.P["Manage Roles"]
    assert api.role("SOCIOL 167")["permissions"] == "0" and api.role("SOCIOL 167")["mentionable"] is False


def test_rerun_is_idempotent(built):
    api, routes, _ = built
    n_ch, n_roles = len(api.channels), len(api.roles)
    n_msgs = {k: len(v) for k, v in api.messages.items()}
    k = len(api.calls)
    routes2, log = srv.setup_server([], api=api, routes=json.loads(json.dumps(routes)))
    assert (len(api.channels), len(api.roles)) == (n_ch, n_roles)
    assert {k: len(v) for k, v in api.messages.items()} == n_msgs
    assert not [c for c in api.calls[k:] if c[0] in ("POST", "DELETE")]
    assert routes2["courses"] == routes["courses"] and routes2["server"]["classes"] == routes["server"]["classes"]
    assert not any(line.startswith("create") for line in log)


def test_adopts_legacy_setup_and_existing_channels():
    api = FakeDiscord()
    ds.setup(["SOCIOL 167"], token="t", api=api)                   # the older command's layout
    api.channels.append({"id": "7", "name": "general", "type": 0, "parent_id": None, "position": 0})
    old_hook = api.hooks[api.chan("sociol-167")["id"]][0]
    routes, log = srv.setup_server(["SOCIOL 167"], api=api)
    assert len([c for c in api.channels if c["name"] == "sociol-167"]) == 1
    assert len([c for c in api.channels if c["name"] == "general"]) == 1
    assert api.chan("sociol-167")["parent_id"] == api.chan("📚 SOCIOL")["id"]
    assert api.chan("all-alerts")["parent_id"] == api.chan("🔔 ALERTS")["id"]
    assert api.chan("general")["parent_id"] == api.chan("💬 COMMUNITY")["id"]
    assert routes["courses"]["SOCIOL 167"].endswith(old_hook["token"])    # same webhook, watcher keeps working
    assert not [c for c in api.channels if c["name"] == "Seat Alerts"]    # emptied legacy category removed


def test_dry_run_changes_nothing():
    api = FakeDiscord()
    routes, log = srv.setup_server(["MATH 53"], api=api, dry_run=True)
    assert not [c for c in api.calls if c[0] != "GET"]
    assert any("create  #math-53" in line for line in log) and any("post    panel" in line for line in log)


def test_missing_required_permission_stops_before_changes():
    api = FakeDiscord(bot_perms=ALL & ~srv.P["Manage Roles"])
    with pytest.raises(ds.DiscordSetupError, match="Manage Roles") as ei:
        srv.setup_server(["MATH 53"], api=api)
    assert "oauth2/authorize" in str(ei.value) and not [c for c in api.calls if c[0] != "GET"]
    lines = srv.check(api=api)
    assert any(line.startswith("MISSING (required) Manage Roles") for line in lines)


def test_minimum_permissions_still_build():
    need = 0
    for name in srv.REQUIRED:
        need |= srv.P[name]
    api = FakeDiscord(bot_perms=need, everyone=(1 << 10) | (1 << 11))
    routes, log = srv.setup_server(["MATH 53"], api=api)        # the fake rejects any bit the bot lacks
    assert api.role("Moderator")["permissions"] == "0"
    assert any(line.startswith("manual") for line in log)
    assert any("optional" in line for line in srv.check(api=api, routes=routes))


def test_subject_category_overflows_at_50():
    api = FakeDiscord()
    courses = [f"MATH {n}" for n in range(1, 53)]
    srv.setup_server(courses, api=api)
    first, second = api.chan("📚 MATH")["id"], api.chan("📚 MATH (2)")["id"]
    assert sum(c.get("parent_id") == first for c in api.channels) == 50
    assert sum(c.get("parent_id") == second for c in api.channels) == 2
    with pytest.raises(ds.DiscordSetupError, match="limit"):
        srv.setup_server([f"STAT {n}" for n in range(1, 202)], api=FakeDiscord())


def test_content_edit_in_place_and_repost_when_deleted(built):
    api, routes, _ = built
    panel_ch = api.chan("get-alerts")["id"]
    (mid, panel), = api.messages[panel_ch].items()
    assert "2 classes watched" in panel["embeds"][0]["description"]
    assert [b["custom_id"] for b in panel["components"][0]["components"]] == \
        ["cc:browse", "cc:mine", "cc:request", "cc:all"]
    welcome = next(iter(api.messages[api.chan("welcome")["id"]].values()))
    assert f"<#{panel_ch}>" in welcome["embeds"][0]["description"] and "Cal Seats" in welcome["embeds"][0]["title"]
    del api.messages[panel_ch][mid]
    srv.setup_server(["MATH 53"], api=api, routes=routes)
    (_, panel2), = api.messages[panel_ch].items()
    assert "3 classes watched" in panel2["embeds"][0]["description"]


# ---- notifier ------------------------------------------------------------
def test_alerts_ping_class_role_and_copy_to_feed(built, monkeypatch):
    from watcher.notify import http_channels as hc
    api, routes, path = built
    sent = []
    monkeypatch.setattr(hc, "post", lambda url, **kw: sent.append((url, kw["json"])))
    n = hc.DiscordWebhookNotifier(routes_file=path)
    sec = Section(course="SOCIOL 167", classNumber="1", section="002 LEC")
    n.send(ChangeEvent("seats_opened", sec, None, "m"))
    (u1, p1), (u2, p2) = sent
    role = api.role("SOCIOL 167")["id"]
    assert u1 == routes["courses"]["SOCIOL 167"] and p1["content"] == f"<@&{role}>"
    assert p1["allowed_mentions"] == {"roles": [role]}
    assert u2 == routes["feed"] and p2["content"] == f"<@&{routes['all_role']}>"
    sent.clear()
    n.send(ChangeEvent("seats_increased", sec, None, "m"))             # not urgent: no ping anywhere
    assert [("content" in p) for _, p in sent] == [False, False]
    sent.clear()
    n.send(ChangeEvent("error", sec, None, "boom"))                    # errors stay in staff #bot-log
    assert [u for u, _ in sent] == [routes["errors"]]
    sent.clear()
    n.send(ChangeEvent("seats_opened", Section(course="X 1", classNumber="2", section="001"), None, "m"))
    assert [u for u, _ in sent] == [routes["feed"]]


def test_watcher_polls_classes_from_routes(built, tmp_path):
    from watcher.config import Config
    from watcher.runner import Watcher
    from watcher.sources.base import Target
    from watcher.store import Store
    _, _, path = built
    cfg = Config(targets=[Target(course="SOCIOL 167")], term="2027 Spring", discord_routes_file=path, notifiers=[])
    w = Watcher(cfg, store=Store(tmp_path / "d"), sources=[])
    assert [(t.course, t.term) for t, _ in w.all_targets()] == [("SOCIOL 167", ""), ("COMPSCI 61A", "2027 Spring")]
    cfg.watch_discord_classes = False
    assert len(w.all_targets()) == 1


# ---- bot -------------------------------------------------------------------
def test_normalize_course():
    f = db.normalize_course
    assert f("cs61a") == "COMPSCI 61A" and f(" compsci  61a ") == "COMPSCI 61A"
    assert f("data c8") == "DATA C8" and f("MATH53") == "MATH 53" and f("l & s c30t") == "LS C30T"
    assert f("pol sci 1") == "POLSCI 1" and f("EE 16A") == "ELENG 16A" and f("polisci1") == "POLSCI 1"
    assert f("el eng 16a") == "ELENG 16A" and f("pb hlth 142") == "PBHLTH 142" and f("ieor 162") == "INDENG 162"
    assert f("hello") is None and f("61A") is None and f("") is None and f("@everyone 1") is None


def interaction(type_, data, user="42", roles=(), perms=0, message=None):
    i = {"id": "i1", "token": "tok", "type": type_, "data": data, "guild_id": GID, "application_id": BOT,
         "member": {"user": {"id": user}, "roles": list(roles), "permissions": str(perms)}}
    if message:
        i["message"] = message
    return i


def press(cid, **kw):
    return interaction(3, {"custom_id": cid, **kw.pop("data", {})}, **kw)


def make_bot(built, **kw):
    api, routes, path = built
    api.callbacks.clear()
    kw.setdefault("auto_approve", False)      # most tests exercise the staff queue
    return api, db.Bot(api, path, **kw)


def test_browse_then_pick_gives_and_removes_roles(built):
    api, bot = make_bot(built)
    soc, cs = api.role("SOCIOL 167")["id"], api.role("COMPSCI 61A")["id"]
    bot.handle(press("cc:browse", roles=[cs]))
    reply = api.callbacks[-1]
    assert reply["type"] == 4 and reply["data"]["flags"] == 64
    menu = reply["data"]["components"][0]["components"][0]
    assert [(o["value"], o["default"]) for o in menu["options"]] == [("COMPSCI 61A", True), ("SOCIOL 167", False)]
    # they untick COMPSCI 61A and tick SOCIOL 167
    bot.handle(press("cc:cls:0", roles=[cs], data={"values": ["SOCIOL 167"]},
                     message={"components": reply["data"]["components"]}))
    assert api.member_roles["42"] == {soc}
    assert api.callbacks[-1] == {"type": 6}
    edit = api.edits[-1]
    assert "SOCIOL 167" in edit["content"] and f"<#{api.chan('sociol-167')['id']}>" in edit["content"]
    assert [(o["value"], o["default"]) for o in edit["components"][0]["components"][0]["options"]] == \
        [("COMPSCI 61A", False), ("SOCIOL 167", True)]


def test_browse_by_subject_when_many_classes(tmp_path):
    api = FakeDiscord()
    routes, _ = srv.setup_server([f"MATH {n}" for n in range(1, 21)] + [f"STAT {n}" for n in range(1, 11)], api=api)
    path = tmp_path / "r.json"
    ds.write_routes(routes, path)
    bot = db.Bot(api, str(path))
    bot.handle(press("cc:browse"))
    menu = api.callbacks[-1]["data"]["components"][0]["components"][0]
    assert menu["custom_id"] == "cc:subj:0" and [o["label"] for o in menu["options"]] == ["MATH", "STAT"]
    bot.handle(press("cc:subj:0", data={"values": ["STAT"]}))
    reply = api.callbacks[-1]
    assert reply["type"] == 7 and len(reply["data"]["components"][0]["components"][0]["options"]) == 10
    assert reply["data"]["components"][-1]["components"][0]["custom_id"] == "cc:back"


def test_my_alerts_clear_and_every_alert(built):
    api, bot = make_bot(built)
    soc, every = api.role("SOCIOL 167")["id"], api.role("Every Alert")["id"]
    bot.handle(press("cc:mine"))
    assert "no alerts yet" in api.callbacks[-1]["data"]["content"]
    bot.handle(press("cc:all"))
    assert api.member_roles["42"] == {every} and "**on**" in api.edits[-1]["content"]
    api.member_roles["42"].add(soc)
    bot.handle(press("cc:mine", roles=[soc, every]))
    assert "SOCIOL 167" in api.callbacks[-1]["data"]["content"]
    bot.handle(press("cc:clear", roles=[soc, every]))
    assert api.member_roles["42"] == set()
    bot.handle(press("cc:all", roles=[every]))
    assert "**off**" in api.edits[-1]["content"]


def test_watch_command_joins_existing_class(built):
    api, bot = make_bot(built)
    bot.handle(interaction(2, {"name": "watch", "options": [{"name": "course", "value": "soc 167"}]}))
    assert api.member_roles["42"] == {api.role("SOCIOL 167")["id"]}
    assert api.callbacks[-1] == {"type": 5, "data": {"flags": 64}} and "Alerts on" in api.edits[-1]["content"]
    bot.handle(interaction(2, {"name": "unwatch", "options": [{"name": "course", "value": "SOCIOL 167"}]},
                           roles=[api.role("SOCIOL 167")["id"]]))
    assert api.member_roles["42"] == set()
    bot.handle(interaction(2, {"name": "classes"}))
    assert "COMPSCI 61A, SOCIOL 167" in api.callbacks[-1]["data"]["content"]


def test_request_goes_to_staff_then_approval_creates_class(built):
    api, bot = make_bot(built, verify=lambda c: ("ok", "Calculus"), term="2027 Spring")
    bot.handle(press("cc:request"))
    assert api.callbacks[-1]["type"] == 9 and api.callbacks[-1]["data"]["custom_id"] == "cc:reqmodal"
    modal = {"custom_id": "cc:reqmodal", "components": [{"components": [{"custom_id": "course", "value": "math 53"}]}]}
    bot.handle(interaction(5, modal, user="42"))
    bot.handle(interaction(5, modal, user="43"))
    bot.handle(interaction(5, modal, user="42"))
    assert "already asked" in api.edits[-1]["content"]
    req_ch = api.chan("class-requests")["id"]
    (mid, msg), = api.messages[req_ch].items()                       # one request card, updated in place
    assert msg["embeds"][0]["title"] == "Class request: MATH 53" and "<@43>" in msg["embeds"][0]["fields"][0]["value"]
    assert "MATH 53" not in [r["name"] for r in api.roles]
    # a regular member cannot approve
    card = {"embeds": msg["embeds"], "components": msg["components"]}
    bot.handle(press("cc:approve:MATH 53", user="42", message=card))
    assert "Only staff" in api.callbacks[-1]["data"]["content"] and "MATH 53" not in [r["name"] for r in api.roles]
    # a moderator can
    bot.handle(press("cc:approve:MATH 53", user="7", roles=[api.role("Moderator")["id"]], message=card))
    role = api.role("MATH 53")["id"]
    assert api.member_roles["42"] == {role} and api.member_roles["43"] == {role}
    assert api.chan("math-53")["parent_id"] == api.chan("📚 MATH")["id"]
    hello = next(iter(api.messages[api.chan("math-53")["id"]].values()))
    assert "<@42>" in hello["content"] and hello["allowed_mentions"] == {"users": ["42", "43"]}
    assert "Approved by <@7>" in api.edits[-1]["content"] and api.edits[-1]["components"] == []
    saved = ds.load_routes(bot.path)
    assert "MATH 53" in saved["courses"] and saved["roles"]["MATH 53"] == role and saved["server"]["requests"] == {}
    assert ds.watched_courses(bot.path) == ["COMPSCI 61A", "MATH 53", "SOCIOL 167"]   # the watcher picks it up
    panel = next(iter(api.messages[api.chan("get-alerts")["id"]].values()))
    assert "3 classes watched" in panel["embeds"][0]["description"]


def test_request_rejections_and_deny(built):
    api, bot = make_bot(built, verify=lambda c: ("missing", ""), term="2027 Spring")
    watch = lambda text, **kw: bot.handle(interaction(2, {"name": "watch", "options": [{"name": "course", "value": text}]}, **kw))  # noqa: E731
    watch("lol what")
    assert "doesn't look like a course code" in api.edits[-1]["content"]
    watch("MATH 999")
    assert "**MATH 999** is not in the Berkeley course catalog" in api.edits[-1]["content"]
    watch("compsci 61")                                               # a typo gets suggestions
    assert "Did you mean" in api.edits[-1]["content"] and "`COMPSCI 61A`" in api.edits[-1]["content"]
    watch("MATH 110")
    assert "couldn't find **MATH 110** in 2027 Spring" in api.edits[-1]["content"]
    assert not api.messages.get(api.chan("class-requests")["id"])
    bot.verify = lambda c: ("unknown", "")
    watch("MATH 54")
    msg = next(iter(api.messages[api.chan("class-requests")["id"]].values()))
    assert "Could not be checked" in msg["embeds"][0]["fields"][1]["value"]
    bot.handle(press("cc:deny:MATH 54", perms=srv.P["Administrator"], message={"embeds": msg["embeds"]}))
    assert "Denied" in api.edits[-1]["content"] and ds.load_routes(bot.path)["server"]["requests"] == {}
    bot.max_classes = 2
    watch("MATH 55")
    assert "limit of 2" in api.edits[-1]["content"]


def test_auto_approve_creates_verified_classes_only(built):
    api, bot = make_bot(built, verify=lambda c: ("ok", "T"), auto_approve=True)
    bot.handle(interaction(2, {"name": "watch", "options": [{"name": "course", "value": "DATA C8"}]}))
    assert api.member_roles["42"] == {api.role("DATA C8")["id"]} and api.chan("data-c8")
    bot.verify = lambda c: ("unknown", "")
    bot.handle(interaction(2, {"name": "watch", "options": [{"name": "course", "value": "DATA C100"}]}))
    assert "DATA C100" not in [r["name"] for r in api.roles] and "sent your request" in api.edits[-1]["content"]


def test_staff_commands(built):
    api, bot = make_bot(built)
    add = {"name": "class-add", "options": [{"name": "course", "value": "stat 20"}]}
    bot.handle(interaction(2, add))
    assert "Only staff" in api.callbacks[-1]["data"]["content"]
    bot.handle(interaction(2, add, perms=srv.P["Manage Channels"]))
    assert api.chan("stat-20") and api.role("STAT 20")
    rm = {"name": "class-remove", "options": [{"name": "course", "value": "STAT 20"}]}
    bot.handle(interaction(2, rm, perms=srv.P["Manage Channels"]))
    assert "stat-20" not in [c["name"] for c in api.channels] and "STAT 20" not in [r["name"] for r in api.roles]
    assert "STAT 20" not in ds.load_routes(bot.path)["courses"]
    log_msgs = [m["content"] for m in api.messages[api.chan("bot-log")["id"]].values()]
    assert any("added **STAT 20**" in m for m in log_msgs) and any("removed **STAT 20**" in m for m in log_msgs)


def test_autocomplete_and_commands_registration(built):
    api, bot = make_bot(built)
    bot.handle(interaction(4, {"name": "watch", "options": [{"name": "course", "value": "cs", "focused": True}]}))
    assert api.callbacks[-1] == {"type": 8, "data": {"choices": [{"name": "COMPSCI 61A", "value": "COMPSCI 61A"}]}}
    bot.handle(interaction(4, {"name": "unwatch", "options": [{"name": "course", "value": "", "focused": True}]},
                           roles=[api.role("SOCIOL 167")["id"]]))
    assert [c["name"] for c in api.callbacks[-1]["data"]["choices"]] == ["SOCIOL 167"]
    bot.register_commands()
    assert {c["name"] for c in api.commands} == {"watch", "unwatch", "alerts", "classes", "class-add", "class-remove"}
    for c in api.commands:
        assert re.fullmatch(r"[a-z-]{1,32}", c["name"]) and len(c["description"]) <= 100


def test_errors_reach_the_member_not_the_log(built):
    api, bot = make_bot(built)
    real = api.call

    def call(method, path, **kw):
        if "/members/" in path and method == "PUT":
            raise ds.DiscordForbidden("403")
        return real(method, path, **kw)
    api.call = call
    bot.handle(interaction(2, {"name": "watch", "options": [{"name": "course", "value": "SOCIOL 167"}]}))
    assert "Manage Roles" in api.edits[-1]["content"]
    api.call = real
    dm = interaction(3, {"custom_id": "cc:browse"})
    del dm["member"]
    bot.handle(dm)
    assert "inside the server" in api.callbacks[-1]["data"]["content"]


def test_auto_approve_is_the_default_with_a_daily_limit_per_member(built):
    api, routes, path = built
    bot = db.Bot(api, path, verify=lambda c: ("ok", "T"))
    assert bot.auto_approve and bot.max_classes == 100
    watch = lambda text, user: bot.handle(interaction(2, {"name": "watch", "options": [{"name": "course", "value": text}]}, user=user))  # noqa: E731
    for n, course in enumerate(["MATH 53", "MATH 54", "MATH 55", "MATH 1A", "MATH 1B"]):
        watch(course, "42")
        assert "Alerts on" in api.edits[-1]["content"]
    assert len(api.member_roles["42"]) == 5
    watch("MATH 110", "42")                                           # sixth new class in a day: staff decide
    assert "sent your request" in api.edits[-1]["content"] and "MATH 110" not in [r["name"] for r in api.roles]
    watch("MATH 110", "43")                                           # joining a pending request still queues
    watch("MATH 104", "43")                                           # but another member can open their own
    assert "Alerts on" in api.edits[-1]["content"]
    watch("MATH 53", "44")                                            # joining existing classes is never limited
    assert api.member_roles["44"] == {api.role("MATH 53")["id"]}


def test_popular_picks_big_filling_classes_the_schedule_offers(tmp_path):
    (tmp_path / "predictions").mkdir()
    (tmp_path / "enrollment").mkdir()
    preds = [{"course": "BIG 1", "fillsInPhase": "Phase 1", "expectedDemandRatio": 1.2},
             {"course": "BIG 1", "fillsInPhase": "Phase 2", "expectedDemandRatio": 0.9},
             {"course": "XLIST C8", "fillsInPhase": "Phase 1", "expectedDemandRatio": 1.4},
             {"course": "SMALL 2", "fillsInPhase": "Phase 1", "expectedDemandRatio": 3.0},
             {"course": "EMPTY 3", "fillsInPhase": "Does not fill", "expectedDemandRatio": 0.4},
             {"course": "MID 4", "fillsInPhase": "Adjustment Period", "expectedDemandRatio": 1.0}]
    (tmp_path / "predictions" / "predictions.json").write_text(json.dumps({"predictions": preds}))
    rows = ["term,term_key,course,enrolled", "F,10,BIG 1,9999", "S,11,BIG 1,400", "S,11,BIG 1,200",
            "S,11,XLIST C8,1000", "S,11,SMALL 2,20", "S,11,EMPTY 3,5000", "S,11,MID 4,300"]
    (tmp_path / "enrollment" / "observations.csv").write_text("\n".join(rows))
    assert srv.popular_courses(tmp_path) == ["XLIST C8", "BIG 1", "MID 4", "SMALL 2"]
    verify = lambda c: ("missing", "") if c == "XLIST C8" else ("ok", "")  # noqa: E731
    picked, log = srv.pick_popular(2, verify, {"MID 4"}, tmp_path)
    assert picked == ["BIG 1", "SMALL 2"] and any("skip    XLIST C8" in line for line in log)
    with pytest.raises(ds.DiscordSetupError, match="could not reach"):
        srv.pick_popular(2, lambda c: ("unknown", ""), set(), tmp_path)
    flaky = lambda c: ("unknown", "") if c == "BIG 1" else ("ok", "")  # noqa: E731   one timeout is skipped
    assert srv.pick_popular(3, flaky, set(), tmp_path)[0] == ["XLIST C8", "MID 4", "SMALL 2"]
    assert srv.popular_courses(tmp_path / "nope") == []
    real = srv.popular_courses()                                     # the committed predictor output
    assert len(real) > 200 and {"MATH 54", "COMPSCI 61B", "CHEM 3A"} <= set(real[:40])


# ---- gateway ---------------------------------------------------------------
class FakeWS:
    def __init__(self, frames):
        self.frames, self.sent, self.closed = list(frames), [], False

    def recv_data(self):
        if not self.frames:
            raise ConnectionError("eof")
        f = self.frames.pop(0)
        return f if isinstance(f, tuple) else (1, json.dumps(f).encode())

    def send(self, text):
        self.sent.append(json.loads(text))

    def close(self):
        self.closed = True


def test_gateway_identify_dispatch_then_resume():
    hello = {"op": 10, "d": {"heartbeat_interval": 3_600_000}}
    ready = {"op": 0, "t": "READY", "s": 1, "d": {"session_id": "S", "resume_gateway_url": "wss://resume"}}
    inter = {"op": 0, "t": "INTERACTION_CREATE", "s": 2, "d": {"id": "x"}}
    sockets = [FakeWS([hello, ready, inter, {"op": 7}]), FakeWS([hello, (8, struct.pack("!H", 4004))])]
    urls, got = [], []

    def connect(url):
        urls.append(url)
        return sockets[len(urls) - 1]
    gw = db.Gateway("TOKEN", lambda t, d: got.append((t, d)), url="wss://gw", connect=connect)
    gw.run_once()
    ident = sockets[0].sent[0]
    assert ident["op"] == 2 and ident["d"]["token"] == "TOKEN" and ident["d"]["intents"] == 0
    assert ("INTERACTION_CREATE", {"id": "x"}) in got and sockets[0].closed
    with pytest.raises(db.FatalGatewayError, match="token"):
        gw.run_once()
    assert urls == ["wss://gw/?v=10&encoding=json", "wss://resume/?v=10&encoding=json"]
    assert sockets[1].sent[0] == {"op": 6, "d": {"token": "TOKEN", "session_id": "S", "seq": 2}}


def test_gateway_invalid_session_starts_fresh(monkeypatch):
    gw = db.Gateway("T", lambda t, d: None, url="wss://gw",
                    connect=lambda url: FakeWS([{"op": 10, "d": {"heartbeat_interval": 3_600_000}}, {"op": 9, "d": False}]))
    gw.session_id, gw.resume_url, gw.seq = "old", "wss://r", 5
    monkeypatch.setattr(gw._stop, "wait", lambda t=None: False)
    gw.run_once()
    assert gw.session_id is None and gw.seq is None
