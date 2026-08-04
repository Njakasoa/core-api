import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { tales, taleVersions, taleConsents } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { sha256 } from "../lib/crypto.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { pageQuery, paginate, decodeCursor } from "../lib/pagination.ts";
import { requireAuth } from "../middleware/auth.ts";
import { optionalAuth, requireRealUser } from "../middleware/corpus-role.ts";
import { divergencePpm, DIVERGENCE_MAX_PPM } from "../lib/collecte/lettres.ts";

/**
 * Collecte — the community platform for Malagasy folktales.
 *
 * WHY THIS FILE DOES NOT MOUNT `requireOrg`
 * Reading is anonymous: a corpus nobody can read is not a public corpus. The
 * other resource routes mount `requireAuth, requireOrg` on the whole factory
 * (see routes/items.ts); this one mounts nothing globally and states the
 * boundary per endpoint, because the boundary is the design.
 *
 * Two consequences, both deliberate:
 *   · `idempotency` is NOT mounted here. It namespaces stored responses by
 *     `org?.id ?? "_"`, so without an org every caller would share the "_"
 *     bucket and two contributors sending the same Idempotency-Key would be
 *     served each other's response body. Double-submit protection for this
 *     module has to come from somewhere else, and pretending otherwise would be
 *     worse than not having it.
 *   · writes require `requireRealUser`, not merely `requireAuth`. A guest token
 *     carries a subject with no row in `users`, so any insert referencing it
 *     would raise a foreign-key violation and answer 500 to what is an
 *     authorisation problem.
 *
 * The route namespace is /v1/collecte and the folder is `collecte`, because
 * `src/games/angano/` already means the werewolf game in this repo. Calling
 * this one angano too would confuse every future reader of app.ts.
 */

/** What a contributor declares before writing a single line of the tale. */
const nouveauTale = z.object({
  titreSource: z.string().min(1).max(200),
  /** INEDIT_ORAL — heard and never written down. DEJA_ATTESTE — a tale already
   *  published somewhere. Both are welcome; the corpus is filtered on this, so
   *  it is declared by the contributor and never guessed from the text. */
  nouveaute: z.enum(["INEDIT_ORAL", "DEJA_ATTESTE"]),
  /** The spelling the contributor uses for their own dialect, kept verbatim.
   *  A canonical form may be assigned later, in the column beside it. */
  dialecteSource: z.string().max(80).optional(),
  regionCollecte: z.string().max(120).optional(),
  lieuCollecte: z.string().max(120).optional(),
  genreSource: z.string().max(80).optional(),
  /** The raw text. Written once and never again — see the trigger in
   *  drizzle/0001. Corrections arrive as new `corrigee` versions. */
  texte: z.string().min(1).max(200_000),
});

const nouveauConsentement = z.object({
  grantorRole: z.enum(["conteur", "transcripteur", "deposant", "ayant_droit"]),
  grantorDisplay: z.string().min(1).max(200),
  attribution: z.enum(["nom_reel", "pseudonyme", "anonyme"]),
  capturedVia: z.enum(["formulaire_web", "papier_scanne", "oral_enregistre"]),
  /** Consent obtained in French from a Malagasy-speaking teller is not informed
   *  consent. Which language was used is part of the evidence, not metadata. */
  langueDuFormulaire: z.enum(["plt_Latn", "fra_Latn"]),
  finalites: z.array(z.string().max(60)).max(20).default([]),
  /** Model weights can only be unwound by retraining. Opted into, never assumed. */
  niveauIrreversibleAutorise: z.boolean().default(false),
  diffusionPubliqueTexte: z.boolean().default(false),
  diffusionPubliqueAudio: z.boolean().default(false),
  /** Its own permission: publishing a recording and training a voice model on a
   *  grandmother's voice are not the same sentence. */
  clonageVocal: z.boolean().default(false),
  signedAt: z.coerce.date(),
});

const nouvelleCorrection = z.object({
  texte: z.string().min(1).max(200_000),
  origine: z.string().min(1).max(200),
});

/** The tale as the public sees it — never the submitter's identity. */
function publique(t: typeof tales.$inferSelect) {
  return {
    id: t.id,
    titre: t.titre ?? t.titreSource,
    titreSource: t.titreSource,
    langue: t.langue,
    dialecte: t.dialecte,
    dialecteSource: t.dialecteSource,
    regionCollecte: t.regionCollecte,
    lieuCollecte: t.lieuCollecte,
    genreSource: t.genreSource,
    nouveaute: t.nouveaute,
    statutRecit: t.statutRecit,
    statutFixation: t.statutFixation,
    provenance: t.provenance,
    licence: t.licence,
    /** Null until a NAMED community authority says otherwise. Rendered beside
     *  every tale rather than in a page footer: a notice at the top of a screen
     *  scrolls away and stops qualifying anything. */
    validationCommunautaire: null,
    createdAt: t.createdAt,
  };
}

async function conteDeLAuteur(taleId: string, userId: string) {
  const [t] = await db.select().from(tales).where(eq(tales.id, taleId)).limit(1);
  if (!t) throw errors.notFound("Tale not found");
  if (t.submitterUserId !== userId) throw errors.forbidden("Not your submission");
  return t;
}

export function collecteRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // ── Public reading ───────────────────────────────────────
  app.get(
    "/tales",
    describeRoute({ description: "List accepted tales (cursor paginated)", tags: ["collecte"] }),
    optionalAuth,
    validate("query", pageQuery),
    async (c) => {
      const { limit, cursor } = c.req.valid("query");
      const after = decodeCursor(cursor);
      const rows = await db
        .select()
        .from(tales)
        .where(
          and(eq(tales.status, "accepted"), after ? gt(tales.id, after) : undefined),
        )
        .orderBy(asc(tales.id))
        .limit(limit + 1);
      const page = paginate(rows, limit);
      return c.json({ data: page.data.map(publique), nextCursor: page.nextCursor });
    },
  );

  app.get(
    "/tales/:id",
    describeRoute({ description: "One accepted tale, with its versions", tags: ["collecte"] }),
    optionalAuth,
    async (c) => {
      const [t] = await db
        .select()
        .from(tales)
        .where(and(eq(tales.id, c.req.param("id")), eq(tales.status, "accepted")))
        .limit(1);
      if (!t) throw errors.notFound("Tale not found");
      const versions = await db
        .select({
          kind: taleVersions.kind,
          texte: taleVersions.texte,
          origine: taleVersions.origine,
          createdAt: taleVersions.createdAt,
        })
        .from(taleVersions)
        .where(eq(taleVersions.taleId, t.id))
        .orderBy(asc(taleVersions.createdAt));
      // Both forms are published, raw included. Showing only the tidy version
      // would make the 2 % rule unverifiable by anyone outside this codebase.
      return c.json({ ...publique(t), versions });
    },
  );

  // ── Contributing ─────────────────────────────────────────
  app.post(
    "/tales",
    describeRoute({ description: "Start a submission (draft)", tags: ["collecte"] }),
    requireAuth,
    requireRealUser,
    validate("json", nouveauTale),
    async (c) => {
      const b = c.req.valid("json");
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const taleId = id("tale");
      await db.transaction(async (tx) => {
        await tx.insert(tales).values({
          id: taleId,
          submitterUserId: userId,
          nouveaute: b.nouveaute,
          titreSource: b.titreSource,
          dialecteSource: b.dialecteSource ?? null,
          regionCollecte: b.regionCollecte ?? null,
          lieuCollecte: b.lieuCollecte ?? null,
          genreSource: b.genreSource ?? null,
        });
        await tx.insert(taleVersions).values({
          id: id("tver"),
          taleId,
          kind: "brute",
          texte: b.texte,
          texteSha256: sha256(b.texte),
          origine: "saisie du contributeur",
          authorUserId: userId,
        });
      });
      const [t] = await db.select().from(tales).where(eq(tales.id, taleId)).limit(1);
      return c.json({ ...publique(t!), status: t!.status }, 201);
    },
  );

  app.post(
    "/tales/:id/consents",
    describeRoute({ description: "Record one person's consent", tags: ["collecte"] }),
    requireAuth,
    requireRealUser,
    validate("json", nouveauConsentement),
    async (c) => {
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const t = await conteDeLAuteur(c.req.param("id"), userId);
      const b = c.req.valid("json");
      const consentId = id("cons");
      await db.insert(taleConsents).values({
        id: consentId,
        taleId: t.id,
        grantorRole: b.grantorRole,
        grantorDisplay: b.grantorDisplay,
        attribution: b.attribution,
        capturedVia: b.capturedVia,
        langueDuFormulaire: b.langueDuFormulaire,
        finalites: b.finalites,
        niveauIrreversibleAutorise: b.niveauIrreversibleAutorise,
        diffusionPubliqueTexte: b.diffusionPubliqueTexte,
        diffusionPubliqueAudio: b.diffusionPubliqueAudio,
        clonageVocal: b.clonageVocal,
        signedAt: b.signedAt,
      });
      return c.json({ id: consentId }, 201);
    },
  );

  app.post(
    "/tales/:id/corrections",
    describeRoute({ description: "Propose a corrected version", tags: ["collecte"] }),
    requireAuth,
    requireRealUser,
    validate("json", nouvelleCorrection),
    async (c) => {
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const t = await conteDeLAuteur(c.req.param("id"), userId);
      const b = c.req.valid("json");
      const [brute] = await db
        .select()
        .from(taleVersions)
        .where(and(eq(taleVersions.taleId, t.id), eq(taleVersions.kind, "brute")))
        .limit(1);
      if (!brute) throw errors.unprocessable("This tale has no raw version");

      // The rule repparcs/scripts/validate.py enforces at export. Checked here
      // too, because a rule that only fires at the end of a pipeline is one
      // that gets broken for months and discovered on release day.
      const ppm = divergencePpm(brute.texte, b.texte);
      if (ppm > DIVERGENCE_MAX_PPM) {
        throw errors.unprocessable(
          "A correction may repair layout, not rewrite the telling",
          { divergence_ppm: ppm, maximum_ppm: DIVERGENCE_MAX_PPM },
        );
      }
      const [derniere] = await db
        .select({ id: taleVersions.id })
        .from(taleVersions)
        .where(and(eq(taleVersions.taleId, t.id), eq(taleVersions.kind, "corrigee")))
        .orderBy(desc(taleVersions.createdAt))
        .limit(1);
      const versionId = id("tver");
      await db.insert(taleVersions).values({
        id: versionId,
        taleId: t.id,
        kind: "corrigee",
        texte: b.texte,
        texteSha256: sha256(b.texte),
        origine: b.origine,
        authorUserId: userId,
        letterDelta: ppm,
        supersedesId: derniere?.id ?? brute.id,
      });
      return c.json({ id: versionId, divergence_ppm: ppm }, 201);
    },
  );

  app.post(
    "/tales/:id/submit",
    describeRoute({ description: "Send a draft for review", tags: ["collecte"] }),
    requireAuth,
    requireRealUser,
    async (c) => {
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const t = await conteDeLAuteur(c.req.param("id"), userId);
      if (t.status !== "draft") {
        throw errors.conflict(`A ${t.status} submission cannot be sent again`);
      }

      // THE INTAKE GATE. It is deliberately expensive: naming a consenting
      // teller is a statement about a real person, which is far harder to
      // fabricate than fluent text — and fluent text is exactly what an
      // automatic quality measure cannot tell from the real thing, as three
      // failed attempts in the corpus repo established.
      const manquant: string[] = [];
      const [brute] = await db
        .select({ id: taleVersions.id })
        .from(taleVersions)
        .where(and(eq(taleVersions.taleId, t.id), eq(taleVersions.kind, "brute")))
        .limit(1);
      if (!brute) manquant.push("texte");
      if (!t.dialecteSource) manquant.push("dialecteSource");
      const [conteur] = await db
        .select({ id: taleConsents.id })
        .from(taleConsents)
        .where(
          and(eq(taleConsents.taleId, t.id), eq(taleConsents.grantorRole, "conteur")),
        )
        .limit(1);
      // The submitter licenses their transcription; the teller licenses the
      // telling. Two instruments, and only the second can be given by the
      // person the folklore regime exists to protect.
      if (!conteur) manquant.push("consentement du conteur");
      if (manquant.length > 0) {
        throw errors.unprocessable("Incomplete submission", { manquant });
      }

      await db
        .update(tales)
        .set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
        .where(eq(tales.id, t.id));
      return c.json({ id: t.id, status: "submitted" });
    },
  );

  app.get(
    "/me/tales",
    describeRoute({ description: "Your own submissions, at any status", tags: ["collecte"] }),
    requireAuth,
    requireRealUser,
    async (c) => {
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const rows = await db
        .select()
        .from(tales)
        .where(eq(tales.submitterUserId, userId))
        .orderBy(desc(tales.createdAt));
      return c.json({ data: rows.map((t) => ({ ...publique(t), status: t.status })) });
    },
  );

  return app;
}
