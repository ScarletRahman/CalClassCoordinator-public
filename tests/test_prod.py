"""Offline tests for server mode: polite scraping at scale, subscriber emails,
API auth, state on the volume, and the `prod` process wiring."""
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from watcher import discord_setup as ds
from watcher.config import Config, load_config, smtp_from_env
from watcher.models import ReservedSeat, Section
from watcher.notify.smtp_email import EmailNotifier
from watcher.prod import ProdApp
from watcher.runner import Watcher
from watcher.server import serve
from watcher.sources.base import SourceError, Target
from watcher.store import Store

ROOT = Path(__file__).resolve().parent.parent


def sec(open_=0, cn="28984", course="COMPSCI 61A", section="001 LEC", reserved=()):
    return Section(course=course, classNumber=cn, section=section, term="2026 Spring",
                   enrolled=100 - open_, capacity=100, waitlisted=0, waitlistCapacity=50,
                   open=open_, reserved=[ReservedSeat(*r) for r in reserved])


class Clock:
    def __init__(self):
        self.t = 1000.0
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


class Src:
    """Answers from a function of the target; records every call with the clock time."""

    def __init__(self, answer, name="fake", clock=None):
        self.answer, self.name, self.clock = answer, name, clock
        self.calls = []

    def fetch(self, target):
        self.calls.append((target, self.clock() if self.clock else None))
        r = self.answer(target)
        if isinstance(r, Exception):
            raise r
        return r


class Collect:
    def __init__(self, conf=None):
        self.conf, self.events, self.footer = conf, [], ""

    def send(self, e):
        self.events.append(e)


class Factory:
    """notifier_factory that keeps one Collect per subscriber email (global under '')."""

    def __init__(self):
        self.by = {}
        self.builds = 0

    def __call__(self, conf):
        self.builds += 1
        key = conf[0].get("to", "") if conf else ""
        c = self.by.setdefault(key, Collect(conf))
        return [c]

    def kinds(self, key):
        return [e.kind for e in self.by[key].events] if key in self.by else []


def watcher(tmp_path, answer, *, targets=(), subs=(), clock=None, sources=None, **cfg):
    st = Store(tmp_path / "data")
    for s in subs:
        st.add_subscription(s)
    f = Factory()
    clock = clock or Clock()
    src = sources or [Src(answer, clock=clock)]
    cfg.setdefault("subscription_email", {"type": "email", "host": "h"})
    cfg.setdefault("watch_discord_classes", False)
    w = Watcher(Config(targets=list(targets), **cfg), store=st, sources=src, notifier_factory=f,
                clock=clock, sleep=clock.sleep)
    return w, f, src, clock


# ---- dedupe + fan-out ------------------------------------------------------------
def test_many_subscribers_one_fetch_each_gets_one_email(tmp_path):
    subs = [{"email": f"u{i}@x.edu", "classNumber": "28984"} for i in range(50)]
    w, f, (src,), _ = watcher(tmp_path, lambda t: [sec(3)], subs=subs)
    w.poll_once()
    assert len(src.calls) == 1
    for i in range(50):
        assert f.kinds(f"u{i}@x.edu") == ["seats_opened"]
    assert f.kinds("") == []          # nobody global is interested in this class
    assert f.builds == 51             # global + one notifier per subscriber, reused next pass
    w.poll_once()
    assert f.builds == 51


def test_include_reserved_respected_per_subscriber(tmp_path):
    subs = [{"email": "yes@x.edu", "classNumber": "28984"},
            {"email": "no@x.edu", "classNumber": "28984", "includeReserved": False}]
    answers = iter([[sec(0, reserved=[("Majors", 10, 10)])], [sec(0, reserved=[("Majors", 8, 10)])]])
    w, f, (src,), _ = watcher(tmp_path, lambda t: next(answers), subs=subs)
    w.poll_once()
    w.poll_once()
    assert len(src.calls) == 2
    assert f.kinds("yes@x.edu") == ["reserved_opened"]
    assert f.kinds("no@x.edu") == []


def test_global_and_subscriber_share_fetch_and_global_gets_it_once(tmp_path):
    subs = [{"email": "a@x.edu", "classNumber": "28984"}]
    w, f, (src,), _ = watcher(tmp_path, lambda t: [sec(2)], subs=subs,
                              targets=[Target(class_number="28984"), Target(class_number="28984")])
    w.poll_once()
    assert len(src.calls) == 1
    assert f.kinds("") == ["seats_opened"] and f.kinds("a@x.edu") == ["seats_opened"]


def test_class_number_reuses_whole_course_fetch(tmp_path):
    both = [sec(0), sec(1, cn="28985", section="002 LEC")]

    def answer(t):
        return [s for s in both if not t.class_number or s.classNumber == t.class_number]
    subs = [{"email": "a@x.edu", "classNumber": "28985"}, {"email": "b@x.edu", "classNumber": "28984"}]
    w, f, (src,), _ = watcher(tmp_path, answer, subs=subs, targets=[Target(course="COMPSCI 61A")])
    w.poll_once()   # first pass: class numbers are not known to belong to COMPSCI 61A yet
    first = len(src.calls)
    assert first == 3
    assert f.kinds("a@x.edu") == ["seats_opened"]     # 28985 had 1 open seat on first sight
    assert f.kinds("") == ["seats_opened"]            # global got it once, not twice
    both[0] = sec(5)
    w.poll_once()
    assert len(src.calls) - first == 1                # only the course was fetched
    assert src.calls[-1][0].course == "COMPSCI 61A" and not src.calls[-1][0].class_number
    assert f.kinds("b@x.edu") == ["seats_opened"]     # 28984 opened, seen through the course fetch
    assert f.kinds("a@x.edu") == ["seats_opened"]


def test_class_number_not_in_course_falls_back_to_own_fetch(tmp_path):
    calls = []

    def answer(t):
        calls.append(t)
        return [sec(0)] if t.class_number else [sec(0, cn="11111")]
    w, f, (src,), _ = watcher(tmp_path, answer, subs=[{"email": "a@x.edu", "classNumber": "28984"}],
                              targets=[Target(course="COMPSCI 61A")])
    w.poll_once()
    w.poll_once()
    # every pass: the course, plus the class number on its own because it isn't in the course result
    assert [bool(t.class_number) for t in calls[-2:]] == [False, True]


# ---- request gap, max_targets, backoff, cool-down ---------------------------------
def test_min_gap_between_requests(tmp_path):
    clock = Clock()
    w, _, (src,), _ = watcher(tmp_path, lambda t: [], clock=clock, min_request_gap_seconds=2.0,
                              targets=[Target(course=f"MATH {n}") for n in (1, 53, 54, 110)])
    w.poll_once()
    times = [at for _, at in src.calls]
    assert len(times) == 4
    assert all(b - a >= 2.0 for a, b in zip(times, times[1:]))
    assert sum(clock.sleeps) >= 3 * 2.0
    w.poll_once()                       # the gap holds across passes too
    assert src.calls[4][1] - times[-1] >= 2.0


def test_max_targets_rotates_fairly(tmp_path, caplog):
    targets = [Target(course=f"MATH {n}") for n in range(1, 8)]   # 7 distinct
    w, _, (src,), _ = watcher(tmp_path, lambda t: [], targets=targets, max_targets=3)
    with caplog.at_level(logging.WARNING, logger="watcher"):
        for _ in range(7):
            w.poll_once()
    assert all(len(src.calls[i * 3:(i + 1) * 3]) == 3 for i in range(7))
    counts = {}
    for t, _ in src.calls:
        counts[t.course] = counts.get(t.course, 0) + 1
    assert set(counts) == {t.course for t in targets}
    assert set(counts.values()) == {3}                 # 21 fetches / 7 targets
    assert sum("exceed max_targets" in r.message for r in caplog.records) == 7   # once per pass


def test_failing_target_backs_off_and_error_goes_to_global_only(tmp_path):
    w, f, (src,), _ = watcher(tmp_path, lambda t: SourceError("boom"),
                              subs=[{"email": "a@x.edu", "classNumber": "28984"}], interval_seconds=60)
    attempts = []
    for p in range(1, 40):
        n = len(src.calls)
        w.poll_once()
        if len(src.calls) > n:
            attempts.append(p)
    # failure 1 -> skip 2 passes, 2 -> skip 4, 3 -> skip 8, 4 -> skip 16
    assert attempts[:4] == [1, 4, 9, 18]
    assert f.kinds("") == ["error"]
    assert f.kinds("a@x.edu") == []


def test_backoff_capped_at_30_minutes(tmp_path):
    w, *_ = watcher(tmp_path, lambda t: [], interval_seconds=300)
    assert w._backoff_passes(1) == 2 and w._backoff_passes(10) == 6   # 6 x 300s = 30 min


def test_cooldown_after_429_pauses_source(tmp_path, caplog):
    clock = Clock()
    answers = iter([SourceError("slow down", status=429)] + [[sec(0)]] * 10)
    w, f, (src,), _ = watcher(tmp_path, lambda t: next(answers), clock=clock, cooldown_seconds=600,
                              targets=[Target(class_number="28984"), Target(course="MATH 1")])
    with caplog.at_level(logging.WARNING, logger="watcher"):
        w.poll_once()
    assert len(src.calls) == 1                      # the 2nd target was not tried during the pause
    assert any("pausing" in r.message and "429" in r.message for r in caplog.records)
    clock.t += 300
    w.poll_once()
    assert len(src.calls) == 1
    assert w._errors == {}                          # a paused source is not the target's fault
    clock.t += 301
    w.poll_once()
    assert len(src.calls) == 3


def test_cooldown_on_first_source_uses_fallback(tmp_path):
    clock = Clock()
    a = Src(lambda t: SourceError("no", status=403), name="a", clock=clock)
    b = Src(lambda t: [sec(1)], name="b", clock=clock)
    w, f, _, _ = watcher(tmp_path, None, clock=clock, sources=[a, b], targets=[Target(class_number="28984")])
    w.poll_once()
    w.poll_once()
    assert len(a.calls) == 1 and len(b.calls) == 2


def test_source_errors_carry_http_status():
    from watcher.sources.classes_berkeley import ClassesBerkeleySource

    class Resp:
        status_code, text = 429, ""

    class Sess:
        headers = {}

        def get(self, url, timeout):
            assert timeout
            return Resp()
    s = ClassesBerkeleySource(session=Sess(), sleep=lambda x: None)
    with pytest.raises(SourceError) as e:
        s._get("/x")
    assert e.value.status == 429
    assert "CalClassCoordinator" in Sess.headers["User-Agent"]


# ---- subscriber emails -------------------------------------------------------------
def test_subscriber_cooldown(tmp_path):
    clock = Clock()
    seq = iter([[sec(2)], [sec(0)], [sec(3)], [sec(0)], [sec(4)]])
    w, f, _, _ = watcher(tmp_path, lambda t: next(seq), clock=clock, subscriber_cooldown_seconds=600,
                         subs=[{"email": "a@x.edu", "classNumber": "28984"}])
    w.poll_once()                    # opened -> email
    clock.t += 60
    w.poll_once()                    # closed
    clock.t += 60
    w.poll_once()                    # opened again within 10 min -> no email
    assert f.kinds("a@x.edu") == ["seats_opened"]
    clock.t += 600
    w.poll_once()
    w.poll_once()                    # opened again after the cool-down -> email
    assert f.kinds("a@x.edu") == ["seats_opened", "seats_opened"]


def test_one_email_per_class_per_pass(tmp_path):
    seq = iter([[sec(0, reserved=[("M", 5, 5)])], [sec(2, reserved=[("M", 3, 5)])]])
    w, f, _, _ = watcher(tmp_path, lambda t: next(seq), subs=[{"email": "a@x.edu", "classNumber": "28984"}],
                         targets=[Target(class_number="28984")])
    w.poll_once()
    w.poll_once()
    assert f.kinds("") == ["seats_opened", "reserved_opened"]
    assert f.kinds("a@x.edu") == ["seats_opened"]


def test_smtp_from_env_and_footer(tmp_path, monkeypatch):
    env = {"SMTP_HOST": "smtp.example.com", "SMTP_USER": "bot@example.com", "MAIL_FROM": "Alerts <a@example.com>"}
    assert smtp_from_env(env) == {"type": "email", "host": "smtp.example.com", "port": 587,
                                  "user": "bot@example.com", "password_env": "SMTP_PASSWORD",
                                  "from": "Alerts <a@example.com>"}
    assert smtp_from_env({"SMTP_HOST": "h", "SMTP_PORT": "465", "MAIL_FROM": "a@b.co"})["port"] == 465
    assert smtp_from_env({}) is None and smtp_from_env({"SMTP_HOST": "h"}) is None
    for k, v in {**env, "SMTP_PORT": "2525", "APP_URL": "https://cal.example.com/alerts"}.items():
        monkeypatch.setenv(k, v)
    p = tmp_path / "w.yaml"
    p.write_text("watch: []\n")
    cfg = load_config(p)
    assert cfg.subscription_email["port"] == 2525
    p.write_text("subscription_email: {type: email, host: yaml-host, from: x@y.zz}\n")
    assert load_config(p).subscription_email["host"] == "yaml-host"      # YAML wins when present

    # A real EmailNotifier built for a subscriber ends with the manage line.
    from watcher.notify import build_notifiers
    st = Store(tmp_path / "d")
    st.add_subscription({"email": "A@X.edu ", "classNumber": "28984"})
    w = Watcher(Config(subscription_email=cfg.subscription_email, notifiers=[], watch_discord_classes=False),
                store=st, sources=[Src(lambda t: [sec(1)])], notifier_factory=build_notifiers)
    sent = []
    n = w._subscriber_notifiers([{**cfg.subscription_email, "to": "a@x.edu"}])[0]
    assert isinstance(n, EmailNotifier)
    monkeypatch.setattr(EmailNotifier, "send", lambda self, e: sent.append(self.build_message(e)))
    w.poll_once()
    assert len(sent) == 1 and sent[0]["To"] == "a@x.edu"
    body = sent[0].get_content().rstrip()
    assert body.endswith("Manage or stop alerts: https://cal.example.com/alerts")


# ---- store ---------------------------------------------------------------------------
def test_history_rotation(tmp_path):
    from watcher.models import ChangeEvent
    st = Store(tmp_path, history_max_bytes=2000)
    ev = ChangeEvent("seats_opened", sec(1), None, "m")
    for _ in range(20):
        st.append_events([ev])
    cur, old = tmp_path / "history.jsonl", tmp_path / "history.jsonl.1"
    assert old.exists() and cur.exists()
    assert cur.stat().st_size < 2000 + 2000 and old.stat().st_size >= 2000
    assert not (tmp_path / "history.jsonl.2").exists()


def test_emails_normalized_in_store(tmp_path):
    st = Store(tmp_path)
    st.add_subscription({"email": " Ann@X.EDU", "classNumber": "1"})
    st.add_subscription({"email": "ann@x.edu", "classNumber": "1"})
    assert [s["email"] for s in st.load_subscriptions()] == ["ann@x.edu"]
    assert st.remove_subscription("ANN@x.edu ", "1")


# ---- routes file on the volume --------------------------------------------------------
def test_routes_file_resolved_under_data_dir(tmp_path, monkeypatch):
    vol = tmp_path / "vol"
    monkeypatch.setenv("WATCHER_DATA_DIR", str(vol))
    p = tmp_path / "w.yaml"
    p.write_text("watch: []\n")
    cfg = load_config(p)
    assert Path(cfg.discord_routes_file) == vol / "discord_channels.json"
    written = ds.write_routes({"courses": {"MATH 53": "u"}}, "discord_channels.json")
    assert written == vol / "discord_channels.json"
    assert ds.load_routes("discord_channels.json") == {"courses": {"MATH 53": "u"}}
    assert ds.watched_courses() == ["MATH 53"]
    assert ds.resolve_routes_path(tmp_path / "abs.json") == tmp_path / "abs.json"   # absolute kept
    w = Watcher(cfg, store=Store(tmp_path / "s"), sources=[], notifier_factory=lambda c: [])
    assert [t.course for t, _ in w.all_targets()] == ["MATH 53"]


def test_routes_file_in_cwd_without_data_dir(tmp_path, monkeypatch):
    monkeypatch.delenv("WATCHER_DATA_DIR", raising=False)
    assert ds.resolve_routes_path("discord_channels.json") == Path("discord_channels.json")
    p = tmp_path / "w.yaml"
    p.write_text("watch: []\n")
    assert load_config(p).discord_routes_file == "discord_channels.json"


def test_prod_yaml_and_env_overrides(monkeypatch):
    monkeypatch.setenv("DISCORD_AUTO_APPROVE", "1")
    monkeypatch.setenv("DISCORD_MAX_CLASSES", "40")
    cfg = load_config(ROOT / "deploy" / "watcher.prod.yaml")
    assert cfg.term == "" and cfg.interval_seconds == 60 and cfg.targets == []
    assert cfg.sources == ["berkeleytime", "classes.berkeley.edu"]
    assert cfg.notifiers == [{"type": "console"}, {"type": "discord"}]
    assert cfg.min_request_gap_seconds == 2.0 and cfg.max_targets == 300
    assert cfg.cooldown_seconds == 600 and cfg.subscriber_cooldown_seconds == 600
    assert cfg.discord_auto_approve is True and cfg.discord_max_classes == 40
    load_config(ROOT / "watcher.example.yaml")


# ---- HTTP API -------------------------------------------------------------------------
def call(url, method="GET", body=None, token=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read() or b"null"), dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null"), dict(e.headers)


@pytest.fixture
def authed(tmp_path):
    st = Store(tmp_path)
    httpd = serve(st, "127.0.0.1", 0, token="s3cret")
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield st, f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def test_api_bearer_auth_on_every_verb(authed):
    st, base = authed
    sub = {"email": "a@b.co", "classNumber": "1"}
    cases = [("GET", "/seats", None), ("GET", "/seats/1", None), ("GET", "/subscriptions?email=a@b.co", None),
             ("POST", "/subscriptions", sub), ("DELETE", "/subscriptions", sub), ("OPTIONS", "/seats", None)]
    for method, path, body in cases:
        for bad in (None, "wrong", "s3cret-plus"):
            assert call(base + path, method, body, token=bad)[0] == 401, (method, path, bad)
    assert call(base + "/seats", token="s3cret")[0] == 200
    assert call(base + "/subscriptions", "POST", sub, token="s3cret")[0] == 201
    assert call(base + "/subscriptions?email=a@b.co", token="s3cret")[0] == 200
    assert call(base + "/subscriptions", "DELETE", sub, token="s3cret")[0] == 200
    code, body, _ = call(base + "/health")
    assert code == 200 and body["ok"] is True


def test_api_no_cors_headers_by_default(authed):
    _, base = authed
    _, _, headers = call(base + "/seats", token="s3cret")
    assert not any(h.lower().startswith("access-control") for h in headers)


def test_api_validation_and_email_normalizing(authed):
    st, base = authed
    t = "s3cret"
    assert call(base + "/subscriptions", "POST", raw=b"{not json", token=t)[0] == 400
    assert call(base + "/subscriptions", "POST", raw=b"[1,2]", token=t)[0] == 400
    assert call(base + "/subscriptions", "POST", raw=b"\xff\xfe", token=t)[0] == 400
    assert call(base + "/subscriptions", "POST", {"email": "a@b.co", "classNumber": "12345678901"}, token=t)[0] == 400
    assert call(base + "/subscriptions", "POST", {"email": "a@b.co", "classNumber": "12a"}, token=t)[0] == 400
    long_email = "a" * 250 + "@b.co"
    assert call(base + "/subscriptions", "POST", {"email": long_email, "classNumber": "1"}, token=t)[0] == 400
    assert call(base + "/subscriptions", "POST", raw=b"x" * 10_001, token=t)[0] == 400
    code, sub, _ = call(base + "/subscriptions", "POST", {"email": " Ann@Example.COM ", "classNumber": " 28984"},
                        token=t)
    assert code == 201 and sub["email"] == "ann@example.com" and sub["classNumber"] == "28984"
    assert len(call(base + "/subscriptions?email=ANN@example.com", token=t)[1]) == 1
    assert call(base + "/subscriptions", "DELETE", {"email": "ann@EXAMPLE.com", "classNumber": "28984"},
                token=t)[0] == 200
    assert st.load_subscriptions() == []


def test_refuses_public_bind_without_token(tmp_path):
    with pytest.raises(ValueError, match="WATCHER_API_TOKEN"):
        serve(Store(tmp_path), "0.0.0.0", 0)
    httpd = serve(Store(tmp_path), "0.0.0.0", 0, token="t")
    httpd.server_close()
    serve(Store(tmp_path), "localhost", 0).server_close()


def test_health_goes_503_when_poll_loop_stalls(tmp_path):
    clock = Clock()
    w, *_ = watcher(tmp_path, lambda t: [], clock=clock, interval_seconds=60)
    httpd = serve(w.store, "127.0.0.1", 0, health=w.health)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    try:
        code, body, _ = call(base + "/health")
        assert code == 200 and body == {"ok": True, "lastPollAt": None, "lastPollOk": None, "targets": 0}
        clock.t += 601                       # startup grace (10 min) passed without a pass
        assert call(base + "/health")[0] == 503
        w.poll_once()
        code, body, _ = call(base + "/health")
        assert code == 200 and body["lastPollOk"] is True and body["lastPollAt"]
        clock.t += 599
        assert call(base + "/health")[0] == 200
        clock.t += 2
        assert call(base + "/health")[0] == 503
    finally:
        httpd.shutdown()
        httpd.server_close()


# ---- prod wiring -----------------------------------------------------------------------
def prod_app(tmp_path, **kw):
    cfg = Config(targets=[Target(class_number="28984")], notifiers=[], watch_discord_classes=False,
                 discord_routes_file=str(tmp_path / "routes.json"))
    w = Watcher(cfg, store=Store(tmp_path / "data"), sources=[Src(lambda t: [sec(2)])],
                notifier_factory=lambda c: [])
    return ProdApp(cfg, "127.0.0.1", 0, watcher=w, **kw)


def wait_for(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_prod_serves_and_stops_cleanly(tmp_path):
    app = prod_app(tmp_path, api_token="tok")
    app.start()
    result = {}
    t = threading.Thread(target=lambda: result.setdefault("code", app.wait(poll=0.05)))
    t.start()
    base = "http://127.0.0.1:%d" % app.address[1]
    assert wait_for(lambda: app.watcher.last_poll_at is not None)
    code, body, _ = call(base + "/health")
    assert code == 200 and body["ok"] and body["lastPollOk"] and body["targets"] == 1
    assert call(base + "/seats")[0] == 401
    code, snap, _ = call(base + "/seats", token="tok")
    assert code == 200 and snap["sections"][0]["classNumber"] == "28984"
    assert "discord" not in app._threads
    app.stop()
    t.join(5)
    assert result["code"] == 0
    assert not app._threads["poll"].is_alive()
    with pytest.raises(OSError):
        urllib.request.urlopen(base + "/health", timeout=1)


def test_prod_exits_nonzero_when_poll_loop_dies(tmp_path):
    app = prod_app(tmp_path)

    app.watcher.run_forever = lambda: None   # the loop thread ends unexpectedly
    app.start()
    assert app.wait(poll=0.05) == 1


def test_prod_bot_supervisor_retries_without_killing_watcher(tmp_path, caplog):
    calls = []
    release = threading.Event()

    def bot(token, **kw):
        calls.append(kw)
        if len(calls) < 3:
            raise RuntimeError("Discord rejected the bot token")
        class GW:
            def stop(self):
                release.set()
        kw["on_gateway"](GW())
        release.wait(5)

    app = prod_app(tmp_path, discord_token="t", bot_runner=bot, bot_backoff=(0.01, 0.05))
    with caplog.at_level(logging.ERROR, logger="watcher.prod"):
        app.start()
        assert wait_for(lambda: len(calls) == 3)
    assert app._threads["poll"].is_alive() and app._threads["http"].is_alive()
    assert calls[0]["routes_path"] == str(tmp_path / "routes.json")
    assert calls[0]["max_classes"] == 100 and calls[0]["auto_approve"] is True
    assert sum("discord bot failed" in r.message for r in caplog.records) == 2
    # the bot's schedule check goes through the shared watcher
    assert calls[0]["verify"]("COMPSCI 61A") == ("ok", "")
    app.stop()
    assert app.wait(poll=0.05) == 0
    assert release.is_set()


def test_prod_without_websocket_package_runs_without_bot(tmp_path, monkeypatch, caplog):
    import watcher.prod as prod
    monkeypatch.setattr(prod, "websocket_available", lambda: False)
    app = prod_app(tmp_path, discord_token="t")
    with caplog.at_level(logging.WARNING, logger="watcher.prod"):
        app.start()
    assert "discord" not in app._threads
    assert any("websocket-client" in r.message for r in caplog.records)
    app.stop()
    assert app.wait(poll=0.05) == 0


def test_prod_refuses_public_bind_without_token(tmp_path):
    with pytest.raises(ValueError):
        ProdApp(Config(notifiers=[]), "0.0.0.0", 0, watcher=Watcher(
            Config(notifiers=[]), store=Store(tmp_path), sources=[], notifier_factory=lambda c: []))


def test_prod_command_sigterm(tmp_path):
    """The real entry point: `python -m watcher prod` with the committed config, no
    targets (so nothing is fetched), port 0; SIGTERM must exit 0."""
    env = {k: v for k, v in os.environ.items()
           if k not in ("DISCORD_BOT_TOKEN", "WATCHER_API_TOKEN", "SMTP_HOST", "WATCHER_HOST")}
    env.update(WATCHER_DATA_DIR=str(tmp_path / "vol"), WATCHER_CONFIG=str(ROOT / "deploy" / "watcher.prod.yaml"),
               WATCHER_PORT="0", PYTHONUNBUFFERED="1")
    p = subprocess.Popen([sys.executable, "-m", "watcher", "prod"], cwd=tmp_path, env={**env, "PYTHONPATH": str(ROOT)},
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        port = None
        lines = []
        end = time.monotonic() + 20
        while time.monotonic() < end and port is None:
            line = p.stdout.readline()
            if not line:
                break
            lines.append(line)
            if "serving on http://" in line:
                port = int(line.split("serving on http://", 1)[1].split()[0].rsplit(":", 1)[1])
        assert port, "".join(lines)
        assert wait_for(lambda: call(f"http://127.0.0.1:{port}/health")[0] == 200, 10)
        assert call(f"http://127.0.0.1:{port}/seats")[0] == 200     # no token set: loopback is open
        p.send_signal(signal.SIGTERM)
        out, _ = p.communicate(timeout=20)
        assert p.returncode == 0, "".join(lines) + out
        assert "stopped" in out
        assert (tmp_path / "vol" / "latest.json").exists()
    finally:
        if p.poll() is None:
            p.kill()


# ---- course hint on subscriptions (Berkeleytime cannot look up by class number alone) ------
def test_subscription_course_reaches_the_source(tmp_path):
    subs = [{"email": "u@x.edu", "classNumber": "28984", "course": "COMPSCI 61A"}]
    w, f, (src,), _ = watcher(tmp_path, lambda t: [sec(3)], subs=subs)
    w.poll_once()
    assert len(src.calls) == 1
    t = src.calls[0][0]
    assert t.course == "COMPSCI 61A" and t.class_number == "28984"
    assert f.kinds("u@x.edu") == ["seats_opened"]


def test_api_stores_course_hint_and_drops_a_malformed_one(authed):
    st, base = authed
    t = "s3cret"
    code, sub, _ = call(base + "/subscriptions", "POST",
                        {"email": "a@b.co", "classNumber": "28984", "course": " compsci  61a "}, token=t)
    assert code == 201 and sub["course"] == "COMPSCI 61A"
    code, sub, _ = call(base + "/subscriptions", "POST",
                        {"email": "b@b.co", "classNumber": "28985", "course": "<script>"}, token=t)
    assert code == 201 and "course" not in sub
