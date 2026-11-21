import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { planEncryptionKey } from "./env";

/**
 * Optional at-rest encryption for saved plans (AES-256-GCM, key from PLAN_ENCRYPTION_KEY).
 * Stored form: enc:v1:<iv b64>:<tag b64>:<ciphertext b64>. The user id is bound in as
 * additional authenticated data, so a row copied onto another user fails to decrypt.
 * Rows written before a key was set are plain JSON and are read as-is.
 */

const PREFIX = "enc:v1:";

function aad(userId: number): Buffer {
  return Buffer.from(`plan:${userId}`);
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function encryptPlan(json: string, userId: number, key: Buffer | null = planEncryptionKey()): string {
  if (!key) return json;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptPlan(stored: string, userId: number, key: Buffer | null = planEncryptionKey()): string {
  if (!isEncrypted(stored)) return stored;
  if (!key) throw new Error("Saved plan is encrypted but PLAN_ENCRYPTION_KEY is not set.");
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(":");
  if (!ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Malformed encrypted plan.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}
