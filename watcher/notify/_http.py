"""Small helpers shared by HTTP-based notifiers."""
from __future__ import annotations

import os

import requests

from watcher.notify.base import NotifyError


def env_secret(var: str | None, what: str, required: bool = True) -> str | None:
    if not var:
        if required:
            raise NotifyError(f"{what}: no env var name configured")
        return None
    val = os.environ.get(var)
    if not val and required:
        raise NotifyError(f"{what}: environment variable {var} is not set")
    return val or None


def _redact(text: str, url: str) -> str:
    from urllib.parse import urlsplit
    parts = urlsplit(url)
    for secret in (url, parts.path, parts.query):
        if secret and len(secret) > 1:
            text = text.replace(secret, "<redacted>")
    return text


def post(url: str, *, timeout: float = 10.0, what: str = "http", **kwargs) -> requests.Response:
    try:
        resp = requests.post(url, timeout=timeout, **kwargs)
    except requests.RequestException as e:
        # Webhook URLs are secrets, and requests puts the URL in its error text.
        raise NotifyError(f"{what}: request failed: {_redact(str(e), url)}") from None
    if resp.status_code >= 400:
        raise NotifyError(f"{what}: HTTP {resp.status_code}: {resp.text[:200]}")
    return resp
