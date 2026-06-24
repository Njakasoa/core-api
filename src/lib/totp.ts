import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { randomToken } from "./ids.ts";

const ISSUER = "core-api";

export function newTotpSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

function totp(secret: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}

/** otpauth:// URI + a data-URL QR code for authenticator apps. */
export async function totpProvisioning(
  secret: string,
  label: string,
): Promise<{ uri: string; qr: string }> {
  const uri = totp(secret, label).toString();
  const qr = await QRCode.toDataURL(uri);
  return { uri, qr };
}

/** Verify a 6-digit code with a ±1 step window. */
export function verifyTotp(secret: string, code: string, label = "user"): boolean {
  const delta = totp(secret, label).validate({ token: code, window: 1 });
  return delta !== null;
}

export function newRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => randomToken(6));
}
