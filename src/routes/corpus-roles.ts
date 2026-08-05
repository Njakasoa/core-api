import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { corpusRoles, users } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireCorpusRole, requireRealUser } from "../middleware/corpus-role.ts";

/**
 * Accorder et révoquer les rôles de corpus.
 *
 * POURQUOI CETTE ROUTE EXISTE MAINTENANT
 * `corpus_roles` porte depuis le début `granted_by_user_id` et `revoked_at` —
 * la trace était prévue, l'acte ne l'était pas. Jusqu'ici tout rôle a été posé
 * par un INSERT à la main, ce qui veut dire qu'une seule personne au monde
 * pouvait en donner un, et que la surface de relecture n'était testable par
 * personne d'autre.
 *
 * UN RÔLE NE S'EFFACE PAS, IL SE RÉVOQUE
 * `revoked_at` existe pour ça. Supprimer la ligne effacerait qui l'avait
 * accordé, quand, et jusqu'à quand il a valu — c'est-à-dire tout ce dont on a
 * besoin le jour où l'on se demande qui a validé une correction contestée.
 *
 * LA PORTÉE N'EST PAS ACCORDABLE ICI
 * `corpus_roles.scope` existe pour « relecteur d'un dialecte », et
 * `requireCorpusRole` ne sait pas encore l'appliquer — il échoue fermé quand il
 * en voit une. Offrir de poser une portée qui ne restreint rien et bloque tout
 * serait offrir un piège. Le champ reste, la route n'y touche pas.
 */
const ROLES = ["moderateur", "curateur", "relecteur", "communaute"] as const;

const nouveauRole = z
  .object({
    userId: z.string().min(1).max(60),
    role: z.enum(ROLES),
    /** Pourquoi ce rôle est accordé. Un rôle sans motif est un rôle dont
     *  personne ne saura, dans six mois, s'il doit rester. */
    motif: z.string().max(300).optional(),
  })
  .strict();

export function corpusRolesRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  app.get(
    "/roles",
    describeRoute({ description: "Les rôles de corpus en vigueur", tags: ["corpus"] }),
    requireAuth,
    requireCorpusRole("moderateur"),
    async (c) => {
      const lignes = await db
        .select({
          id: corpusRoles.id,
          userId: corpusRoles.userId,
          email: users.email,
          role: corpusRoles.role,
          scope: corpusRoles.scope,
          grantedByUserId: corpusRoles.grantedByUserId,
          revokedAt: corpusRoles.revokedAt,
          createdAt: corpusRoles.createdAt,
        })
        .from(corpusRoles)
        .leftJoin(users, eq(users.id, corpusRoles.userId))
        .orderBy(desc(corpusRoles.createdAt))
        .limit(200);
      // Les rôles révoqués sont rendus AUSSI : « qui pouvait valider en mars »
      // est la question qu'on se pose quand une décision est contestée.
      return c.json({ data: lignes });
    },
  );

  app.post(
    "/roles",
    describeRoute({ description: "Accorder un rôle de corpus", tags: ["corpus"] }),
    requireAuth,
    requireRealUser,
    requireCorpusRole("moderateur"),
    validate("json", nouveauRole),
    async (c) => {
      const auth = c.get("auth");
      const b = c.req.valid("json");

      const [cible] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, b.userId))
        .limit(1);
      if (!cible) throw errors.unprocessable("ce compte n'existe pas");

      const [deja] = await db
        .select({ id: corpusRoles.id })
        .from(corpusRoles)
        .where(
          and(
            eq(corpusRoles.userId, b.userId),
            eq(corpusRoles.role, b.role),
            isNull(corpusRoles.revokedAt),
          ),
        )
        .limit(1);
      if (deja) return c.json({ id: deja.id, deja: true }, 200);

      const roleId = id("crole");
      await db.insert(corpusRoles).values({
        id: roleId,
        userId: b.userId,
        role: b.role,
        grantedByUserId: auth.kind === "user" ? auth.userId : "",
      });
      return c.json({ id: roleId, role: b.role, motif: b.motif ?? null }, 201);
    },
  );

  app.delete(
    "/roles/:id",
    describeRoute({ description: "Révoquer un rôle de corpus", tags: ["corpus"] }),
    requireAuth,
    requireRealUser,
    requireCorpusRole("moderateur"),
    async (c) => {
      const modifiees = await db
        .update(corpusRoles)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(corpusRoles.id, c.req.param("id")),
            isNull(corpusRoles.revokedAt),
          ),
        )
        .returning({ id: corpusRoles.id, role: corpusRoles.role });
      if (modifiees.length === 0) {
        throw errors.notFound("Rôle introuvable, ou déjà révoqué");
      }
      return c.json({ id: modifiees[0]!.id, revoque: true });
    },
  );

  return app;
}
