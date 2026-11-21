"""The long-running Discord bot: self-serve opt-in for class alerts.

    python -m watcher discord-bot [-c watcher.yaml] [--watch] [--auto-approve] [--max-classes 60]

Members pick classes with the buttons in #get-alerts or with slash commands
(/watch, /unwatch, /alerts, /classes). Picking a class gives them that class's
role, which unlocks its channel and is what alerts ping. Classes that are not
watched yet can be requested; staff approve them in #class-requests (or pass
--auto-approve to create any class that exists in the live schedule).

The server itself is built by ``python -m watcher discord-server`` first; this
process only needs to stay online to answer button presses and commands. It
talks to Discord's gateway directly over one websocket (the small
``websocket-client`` package) and needs no privileged intents.
"""
from __future__ import annotations

import json
import logging
import random
import re
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

from watcher import discord_content as dc
from watcher.discord_server import HARD_MAX_CLASSES, P, Server, subject_of
from watcher.discord_setup import (
    ROUTES_FILE, DiscordAPI, DiscordForbidden, DiscordNotFound, DiscordSetupError,
    load_routes, write_routes,
)

log = logging.getLogger("watcher.discord")

EPHEMERAL = 64
AUTO_ADDS_PER_DAY = 5
# Nicknames students type -> the subject code the schedule uses. The catalog's own
# aliases (data/subjects.json: "EL ENG", "L & S", "CS", ...) are added on top.
NICKNAMES = {
    "CS": "COMPSCI", "EE": "ELENG", "STATS": "STAT", "MCB": "MCELLBI", "IB": "INTEGBI", "BIO": "BIOLOGY",
    "POLISCI": "POLSCI", "PS": "POLSCI", "SOC": "SOCIOL", "ENG": "ENGLISH", "ME": "MECENG",
    "CE": "CIVENG", "CEE": "CIVENG", "IEOR": "INDENG", "BIOE": "BIOENG", "MSE": "MATSCI",
    "NE": "NUCENG", "CHEME": "CHMENG", "CBE": "CHMENG", "ASTRO": "ASTRON", "PHIL": "PHILOS",
    "LING": "LINGUIS", "HIST": "HISTORY", "PH": "PBHLTH", "MEDIA": "MEDIAST", "PHYS": "PHYSICS",
    "PSYC": "PSYCH", "NST": "NUSCTX", "DS": "DATA", "HAAS": "UGBA", "BUS": "UGBA",
}
_NUM = re.compile(r"^[A-Z]{0,2}\d{1,3}[A-Z]{0,3}$")
_SUBJ = re.compile(r"^[A-Z][A-Z ,&/-]{0,24}$")
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def _squash(text: str) -> str:
    return re.sub(r"[^A-Z]", "", text.upper())


@lru_cache(maxsize=1)
def _catalog() -> tuple[dict[str, str], frozenset[str]]:
    """(subject spelling without spaces -> code, every course id). Empty when data/ is absent."""
    subjects = {_squash(k): v for k, v in NICKNAMES.items()}
    courses: set[str] = set()
    try:
        for row in json.loads((DATA_DIR / "subjects.json").read_text(encoding="utf-8")):
            for name in [row["code"], *row.get("aliases", [])]:
                subjects[_squash(name)] = row["code"]
        courses = {c["id"] for c in json.loads((DATA_DIR / "courses.json").read_text(encoding="utf-8"))}
    except (OSError, ValueError, KeyError, TypeError):
        log.info("no course catalog in %s; course codes are only checked against the live schedule", DATA_DIR)
    return subjects, frozenset(courses)


def normalize_course(text: str) -> str | None:
    """'cs61a' -> 'COMPSCI 61A', 'l & s c30t' -> 'LS C30T'; None if it is not a course code."""
    t = re.sub(r"\s+", " ", (text or "").upper().strip())
    if " " in t:
        subj, num = t.rsplit(" ", 1)
    else:
        m = re.match(r"^([A-Z&]+?)(\d.*)$", t)
        if not m:
            return None
        subj, num = m.groups()
    if not _NUM.match(num) or not _SUBJ.match(subj):
        return None
    return f"{_catalog()[0].get(_squash(subj), subj)} {num}"


def suggestions(course: str, limit: int = 5) -> list[str]:
    """Catalog courses that look like a mistyped one: same subject, similar number."""
    subj, num = course.rsplit(" ", 1)
    digits = re.sub(r"\D", "", num)
    same = sorted(c for c in _catalog()[1] if c.rsplit(" ", 1)[0] == subj
                  and re.sub(r"\D", "", c.rsplit(" ", 1)[1]) == digits)
    return same[:limit]


COMMANDS = [
    {"name": "watch", "description": "Get pinged when seats open in a class",
     "options": [{"type": 3, "name": "course", "description": "Course code, like COMPSCI 61A",
                  "required": True, "autocomplete": True}]},
    {"name": "unwatch", "description": "Stop alerts for a class",
     "options": [{"type": 3, "name": "course", "description": "Course code", "required": True,
                  "autocomplete": True}]},
    {"name": "alerts", "description": "Show the classes you get alerts for"},
    {"name": "classes", "description": "List every class being watched"},
    {"name": "class-add", "description": "Staff: start watching a class",
     "default_member_permissions": str(P["Manage Messages"]),
     "options": [{"type": 3, "name": "course", "description": "Course code", "required": True}]},
    {"name": "class-remove", "description": "Staff: stop watching a class and delete its channel and role",
     "default_member_permissions": str(P["Manage Messages"]),
     "options": [{"type": 3, "name": "course", "description": "Course code", "required": True,
                  "autocomplete": True}]},
]


def _chunks(seq: list, n: int) -> list[list]:
    return [seq[i:i + n] for i in range(0, len(seq), n)]


class Bot:
    """Turns one Discord interaction into role changes and replies."""

    def __init__(self, api: DiscordAPI, routes_path: str = ROUTES_FILE, *,
                 verify: Callable[[str], tuple[str, str]] | None = None,
                 auto_approve: bool = True, max_classes: int = 100, term: str = ""):
        self.api, self.path = api, routes_path
        self.verify = verify or (lambda course: ("unknown", ""))
        self.auto_approve = auto_approve
        self.max_classes = min(max_classes, HARD_MAX_CLASSES)
        self.term = term
        self.lock = threading.RLock()
        self._auto_adds: dict[str, list[float]] = {}   # member id -> times they opened a new class

    # ---- state --------------------------------------------------------
    def routes(self) -> dict:
        r = load_routes(self.path)
        if not r or "server" not in r:
            raise DiscordSetupError("run `python -m watcher discord-server` first")
        return r

    def state(self) -> dict:
        return self.routes()["server"]

    def register_commands(self) -> None:
        r = self.routes()
        app = self.api.call("GET", "/applications/@me")["id"]
        self.api.call("PUT", f"/applications/{app}/guilds/{r['guild_id']}/commands", json=COMMANDS)

    # ---- replying -----------------------------------------------------
    def _callback(self, i: dict, type_: int, data: dict | None = None) -> None:
        body: dict[str, Any] = {"type": type_}
        if data is not None:
            body["data"] = data
        self.api.call("POST", f"/interactions/{i['id']}/{i['token']}/callback", json=body)
        i["_answered"] = True

    def _say(self, i: dict, text: str, components: list | None = None, update: bool = False) -> None:
        data = {"content": text, "flags": EPHEMERAL, "allowed_mentions": {"parse": []}}
        if components is not None:
            data["components"] = components
        self._callback(i, 7 if update else 4, data)

    def _defer(self, i: dict, update: bool = False) -> None:
        self._callback(i, 6 if update else 5, None if update else {"flags": EPHEMERAL})

    def _edit(self, i: dict, text: str | None = None, **extra: Any) -> None:
        body: dict[str, Any] = {"allowed_mentions": {"parse": []}, **extra}
        if text is not None:
            body["content"] = text
        self.api.call("PATCH", f"/webhooks/{i['application_id']}/{i['token']}/messages/@original", json=body)

    def note(self, text: str) -> None:
        """Best-effort line in #bot-log."""
        try:
            ch = self.state()["channels"].get("bot_log")
            if ch:
                self.api.call("POST", f"/channels/{ch}/messages",
                              json={"content": text[:1900], "allowed_mentions": {"parse": []}})
        except DiscordSetupError as e:
            log.warning("bot-log: %s", e)

    # ---- members ------------------------------------------------------
    @staticmethod
    def _uid(i: dict) -> str:
        return str(i["member"]["user"]["id"])

    @staticmethod
    def _have(i: dict) -> set[str]:
        return set(map(str, i["member"].get("roles", [])))

    def is_staff(self, i: dict) -> bool:
        perms = int(i["member"].get("permissions", 0))
        if perms & (P["Administrator"] | P["Manage Channels"] | P["Manage Server"]):
            return True
        roles = self.state()["roles"]
        return bool(self._have(i) & {roles.get("admin"), roles.get("mod")})

    def _set_role(self, guild: str, user: str, role: str, on: bool) -> None:
        self.api.call("PUT" if on else "DELETE", f"/guilds/{guild}/members/{user}/roles/{role}")

    def _mine(self, i: dict, st: dict) -> list[str]:
        have = self._have(i)
        return sorted(c for c, e in st["classes"].items() if e["role_id"] in have)

    # ---- entry point --------------------------------------------------
    def handle(self, i: dict) -> None:
        try:
            self._route(i)
        except DiscordForbidden:
            log.warning("forbidden while handling interaction")
            self._fail(i, "I'm not allowed to do that. A staff member needs to check that my role has "
                          "Manage Roles and sits above the class roles.")
        except DiscordSetupError as e:
            log.warning("interaction failed: %s", e)
            self._fail(i, "Something went wrong on my side. Please try again in a minute.")
        except Exception:
            log.exception("interaction crashed")
            self._fail(i, "Something went wrong on my side. Please try again in a minute.")

    def _fail(self, i: dict, text: str) -> None:
        try:
            if i.get("_answered"):  # already deferred or replied: edit that reply
                self._edit(i, text, components=[])
            else:
                self._say(i, text)
        except Exception:  # expired or Discord is down: nothing more to do
            log.warning("could not deliver an error reply")

    def _route(self, i: dict) -> None:
        kind, data = i.get("type"), i.get("data", {})
        if "member" not in i:
            if kind != 4:
                self._say(i, "Use me inside the server, not in DMs.")
            return
        if kind == 4:
            return self._autocomplete(i, data)
        if kind == 2:
            opts = {o["name"]: o.get("value") for o in data.get("options", [])}
            return {"watch": self._cmd_watch, "unwatch": self._cmd_unwatch, "alerts": self._show_mine,
                    "classes": self._cmd_classes, "class-add": self._cmd_class_add,
                    "class-remove": self._cmd_class_remove}[data["name"]](i, **opts)
        if kind == 5 and data.get("custom_id") == "cc:reqmodal":
            text = data["components"][0]["components"][0]["value"]
            self._defer(i)
            return self._edit(i, self._request(i, text))
        if kind == 3:
            cid = data.get("custom_id", "")
            if cid == dc.BTN_BROWSE:
                return self._browse(i, update=False)
            if cid == "cc:back":
                return self._browse(i, update=True)
            if cid.startswith("cc:subj"):
                return self._browse(i, update=True, subject=data["values"][0])
            if cid.startswith("cc:cls"):
                return self._pick(i, cid, data.get("values", []))
            if cid == dc.BTN_MINE:
                return self._show_mine(i)
            if cid == "cc:clear":
                return self._clear(i)
            if cid == dc.BTN_ALL:
                return self._toggle_all(i)
            if cid == dc.BTN_REQUEST:
                return self._callback(i, 9, {"custom_id": "cc:reqmodal", "title": "Request a class", "components": [
                    {"type": 1, "components": [{"type": 4, "custom_id": "course", "style": 1, "min_length": 3,
                                                "max_length": 40, "required": True, "label": "Course code",
                                                "placeholder": "COMPSCI 61A"}]}]})
            if cid.startswith(("cc:approve:", "cc:deny:")):
                return self._decide(i, cid.split(":", 2)[1] == "approve", cid.split(":", 2)[2])
        self._say(i, "I don't know that one. Try the buttons in the get-alerts channel.")

    # ---- browsing and picking ----------------------------------------
    def _class_rows(self, courses: list[str], st: dict, have: set[str], back: bool) -> list[dict]:
        rows = []
        for n, chunk in enumerate(_chunks(courses, 25)[:4]):
            rows.append({"type": 1, "components": [{
                "type": 3, "custom_id": f"cc:cls:{n}", "min_values": 0, "max_values": len(chunk),
                "placeholder": "Pick your classes" if n == 0 else "More classes",
                "options": [{"label": c, "value": c, "default": st["classes"][c]["role_id"] in have}
                            for c in chunk]}]})
        if back:
            rows.append({"type": 1, "components": [
                {"type": 2, "style": 2, "label": "Back to subjects", "custom_id": "cc:back"}]})
        return rows

    def _browse(self, i: dict, update: bool, subject: str | None = None) -> None:
        st = self.state()
        courses = sorted(st["classes"])
        if not courses:
            return self._say(i, "No classes are being watched yet. Press **Request a class** to ask for one.",
                             components=[], update=update)
        have = self._have(i)
        if subject or len(courses) <= 25:
            shown = [c for c in courses if subject_of(c) == subject] if subject else courses
            text = ("Tick every class you want alerts for, untick the ones you don't, then click away. "
                    "Your choices save as soon as the menu closes.")
            return self._say(i, text, self._class_rows(shown, st, have, back=bool(subject)), update=update)
        counts: dict[str, int] = {}
        for c in courses:
            counts[subject_of(c)] = counts.get(subject_of(c), 0) + 1
        rows = [{"type": 1, "components": [{
            "type": 3, "custom_id": f"cc:subj:{n}", "placeholder": f"Subjects {chunk[0]} to {chunk[-1]}",
            "options": [{"label": s, "value": s, "description": f"{counts[s]} class{'' if counts[s] == 1 else 'es'}"}
                        for s in chunk]}]} for n, chunk in enumerate(_chunks(sorted(counts), 25)[:5])]
        self._say(i, "Pick a subject to see its classes.", rows, update=update)

    def _pick(self, i: dict, cid: str, selected: list[str]) -> None:
        st = self.state()
        rows = i.get("message", {}).get("components", [])
        menu = next((c for r in rows for c in r.get("components", []) if c.get("custom_id") == cid), None)
        shown = [o["value"] for o in (menu or {}).get("options", [])] or selected
        have, guild, uid = self._have(i), str(i["guild_id"]), self._uid(i)
        self._defer(i, update=True)
        added, removed = [], []
        for course in shown:
            entry = st["classes"].get(course)
            if not entry:
                continue
            want, has = course in selected, entry["role_id"] in have
            if want != has:
                self._set_role(guild, uid, entry["role_id"], want)
                (added if want else removed).append(course)
                (have.add if want else have.discard)(entry["role_id"])
        for r in rows:  # redraw the same menus with the new ticks
            for c in r.get("components", []):
                for o in c.get("options", []) if str(c.get("custom_id", "")).startswith("cc:cls") else []:
                    o["default"] = st["classes"].get(o["value"], {}).get("role_id") in have
        parts = []
        if added:
            parts.append("✅ Alerts on for " + ", ".join(f"**{c}** (<#{st['classes'][c]['channel_id']}>)" for c in added))
        if removed:
            parts.append("Alerts off for " + ", ".join(f"**{c}**" for c in removed))
        self._edit(i, "\n".join(parts) or "No changes.", components=rows)

    def _show_mine(self, i: dict) -> None:
        st = self.state()
        mine = self._mine(i, st)
        every = st["roles"].get("all") in self._have(i)
        if not mine and not every:
            return self._say(i, "You have no alerts yet. Press **Browse classes** in the get-alerts channel, "
                                "or type `/watch`.")
        lines = [f"• **{c}** in <#{st['classes'][c]['channel_id']}>" for c in mine]
        if every:
            lines.append("• **Every Alert**: you are pinged for every class")
        self._say(i, "You get alerts for:\n" + "\n".join(lines), [{"type": 1, "components": [
            {"type": 2, "style": 4, "label": "Stop all my alerts", "custom_id": "cc:clear"}]}])

    def _clear(self, i: dict) -> None:
        st = self.state()
        self._defer(i, update=True)
        have = self._have(i)
        gone = [r for r in [e["role_id"] for e in st["classes"].values()] + [st["roles"].get("all")] if r in have]
        for r in gone:
            self._set_role(str(i["guild_id"]), self._uid(i), r, False)
        self._edit(i, "All your alerts are off. You can turn them back on any time.", components=[])

    def _toggle_all(self, i: dict) -> None:
        role = self.state()["roles"].get("all")
        if not role:
            return self._say(i, "Every Alert is not set up on this server.")
        on = role not in self._have(i)
        self._defer(i)
        self._set_role(str(i["guild_id"]), self._uid(i), role, on)
        feed = self.state()["channels"].get("feed")
        self._edit(i, f"🔔 Every Alert is **on**. You will be pinged in <#{feed}> whenever any class opens up."
                   if on else "Every Alert is **off**. You still get the classes you picked one by one.")

    # ---- slash commands ----------------------------------------------
    def _autocomplete(self, i: dict, data: dict) -> None:
        typed = next((str(o.get("value", "")) for o in data.get("options", []) if o.get("focused")), "")
        try:
            st = self.state()
        except DiscordSetupError:
            st = {"classes": {}}
        pool = self._mine(i, st) if data.get("name") == "unwatch" else sorted(st["classes"])
        want = re.sub(r"\s+", "", typed.upper())
        m = re.match(r"^([A-Z&]+)(.*)$", want)   # "CS61" should also find COMPSCI 61A
        alt = (_catalog()[0].get(m[1], m[1]) + m[2]) if m else want
        hits = [c for c in pool if want in c.replace(" ", "") or alt in c.replace(" ", "")][:25]
        self._callback(i, 8, {"choices": [{"name": c, "value": c} for c in hits]})

    def _cmd_watch(self, i: dict, course: str = "") -> None:
        self._defer(i)
        self._edit(i, self._request(i, course))

    def _cmd_unwatch(self, i: dict, course: str = "") -> None:
        st = self.state()
        name = normalize_course(course)
        entry = st["classes"].get(name or "")
        if not entry or entry["role_id"] not in self._have(i):
            return self._say(i, f"You don't have alerts for **{name or course}**.")
        self._defer(i)
        self._set_role(str(i["guild_id"]), self._uid(i), entry["role_id"], False)
        self._edit(i, f"Alerts off for **{name}**.")

    def _cmd_classes(self, i: dict) -> None:
        courses = sorted(self.state()["classes"])
        if not courses:
            return self._say(i, "No classes are being watched yet. Use `/watch` to request one.")
        text = f"**{len(courses)} watched:** " + ", ".join(courses)
        self._say(i, text[:1900] + (" …" if len(text) > 1900 else ""))

    def _cmd_class_add(self, i: dict, course: str = "") -> None:
        if not self.is_staff(i):
            return self._say(i, "Only staff can do that. Use `/watch` to request a class.")
        name = normalize_course(course)
        if not name:
            return self._say(i, "That doesn't look like a course code. Example: `COMPSCI 61A`.")
        self._defer(i)
        entry = self.create_class(name)
        self.note(f"➕ <@{self._uid(i)}> added **{name}**")
        self._edit(i, f"Now watching **{name}** in <#{entry['channel_id']}>.")

    def _cmd_class_remove(self, i: dict, course: str = "") -> None:
        if not self.is_staff(i):
            return self._say(i, "Only staff can do that.")
        name = normalize_course(course) or course
        self._defer(i)
        with self.lock:
            srv = Server(self.api, self.routes())
            found = srv.remove_class(name)
            if found:
                srv.refresh_panel()
                write_routes(srv.routes, self.path)
        if found:
            self.note(f"➖ <@{self._uid(i)}> removed **{name}**")
        self._edit(i, f"Removed **{name}**: its channel and role are gone and it is no longer watched."
                   if found else f"**{name}** is not being watched.")

    # ---- classes and requests ----------------------------------------
    def create_class(self, course: str) -> dict:
        with self.lock:
            srv = Server(self.api, self.routes())
            entry = srv.ensure_class(course)
            srv.state["requests"].pop(course, None)
            srv.refresh_panel()
            write_routes(srv.routes, self.path)
            return entry

    def _join(self, i: dict, course: str, entry: dict) -> str:
        self._set_role(str(i["guild_id"]), self._uid(i), entry["role_id"], True)
        return f"✅ Alerts on for **{course}**. You will be pinged in <#{entry['channel_id']}> when seats open."

    def _request(self, i: dict, text: str) -> str:
        """Join a watched class, or ask for a new one. Returns the reply text."""
        course = normalize_course(text)
        if not course:
            return ("That doesn't look like a course code. Write the subject and number the way the "
                    "schedule does, for example `COMPSCI 61A`, `DATA C8` or `MATH 53`.")
        st = self.state()
        if course in st["classes"]:
            return self._join(i, course, st["classes"][course])
        uid = self._uid(i)
        pending = st["requests"].get(course)
        if pending and uid in pending.get("users", []):
            return f"You already asked for **{course}**. Staff will get to it soon."
        if len(st["classes"]) >= self.max_classes:
            return (f"This server is at its limit of {self.max_classes} watched classes, so **{course}** "
                    "can't be added right now.")
        if not pending and sum(uid in r.get("users", []) for r in st["requests"].values()) >= 3:
            return "You have 3 requests waiting already. Please wait for staff to review them."
        known = _catalog()[1]
        if known and course not in known and not pending:
            near = suggestions(course)
            return (f"**{course}** is not in the Berkeley course catalog."
                    + (" Did you mean " + ", ".join(f"`{c}`" for c in near) + "?" if near else
                       " Write the subject and number the way the schedule does, for example `COMPSCI 61A`."))
        status, title = ("ok", pending.get("title", "")) if pending else self.verify(course)
        term = f" in {self.term}" if self.term else ""
        if status == "missing":
            return (f"I couldn't find **{course}**{term} on classes.berkeley.edu. Check the code: the subject "
                    "must be written the way the schedule writes it, for example `COMPSCI 61A`.")
        if self.auto_approve and status == "ok" and self._may_auto_add(uid):
            entry = self.create_class(course)
            self.note(f"➕ **{course}** added automatically for <@{uid}>")
            return self._join(i, course, entry)
        self._queue(course, uid, title, verified=status == "ok")
        return (f"**{course}** isn't watched yet, so I sent your request to the staff. "
                "You'll get the role and a ping in the new channel as soon as it's approved.")

    def _may_auto_add(self, uid: str) -> bool:
        """One member can open at most AUTO_ADDS_PER_DAY new classes a day; more go to staff."""
        now = time.time()
        recent = [t for t in self._auto_adds.get(uid, []) if now - t < 86400]
        if len(recent) >= AUTO_ADDS_PER_DAY:
            self._auto_adds[uid] = recent
            return False
        self._auto_adds[uid] = recent + [now]
        return True

    def _request_message(self, course: str, req: dict) -> dict:
        embed = {
            "title": f"Class request: {course}", "color": dc.GOLD,
            "description": req.get("title") or "",
            "fields": [
                {"name": "Requested by", "value": " ".join(f"<@{u}>" for u in req["users"]) or "?"},
                {"name": "Schedule check", "value": "Found in the live schedule" if req.get("verified")
                 else "Could not be checked (schedule unreachable). Look it up before approving."},
            ]}
        return {"embeds": [embed], "allowed_mentions": {"parse": []}, "components": [{"type": 1, "components": [
            {"type": 2, "style": 3, "label": "Approve", "custom_id": f"cc:approve:{course}"},
            {"type": 2, "style": 4, "label": "Deny", "custom_id": f"cc:deny:{course}"}]}]}

    def _queue(self, course: str, uid: str, title: str, verified: bool) -> None:
        with self.lock:
            routes = self.routes()
            st = routes["server"]
            req = st["requests"].setdefault(course, {"users": [], "title": title, "verified": verified})
            if uid not in req["users"]:
                req["users"].append(uid)
            ch, payload = st["channels"]["class_requests"], self._request_message(course, req)
            try:
                if not req.get("message_id"):
                    raise DiscordNotFound("new")
                self.api.call("PATCH", f"/channels/{ch}/messages/{req['message_id']}", json=payload)
            except DiscordNotFound:
                req["message_id"] = str(self.api.call("POST", f"/channels/{ch}/messages", json=payload)["id"])
            write_routes(routes, self.path)

    def _decide(self, i: dict, approve: bool, course: str) -> None:
        if not self.is_staff(i):
            return self._say(i, "Only staff can decide on requests.")
        self._defer(i, update=True)
        req = self.state()["requests"].get(course, {"users": []})
        embeds = i.get("message", {}).get("embeds", [])
        mod = self._uid(i)
        if not approve:
            with self.lock:
                routes = self.routes()
                routes["server"]["requests"].pop(course, None)
                write_routes(routes, self.path)
            return self._edit(i, f"❌ Denied by <@{mod}>", embeds=embeds, components=[])
        if course not in self.state()["classes"] and len(self.state()["classes"]) >= self.max_classes:
            return self._edit(i, f"⚠️ At the limit of {self.max_classes} classes. Remove one with "
                                 "`/class-remove` or restart the bot with a higher `--max-classes`.", embeds=embeds)
        entry = self.create_class(course)
        for u in req["users"]:
            try:
                self._set_role(str(i["guild_id"]), u, entry["role_id"], True)
            except DiscordSetupError:  # they left the server
                pass
        hello = f"Now watching **{course}**. " + " ".join(f"<@{u}>" for u in req["users"])
        self.api.call("POST", f"/channels/{entry['channel_id']}/messages", json={
            "content": hello + (" you asked for this one, so you're signed up." if req["users"] else ""),
            "allowed_mentions": {"users": req["users"][:100]}})
        self._edit(i, f"✅ Approved by <@{mod}>, alerts go to <#{entry['channel_id']}>", embeds=embeds, components=[])


def make_verifier(sources: list[str], term: str) -> Callable[[str], tuple[str, str]]:
    """Check a course against the live schedule: ('ok', title) | ('missing', '') | ('unknown', '')."""
    def verify(course: str) -> tuple[str, str]:
        from watcher.runner import make_source
        from watcher.sources.base import SourceError, Target
        for name in sources:
            try:
                secs = [s for s in make_source(name).fetch(Target(course=course, term=term)) if s.course == course]
            except SourceError:
                continue
            except Exception:
                log.exception("verify crashed for %s", course)
                continue
            return ("ok", secs[0].title) if secs else ("missing", "")
        return ("unknown", "")
    return verify


# ---- gateway ---------------------------------------------------------------
class FatalGatewayError(RuntimeError):
    pass


FATAL_CLOSE = {4004: "Discord rejected the bot token", 4010: "invalid shard", 4011: "sharding required",
               4012: "invalid API version", 4013: "invalid intents", 4014: "disallowed intents"}


def _ws_connect(url: str):
    import websocket  # the `websocket-client` package
    return websocket.create_connection(url, timeout=90)


class Gateway:
    """Minimal Discord gateway client: identify, heartbeat, resume, reconnect."""

    def __init__(self, token: str, on_dispatch: Callable[[str, dict], None], *, url: str,
                 connect: Callable[[str], Any] = _ws_connect, intents: int = 0):
        self._token, self.on_dispatch, self.url, self.connect, self.intents = token, on_dispatch, url, connect, intents
        self.session_id: str | None = None
        self.resume_url: str | None = None
        self.seq: int | None = None
        self._stop = threading.Event()
        self._send_lock = threading.Lock()
        self._acked = True

    def stop(self) -> None:
        self._stop.set()

    def _send(self, ws: Any, op: int, d: Any) -> None:
        with self._send_lock:
            ws.send(json.dumps({"op": op, "d": d}))

    def _heartbeats(self, ws: Any, interval: float, done: threading.Event) -> None:
        done.wait(interval * random.random())
        while not done.is_set() and not self._stop.is_set():
            if not self._acked:  # the connection is a zombie: drop it so the main loop reconnects
                log.warning("gateway: heartbeat not acknowledged, reconnecting")
                try:
                    ws.close()
                except Exception:
                    pass
                return
            self._acked = False
            try:
                self._send(ws, 1, self.seq)
            except Exception:
                return
            done.wait(interval)

    def run_once(self) -> None:
        """One connection. Returns when it should be re-established."""
        base = self.resume_url if (self.session_id and self.resume_url) else self.url
        ws = self.connect(base.rstrip("/") + "/?v=10&encoding=json")
        done = threading.Event()
        try:
            while not self._stop.is_set():
                opcode, raw = ws.recv_data()
                if opcode == 8:  # close frame
                    code = struct.unpack("!H", raw[:2])[0] if len(raw) >= 2 else 1000
                    if code in FATAL_CLOSE:
                        raise FatalGatewayError(FATAL_CLOSE[code])
                    if code in (4007, 4009):
                        self.session_id = None
                    log.info("gateway closed (%s)", code)
                    return
                if opcode not in (1, 2) or not raw:
                    continue
                msg = json.loads(raw)
                op, d = msg.get("op"), msg.get("d")
                if msg.get("s") is not None:
                    self.seq = msg["s"]
                if op == 10:
                    self._acked = True
                    threading.Thread(target=self._heartbeats, args=(ws, d["heartbeat_interval"] / 1000, done),
                                     daemon=True).start()
                    if self.session_id:
                        self._send(ws, 6, {"token": self._token, "session_id": self.session_id, "seq": self.seq})
                    else:
                        self._send(ws, 2, {"token": self._token, "intents": self.intents, "properties": {
                            "os": sys.platform, "browser": "CalClassCoordinator", "device": "CalClassCoordinator"},
                            "presence": {"status": "online", "afk": False, "since": None, "activities": [
                                {"name": "Berkeley seats", "type": 3}]}})
                elif op == 11:
                    self._acked = True
                elif op == 1:
                    self._send(ws, 1, self.seq)
                elif op == 7:
                    return
                elif op == 9:
                    if not d:
                        self.session_id, self.seq = None, None
                    self._stop.wait(1 + 4 * random.random())
                    return
                elif op == 0:
                    if msg.get("t") == "READY":
                        self.session_id, self.resume_url = d["session_id"], d.get("resume_gateway_url")
                        log.info("gateway ready as %s", d.get("user", {}).get("username", "?"))
                    self.on_dispatch(msg.get("t", ""), d)
        finally:
            done.set()
            try:
                ws.close()
            except Exception:
                pass

    def run_forever(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self.run_once()
            except FatalGatewayError:
                raise
            except Exception as e:  # network drop, timeout, bad frame: reconnect
                log.warning("gateway connection lost: %s", type(e).__name__)
            backoff = 1.0 if time.monotonic() - started > 60 else min(backoff * 2, 60)
            self._stop.wait(backoff + random.random())


def run_bot(token: str, *, routes_path: str = ROUTES_FILE, sources: list[str] | None = None, term: str = "",
            auto_approve: bool = True, max_classes: int = 100,
            verify: Callable[[str], tuple[str, str]] | None = None,
            on_gateway: Callable[["Gateway"], None] | None = None) -> None:
    """Register the slash commands, then answer interactions until stopped.

    ``verify`` overrides the schedule check (``prod`` passes one that goes through the
    shared Watcher so it respects its request gap and cool-downs). ``on_gateway`` gets
    the Gateway before it connects so a supervisor can ``stop()`` it.
    """
    api = DiscordAPI(token)
    if verify is None and sources:
        verify = make_verifier(sources, term)
    bot = Bot(api, routes_path, verify=verify, auto_approve=auto_approve, max_classes=max_classes, term=term)
    bot.register_commands()
    pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="interaction")

    def dispatch(event: str, d: dict) -> None:
        if event == "INTERACTION_CREATE":
            pool.submit(bot.handle, d)

    try:
        url = api.call("GET", "/gateway/bot")["url"]
        log.info("discord bot online for %s; %d classes", bot.routes().get("guild_name"), len(bot.state()["classes"]))
        gw = Gateway(token, dispatch, url=url)
        if on_gateway:
            on_gateway(gw)
        gw.run_forever()
    finally:
        pool.shutdown(wait=False)
