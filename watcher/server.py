"""Tiny stdlib HTTP API so web/ can read seats and create alert subscriptions.

GET    /seats                    -> latest.json (Snapshot contract)
GET    /seats/<classNumber>      -> one section or 404
GET    /subscriptions?email=...  -> that email's subscriptions
POST   /subscriptions            {email, classNumber, includeReserved?, term?}
DELETE /subscriptions            {email, classNumber}
GET    /lookup?course=..&term=.. -> one course's sections, times and seats, fetched live and
                                    cached (docs/schedule.md); 404 when not offered, 502 when no source answers
GET    /health                   -> {ok, lastPollAt, lastPollOk, targets}; 503 when the poll loop is stuck

Only the web app's server calls this API (never a browser), so there are no CORS
headers unless ``cors_origin`` is given. When a token is set (env
WATCHER_API_TOKEN in ``prod``), every endpoint except GET /health needs
``Authorization: Bearer <token>``. Binding to a non-loopback address without a
token is refused.
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from watcher.sources.base import SourceError
from watcher.store import Store, norm_email

log = logging.getLogger("watcher.api")

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
MAX_BODY = 10_000
MAX_EMAIL = 254
MAX_CLASS_NUMBER = 10
MAX_TERM = 40
MAX_COURSE = 20
COURSE_RE = re.compile(r"^[A-Z][A-Z0-9&,\- ]* [A-Z]*\d+[A-Z0-9]*$")

HealthFn = Callable[[], "tuple[bool, dict[str, Any]]"]


class BadRequest(ValueError):
    pass


def is_loopback(host: str) -> bool:
    if host in ("localhost",):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def make_handler(store: Store, cors_origin: str | None = None, *, token: str | None = None,
                 health: HealthFn | None = None, lookup: Any = None):
    token_b = token.encode() if token else None

    class Handler(BaseHTTPRequestHandler):
        server_version = "CalClassWatcher/1"
        timeout = 30  # seconds a client may idle mid-request

        def log_message(self, fmt, *args):  # quieter logs
            pass

        def _send(self, code: int, body) -> None:
            data = b"" if code == 204 else json.dumps(body).encode()
            self.send_response(code)
            if data:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if cors_origin:
                self.send_header("Access-Control-Allow-Origin", cors_origin)
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
                self.send_header("Vary", "Origin")
            if code == 401:
                self.send_header("WWW-Authenticate", "Bearer")
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            if token_b is None:
                return True
            got = self.headers.get("Authorization", "")
            scheme, _, value = got.partition(" ")
            if scheme.lower() != "bearer":
                return False
            return hmac.compare_digest(value.strip().encode(), token_b)

        def _body(self) -> dict:
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                raise BadRequest("bad Content-Length") from None
            if n < 0:
                raise BadRequest("bad Content-Length")
            if n > MAX_BODY:
                raise BadRequest("body too large")
            raw = self.rfile.read(n) if n else b""
            try:
                b = json.loads(raw or b"{}")
            except (ValueError, UnicodeDecodeError):
                raise BadRequest("body must be JSON") from None
            if not isinstance(b, dict):
                raise BadRequest("body must be a JSON object")
            return b

        def _guard(self, fn) -> None:
            path = urlparse(self.path).path.rstrip("/")
            if not (self.command == "GET" and path == "/health") and not self._authorized():
                return self._send(401, {"error": "unauthorized"})
            try:
                fn()
            except BadRequest as e:
                self._send(400, {"error": str(e)})
            except Exception:
                log.exception("API %s %s crashed", self.command, path)
                self._send(500, {"error": "internal error"})

        # ---- verbs ------------------------------------------------------
        def do_OPTIONS(self):
            if cors_origin:  # browsers send preflights without credentials
                return self._send(204, {})
            self._guard(lambda: self._send(405, {"error": "method not allowed"}))

        def do_GET(self):
            self._guard(self._get)

        def do_POST(self):
            self._guard(self._post)

        def do_DELETE(self):
            self._guard(self._delete)

        # ---- handlers ---------------------------------------------------
        def _get(self):
            u = urlparse(self.path)
            parts = [p for p in u.path.split("/") if p]
            if parts == ["health"]:
                if health is None:
                    return self._send(200, {"ok": True, "lastPollAt": None, "lastPollOk": None, "targets": 0})
                ok, body = health()
                return self._send(200 if ok else 503, body)
            if parts[:1] == ["seats"] and len(parts) <= 2:
                if not store.latest_path.exists():
                    return self._send(200, {"updatedAt": None, "term": "", "sections": []})
                snap = json.loads(store.latest_path.read_text())
                if len(parts) == 1:
                    return self._send(200, snap)
                hit = [s for s in snap["sections"] if s["classNumber"] == parts[1]]
                return self._send(200, hit[0]) if hit else self._send(404, {"error": "not watched"})
            if parts == ["lookup"]:
                if lookup is None:
                    return self._send(404, {"error": "lookup is not enabled"})
                q = parse_qs(u.query)
                course, term = q.get("course", [""])[0], q.get("term", [""])[0]
                if len(course) > 40 or len(term) > MAX_TERM:
                    raise BadRequest("course or term too long")
                try:
                    found = lookup.lookup(course, term)
                except ValueError as e:
                    raise BadRequest(str(e)) from None
                except SourceError as e:
                    log.warning("lookup %s %s failed: %s", course, term, e)
                    return self._send(502, {"error": "could not reach the class schedule"})
                if found is None:
                    return self._send(404, {"error": "not offered"})
                return self._send(200, found)
            if parts == ["subscriptions"]:
                email = norm_email(parse_qs(u.query).get("email", [""])[0])
                if not email or len(email) > MAX_EMAIL:
                    return self._send(400, {"error": "email required"})
                return self._send(200, store.subscriptions_for(email))
            self._send(404, {"error": "not found"})

        def _email_cn(self, b: dict) -> tuple[str, str]:
            email, cn = norm_email(b.get("email")), str(b.get("classNumber", "")).strip()
            if (not EMAIL_RE.match(email) or len(email) > MAX_EMAIL
                    or not (cn.isascii() and cn.isdigit()) or len(cn) > MAX_CLASS_NUMBER):
                raise BadRequest("valid email and numeric classNumber required")
            return email, cn

        def _post(self):
            if urlparse(self.path).path.rstrip("/") != "/subscriptions":
                return self._send(404, {"error": "not found"})
            b = self._body()
            email, cn = self._email_cn(b)
            sub = {"email": email, "classNumber": cn, "includeReserved": bool(b.get("includeReserved", True))}
            if b.get("term"):
                term = str(b["term"]).strip()
                if len(term) > MAX_TERM:
                    raise BadRequest("term too long")
                sub["term"] = term
            if b.get("course"):
                # Lets sources that cannot look a class up by number alone (Berkeleytime) find it.
                course = " ".join(str(b["course"]).upper().split())
                if len(course) <= MAX_COURSE and COURSE_RE.match(course):
                    sub["course"] = course  # a malformed hint is dropped, not an error
            self._send(201, store.add_subscription(sub))

        def _delete(self):
            if urlparse(self.path).path.rstrip("/") != "/subscriptions":
                return self._send(404, {"error": "not found"})
            email, cn = self._email_cn(self._body())
            ok = store.remove_subscription(email, cn)
            self._send(200 if ok else 404, {"removed": ok})

    return Handler


def serve(store: Store, host: str = "127.0.0.1", port: int = 8765, *, token: str | None = None,
          health: HealthFn | None = None, cors_origin: str | None = None,
          lookup: Any = None) -> ThreadingHTTPServer:
    """Bind the API (call ``serve_forever`` on the result). Refuses a public bind without a token."""
    if not token and not is_loopback(host):
        raise ValueError(f"refusing to serve the watcher API on {host!r} without a token: "
                         "set WATCHER_API_TOKEN or bind to 127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), make_handler(store, cors_origin, token=token, health=health,
                                                             lookup=lookup))
    httpd.daemon_threads = True
    return httpd
