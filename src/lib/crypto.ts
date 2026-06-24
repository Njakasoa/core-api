import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Password hashing via Bun's native argon2id. */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}
export function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

/** Fast deterministic hash for opaque tokens (API keys, refresh tokens). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** HMAC-SHA256 hex signature (webhook signing). */
export function hmacSign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
