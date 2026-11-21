"""CLI.

python -m watcher run   [-c watcher.yaml]        poll forever and alert
python -m watcher once  [-c watcher.yaml]        one pass, print events
python -m watcher check "COMPSCI 61A" [--term "2026 Spring"] [--source ...]
                                                  print current seats, no state
python -m watcher discord-setup [-c watcher.yaml] [--guild ID] [--dry-run]
                                                  create Discord channels/webhooks per class
python -m watcher discord-server [-c watcher.yaml] [--classes "A 1,B 2"] [--check] [--dry-run]
                                                  build the full public server (roles, channels, opt-in panel)
python -m watcher discord-bot [-c watcher.yaml] [--watch] [--auto-approve]
                                                  stay online for opt-in buttons and slash commands
python -m watcher serve [-c watcher.yaml] [--port 8765] [--no-watch]
                                                  HTTP API (+ the poll loop unless --no-watch)
python -m watcher import-schedule [--term "2027 Spring" ...] [--out data/schedule]
                                                  download a term's class times (Berkeleytime) for the planner
python -m watcher lookup "COMPSCI 61A" [--term "2027 Spring"]
                                                  print a course's sections, times and seats as JSON
python -m watcher prod  [-c CONFIG] [--host H] [--port P]
                                                  server mode: poll loop + HTTP API + Discord bot
                                                  (bot only when DISCORD_BOT_TOKEN is set), logs to stdout
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import threading

from watcher.config import Config, load_config
from watcher.sources.base import SourceError, Target


def _cfg(path: str) -> Config:
    try:
        return load_config(path)
    except FileNotFoundError:
        sys.exit(f"config not found: {path} (copy watcher.example.yaml to watcher.yaml)")


def _fmt(s) -> str:
    seats = f"{s.enrolled}/{s.capacity}" if s.capacity is not None else "?"
    wl = f" wl {s.waitlisted}/{s.waitlistCapacity}" if s.waitlisted is not None else ""
    line = f"{s.course:<14} {s.section:<8} #{s.classNumber:<6} open {s.open if s.open is not None else '?':>4}  enrolled {seats}{wl}  {s.instructor}"
    for r in s.reserved:
        line += f"\n{'':24}reserved {r.group}: {r.enrolled}/{r.capacity} ({r.open} open)"
    return line


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="watcher", description="Berkeley seat alert watcher")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("run", "once", "serve"):
        sp = sub.add_parser(name)
        sp.add_argument("-c", "--config", default="watcher.yaml")
        if name == "serve":
            sp.add_argument("--host", default="127.0.0.1")
            sp.add_argument("--port", type=int, default=8765)
            sp.add_argument("--no-watch", action="store_true")
    pr = sub.add_parser("prod", help="server mode: poll loop + HTTP API + Discord bot in one process")
    pr.add_argument("-c", "--config", default=os.environ.get("WATCHER_CONFIG") or "watcher.yaml")
    pr.add_argument("--host", default=os.environ.get("WATCHER_HOST") or "127.0.0.1")
    pr.add_argument("--port", type=int, default=int(os.environ.get("WATCHER_PORT") or 8765))
    pr.add_argument("--token-env", default="DISCORD_BOT_TOKEN")
    ds = sub.add_parser("discord-setup", help="create Discord channels + webhooks for watched classes")
    ds.add_argument("-c", "--config", default="watcher.yaml")
    ds.add_argument("--guild", default="", help="server id (only needed if the bot is in several)")
    ds.add_argument("--token-env", default="DISCORD_BOT_TOKEN")
    ds.add_argument("--dry-run", action="store_true")
    sv = sub.add_parser("discord-server", help="build the full public Discord server")
    sv.add_argument("-c", "--config", default="watcher.yaml")
    sv.add_argument("--guild", default="")
    sv.add_argument("--token-env", default="DISCORD_BOT_TOKEN")
    sv.add_argument("--classes", default="", help='extra courses, comma separated: "COMPSCI 61A,MATH 53"')
    sv.add_argument("--popular", type=int, default=0, metavar="N",
                    help="also add the N most in-demand classes of the term that are not watched yet "
                         "(big classes predicted to fill; each is checked against the live schedule)")
    sv.add_argument("--check", action="store_true", help="only report the bot's permissions")
    sv.add_argument("--dry-run", action="store_true")
    bt = sub.add_parser("discord-bot", help="run the opt-in bot (keep it running)")
    bt.add_argument("-c", "--config", default="watcher.yaml")
    bt.add_argument("--token-env", default="DISCORD_BOT_TOKEN")
    bt.add_argument("--watch", action="store_true", help="also run the seat watcher in this process")
    bt.add_argument("--auto-approve", action="store_true",
                    help="(the default) create requested classes right away when they exist in the schedule")
    bt.add_argument("--require-approval", action="store_true",
                    help="send every request for a new class to staff in #class-requests instead "
                         "(or discord_auto_approve: false in config / DISCORD_AUTO_APPROVE=0)")
    bt.add_argument("--max-classes", type=int, default=None,
                    help="default: discord_max_classes from config (100)")
    im = sub.add_parser("import-schedule", help="download class times for whole terms")
    im.add_argument("--term", action="append", default=[],
                    help='"2027 Spring"; repeat for several. Default: every current or future term with classes')
    im.add_argument("--out", default="data/schedule")
    im.add_argument("--cache", default="", help="folder for raw responses, so an interrupted run resumes")
    im.add_argument("--level", choices=["undergrad", "grad", "all"], default="undergrad")
    im.add_argument("--subjects", default="", help="comma separated subject codes (default: all)")
    im.add_argument("--rps", type=float, default=3.0, help="requests per second (keep it low)")
    lk = sub.add_parser("lookup", help="print one course's sections, times and seats")
    lk.add_argument("course")
    lk.add_argument("--term", default="")
    lk.add_argument("--sources", default="classes.berkeley.edu,berkeleytime")
    ck = sub.add_parser("check")
    ck.add_argument("what", help='course like "COMPSCI 61A" or a class number')
    ck.add_argument("--term", default="")
    ck.add_argument("--section", default="")
    ck.add_argument("--source", default="classes.berkeley.edu")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s" if a.cmd == "prod"
                        else "%(asctime)s %(levelname)s %(message)s",
                        # prod: stdout only, the container collects it; nothing written to the volume
                        stream=sys.stdout if a.cmd == "prod" else None)

    if a.cmd == "prod":
        from watcher import prod
        return prod.run(_cfg(a.config), a.host, a.port, token_env=a.token_env)

    if a.cmd == "import-schedule":
        from pathlib import Path
        from watcher import schedule
        client = schedule.BerkeleytimeClient(per_second=min(max(a.rps, 0.2), 5.0))
        subjects = {x.strip().upper() for x in a.subjects.split(",") if x.strip()} or None
        try:
            terms = a.term or schedule.upcoming_terms(client)
            for term in terms:
                schedule.import_term(term, Path(a.out), cache=Path(a.cache) if a.cache else None,
                                     level=a.level, subjects=subjects, client=client,
                                     progress=lambda msg: print(msg, flush=True))
        except SourceError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        return 0

    if a.cmd == "lookup":
        import json as _json
        from watcher.lookup import LookupService
        svc = LookupService(sources=[x.strip() for x in a.sources.split(",") if x.strip()])
        try:
            print(_json.dumps(svc.lookup(a.course, a.term), indent=1))
        except SourceError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        return 0

    from watcher.runner import Watcher, make_source

    if a.cmd == "check":
        t = Target(term=a.term, section=a.section.upper())
        if a.what.strip().isdigit():
            t.class_number = a.what.strip()
        else:
            t.course = a.what.upper().strip()
        try:
            secs = make_source(a.source).fetch(t)
        except SourceError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        for s in secs:
            print(_fmt(s))
        if not secs:
            print("no matching sections")
        return 0

    if a.cmd == "discord-setup":
        from watcher import discord_setup as dsu
        cfg = _cfg(a.config)
        token = os.environ.get(a.token_env)
        if not token:
            print(f"error: set the {a.token_env} environment variable to your bot token", file=sys.stderr)
            return 1
        if "server" in (dsu.load_routes(cfg.discord_routes_file) or {}):
            print("error: this server was built with discord-server; re-run that instead "
                  "(discord-setup would discard its roles and channels list)", file=sys.stderr)
            return 1
        courses = [t.course for t in cfg.targets if t.course]
        skipped = [t.class_number for t in cfg.targets if not t.course]
        try:
            routes, lines = dsu.setup(courses, token=token, guild_id=a.guild or None, dry_run=a.dry_run)
        except dsu.DiscordSetupError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        for line in lines:
            print(line)
        if skipped:
            print(f"note: class-number-only targets go to #{dsu.DEFAULT_CHANNEL}: {', '.join(skipped)}")
        if a.dry_run:
            print("dry run: nothing was changed")
        else:
            print(f"saved {dsu.write_routes(routes, cfg.discord_routes_file)} (local only, gitignored); "
                  "restart the watcher to use it")
        return 0

    if a.cmd in ("discord-server", "discord-bot"):
        from watcher import discord_server as srv
        from watcher import discord_setup as dsu
        cfg = _cfg(a.config)
        token = os.environ.get(a.token_env)
        if not token:
            print(f"error: set the {a.token_env} environment variable to your bot token", file=sys.stderr)
            return 1
        path = cfg.discord_routes_file
        try:
            if a.cmd == "discord-bot":
                from watcher import discord_bot
                if a.watch:
                    threading.Thread(target=Watcher(cfg).run_forever, daemon=True).start()
                discord_bot.run_bot(token, routes_path=path, sources=cfg.sources, term=cfg.term,
                                    auto_approve=not a.require_approval
                                    and (a.auto_approve or cfg.discord_auto_approve),
                                    max_classes=a.max_classes if a.max_classes is not None
                                    else cfg.discord_max_classes)
                return 0
            routes = dsu.load_routes(path)
            if a.check:
                lines = srv.check(token=token, guild_id=a.guild or None, routes=routes)
            else:
                courses = [t.course for t in cfg.targets if t.course] + a.classes.split(",")
                seeded: list[str] = []
                if a.popular > 0:
                    from watcher.discord_bot import make_verifier
                    have = set((routes or {}).get("courses", {})) | {c.upper().strip() for c in courses}
                    room = max(cfg.discord_max_classes - len(have), 0)
                    if room < a.popular:
                        print(f"note: only room for {room} more (discord_max_classes is {cfg.discord_max_classes})")
                    print(f"checking the live schedule for the top classes of {cfg.term or 'the current term'} ...")
                    picked, seeded = srv.pick_popular(min(a.popular, room), make_verifier(cfg.sources, cfg.term), have)
                    courses += picked
                routes, lines = srv.setup_server(courses, token=token, guild_id=a.guild or None,
                                                 routes=routes, dry_run=a.dry_run)
        except KeyboardInterrupt:
            return 0
        except (dsu.DiscordSetupError, RuntimeError) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        except ImportError:
            print("error: the bot needs one extra package: pip install websocket-client", file=sys.stderr)
            return 1
        for line in (seeded if not a.check else []) + lines:
            print(line)
        if a.dry_run:
            print("dry run: nothing was changed")
        elif not a.check:
            print(f"saved {dsu.write_routes(routes, path)} (local only, gitignored)")
            print("next: keep `python -m watcher discord-bot --watch` running so buttons and commands answer")
        return 0

    w = Watcher(_cfg(a.config))
    if a.cmd == "once":
        for e in w.poll_once():
            print(f"[{e.kind}] {e.message}")
        return 0
    if a.cmd == "run":
        try:
            w.run_forever()
        except KeyboardInterrupt:
            pass
        return 0
    if a.cmd == "serve":
        from watcher.server import serve
        try:
            from watcher.lookup import LookupService
            httpd = serve(w.store, a.host, a.port,
                          token=os.environ.get("WATCHER_API_TOKEN", "").strip() or None,
                          health=None if a.no_watch else w.health,
                          lookup=LookupService(w.cfg.lookup_sources, ttl=w.cfg.lookup_cache_seconds))
        except ValueError as e:
            print(f"error: {e}", file=sys.stderr)
            return 2
        if not a.no_watch:
            threading.Thread(target=w.run_forever, daemon=True).start()
        print(f"serving on http://{a.host}:{a.port}  (GET /seats, POST /subscriptions)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            w.stop()
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
