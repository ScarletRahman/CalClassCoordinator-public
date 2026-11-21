import { randomBytes } from "node:crypto";
import { hashToken } from "./auth";
import { deleteEmailTokens, insertEmailToken, claimEmailToken, type TokenPurpose } from "./db";
import { appUrl } from "./env";
import { sendMail } from "./mail";

export const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 60 * 60 * 1000;

/** Creates a single-use token and returns the raw value (only its hash is stored). */
export function createEmailToken(userId: number, purpose: TokenPurpose, now = Date.now()): string {
  const token = randomBytes(32).toString("base64url");
  // Only the newest reset link works; older verify links stay valid until they expire.
  if (purpose === "reset") deleteEmailTokens(userId, "reset");
  insertEmailToken(hashToken(token), userId, purpose, now + (purpose === "verify" ? VERIFY_TTL_MS : RESET_TTL_MS));
  return token;
}

/** Returns the user id if the token is valid, unexpired and unused, and marks it used. */
export function consumeEmailToken(token: string, purpose: TokenPurpose, now = Date.now()): number | null {
  if (!token || token.length > 200) return null;
  return claimEmailToken(hashToken(token), purpose, now);
}

export async function sendVerificationEmail(userId: number, email: string): Promise<boolean> {
  const link = `${appUrl()}/verify?token=${createEmailToken(userId, "verify")}`;
  return sendMail({
    to: email,
    subject: "Confirm your CalClassCoordinator email",
    link,
    text: [
      "Confirm this email address for your CalClassCoordinator account:",
      "",
      link,
      "",
      "The link works for 24 hours. Confirming lets you sign up for seat alerts.",
      "If you didn't create an account, ignore this email.",
    ].join("\n"),
  });
}

export async function sendResetEmail(userId: number, email: string): Promise<boolean> {
  const link = `${appUrl()}/reset?token=${createEmailToken(userId, "reset")}`;
  return sendMail({
    to: email,
    subject: "Reset your CalClassCoordinator password",
    link,
    text: [
      "Someone (hopefully you) asked to reset the password for this CalClassCoordinator account.",
      "",
      link,
      "",
      "The link works for 1 hour and can be used once. Resetting signs you out everywhere.",
      "If you didn't ask for this, ignore this email; your password hasn't changed.",
    ].join("\n"),
  });
}
