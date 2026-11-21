"""Shared test setup.

The runner keeps ``min_request_gap_seconds`` (default 2s) between requests to a
source by sleeping through ``watcher.runner._wait``. Offline tests use fake
sources, so make that sleep a no-op; tests of the gap itself inject their own
clock and sleep into ``Watcher``.
"""
import pytest


@pytest.fixture(autouse=True)
def _no_request_gap_sleep(monkeypatch):
    import watcher.runner
    monkeypatch.setattr(watcher.runner, "_wait", lambda stop, seconds: None)
