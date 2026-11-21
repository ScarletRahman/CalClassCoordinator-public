"""Best-effort native desktop notifications.

Backend order for ``backend: auto``:
  * Windows: PowerShell WinRT toast (no installs needed, click opens the class
    page), then plyer if installed, then ``msg`` (Pro/Enterprise only).
  * macOS:   plyer if installed, then osascript.
  * Linux:   plyer if installed, then notify-send.
Any failure raises NotifyError; nothing here ever crashes the watcher.
"""
from __future__ import annotations

import base64
import platform
import shutil
import subprocess
from xml.sax.saxutils import escape, quoteattr

from watcher.models import ChangeEvent
from watcher.notify.base import NotifyError
from watcher.notify.format import URGENT_KINDS, format_title, _open_count

# Windows PowerShell's registered AppUserModelID: lets an unpackaged script
# show toasts on Windows 10/11 without registering a shortcut.
POWERSHELL_APP_ID = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"


def short_text(event: ChangeEvent) -> str:
    s = event.section
    parts = [f"Open {_fmt(_open_count(s))}  Enrolled {_fmt(s.enrolled)}/{_fmt(s.capacity)}"]
    if s.reserved_open:
        parts.append(f"Reserved open {s.reserved_open}")
    if s.waitlisted is not None:
        parts.append(f"Waitlist {_fmt(s.waitlisted)}/{_fmt(s.waitlistCapacity)}")
    return " | ".join(parts)


def _fmt(v) -> str:
    return "?" if v is None else str(v)


def windows_toast_xml(title: str, text: str, url: str = "", urgent: bool = False) -> str:
    launch = f" activationType=\"protocol\" launch={quoteattr(url)}" if url else ""
    duration = ' duration="long"' if urgent else ""
    actions = (
        f'<actions><action content="Open class" activationType="protocol" arguments={quoteattr(url)}/></actions>'
        if url else ""
    )
    return (
        f"<toast{launch}{duration}><visual><binding template=\"ToastGeneric\">"
        f"<text>{escape(title)}</text><text>{escape(text)}</text>"
        f"</binding></visual>{actions}</toast>"
    )


def windows_toast_script(xml: str, app_id: str = POWERSHELL_APP_ID) -> str:
    # Single-quoted PowerShell strings: only ' needs escaping (doubled).
    xml_ps = xml.replace("'", "''")
    app_ps = app_id.replace("'", "''")
    return (
        "$ErrorActionPreference='Stop';"
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;"
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null;"
        "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;"
        f"$x.LoadXml('{xml_ps}');"
        "$t = New-Object Windows.UI.Notifications.ToastNotification $x;"
        f"[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{app_ps}').Show($t)"
    )


def encode_ps(script: str) -> str:
    return base64.b64encode(script.encode("utf-16-le")).decode("ascii")


class DesktopNotifier:
    name = "desktop"

    def __init__(
        self,
        backend: str = "auto",          # auto | windows | plyer | notify-send | osascript | msg
        app_name: str = "Berkeley Seat Watcher",
        timeout: int = 10,              # seconds the popup stays (where supported)
        app_id: str = POWERSHELL_APP_ID,
        **_: object,
    ) -> None:
        self.backend = backend
        self.app_name = app_name
        self.timeout = int(timeout)
        self.app_id = app_id
        self.system = platform.system()

    # --- backends -------------------------------------------------------
    def _plyer(self, title: str, text: str, url: str, urgent: bool) -> None:
        try:
            from plyer import notification  # type: ignore
        except Exception as e:  # ImportError or broken install
            raise NotifyError(f"plyer unavailable: {e}") from e
        try:
            notification.notify(title=title[:64], message=text[:256], app_name=self.app_name, timeout=self.timeout)
        except Exception as e:
            raise NotifyError(f"plyer failed: {e}") from e

    def _windows(self, title: str, text: str, url: str, urgent: bool) -> None:
        exe = shutil.which("powershell.exe") or shutil.which("powershell")
        if not exe:
            raise NotifyError("powershell.exe not found")
        script = windows_toast_script(windows_toast_xml(title, text, url, urgent), self.app_id)
        self._run([exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                   "-EncodedCommand", encode_ps(script)])

    def _msg(self, title: str, text: str, url: str, urgent: bool) -> None:
        exe = shutil.which("msg")
        if not exe:
            raise NotifyError("msg.exe not found")
        body = f"{title}\n{text}" + (f"\n{url}" if url else "")
        self._run([exe, "*", f"/TIME:{max(self.timeout, 5)}", body])

    def _notify_send(self, title: str, text: str, url: str, urgent: bool) -> None:
        exe = shutil.which("notify-send")
        if not exe:
            raise NotifyError("notify-send not found")
        body = text + (f"\n{url}" if url else "")
        self._run([exe, "-a", self.app_name, "-u", "critical" if urgent else "normal",
                   "-t", str(self.timeout * 1000), title, body])

    def _osascript(self, title: str, text: str, url: str, urgent: bool) -> None:
        exe = shutil.which("osascript")
        if not exe:
            raise NotifyError("osascript not found")

        def q(s: str) -> str:
            return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

        sound = ' sound name "Glass"' if urgent else ""
        self._run([exe, "-e", f"display notification {q(text)} with title {q(title)}"
                              f" subtitle {q(self.app_name)}{sound}"])

    def _run(self, cmd: list[str]) -> None:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError) as e:
            raise NotifyError(f"{cmd[0]}: {e}") from e
        if r.returncode != 0:
            raise NotifyError(f"{cmd[0]} exited {r.returncode}: {(r.stderr or r.stdout).strip()[:200]}")

    def backends(self) -> list[str]:
        if self.backend != "auto":
            return [self.backend]
        if self.system == "Windows":
            return ["windows", "plyer", "msg"]
        if self.system == "Darwin":
            return ["plyer", "osascript"]
        return ["plyer", "notify-send"]

    def send(self, event: ChangeEvent) -> None:
        title = format_title(event)
        text = short_text(event)
        url = event.section.url or ""
        urgent = event.kind in URGENT_KINDS
        table = {
            "windows": self._windows, "plyer": self._plyer, "msg": self._msg,
            "notify-send": self._notify_send, "osascript": self._osascript,
        }
        errors = []
        for b in self.backends():
            fn = table.get(b)
            if fn is None:
                errors.append(f"unknown backend {b!r}")
                continue
            try:
                fn(title, text, url, urgent)
                return
            except NotifyError as e:
                errors.append(f"{b}: {e}")
        raise NotifyError("desktop notification unavailable (" + "; ".join(errors) + ")")
