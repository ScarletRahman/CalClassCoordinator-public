import nodemailer, { type Transporter } from "nodemailer";
import { isProduction, smtpConfig } from "./env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** The one link that matters in the message; logged in development when SMTP is not set up. */
  link?: string;
}

let transporter: Transporter | null = null;
let warned = false;

export function mailConfigured(): boolean {
  return smtpConfig() !== null;
}

function getTransporter(): Transporter | null {
  const cfg = smtpConfig();
  if (!cfg) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      // 587 is the submission port: insist on STARTTLS. Other ports (25, local dev sinks) use it if offered.
      requireTLS: cfg.port === 587,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

/**
 * Sends a plain-text email. Never throws: a failed send is logged and reported as false, so a
 * mail outage can't break signup or reveal whether an address has an account.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const t = getTransporter();
  if (!t) {
    if (isProduction()) {
      if (!warned) {
        console.warn("[mail] SMTP_HOST is not set, so no email will be sent (verification, password reset).");
        warned = true;
      }
    } else {
      console.log(`[mail] (not sent, SMTP_HOST unset) to=${mail.to} subject="${mail.subject}"${mail.link ? ` link=${mail.link}` : ""}`);
    }
    return false;
  }
  try {
    await t.sendMail({ from: smtpConfig()!.from, to: mail.to, subject: mail.subject, text: mail.text });
    return true;
  } catch (e) {
    console.error(`[mail] failed to send "${mail.subject}":`, (e as Error).message);
    return false;
  }
}
