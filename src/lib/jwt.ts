import { sign, verify } from "hono/jwt";
import { env } from "../env.ts";

export interface AccessClaims {
  sub: string; // user id
  exp: number;
  iat: number;
}

/** Sign a short-lived access token for a user. */
export async function signAccessToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { sub: userId, iat: now, exp: now + env.ACCESS_TTL },
    env.JWT_SECRET,
  );
}

/** Verify and return claims, or null if invalid/expired. */
export async function verifyAccessToken(
  token: string,
): Promise<AccessClaims | null> {
  try {
    return (await verify(
      token,
      env.JWT_SECRET,
      "HS256",
    )) as unknown as AccessClaims;
  } catch {
    return null;
  }
}
