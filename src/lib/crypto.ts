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

/**
 * The sha256 of raw BYTES — the one `sha256sum` also computes.
 *
 * Deliberately separate from `sha256(string)` above, and this is not a stylistic
 * split. `createHash().update(s)` encodes a string as UTF-8, so hashing bytes by
 * first turning them into a latin1 string (as a deleted helper in
 * routes/bibliotheque.ts did) doubles every byte ≥ 0x80 and yields a digest that
 * matches nothing outside this process. That helper's own doc comment promised
 * the opposite: that an external uploader could "compute it the same way". It
 * could not. Images are content-addressed, so the digest IS the URL — a wrong
 * one silently breaks deduplication and addresses no file any tool can produce.
 */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
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
