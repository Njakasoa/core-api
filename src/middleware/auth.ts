import type { MiddlewareHandler } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { apiKeys } from "../db/schema.ts";
import { sha256 } from "../lib/crypto.ts";
import { verifyAccessToken } from "../lib/jwt.ts";
import { errors } from "../lib/errors.ts";

export const API_KEY_PREFIX = "sk_";

/**
 * Authenticate a request via either:
 *  - a Bearer JWT access token  → user principal
 *  - a Bearer API key (sk_…)    → org/machine principal
 * Sets c.var.auth. Throws 401 when absent/invalid.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw errors.unauthorized("Missing Bearer token");
  }
  const token = header.slice(7).trim();

  if (token.startsWith(API_KEY_PREFIX)) {
    const keyHash = sha256(token);
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, keyHash))
      .limit(1);

    if (!key || key.revokedAt) throw errors.unauthorized("Invalid API key");

    c.set("auth", {
      kind: "apiKey",
      apiKeyId: key.id,
      orgId: key.orgId,
      scopes: key.scopes,
    });
    // Touch lastUsedAt without blocking the request.
    void db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id));
    return next();
  }

  const claims = await verifyAccessToken(token);
  if (!claims) throw errors.unauthorized("Invalid or expired token");
  c.set("auth", { kind: "user", userId: claims.sub });
  return next();
};

/** Require an API key with a given scope (no-op for user principals). */
export function requireScope(scope: string): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (auth.kind === "apiKey" && !auth.scopes.includes(scope)) {
      throw errors.forbidden(`API key missing scope: ${scope}`);
    }
    await next();
  };
}
