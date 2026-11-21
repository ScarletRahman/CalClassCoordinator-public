"""Offline tests for the diff engine, store, runner and HTTP API."""
import json
import threading
import urllib.request

import pytest

from watcher.config import Config, load_config
from watcher.diff import diff_section
from watcher.models import ReservedSeat, Section
from watcher.runner import Watcher
from watcher.server import serve
from watcher.sources.base import SourceError, Target
from watcher.store import Store


def sec(open_=0, enrolled=100, cap=100, wl=0, wlcap=50, reserved=(), cn="28984"):
    return Section(course="COMPSCI 61A", classNumber=cn, section="001 LEC", term="2026 Spring",
                   enrolled=enrolled, capacity=cap, waitlisted=wl, waitlistCapacity=wlcap,
                   open=open_, reserved=[ReservedSeat(*r) for r in reserved])


def kinds(evs):
    return [e.kind for e in evs]


def test_new_section():
    assert kinds(diff_section(None, sec())) == ["new_section"]


def test_seats_opened_increased_closed():
    assert kinds(diff_section(sec(0), sec(3))) == ["seats_opened"]
    assert kinds(diff_section(sec(3), sec(5))) == ["seats_increased"]
    assert kinds(diff_section(sec(3), sec(0))) == ["closed"]
    assert diff_section(sec(3), sec(3)) == []
    assert diff_section(sec(5), sec(2)) == []


def test_reserved_opened_and_flag():
    b = sec(reserved=[("CS Majors", 50, 50), ("EECS", 10, 20)])
    a = sec(reserved=[("CS Majors", 48, 50), ("EECS", 9, 20)])
    evs = diff_section(b, a)
    assert kinds(evs) == ["reserved_opened"]
    assert "2 reserved seat(s) open for CS Majors" in evs[0].message
    assert diff_section(b, a, include_reserved=False) == []


def test_new_reserved_group_with_seats():
    assert kinds(diff_section(sec(), sec(reserved=[("Transfers", 0, 5)]))) == ["reserved_opened"]


def test_waitlist():
    assert kinds(diff_section(sec(wl=50), sec(wl=49))) == ["waitlist_opened"]
    assert kinds(diff_section(sec(wl=20), sec(wl=18))) == ["waitlist_moved"]
    assert diff_section(sec(wl=20), sec(wl=18), include_waitlist=False) == []
    assert diff_section(sec(wl=None), sec(wl=5)) == []
    # a waitlist that didn't exist (0/0) and now does
    assert kinds(diff_section(sec(wl=0, wlcap=0), sec(wl=0, wlcap=50))) == ["waitlist_opened"]
    assert diff_section(sec(wl=0, wlcap=0), sec(wl=0, wlcap=0)) == []


def test_store_roundtrip(tmp_path):
    st = Store(tmp_path)
    s = sec(2, reserved=[("CS Majors", 1, 5)])
    st.save_latest({s.key: s})
    data = json.loads((tmp_path / "latest.json").read_text())
    assert set(data) == {"updatedAt", "term", "sections"}
    assert data["term"] == "2026 Spring"
    row = data["sections"][0]
    for k in ("course", "classNumber", "section", "instructor", "enrolled", "capacity",
              "waitlisted", "waitlistCapacity", "open", "reserved"):
        assert k in row
    assert row["reserved"] == [{"group": "CS Majors", "enrolled": 1, "capacity": 5}]
    assert st.load_latest()[s.key].reserved[0].open == 4


def test_subscriptions_dedupe(tmp_path):
    st = Store(tmp_path)
    st.add_subscription({"email": "a@b.co", "classNumber": 1})
    st.add_subscription({"email": "a@b.co", "classNumber": "1", "includeReserved": False})
    assert len(st.load_subscriptions()) == 1
    assert st.remove_subscription("a@b.co", "1")
    assert not st.remove_subscription("a@b.co", "1")


class FakeSource:
    name = "fake"

    def __init__(self, seq):
        self.seq = list(seq)

    def fetch(self, target):
        item = self.seq.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class Collect:
    name = "collect"

    def __init__(self):
        self.events = []

    def send(self, e):
        self.events.append(e)


def make(tmp_path, seq, **cfg):
    c = Collect()
    w = Watcher(Config(targets=[Target(class_number="28984")], **cfg), store=Store(tmp_path),
                sources=[FakeSource(seq)], notifier_factory=lambda conf: [c])
    return w, c


def test_runner_alerts_on_open(tmp_path):
    w, c = make(tmp_path, [[sec(0)], [sec(0)], [sec(2)], [sec(2)]])
    w.poll_once()
    w.poll_once()
    assert c.events == []          # new_section isn't in the default alert_on
    w.poll_once()
    assert kinds(c.events) == ["seats_opened"]
    w.poll_once()
    assert len(c.events) == 1      # no repeat alert while unchanged
    assert (tmp_path / "history.jsonl").read_text().count("\n") == 2


def test_runner_first_sight_with_seats_alerts(tmp_path):
    w, c = make(tmp_path, [[sec(4)]])
    w.poll_once()
    assert kinds(c.events) == ["seats_opened"]


def test_runner_state_survives_restart(tmp_path):
    w, _ = make(tmp_path, [[sec(0)]])
    w.poll_once()
    w2, c2 = make(tmp_path, [[sec(1)]])
    w2.poll_once()
    assert kinds(c2.events) == ["seats_opened"]


def test_runner_error_alert_after_three_failures(tmp_path):
    err = SourceError("boom")
    src = FakeSource([err, err, err, err, [sec(0)]])
    c = Collect()
    w = Watcher(Config(targets=[Target(class_number="28984")]), store=Store(tmp_path),
                sources=[src], notifier_factory=lambda conf: [c])
    # A failing target backs off (skipped for 2, 4, 8... passes), so drive passes
    # until the fake source has answered all five times.
    for _ in range(60):
        w.poll_once()
        if not src.seq:
            break
    assert not src.seq
    assert kinds(c.events) == ["error"]   # exactly once, after the 3rd failure
    assert w._errors == {}


def test_runner_falls_back_to_second_source(tmp_path):
    c = Collect()
    w = Watcher(Config(targets=[Target(class_number="28984")]), store=Store(tmp_path),
                sources=[FakeSource([SourceError("down")]), FakeSource([[sec(1)]])],
                notifier_factory=lambda conf: [c])
    w.poll_once()
    assert kinds(c.events) == ["seats_opened"]


def test_runner_filters_other_sections(tmp_path):
    w, _ = make(tmp_path, [[sec(1), sec(9, cn="99999")]])
    w.poll_once()
    assert list(w.state) == ["2026 Spring|28984"]


def test_subscription_becomes_target_with_email(tmp_path):
    st = Store(tmp_path)
    st.add_subscription({"email": "x@y.zz", "classNumber": "28984"})
    built = []

    def factory(conf):
        built.append(conf)
        return [Collect()]

    w = Watcher(Config(subscription_email={"type": "email", "host": "h"}), store=st,
                sources=[FakeSource([[sec(3)]])], notifier_factory=factory)
    w.poll_once()
    assert built[-1] == [{"type": "email", "host": "h", "to": "x@y.zz"}]


def test_config(tmp_path):
    p = tmp_path / "w.yaml"
    p.write_text('term: "2026 Spring"\ninterval_seconds: 5\nwatch:\n  - compsci 61a\n  - "28984"\n'
                 '  - {course: data c8, section: 001 lec, include_reserved: false}\n')
    c = load_config(p)
    assert c.interval_seconds == 30            # clamped to the polite minimum
    assert c.targets[0].course == "COMPSCI 61A" and c.targets[0].term == "2026 Spring"
    assert c.targets[1].class_number == "28984"
    assert c.targets[2].section == "001 LEC" and not c.targets[2].include_reserved


@pytest.fixture
def api(tmp_path):
    st = Store(tmp_path)
    httpd = serve(st, "127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield st, f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def call(url, method="GET", body=None):
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_api(api):
    st, base = api
    assert call(base + "/seats") == (200, {"updatedAt": None, "term": "", "sections": []})
    s = sec(2)
    st.save_latest({s.key: s})
    assert call(base + "/seats")[1]["sections"][0]["classNumber"] == "28984"
    assert call(base + "/seats/28984")[1]["open"] == 2
    assert call(base + "/seats/1")[0] == 404
    assert call(base + "/subscriptions", "POST", {"email": "bad", "classNumber": "1"})[0] == 400
    code, sub = call(base + "/subscriptions", "POST", {"email": "a@b.co", "classNumber": 28984})
    assert code == 201 and sub["includeReserved"] is True
    assert len(call(base + "/subscriptions?email=a@b.co")[1]) == 1
    assert call(base + "/subscriptions", "DELETE", {"email": "a@b.co", "classNumber": "28984"})[0] == 200
