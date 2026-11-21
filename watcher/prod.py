"""``python -m watcher prod``: everything the server needs, in one process.

- the poll loop (one shared ``Watcher``),
- the HTTP API for the web app (127.0.0.1:8765 by default),
- the Discord bot, only when its token env var is set.

The bot runs in a supervised thread: if it dies (network drop, Discord outage,
bad token, routes file missing) it is logged and restarted with backoff capped at
5 minutes, and the watcher keeps going. If the poll loop or the HTTP server dies
the process exits non-zero so the container restarts. SIGTERM/SIGINT stop
everything cleanly with exit code 0.
"""
from __future__ import annotations

import importlib.util
import logging
import os
import signal
import threading
import time
from typing import Any, Callable

from watcher.config import Config
from watcher.runner import Watcher
from watcher.sources.base import SourceError, Target

log = logging.getLogger("watcher.prod")

BOT_BACKOFF = (5.0, 300.0)   # first retry delay, cap
BOT_HEALTHY_AFTER = 600.0    # a bot run this long resets the backoff


def websocket_available() -> bool:
    return importlib.util.find_spec("websocket") is not None


class ProdApp:
    def __init__(self, cfg: Config, host: str = "127.0.0.1", port: int = 8765, *,
                 watcher: Watcher | None = None, api_token: str | None = None,
                 discord_token: str | None = None, bot_runner: Callable[..., None] | None = None,
                 bot_backoff: tuple[float, float] = BOT_BACKOFF):
        self.cfg = cfg
        self.watcher = watcher or Watcher(cfg)
        from watcher.lookup import LookupService
        from watcher.server import serve
        self.lookup = LookupService(cfg.lookup_sources, ttl=cfg.lookup_cache_seconds)
        # Raises ValueError for a public bind without a token: fail before starting anything.
        self.httpd = serve(self.watcher.store, host, port, token=api_token or None, health=self.watcher.health,
                           lookup=self.lookup)
        self.discord_token = discord_token or None
        self._bot_runner = bot_runner
        self._bot_backoff = bot_backoff
        self._stop = threading.Event()
        self._gateway: Any = None
        self._threads: dict[str, threading.Thread] = {}
        self.bot_starts = 0

    @property
    def address(self) -> tuple[str, int]:
        return self.httpd.server_address[:2]

    # ---- lifecycle ----------------------------------------------------------
    def start(self) -> None:
        self._spawn("poll", self.watcher.run_forever)
        self._spawn("http", self.httpd.serve_forever)
        if self.discord_token:
            if self._bot_runner is None and not websocket_available():
                log.warning("DISCORD bot token is set but the websocket-client package is missing "
                            "(pip install 'calclasscoordinator[prod]'); running without the Discord bot")
            else:
                self._spawn("discord", self._supervise_bot)
        host, port = self.address
        log.info("serving on http://%s:%s (poll loop running%s)", host, port,
                 ", discord bot on" if "discord" in self._threads else "")

    def _spawn(self, name: str, fn: Callable[[], None]) -> None:
        t = threading.Thread(target=fn, name=name, daemon=True)
        self._threads[name] = t
        t.start()

    def stop(self) -> None:
        """Ask everything to stop; ``wait`` then returns 0."""
        self._stop.set()

    def wait(self, poll: float = 1.0) -> int:
        """Block until stopped (0) or until the poll loop or HTTP server dies (1)."""
        code = 0
        while not self._stop.wait(poll):
            dead = [n for n in ("poll", "http") if not self._threads[n].is_alive()]
            if dead:
                log.error("%s thread died unexpectedly; exiting so the container restarts", " and ".join(dead))
                code = 1
                break
        self.shutdown()
        return code

    def shutdown(self) -> None:
        self._stop.set()
        self.watcher.stop()
        gw = self._gateway
        if gw is not None:
            try:
                gw.stop()
            except Exception:
                pass
        if self._threads.get("http") and self._threads["http"].is_alive():
            self.httpd.shutdown()
        self.httpd.server_close()
        t = self._threads.get("poll")
        if t is not None:
            t.join(timeout=10)  # a fetch in flight can take up to the request timeout
        log.info("stopped")

    # ---- Discord ------------------------------------------------------------
    def _verify(self, course: str) -> tuple[str, str]:
        """Bot's schedule check, through the shared Watcher (request gap, cool-downs)."""
        try:
            secs = self.watcher.fetch(Target(course=course, term=self.cfg.term))
        except SourceError:
            return ("unknown", "")
        return ("ok", secs[0].title) if secs else ("missing", "")

    def _on_gateway(self, gw: Any) -> None:
        self._gateway = gw
        if self._stop.is_set():
            gw.stop()

    def _supervise_bot(self) -> None:
        runner = self._bot_runner
        if runner is None:
            from watcher.discord_bot import run_bot as runner
        first, cap = self._bot_backoff
        delay = first
        while not self._stop.is_set():
            started = time.monotonic()
            self.bot_starts += 1
            try:
                runner(self.discord_token, routes_path=self.cfg.discord_routes_file, sources=self.cfg.sources,
                       term=self.cfg.term, auto_approve=self.cfg.discord_auto_approve,
                       max_classes=self.cfg.discord_max_classes, verify=self._verify,
                       on_gateway=self._on_gateway)
                if self._stop.is_set():
                    return
                log.warning("discord bot stopped; restarting")
            except Exception as e:  # bad token, routes missing, network: keep the watcher alive
                log.error("discord bot failed: %s: %s", type(e).__name__, e)
            finally:
                self._gateway = None
            if time.monotonic() - started > BOT_HEALTHY_AFTER:
                delay = first
            log.info("restarting the discord bot in %.0fs", delay)
            if self._stop.wait(delay):
                return
            delay = min(delay * 2, cap)


def install_signal_handlers(app: ProdApp) -> None:
    def handler(signum, _frame):
        log.info("got signal %s; shutting down", signum)
        app.stop()
    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def run(cfg: Config, host: str, port: int, *, token_env: str = "DISCORD_BOT_TOKEN") -> int:
    try:
        app = ProdApp(cfg, host, port, api_token=os.environ.get("WATCHER_API_TOKEN", "").strip() or None,
                      discord_token=os.environ.get(token_env, "").strip() or None)
    except ValueError as e:  # public bind without a token
        log.error("%s", e)
        return 2
    except OSError as e:  # port in use, bad host
        log.error("cannot listen on %s:%s: %s", host, port, e)
        return 2
    install_signal_handlers(app)
    app.start()
    return app.wait()
