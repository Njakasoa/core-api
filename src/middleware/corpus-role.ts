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
/**
 * Les rôles qu'une personne détient réellement, portées comprises.
 *
 * Extrait de `requireCorpusRole` parce que deux appelants en ont besoin sans
 * pouvoir se placer en intergiciel : l'interface, qui doit savoir quoi afficher
 * AVANT d'essuyer un 403, et les routes dont la visibilité dépend du rôle plutôt
 * que d'en dépendre entièrement — un déposant voit son livre en attente, un
 * modérateur voit ceux de tout le monde, le public n'en voit aucun.
 *
 * Une seule requête pour les deux voies d'accès : le rôle tenu par la personne,
 * et celui tenu par une organisation dont elle est membre.
 */
export async function rolesDetenus(
  userId: string,
): Promise<{ role: string; scope: unknown }[]> {
  return db
    .select({ role: corpusRoles.role, scope: corpusRoles.scope })
    .from(corpusRoles)
    .leftJoin(orgMembers, eq(orgMembers.orgId, corpusRoles.orgId))
    .where(
      and(
        isNull(corpusRoles.revokedAt),
        or(eq(corpusRoles.userId, userId), eq(orgMembers.userId, userId)),
      ),
    );
}

/**
 * Vrai si la personne détient l'un de ces rôles, SANS portée.
 *
 * La portée fait échouer fermé ici comme dans l'intergiciel : un rôle accordé
 * « pour un dialecte » ne doit pas donner le pouvoir sur tout le site parce que
 * l'appelant a oublié de la regarder.
 */
export async function detientRole(
  userId: string,
  ...roles: string[]
): Promise<boolean> {
  const tenus = (await rolesDetenus(userId)).filter((r) => roles.includes(r.role));
  return tenus.length > 0 && tenus.some((r) => r.scope == null);
}

export function requireCorpusRole(...roles: string[]): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth");
    if (!auth || auth.kind !== "user") {
      throw errors.unauthorized("This endpoint requires a signed-in person");
    }
    const held = (await rolesDetenus(auth.userId)).filter((h) =>
      roles.includes(h.role),
    );
    if (held.length === 0) {
      throw errors.forbidden(`Requires corpus role: ${roles.join(" or ")}`);
    }
    // `scope` existe depuis le premier jour — « relecteur pour un dialecte » —
    // et n'a JAMAIS été lu ici. Un rôle accordé avec une portée donnait donc
    // silencieusement le pouvoir sur tout le site, à quelqu'un qui croyait
    // l'avoir restreint. On échoue fermé plutôt que d'honorer à moitié : le jour
    // où la portée sera appliquée, elle le sera à cet endroit précis, et pas
    // dans chaque route qui aurait oublié de la regarder.
    if (held.every((h) => h.scope != null)) {
      throw errors.forbidden(
        "ce rôle porte une portée que ce contrôle ne sait pas encore appliquer",
      );
    }
    return next();
  };
}
