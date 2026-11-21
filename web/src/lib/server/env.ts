import path from "node:path";

/**
 * Every environment variable the server reads, in one place. Values are read on each call (not
 * at import time) so tests can change process.env, and so a standalone build picks up the
 * container's runtime env rather than whatever was set during `next build`.
 * Documented in web/.env.example and web/README.md.
 */

function str(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const isProduction = () => process.env.NODE_ENV === "production";

/** Public base URL, used to build links in emails. No trailing slash. */
export function appUrl(): string {
  return (str("APP_URL") ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Origin of APP_URL (scheme://host[:port]), or null if APP_URL is malformed. */
export function appOrigin(): string | null {
  try {
    return new URL(appUrl()).origin;
  } catch {
    return null;
  }
}

export function databasePath(): string {
  return str("DATABASE_PATH") ?? path.join(process.cwd(), ".data", "planner.db");
}

export function dataDir(): string {
  return str("CCC_DATA_DIR") ?? path.resolve(process.cwd(), "..", "data");
}

/** Seat watcher base URL without trailing slash, or null when not configured. */
export function watcherUrl(): string | null {
  return str("WATCHER_URL")?.replace(/\/+$/, "") ?? null;
}

export function watcherApiToken(): string | undefined {
  return str("WATCHER_API_TOKEN");
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
}

/** SMTP settings, or null when SMTP_HOST is unset (email disabled). */
export function smtpConfig(): SmtpConfig | null {
  const host = str("SMTP_HOST");
  if (!host) return null;
  const port = Number(str("SMTP_PORT") ?? 587);
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    user: str("SMTP_USER"),
    password: str("SMTP_PASSWORD"),
    from: str("MAIL_FROM") ?? str("SMTP_USER") ?? "CalClassCoordinator <no-reply@localhost>",
  };
}

/**
 * 32-byte AES key for encrypting saved plans, from base64 or 64 hex chars. Null when unset.
 * Throws on a malformed value so a typo fails loudly instead of silently storing plaintext.
 */
export function planEncryptionKey(): Buffer | null {
  const raw = str("PLAN_ENCRYPTION_KEY");
  if (!raw) return null;
  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) key = Buffer.from(raw, raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
  if (!key || key.length !== 32) {
    throw new Error("PLAN_ENCRYPTION_KEY must be 32 bytes, as base64 or 64 hex characters.");
  }
  return key;
}
