import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { livres, pages, pageOcr, ocrJobs } from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { pageQuery, paginate, decodeCursor } from "../lib/pagination.ts";
import { requireAuth } from "../middleware/auth.ts";
import { optionalAuth, requireCorpusRole } from "../middleware/corpus-role.ts";

/**
 * Bibliothèque — les livres numérisés, leurs pages, leurs images.
 *
 * CE QUE LA FRONTIÈRE PROTÈGE ICI, ET CE N'EST PAS LA MÊME CHOSE QUE DANS COLLECTE
 * Dans collecte, la frontière protège le contributeur : sa soumission lui
 * appartient tant qu'elle n'est pas acceptée. Ici elle protège des AYANTS DROIT
 * qui ne sont pas dans la boucle. Un livre de 1980 dont on ignore la date de
 * décès de l'auteur ne se publie pas parce qu'on l'a numérisé.
 *
 * D'où une règle qui traverse chaque lecture publique : `publiable` est faux par
 * défaut, sur le livre ET sur la page, et une page ne peut jamais être plus
 * permissive que son livre — la base le refuse par déclencheur. Le filtre est
 * répété à chaque requête plutôt que confié à une vue, parce qu'une vue qu'on
 * oublie de traverser ne fait pas de bruit.
 *
 * L'ÉCRITURE EST RÉSERVÉE AU CURATEUR
 * `requireCorpusRole("curateur")` est monté ici pour la première fois. Il a été
 * écrit et testé lors de la tranche précédente sans être monté nulle part ;
 * c'est ce module qui lui donne son premier usage réel.
 *
 * Les octets d'image n'ont PAS de route d'écriture par formulaire : ils sont
 * versés par le dépôt de corpus, qui est le seul à savoir d'où ils viennent et
 * sous quel régime. Une plateforme où n'importe qui téléverse une page de livre
 * est une plateforme qui republie du contenu sous droits sans le savoir.
 */

const nouveauLivre = z
  .object({
    sourceRef: z.string().min(1).max(120),
    source: z.enum(["gallica", "archive_org", "scan_local", "autre"]),
    titre: z.string().min(1).max(300),
    auteur: z.string().max(200).optional(),
    annee: z.number().int().min(1500).max(2100).optional(),
    /** La seconde borne, pour un ouvrage paru sur plusieurs millésimes. Écraser
     *  « 1930-1932 » en `1930` serait une coercition muette. */
    anneeFin: z.number().int().min(1500).max(2100).optional(),
    langue: z.string().max(20).default("plt_Latn"),
    pagesTotal: z.number().int().positive().optional(),
    statutFixation: z.enum([
      "DOMAINE_PUBLIC",
      "SOUS_DROITS",
      "LICENCE_CC",
      "SOUS_DROITS_A_ETABLIR",
    ]),
    licence: z.string().min(1).max(300),
    /** Ce que la source a AFFICHÉ, recopié tel quel. « domaine public (notice
     *  Gallica, lue le 2026-08-02) » n'est pas la même affirmation que
     *  « domaine public » : la seconde perd qui l'a dit et quand. */
    licenceConstatee: z.string().max(400).optional(),
    publiable: z.boolean().default(false),
    motifNonPubliable: z.string().max(500).optional(),
    urlNotice: z.string().max(500).optional(),
  })
  .strict()
  .refine((l) => l.publiable || !!l.motifNonPubliable, {
    message: "un livre non publiable doit dire pourquoi",
    path: ["motifNonPubliable"],
  });

/**
 * Les moteurs qu'un exécutant sait réclamer.
 *
 * `moteur` était un texte libre de 60 caractères : une coquille créait un
 * travail qu'aucun exécutant ne viendrait jamais prendre, et — avant que
 * l'unicité ne devienne partielle — elle occupait le créneau (page, moteur)
 * pour toujours.
 *
 * IL N'Y A PAS DE `tesseract-mlg`, ET C'EST UN FAIT, PAS UN CHOIX
 * Tesseract publie 130 langues ; le malgache n'en fait pas partie, sous aucun
 * code (`mlg`, `plt`, `mg` : tous absents de tessdata, tessdata_best et
 * tessdata_fast, vérifié le 2026-08-05). Il a `msa`, `ind`, `jav`, `sun` —
 * quatre parents austronésiens — et pas celui-ci.
 *
 * D'où ces deux moteurs, et pas trois. Une version antérieure annonçait un
 * `tesseract-fra-sansdico`, censé isoler ce que le dictionnaire invente. Mesuré :
 * sur 80 folios, la sortie avec et sans dictionnaire est OCTET POUR OCTET
 * identique — y compris sur des pages en français. tesseract accepte les
 * drapeaux sans avertissement mais tourne en LSTM seul, où ils ne mordent pas ;
 * même `language_model_penalty_non_dict_word=0` ne change rien. Un moteur dont
 * le nom annonce une différence qui n'existe pas est un moteur qui ment.
 *
 * Reste l'écart fra ↔ eng : le modèle de langue complet. Le malgache s'écrit
 * sans accents et sans c, q, u, w, x ; un modèle entraîné sur de l'anglais n'a
 * pas d'accent à proposer, un modèle français en a plein.
 *
 * `humain` n'y figure pas : une transcription humaine n'est pas un travail
 * qu'on met en file, c'est une ligne qu'on verse. Aucun `vision:<modèle>` non
 * plus : la passerelle IA de ce projet n'a aucun chemin pour une image — ses
 * deux fournisseurs sont des CLI locaux lancés avec `--tools ""`, sans entrée
 * standard et en bac à sable lecture seule. Annoncer un moteur qui n'existe pas
 * est la façon dont une file se remplit de travaux que personne ne fera.
 */
export const MOTEURS_CONNUS = ["tesseract-fra", "tesseract-eng"] as const;

const nouvellePage = z
  .object({
    /** Numéro de VUE dans la source — celui qui construit l'URL IIIF. */
    folio: z.number().int().positive(),
    /** Numéro IMPRIMÉ, quand on le connaît. Texte, parce que « xii », « 12bis »
     *  et « — » sont des numéros de page réels.
     *
     *  Il n'est PAS déduit du folio, et la mesure explique pourquoi : l'écart
     *  entre les deux est stable à +6 sur un livre, nul sur un autre, et varie
     *  de +38 à +105 sur un troisième parce qu'il réunit plusieurs volumes.
     *  Une déduction paraîtrait juste sur deux livres et fabriquerait des
     *  citations fausses sur le troisième. */
    pageImprimee: z.string().max(20).optional(),
    texteOcr: z.string().max(200_000).optional(),
    ocrMoteur: z.string().max(60).optional(),
    publiable: z.boolean().optional(),
  })
  .strict();

/** Le livre tel que le public le voit. */
function livrePublic(l: typeof livres.$inferSelect) {
  return {
    id: l.id,
    source: l.source,
    sourceRef: l.sourceRef,
    titre: l.titre,
    auteur: l.auteur,
    annee: l.annee,
    anneeFin: l.anneeFin,
    langue: l.langue,
    pagesTotal: l.pagesTotal,
    /** Les deux statuts voyagent ensemble et ne fusionnent jamais : le récit est
     *  une expression du folklore, seule la fixation porte un droit d'auteur.
     *  Un livre de 1908 dans le domaine public ne rend pas libres les récits
     *  qu'il contient. */
    statutRecit: l.statutRecit,
    statutFixation: l.statutFixation,
    licence: l.licence,
    licenceConstatee: l.licenceConstatee,
    urlNotice: l.urlNotice,
  };
}

/**
 * Une page telle que le public la voit.
 *
 * `imageUrl` est nulle tant que l'image n'a pas été récupérée, ce qui est l'état
 * de la quasi-totalité des pages : les 1 782 images Gallica ont été téléchargées
 * puis jetées par le script d'origine, qui écrivait un JPEG temporaire, appelait
 * tesseract, puis le supprimait. Une page sans image reste une page.
 */
function pagePublique(p: typeof pages.$inferSelect, sourceRef: string, source: string) {
  return {
    id: p.id,
    folio: p.folio,
    pageImprimee: p.pageImprimee,
    texteOcr: p.texteOcr,
    ocrMoteur: p.ocrMoteur,
    /** Bits par caractère, mesuré SANS lexique par detecter_ocr.py. Repères :
     *  Global Voices propre 1,84 · mg.wikipedia 2,36 · Gallica 2,54 ·
     *  Callet 1908 4,15. Publié brut, sans être traduit en « bon / mauvais » :
     *  un seuil posé ici deviendrait un verdict, et ce projet a déjà vu trois
     *  mesures automatiques de qualité du malgache échouer. */
    ocrBitsParCaractere: p.ocrBitsParCaractere == null
      ? null
      : p.ocrBitsParCaractere / 1000,
    imageUrl: p.imageSha256 ? `/v1/bibliotheque/images/${p.imageSha256}` : null,
    imageLargeur: p.imageLargeur,
    imageHauteur: p.imageHauteur,
    /** La même page en 280 px. Sans elle, une grille de 166 folios réclame
     *  41 Mo et 166 bitmaps décodés — `loading="lazy"` diffère, ne réduit pas. */
    vignetteUrl: p.vignetteSha256 ? `/v1/bibliotheque/images/${p.vignetteSha256}` : null,
    /** L'image chez la source, quand elle existe et que nous ne l'avons pas.
     *  Dire où elle est vaut mieux que faire croire qu'elle n'existe pas. */
    urlSource:
      source === "gallica"
        ? `https://gallica.bnf.fr/ark:/12148/${sourceRef}/f${p.folio}.item`
        : null,
  };
}

/** Le livre demandé, et seulement s'il est publiable — ou 404. */
async function livrePubliable(livreId: string) {
  const [l] = await db
    .select()
    .from(livres)
    .where(and(eq(livres.id, livreId), eq(livres.publiable, true)))
    .limit(1);
  // 404 et non 403 : un livre sous droits ne doit pas révéler qu'il existe ici.
  if (!l) throw errors.notFound("Livre introuvable");
  return l;
}

export function bibliothequeRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  // ── Lecture publique ─────────────────────────────────────
  app.get(
    "/livres",
    describeRoute({ description: "Les livres publiables", tags: ["bibliotheque"] }),
    optionalAuth,
    validate("query", pageQuery),
    async (c) => {
      const { limit, cursor } = c.req.valid("query");
      const after = decodeCursor(cursor);
      const rows = await db
        .select()
        .from(livres)
        .where(and(eq(livres.publiable, true), after ? gt(livres.id, after) : undefined))
        .orderBy(asc(livres.id))
        .limit(limit + 1);
      const page = paginate(rows, limit);
      return c.json({ data: page.data.map(livrePublic), nextCursor: page.nextCursor });
    },
  );

  app.get(
    "/livres/:id",
    describeRoute({ description: "Un livre et l'état de ses pages", tags: ["bibliotheque"] }),
    optionalAuth,
    async (c) => {
      const l = await livrePubliable(c.req.param("id"));
      const [compte] = await db
        .select({
          pages: sql<number>`count(*)::int`,
          avecImage: sql<number>`count(${pages.imageSha256})::int`,
          avecTexte: sql<number>`count(${pages.texteOcr})::int`,
        })
        .from(pages)
        .where(eq(pages.livreId, l.id));
      return c.json({
        ...livrePublic(l),
        // Dire combien de pages ont une image ET combien n'en ont pas. Une
        // bibliothèque qui n'affiche que ce qu'elle possède laisse croire
        // qu'elle possède tout.
        pagesConnues: compte?.pages ?? 0,
        pagesAvecImage: compte?.avecImage ?? 0,
        pagesAvecTexte: compte?.avecTexte ?? 0,
      });
    },
  );

  app.get(
    "/livres/:id/pages",
    describeRoute({ description: "Les pages d'un livre", tags: ["bibliotheque"] }),
    optionalAuth,
    validate("query", pageQuery),
    async (c) => {
      const l = await livrePubliable(c.req.param("id"));
      const { limit, cursor } = c.req.valid("query");
      const apres = cursor ? Number(decodeCursor(cursor) ?? 0) : 0;
      // Le filtre de publication est posé EN SQL, pas après la découpe. Appliqué
      // en aval de `slice(limit)`, il rendait moins de pages que demandé sans
      // rien dire, et la page suivante repartait quand même du bon folio : le
      // trou était invisible des deux côtés.
      const rows = await db
        .select()
        .from(pages)
        .where(
          and(
            eq(pages.livreId, l.id),
            gt(pages.folio, apres),
            sql`${pages.publiable} is distinct from false`,
          ),
        )
        .orderBy(asc(pages.folio))
        .limit(limit + 1);
      const suite = rows.length > limit ? rows[limit - 1]?.folio : null;
      return c.json({
        data: rows.slice(0, limit).map((p) => pagePublique(p, l.sourceRef, l.source)),
        nextCursor: suite ? Buffer.from(String(suite)).toString("base64url") : null,
      });
    },
  );

  app.get(
    "/pages/:id",
    describeRoute({ description: "Une page, avec toutes ses océrisations", tags: ["bibliotheque"] }),
    optionalAuth,
    async (c) => {
      const [p] = await db.select().from(pages).where(eq(pages.id, c.req.param("id"))).limit(1);
      if (!p || p.publiable === false) throw errors.notFound("Page introuvable");
      const l = await livrePubliable(p.livreId);
      const passes = await db
        .select({
          id: pageOcr.id,
          moteur: pageOcr.moteur,
          texte: pageOcr.texte,
          accordDocument: pageOcr.accordDocumentMillimes,
          reconnuLexique: pageOcr.reconnuLexiqueMillimes,
          incertitudes: pageOcr.incertitudes,
          createdAt: pageOcr.createdAt,
        })
        .from(pageOcr)
        .where(eq(pageOcr.pageId, p.id))
        .orderBy(asc(pageOcr.createdAt));
      return c.json({
        ...pagePublique(p, l.sourceRef, l.source),
        livre: livrePublic(l),
        /** TOUTES les passes, dans l'ordre, sans en désigner une gagnante.
         *  Deux correcteurs d'OCR entraînés sur ce corpus ont été rejetés APRÈS
         *  avoir paru meilleurs : ils gagnaient 16,6 points de reconnaissance
         *  lexicale en perdant 4,8 points de fidélité au document. Publier la
         *  comparaison est ce qui permet de le voir ; publier un vainqueur est
         *  ce qui l'empêche. */
        ocr: passes.map((o) => ({
          ...o,
          accordDocument: o.accordDocument == null ? null : o.accordDocument / 1000,
          reconnuLexique: o.reconnuLexique == null ? null : o.reconnuLexique / 1000,
        })),
      });
    },
  );

  app.get(
    "/images/:sha256",
    describeRoute({ description: "Les octets d'une image de page", tags: ["bibliotheque"] }),
    async (c) => {
      const h = c.req.param("sha256");
      if (!/^[a-f0-9]{64}$/.test(h)) throw errors.badRequest("empreinte invalide");
      // L'empreinte imprévisible EST l'autorisation, comme pour les clips de
      // routes/tts.ts : une balise <img> ne porte pas de jeton. Mais elle ne
      // suffit pas ici — une image de page sous droits ne doit pas être servie
      // même à qui connaît son empreinte, donc on vérifie le livre.
      //
      // SERVIE SI TOUTES SES RÉFÉRENCES SONT SERVABLES, ET S'IL EN EXISTE UNE.
      // Pas « s'il en existe une servable ». `publiable = false` est une
      // affirmation sur LES OCTETS ; si les mêmes octets sont aussi référencés
      // depuis un livre fermé, l'une des deux étiquettes est fausse et rien ne
      // dit laquelle. Les coûts sont asymétriques : refuser une image libre
      // coûte une tuile blanche, servir un scan sous droits coûte un retrait.
      //
      // Le second EXISTS est requis à part, parce que NOT EXISTS est vrai à vide :
      // sans lui une image orpheline serait servie. L'ancienne jointure la
      // refusait par accident ; celle-ci la refuse exprès.
      //
      // Les DEUX colonnes d'empreinte sont interrogées : l'empreinte d'une
      // vignette n'apparaît jamais dans `image_sha256`, et l'oublier ferait
      // répondre 404 à chaque tuile de la grille.
      const lignes = await db.execute<{ mime: string; contenu: Uint8Array }>(sql`
        select i.mime, i.contenu
          from images i
         where i.sha256 = ${h}
           and exists (
                 select 1 from pages p join livres l on l.id = p.livre_id
                  where (p.image_sha256 = i.sha256 or p.vignette_sha256 = i.sha256)
                    and l.publiable = true
                    and p.publiable is distinct from false)
           and not exists (
                 select 1 from pages p join livres l on l.id = p.livre_id
                  where (p.image_sha256 = i.sha256 or p.vignette_sha256 = i.sha256)
                    and (l.publiable is distinct from true or p.publiable = false))
      `);
      const row = lignes[0];
      if (!row) throw errors.notFound("image introuvable");
      c.header("Content-Type", row.mime);
      c.header("Cache-Control", "public, max-age=86400, immutable");
      c.header("Access-Control-Allow-Origin", "*");
      return c.body(row.contenu as unknown as ArrayBuffer);
    },
  );

  // ── Écriture : curateur seulement ────────────────────────
  app.post(
    "/livres",
    describeRoute({ description: "Verser un livre", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("curateur"),
    validate("json", nouveauLivre),
    async (c) => {
      const b = c.req.valid("json");
      const livreId = id("livre");
      await db.insert(livres).values({
        id: livreId,
        sourceRef: b.sourceRef,
        source: b.source,
        titre: b.titre,
        auteur: b.auteur ?? null,
        annee: b.annee ?? null,
        anneeFin: b.anneeFin ?? null,
        langue: b.langue,
        pagesTotal: b.pagesTotal ?? null,
        statutFixation: b.statutFixation,
        licence: b.licence,
        licenceConstatee: b.licenceConstatee ?? null,
        publiable: b.publiable,
        motifNonPubliable: b.motifNonPubliable ?? null,
        urlNotice: b.urlNotice ?? null,
      });
      const [l] = await db.select().from(livres).where(eq(livres.id, livreId)).limit(1);
      return c.json({ ...livrePublic(l!), publiable: l!.publiable }, 201);
    },
  );

  app.post(
    "/livres/:id/pages",
    describeRoute({ description: "Verser une page", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("curateur"),
    validate("json", nouvellePage),
    async (c) => {
      const [l] = await db.select().from(livres).where(eq(livres.id, c.req.param("id"))).limit(1);
      if (!l) throw errors.notFound("Livre introuvable");
      const b = c.req.valid("json");
      const pageId = id("page");
      // Le déclencheur de la base refusera une page publiable dans un livre qui
      // ne l'est pas ; on ne le rattrape pas ici, on le laisse parler.
      await db.insert(pages).values({
        id: pageId,
        livreId: l.id,
        folio: b.folio,
        pageImprimee: b.pageImprimee ?? null,
        texteOcr: b.texteOcr ?? null,
        ocrMoteur: b.ocrMoteur ?? null,
        publiable: b.publiable ?? null,
      });
      return c.json({ id: pageId, folio: b.folio }, 201);
    },
  );

  app.post(
    "/pages/:id/ocr",
    describeRoute({ description: "Demander une océrisation", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("curateur"),
    validate("json", z.object({ moteur: z.enum(MOTEURS_CONNUS) }).strict()),
    async (c) => {
      const [p] = await db.select().from(pages).where(eq(pages.id, c.req.param("id"))).limit(1);
      if (!p) throw errors.notFound("Page introuvable");
      if (!p.imageSha256) {
        throw errors.unprocessable(
          "cette page n'a pas d'image — il n'y a rien à océriser",
          { folio: p.folio },
        );
      }
      const auth = c.get("auth");
      const moteur = c.req.valid("json").moteur;
      const [insere] = await db
        .insert(ocrJobs)
        .values({
          id: id("ocrjob"),
          pageId: p.id,
          moteur,
          demandeParUserId: auth.kind === "user" ? auth.userId : null,
        })
        // Un index unique sur les travaux EN COURS (page, moteur) empêche de
        // payer deux fois le même appel : redemander la même passe est sans
        // effet, pas une erreur.
        .onConflictDoNothing()
        .returning({ id: ocrJobs.id });
      if (insere) return c.json({ id: insere.id, status: "pending" }, 202);

      // Sur doublon, l'insertion n'a rien rendu. Renvoyer l'identifiant qu'on
      // avait tiré serait renvoyer une référence qui n'existe pas en base — et
      // 202 (« ce sera fait ») serait faux, puisque rien de neuf ne se produira.
      const [deja] = await db
        .select({ id: ocrJobs.id, status: ocrJobs.status })
        .from(ocrJobs)
        .where(and(eq(ocrJobs.pageId, p.id), eq(ocrJobs.moteur, moteur)))
        .orderBy(desc(ocrJobs.createdAt))
        .limit(1);
      return c.json({ id: deja!.id, status: deja!.status, deja: true }, 200);
    },
  );

  return app;
}
