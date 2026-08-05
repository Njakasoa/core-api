import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { corpusRoles, users } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireCorpusRole, requireRealUser, rolesDetenus } from "../middleware/corpus-role.ts";

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

  /**
   * MES rôles. Sans quoi une interface ne peut afficher que des culs-de-sac.
   *
   * Jusqu'ici le front ne découvrait un rôle qu'en se prenant un 403 : il
   * proposait la file de relecture à tout le monde, et n'apprenait qu'après coup
   * qu'elle était fermée. C'est un mauvais écran, et c'est aussi une fuite
   * d'information à l'envers — l'échec renseigne autant que le succès.
   *
   * Renvoie la LISTE, pas un booléen par pouvoir : l'interface doit pouvoir
   * décider seule, et un booléen par écran ferait revenir ici à chaque nouvel
   * écran. Les portées sont dites telles quelles, y compris quand elles rendent
   * le rôle inopérant — cacher une portée qu'aucun contrôle n'applique encore
   * ferait croire à un pouvoir qui n'existe pas.
   */
  app.get(
    "/roles/moi",
    describeRoute({ description: "Les rôles du compte courant", tags: ["corpus"] }),
    requireAuth,
    async (c) => {
      const auth = c.get("auth");
      if (auth.kind !== "user") return c.json({ roles: [] });
      const tenus = await rolesDetenus(auth.userId);
      return c.json({
        roles: tenus.map((r) => r.role),
        // Un rôle porté par une portée ne donne rien tant que `requireCorpusRole`
        // ne sait pas l'appliquer. Le dire évite qu'on cherche pourquoi le bouton
        // apparaît et que l'action échoue.
        portees: tenus.filter((r) => r.scope != null).map((r) => r.role),
      });
    },
  );

  /**
   * Les comptes inscrits — modérateur seulement.
   *
   * POURQUOI CETTE ROUTE EXISTE : accorder un rôle exige un `userId`, et
   * `GET /roles` ne montre que les gens qui EN ONT DÉJÀ UN. Le premier rôle de
   * qui que ce soit était donc impossible à accorder autrement que par un INSERT
   * à la main — c'est-à-dire par une seule personne au monde, ce que la route
   * d'attribution disait justement vouloir corriger.
   *
   * CE QU'ELLE EXPOSE, ET CE QUE ÇA COÛTE
   * La liste complète des inscrits, adresses comprises. C'est un choix : un
   * modérateur administre, et administrer à l'aveugle ne se fait pas. Mais un
   * compte modérateur compromis emporte donc l'annuaire des contributeurs, et
   * cela doit peser sur le nombre de personnes à qui ce rôle est accordé. La
   * recherche est un filtre de commodité et non une restriction : la pagination
   * donne accès à tout de toute façon.
   */
  app.get(
    "/utilisateurs",
    describeRoute({ description: "Les comptes inscrits", tags: ["corpus"] }),
    requireAuth,
    requireCorpusRole("moderateur"),
    validate("query", z.object({
      q: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      cursor: z.string().max(200).optional(),
    })),
    async (c) => {
      const { q, limit, cursor } = c.req.valid("query");
      const motif = q?.trim() ? `%${q.trim().toLowerCase()}%` : null;
      // Curseur sur `id` : l'ordre est stable et un compte créé pendant la
      // pagination ne décale pas les pages déjà vues.
      const lignes = await db.execute<{
        id: string; email: string; name: string | null; createdAt: string; roles: string[] | null;
      }>(sql`
        select u.id, u.email, u.name, u.created_at as "createdAt",
               array_remove(array_agg(distinct cr.role) filter (where cr.revoked_at is null), null) as roles
          from users u
          left join corpus_roles cr on cr.user_id = u.id
         where (${motif}::text is null
                or lower(u.email) like ${motif} or lower(coalesce(u.name,'')) like ${motif})
           and (${cursor ?? null}::text is null or u.id > ${cursor ?? null})
      group by u.id
      order by u.id asc
         limit ${limit + 1}
      `);
      const data = lignes.slice(0, limit);
      return c.json({
        data: data.map((u) => ({ ...u, roles: u.roles ?? [] })),
        nextCursor: lignes.length > limit ? data[data.length - 1]?.id ?? null : null,
      });
    },
  );

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
