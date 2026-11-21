from __future__ import annotations

import smtplib
import ssl as _ssl
from email.message import EmailMessage

from watcher.models import ChangeEvent
from watcher.notify._http import env_secret
from watcher.notify.base import NotifyError
from watcher.notify.format import format_body, format_title


class EmailNotifier:
    """SMTP (STARTTLS by default; ssl=True for implicit TLS on 465)."""

    name = "email"

    def __init__(
        self,
        to: str | list[str],
        host: str = "smtp.gmail.com",
        port: int = 587,
        user: str | None = None,
        from_: str | None = None,
        password_env: str | None = "SMTP_PASSWORD",
        starttls: bool = True,
        ssl: bool = False,
        subject_prefix: str = "[Seat Watcher] ",
        timeout: float = 20.0,
        footer: str = "",
        **kw: object,
    ) -> None:
        if not to:
            raise ValueError("email notifier requires 'to'")
        self.to = [to] if isinstance(to, str) else list(to)
        self.host = host
        self.port = int(port)
        self.user = user
        self.from_ = from_ or kw.get("from") or user
        if not self.from_:
            raise ValueError("email notifier requires 'from' or 'user'")
        self.password_env = password_env
        self.starttls = starttls
        self.use_ssl = ssl
        self.subject_prefix = subject_prefix
        self.timeout = timeout
        self.footer = footer  # appended as the last line(s) of every body

    def build_message(self, event: ChangeEvent) -> EmailMessage:
        msg = EmailMessage()
        msg["Subject"] = f"{self.subject_prefix}{format_title(event)}"
        msg["From"] = self.from_
        msg["To"] = ", ".join(self.to)
        body = format_body(event)
        if self.footer:
            body += "\n\n" + self.footer
        msg.set_content(body)
        return msg

    def send(self, event: ChangeEvent) -> None:
        password = env_secret(self.password_env, "smtp password") if self.user else None
        msg = self.build_message(event)
        ctx = _ssl.create_default_context()
        try:
            if self.use_ssl:
                smtp = smtplib.SMTP_SSL(self.host, self.port, timeout=self.timeout, context=ctx)
            else:
                smtp = smtplib.SMTP(self.host, self.port, timeout=self.timeout)
            with smtp as conn:
                if self.starttls and not self.use_ssl:
                    conn.starttls(context=ctx)
                if self.user:
                    conn.login(self.user, password)
                conn.send_message(msg)
        except (smtplib.SMTPException, OSError) as e:
            raise NotifyError(f"email: {e}") from e
