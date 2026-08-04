import type { MiddlewareHandler } from "hono";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../db/index.ts";
import { corpusRoles, orgMembers, users } from "../db/schema.ts";
import { errors } from "../lib/errors.ts";
import { verifyAccessToken } from "../lib/jwt.ts";

/**
 * Authenticate when a token is present, and stay silent when it is not.
 *
 * `requireAuth` throws on a missing Bearer, which is right for a private API
 * and wrong for a public one: the collecte module is read-anonymous by design,
 * yet still wants to know who is reading when it can. Mount this on routes that
 * serve everyone but behave differently for a signed-in reader.
 *
 * An invalid or expired token is treated as no token at all. Handing a 401 to
 * someone reading a public page because their session lapsed would be a worse
 * answer than simply showing them the page.
 */
export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const claims = await verifyAccessToken(header.slice(7).trim());
    if (claims) c.set("auth", { kind: "user", userId: claims.sub });
  }
  return next();
};

/**
 * A real, persisted human — not a machine key, not a guest.
 *
 * Two reasons, and the second is the one that bites.
 *
 * `POST /v1/auth/guest` mints a token whose subject is never inserted into
 * `users` ("no account, no DB row", says its own comment). `requireAuth`
 * verifies the signature and asks nothing else, so a guest sails through it.
 * The moment such a caller writes a row referencing `users.id`, Postgres raises
 * a foreign-key violation and the API answers 500 — an internal error for what
 * is plainly an authorisation problem. This middleware turns it back into 401.
 *
 * And an API key is an org's machine credential. It can carry no consent, no
 * attribution and no name, which is precisely what a contribution needs.
 */
export const requireRealUser: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth");
  if (!auth || auth.kind !== "user") {
    throw errors.unauthorized("This endpoint requires a signed-in person");
  }
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);
  if (!row) throw errors.unauthorized("Guest sessions cannot contribute");
  return next();
};

/**
 * A site-wide role from `corpus_roles`.
 *
 * Reads NOTHING from `X-Org-Id`, and that is the whole point. `requireRole()`
 * takes the org from a client-supplied header, and every registrant is `owner`
 * of the org created for them at signup — so an org role can never mean
 * "moderator of the platform". It is a limit of what org roles can express, not
 * a hole in them, and the fix is a separate table rather than a looser check.
 *
 * A role may be held by a person OR by an organisation: a community authority
 * is an institution, and its members act for it. Both are resolved here so a
 * caller never has to say which hat they are wearing.
 */
export function requireCorpusRole(...roles: string[]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.kind !== "user") {
      throw errors.unauthorized("This endpoint requires a signed-in person");
    }
    const held = await db
      .select({ role: corpusRoles.role })
      .from(corpusRoles)
      .leftJoin(orgMembers, eq(orgMembers.orgId, corpusRoles.orgId))
      .where(
        and(
          isNull(corpusRoles.revokedAt),
          inArray(corpusRoles.role, roles),
          or(
            eq(corpusRoles.userId, auth.userId),
            eq(orgMembers.userId, auth.userId),
          ),
        ),
      )
      .limit(1);
    if (held.length === 0) {
      throw errors.forbidden(`Requires corpus role: ${roles.join(" or ")}`);
    }
    return next();
  };
}
