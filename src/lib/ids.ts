import { customAlphabet } from "nanoid";

// URL-safe, no ambiguous chars. 21 chars ≈ 121 bits of entropy.
const nano = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
  21,
);

/** Prefixed id, e.g. id("user") → "user_V1StGXR8Z5jdHi6B-myT". */
export function id(prefix: string): string {
  return `${prefix}_${nano()}`;
}

/** Opaque random token (for API keys / secrets), not prefixed. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString("base64url");
}
