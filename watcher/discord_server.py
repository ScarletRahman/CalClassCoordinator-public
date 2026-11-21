"""Build a full public Discord server for seat alerts.

    python -m watcher discord-server [-c watcher.yaml] [--guild ID] [--classes "A 1,B 2"] [--dry-run]
    python -m watcher discord-server --check      only report permissions, change nothing

Using the bot token in DISCORD_BOT_TOKEN this creates (or reuses, never deletes
anything it did not make) the whole layout:

    START HERE     #welcome #rules #how-it-works #announcements #get-alerts   (read-only)
    COMMUNITY      #general #enrollment-help #feedback
    ALERTS         #all-alerts          (read-only feed of every alert, no pings)
    <SUBJECT>      #compsci-61a ...     (one category per subject; a class channel is
                                         only visible to people who opted in to it)
    STAFF          #mod-chat #class-requests #bot-log      (staff only)

plus the roles Admin, Moderator, Every Alert, and one role per class. It posts
the welcome, rules and how-it-works texts and the opt-in panel, and writes
everything the notifier and the bot need to ``discord_channels.json``.

Opt-in (buttons, menus, slash commands) is handled by the long-running bot in
``watcher.discord_bot``; this module is also its library for adding classes.

Safe to re-run: things are found again by saved id, then by name.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from watcher.discord_setup import (
    TYPE_CATEGORY, TYPE_TEXT, DiscordAPI, DiscordForbidden, DiscordNotFound,
    DiscordSetupError, channel_name, ensure_webhook, pick_guild,
)

# ---- permission bits ------------------------------------------------------
P = {
    "Create Invite": 1 << 0, "Kick Members": 1 << 1, "Ban Members": 1 << 2,
    "Administrator": 1 << 3, "Manage Channels": 1 << 4, "Manage Server": 1 << 5,
    "Add Reactions": 1 << 6, "View Audit Log": 1 << 7, "View Channels": 1 << 10,
    "Send Messages": 1 << 11, "Manage Messages": 1 << 13, "Embed Links": 1 << 14,
    "Read Message History": 1 << 16, "Mention Everyone": 1 << 17,
    "Manage Nicknames": 1 << 27, "Manage Roles": 1 << 28, "Manage Webhooks": 1 << 29,
    "Manage Threads": 1 << 34, "Create Public Threads": 1 << 35,
    "Create Private Threads": 1 << 36, "Send Messages in Threads": 1 << 38,
    "Moderate Members": 1 << 40,
}
VIEW, SEND = P["View Channels"], P["Send Messages"]
WRITE = SEND | P["Send Messages in Threads"] | P["Create Public Threads"] | P["Create Private Threads"]

# Without these the setup cannot work at all.
REQUIRED = ["View Channels", "Send Messages", "Embed Links", "Read Message History",
            "Manage Channels", "Manage Roles", "Manage Webhooks"]
# Nice to have: each one missing only switches off the feature named next to it.
OPTIONAL = {
    "Send Messages in Threads": "locking threads in read-only channels",
    "Create Public Threads": "locking threads in read-only channels",
    "Create Private Threads": "locking threads in read-only channels",
    "Mention Everyone": "stopping members from using @everyone",
    "Manage Messages": "giving moderators message deletion",
    "Kick Members": "giving moderators kick",
    "Ban Members": "giving moderators ban",
    "Moderate Members": "giving moderators timeouts",
    "Manage Nicknames": "giving moderators nickname control",
    "Manage Threads": "giving moderators thread control",
    "View Audit Log": "giving moderators the audit log",
    "Manage Server": "setting notifications to mentions-only",
}
MOD_PERMS = ["Manage Messages", "Kick Members", "Ban Members", "Moderate Members",
             "Manage Nicknames", "Manage Threads", "View Audit Log", "Mention Everyone"]
ADMIN_PERMS = MOD_PERMS + ["Manage Channels", "Manage Roles", "Manage Webhooks", "Manage Server"]


def invite_permissions() -> int:
    n = 0
    for name in REQUIRED + list(OPTIONAL):
        n |= P[name]
    return n


def invite_url(app_id: str) -> str:
    return (f"https://discord.com/oauth2/authorize?client_id={app_id}"
            f"&scope=bot+applications.commands&permissions={invite_permissions()}")


# ---- layout ---------------------------------------------------------------
# (key, category name, mode, [(key, channel name, topic)])
LAYOUT = [
    ("start", "📌 START HERE", "readonly", [
        ("welcome", "welcome", "What this server is and how to get started."),
        ("rules", "rules", "Server rules. Short, and they apply to everyone."),
        ("how_it_works", "how-it-works", "How seat alerts work and what each alert means."),
        ("announcements", "announcements", "News from the staff: new features, outages, enrollment dates."),
        ("get_alerts", "get-alerts", "Pick the classes you want to be pinged for."),
    ]),
    ("community", "💬 COMMUNITY", "open", [
        ("general", "general", "General chat."),
        ("enrollment_help", "enrollment-help", "Questions about enrollment, waitlists and reserved seats."),
        ("feedback", "feedback", "Bug reports and ideas for the alerts and the bot."),
    ]),
    ("alerts", "🔔 ALERTS", "readonly", [
        ("feed", "all-alerts", "Every alert for every watched class. No pings here; opt in to a class in #get-alerts."),
    ]),
    ("staff", "🛡️ STAFF", "staff", [
        ("mod_chat", "mod-chat", "Staff discussion."),
        ("class_requests", "class-requests", "Class requests from members. Approve or deny with the buttons."),
        ("bot_log", "bot-log", "Watcher errors and what the bot did."),
    ]),
]
SUBJECT_PREFIX = "📚 "
LEGACY_CATEGORY = "Seat Alerts"   # made by the older `discord-setup`
MAX_PER_CATEGORY = 50
HARD_MAX_CLASSES = 200            # Discord caps a server at 250 roles and 500 channels
ROLE_ADMIN, ROLE_MOD, ROLE_ALL = "Admin", "Moderator", "Every Alert"
CLASS_ROLE_COLOR = 0x3B7EA1       # Berkeley "Founder's Rock" blue
GOLD = 0xFDB515                   # California Gold


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def subject_of(course: str) -> str:
    return course.rsplit(" ", 1)[0] if " " in course else course


def new_state() -> dict[str, Any]:
    return {"roles": {}, "categories": {}, "channels": {}, "messages": {}, "classes": {}, "requests": {}}


class Server:
    """One guild plus our saved state; every method is idempotent."""

    def __init__(self, api: DiscordAPI, routes: dict | None = None, *, guild_id: str | None = None,
                 dry_run: bool = False):
        self.api, self.dry_run, self.log = api, dry_run, []
        self.routes: dict[str, Any] = dict(routes or {})
        self.state: dict[str, Any] = {**new_state(), **self.routes.get("server", {})}
        self.routes["server"] = self.state
        self.routes.setdefault("courses", {})
        self.routes.setdefault("roles", {})
        guild = pick_guild(api, guild_id or self.routes.get("guild_id"))
        self.gid = str(guild["id"])
        self.guild_name = guild["name"]
        self.routes.update(guild_id=self.gid, guild_name=self.guild_name)
        me = api.call("GET", "/users/@me")
        self.bot_id = str(me["id"])
        self.app_id = str(self.state.get("app_id") or self.bot_id)
        self.roles: list[dict] = api.call("GET", f"/guilds/{self.gid}/roles")
        self.channels: list[dict] = api.call("GET", f"/guilds/{self.gid}/channels")
        self.perms = self._bot_permissions()
        self._n = 0

    # ---- permissions --------------------------------------------------
    def _bot_permissions(self) -> int:
        member = self.api.call("GET", f"/guilds/{self.gid}/members/{self.bot_id}")
        mine = set(map(str, member.get("roles", []))) | {self.gid}
        perms = 0
        for r in self.roles:
            if str(r["id"]) in mine:
                perms |= int(r.get("permissions", 0))
        return ~0 if perms & P["Administrator"] else perms

    def has(self, name: str) -> bool:
        return bool(self.perms & P[name])

    def missing(self) -> tuple[list[str], list[str]]:
        return [n for n in REQUIRED if not self.has(n)], [n for n in OPTIONAL if not self.has(n)]

    def preflight(self) -> None:
        req, _ = self.missing()
        if req:
            raise DiscordSetupError(
                "The bot is missing permissions it needs: " + ", ".join(req) + ". In Discord open "
                "Server Settings > Roles, pick the bot's role and switch them on, or re-invite it with: "
                + invite_url(self.app_id))

    def _bits(self, *names: str) -> int:
        """Only bits the bot holds itself; Discord rejects granting or denying any other."""
        n = 0
        for name in names:
            n |= P[name]
        return n & self.perms

    # ---- roles --------------------------------------------------------
    def _fake_id(self, name: str) -> str:
        self._n += 1
        return f"dry-{self._n}-{_norm(name).replace(' ', '-')}"

    def ensure_role(self, key: str | None, name: str, **attrs: Any) -> dict:
        saved = self.state["roles"].get(key) if key else None
        role = next((r for r in self.roles if str(r["id"]) == str(saved)), None) or \
            next((r for r in self.roles if r["name"].lower() == name.lower() and not r.get("managed")), None)
        if role:
            self.log.append(f"reuse   role {name}")
        else:
            self.log.append(f"create  role {name}")
            body = {"name": name, "permissions": str(attrs.pop("permissions", 0)), "mentionable": False, **attrs}
            role = {"id": self._fake_id(name), **body} if self.dry_run else \
                self.api.call("POST", f"/guilds/{self.gid}/roles", json=body)
            self.roles.append(role)
        if key:
            self.state["roles"][key] = str(role["id"])
        return role

    def staff_role_ids(self) -> list[str]:
        return [self.state["roles"][k] for k in ("admin", "mod") if self.state["roles"].get(k)]

    # ---- channels -----------------------------------------------------
    def overwrites(self, mode: str, class_role: str | None = None) -> list[dict]:
        if mode == "open":
            return []
        ow = lambda id_, type_, allow=0, deny=0: {  # noqa: E731
            "id": str(id_), "type": type_, "allow": str(allow & self.perms), "deny": str(deny & self.perms)}
        hist = P["Read Message History"]
        out = [ow(self.bot_id, 1, allow=VIEW | SEND | P["Embed Links"] | hist)]
        staff_allow = VIEW | SEND | hist
        if mode == "readonly":
            out.append(ow(self.gid, 0, deny=WRITE))
        elif mode == "staff":
            out.append(ow(self.gid, 0, deny=VIEW))
        elif mode == "class":
            out.append(ow(self.gid, 0, deny=VIEW | WRITE))
            staff_allow = VIEW | hist
            if class_role:
                out.append(ow(class_role, 0, allow=VIEW | hist))
        out += [ow(r, 0, allow=staff_allow) for r in self.staff_role_ids()]
        return out

    @staticmethod
    def _same_overwrites(a: list[dict], b: list[dict]) -> bool:
        key = lambda o: (str(o["id"]), int(o.get("type", 0)), str(o.get("allow", "0")), str(o.get("deny", "0")))  # noqa: E731
        return sorted(map(key, a or [])) == sorted(map(key, b or []))

    def find_channel(self, saved: str | None, name: str, type_: int) -> dict | None:
        hit = next((c for c in self.channels if str(c["id"]) == str(saved)), None) if saved else None
        return hit or next((c for c in self.channels if c["type"] == type_ and _norm(c["name"]) == _norm(name)), None)

    def ensure_channel(self, saved: str | None, name: str, type_: int, *, parent: str | None = None,
                       topic: str = "", overwrites: list[dict] | None = None) -> dict:
        label = ("category " if type_ == TYPE_CATEGORY else "#") + name
        want: dict[str, Any] = {}
        ch = self.find_channel(saved, name, type_)
        if ch is None:
            self.log.append(f"create  {label}")
            body: dict[str, Any] = {"name": name, "type": type_}
            if parent:
                body["parent_id"] = parent
            if topic:
                body["topic"] = topic
            if overwrites:
                body["permission_overwrites"] = overwrites
            ch = {"id": self._fake_id(name), **body} if self.dry_run else \
                self.api.call("POST", f"/guilds/{self.gid}/channels", json=body)
            self.channels.append(ch)
            return ch
        if parent and str(ch.get("parent_id")) != str(parent):
            want["parent_id"] = parent
        if topic and ch.get("topic") != topic:
            want["topic"] = topic
        if overwrites is not None and overwrites and not self._same_overwrites(
                ch.get("permission_overwrites", []), overwrites):
            want["permission_overwrites"] = overwrites
        if type_ == TYPE_CATEGORY and ch["name"] != name:
            want["name"] = name
        if not want:
            self.log.append(f"reuse   {label}")
            return ch
        self.log.append(f"update  {label} ({', '.join(sorted(want))})")
        if not self.dry_run:
            ch.update(self.api.call("PATCH", f"/channels/{ch['id']}", json=want) or want)
        else:
            ch.update(want)
        return ch

    # ---- the fixed part of the server ---------------------------------
    def build(self) -> None:
        self.log.append(f"server  {self.guild_name}")
        self.preflight()
        admin = self.ensure_role("admin", ROLE_ADMIN, permissions=self._bits(*ADMIN_PERMS), color=0xE74C3C, hoist=True)
        mod = self.ensure_role("mod", ROLE_MOD, permissions=self._bits(*MOD_PERMS), color=0x2ECC71, hoist=True)
        self.ensure_role("all", ROLE_ALL, color=GOLD)
        del admin, mod
        st = self.state
        for ckey, cname, mode, chans in LAYOUT:
            ow = self.overwrites(mode)
            cat = self.ensure_channel(st["categories"].get(ckey), cname, TYPE_CATEGORY, overwrites=ow)
            st["categories"][ckey] = str(cat["id"])
            for key, name, topic in chans:
                ch = self.ensure_channel(st["channels"].get(key), name, TYPE_TEXT, parent=str(cat["id"]),
                                         topic=topic, overwrites=ow)
                st["channels"][key] = str(ch["id"])
        feed = self.find_channel(st["channels"]["feed"], "all-alerts", TYPE_TEXT)
        errors = self.find_channel(st["channels"]["bot_log"], "bot-log", TYPE_TEXT)
        self.routes["feed"] = self.routes["default"] = ensure_webhook(self.api, feed, self.dry_run, self.log)
        self.routes["errors"] = ensure_webhook(self.api, errors, self.dry_run, self.log)
        self.routes["all_role"] = st["roles"]["all"]

    def tidy(self) -> None:
        """Order the categories, drop the empty legacy one, tighten server-wide settings."""
        legacy = next((c for c in self.channels if c["type"] == TYPE_CATEGORY and c["name"] == LEGACY_CATEGORY), None)
        if legacy and not any(str(c.get("parent_id")) == str(legacy["id"]) for c in self.channels):
            self.log.append(f"delete  empty category {LEGACY_CATEGORY}")
            if not self.dry_run:
                self.api.call("DELETE", f"/channels/{legacy['id']}")
            self.channels.remove(legacy)
        cats = self.state["categories"]
        subjects = sorted((c for c in self.channels if c["type"] == TYPE_CATEGORY
                           and c["name"].startswith(SUBJECT_PREFIX)), key=lambda c: c["name"])
        order = [cats.get("start"), cats.get("community"), cats.get("alerts"),
                 *[str(c["id"]) for c in subjects], cats.get("staff")]
        order = [o for o in order if o]
        now = sorted((c for c in self.channels if c["type"] == TYPE_CATEGORY and str(c["id"]) in order),
                     key=lambda c: (c.get("position", 0), int(c["id"]) if str(c["id"]).isdigit() else 0))
        if [str(c["id"]) for c in now] != order:
            self.log.append("order   categories")
            self._soft("PATCH", f"/guilds/{self.gid}/channels",
                       [{"id": cid, "position": i} for i, cid in enumerate(order)], "ordering categories")
        everyone = next((r for r in self.roles if str(r["id"]) == self.gid), None)
        if everyone and int(everyone.get("permissions", 0)) & P["Mention Everyone"]:
            if self.has("Mention Everyone"):
                self.log.append("update  @everyone can no longer ping @everyone/@here")
                self._soft("PATCH", f"/guilds/{self.gid}/roles/{self.gid}",
                           {"permissions": str(int(everyone["permissions"]) & ~P["Mention Everyone"])},
                           "removing Mention Everyone from @everyone")
            else:
                self.log.append("manual  members can still use @everyone; switch off 'Mention @everyone' "
                                "for @everyone in Server Settings > Roles")
        if self.has("Manage Server"):
            # 1 = notify on mentions only, so the feed does not buzz every member's phone.
            self._soft("PATCH", f"/guilds/{self.gid}", {"default_message_notifications": 1},
                       "setting notifications to mentions-only")
        else:
            self.log.append("manual  set Server Settings > Overview > Default Notification Settings to 'Only @mentions'")

    def _soft(self, method: str, path: str, body: Any, what: str) -> None:
        if self.dry_run:
            return
        try:
            self.api.call(method, path, json=body)
        except DiscordSetupError as e:
            if not isinstance(e, DiscordForbidden) and "error 4" not in str(e):
                raise
            self.log.append(f"manual  Discord refused {what}; do it by hand if you want it")

    # ---- classes ------------------------------------------------------
    def _subject_category(self, subject: str) -> dict:
        base = SUBJECT_PREFIX + subject
        ow = self.overwrites("class")
        n = 1
        while True:
            name = base if n == 1 else f"{base} ({n})"
            cat = self.find_channel(None, name, TYPE_CATEGORY)
            if cat is None:
                return self.ensure_channel(None, name, TYPE_CATEGORY, overwrites=ow)
            if sum(1 for c in self.channels if str(c.get("parent_id")) == str(cat["id"])) < MAX_PER_CATEGORY:
                return cat
            n += 1

    def ensure_class(self, course: str) -> dict:
        """Role + private channel + webhook for one course. Returns its state entry."""
        entry = self.state["classes"].get(course, {})
        role = next((r for r in self.roles if str(r["id"]) == str(entry.get("role_id"))), None) or \
            self.ensure_role(None, course, color=CLASS_ROLE_COLOR)
        ow = self.overwrites("class", str(role["id"]))
        existing = self.find_channel(entry.get("channel_id"), channel_name(course), TYPE_TEXT)
        in_subject = existing and any(
            str(c["id"]) == str(existing.get("parent_id")) and c["name"].startswith(SUBJECT_PREFIX + subject_of(course))
            for c in self.channels)
        parent = str(existing["parent_id"]) if in_subject else str(self._subject_category(subject_of(course))["id"])
        ch = self.ensure_channel(entry.get("channel_id"), channel_name(course), TYPE_TEXT, parent=parent,
                                 topic=f"Seat alerts for {course}. Opted-in members are pinged when seats open.",
                                 overwrites=ow)
        self.routes["courses"][course] = ensure_webhook(self.api, ch, self.dry_run, self.log)
        self.routes["roles"][course] = str(role["id"])
        entry = {"role_id": str(role["id"]), "channel_id": str(ch["id"])}
        self.state["classes"][course] = entry
        return entry

    def remove_class(self, course: str) -> bool:
        entry = self.state["classes"].pop(course, None)
        self.routes["courses"].pop(course, None)
        self.routes["roles"].pop(course, None)
        if not entry:
            return False
        self.log.append(f"delete  class {course}")
        if not self.dry_run:
            for path in (f"/channels/{entry['channel_id']}", f"/guilds/{self.gid}/roles/{entry['role_id']}"):
                try:
                    self.api.call("DELETE", path)
                except DiscordNotFound:
                    pass
        self.channels = [c for c in self.channels if str(c["id"]) != entry["channel_id"]]
        self.roles = [r for r in self.roles if str(r["id"]) != entry["role_id"]]
        return True

    # ---- messages -----------------------------------------------------
    def upsert_message(self, key: str, channel_id: str, payload: dict) -> None:
        """Post a bot message once; later runs edit it in place."""
        if self.dry_run:
            self.log.append(f"post    {key}")
            return
        mid = self.state["messages"].get(key)
        if mid:
            try:
                self.api.call("PATCH", f"/channels/{channel_id}/messages/{mid}", json=payload)
                return
            except DiscordNotFound:
                pass
        self.log.append(f"post    {key}")
        self.state["messages"][key] = str(self.api.call("POST", f"/channels/{channel_id}/messages", json=payload)["id"])

    def post_content(self) -> None:
        from watcher import discord_content as dc
        ch = self.state["channels"]
        for key, payload in dc.info_messages(self.guild_name, ch).items():
            self.upsert_message(key, ch[key], payload)
        self.refresh_panel()

    def refresh_panel(self) -> None:
        from watcher import discord_content as dc
        ch = self.state["channels"]
        if ch.get("get_alerts"):
            self.upsert_message("panel", ch["get_alerts"], dc.panel(sorted(self.state["classes"]), ch))


def popular_courses(data_dir: str | Path | None = None) -> list[str]:
    """Courses most worth watching, best first: big classes that are predicted to fill.

    Score = students enrolled the last time the course ran x predicted demand (capped at 1.5),
    from the enrollment predictor's files. Courses predicted not to fill are left out.
    Returns [] when those files are not there.
    """
    import csv
    import json
    root = Path(data_dir) if data_dir else Path(__file__).resolve().parent.parent / "data"
    try:
        preds = json.loads((root / "predictions" / "predictions.json").read_text(encoding="utf-8"))["predictions"]
        with open(root / "enrollment" / "observations.csv", newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    except (OSError, ValueError, KeyError):
        return []
    demand: dict[str, float] = {}
    for p in preds:
        if p.get("fillsInPhase") != "Does not fill":
            demand[p["course"]] = max(demand.get(p["course"], 0.0), float(p.get("expectedDemandRatio") or 0))
    size: dict[str, tuple[int, float]] = {}
    for r in rows:
        try:
            term, enrolled = int(r["term_key"]), float(r["enrolled"] or 0)
        except (KeyError, ValueError):
            continue
        last = size.get(r["course"])
        if not last or term > last[0]:
            size[r["course"]] = (term, enrolled)
        elif term == last[0]:
            size[r["course"]] = (term, last[1] + enrolled)
    score = {c: size[c][1] * min(d, 1.5) for c, d in demand.items() if c in size}
    return sorted(score, key=lambda c: (-score[c], c))


def pick_popular(n: int, verify: Any, have: set[str], data_dir: str | Path | None = None) -> tuple[list[str], list[str]]:
    """The n best courses not watched yet that the live schedule really offers this term.

    ``verify(course)`` is the bot's schedule check. Cross-listed names the schedule does not
    use (COMPSCI C8 for DATA C8) come back "missing" and are skipped. Returns (picked, log).
    """
    picked: list[str] = []
    log: list[str] = []
    failed = 0
    for course in popular_courses(data_dir):
        if len(picked) >= n:
            break
        if course in have:
            continue
        status, _ = verify(course)
        if status == "ok":
            picked.append(course)
            log.append(f"popular {course}")
        elif status == "missing":
            log.append(f"skip    {course} (not in the schedule this term)")
        else:  # the schedule site is slow and sometimes times out; one miss is not fatal
            failed += 1
            log.append(f"skip    {course} (schedule did not answer; run again to retry)")
            if failed >= 3 and not picked:
                raise DiscordSetupError("could not reach the class schedule; try again later (nothing was changed)")
            continue
        failed = 0
    return picked, log


def setup_server(courses: list[str], *, token: str = "", guild_id: str | None = None, routes: dict | None = None,
                 dry_run: bool = False, api: DiscordAPI | None = None) -> tuple[dict, list[str]]:
    """Build or update the whole server. Returns (routes, log lines)."""
    srv = Server(api or DiscordAPI(token), routes, guild_id=guild_id, dry_run=dry_run)
    srv.build()
    wanted = sorted({c.upper().strip() for c in courses if c and c.strip()} | set(srv.state["classes"]))
    if len(wanted) > HARD_MAX_CLASSES:
        raise DiscordSetupError(f"{len(wanted)} classes is over the limit of {HARD_MAX_CLASSES} "
                                "(Discord allows 250 roles and 500 channels per server).")
    for course in wanted:
        srv.ensure_class(course)
    srv.tidy()
    srv.post_content()
    return srv.routes, srv.log


def check(*, token: str = "", guild_id: str | None = None, routes: dict | None = None,
          api: DiscordAPI | None = None) -> list[str]:
    """Report what the bot may do; changes nothing."""
    srv = Server(api or DiscordAPI(token), routes, guild_id=guild_id, dry_run=True)
    req, opt = srv.missing()
    out = [f"server  {srv.guild_name}"]
    out += [f"MISSING (required) {n}" for n in req]
    out += [f"missing (optional) {n}: without it, no {OPTIONAL[n]}" for n in opt]
    if not req and not opt:
        out.append("ok      the bot has every permission it can use")
    elif not req:
        out.append("ok      the bot has every required permission")
    if req or opt:
        out.append("invite  " + invite_url(srv.app_id))
    return out
