import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import {
  livres,
  livresSupprimes,
  pages,
  pageOcr,
  ocrJobs,
  pageCorrections,
  pageCorrectionAvis,
  contributorProfiles,
} from "../db/schema.ts";
import type { Variables } from "../types.ts";
import { id } from "../lib/ids.ts";
import { sha256 } from "../lib/crypto.ts";
import { enregistrerGardien, ficheObjet, supprimerObjet } from "../lib/stockage/index.ts";
import { urlObjet } from "./objets.ts";
import { appliquer, contexte } from "../lib/bibliotheque/corrections.ts";
import { errors } from "../lib/errors.ts";
import { validate } from "../lib/validate.ts";
import { pageQuery, paginate, decodeCursor } from "../lib/pagination.ts";
import { requireAuth } from "../middleware/auth.ts";
import {
  detientRole,
  optionalAuth,
  requireCorpusRole,
  requireRealUser,
} from "../middleware/corpus-role.ts";

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

/**
 * Les champs d'un livre — l'objet NU, sans `.strict()` ni `.refine()`.
 *
 * Il est extrait pour que le correctif puisse en dériver : `.partial()` ne se
 * chaîne pas sur `nouveauLivre`, qui finit par un `.refine()` et n'est donc plus
 * un `ZodObject` mais un `ZodEffects`. Recopier les champs à la main aurait
 * marché le premier jour et divergé au premier ajout — un plafond changé d'un
 * côté seulement ne fait aucun bruit.
 */
const champsLivre = z.object({
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
});

const nouveauLivre = champsLivre
  .strict()
  .refine((l) => l.publiable || !!l.motifNonPubliable, {
    message: "un livre non publiable doit dire pourquoi",
    path: ["motifNonPubliable"],
  });

/**
 * Ce qu'on peut corriger sur un livre déjà déposé.
 *
 * `source` ET `sourceRef` SONT ABSENTS, ET C'EST UN REFUS, PAS UN OUBLI.
 * Ils forment l'identité du dépôt — `livres_source_uq` en fait une clé — et les
 * changer ne corrigerait pas le livre : ça le ferait pointer vers un autre
 * ouvrage, en gardant ses pages, ses océrisations et ses corrections. Un dépôt
 * fait sur la mauvaise notice se supprime et se refait.
 *
 * PAS DE `.refine()` ICI. L'invariant « un livre non publiable doit dire
 * pourquoi » porte sur le livre, pas sur le correctif : envoyer `publiable:
 * false` seul est légitime quand le motif est déjà en base. Il est donc vérifié
 * plus bas, sur la ligne FUSIONNÉE.
 *
 * Les champs facultatifs acceptent `null` — et c'est la seule façon d'EFFACER.
 * À la création, on vide en omettant ; sur un correctif, omettre veut dire « ne
 * touche pas ». Sans le `null`, un auteur saisi par erreur resterait à vie.
 */
const correctifLivre = champsLivre
  .omit({ sourceRef: true, source: true })
  .partial()
  .extend({
    auteur: z.string().max(200).nullish(),
    annee: z.number().int().min(1500).max(2100).nullish(),
    anneeFin: z.number().int().min(1500).max(2100).nullish(),
    pagesTotal: z.number().int().positive().nullish(),
    licenceConstatee: z.string().max(400).nullish(),
    motifNonPubliable: z.string().max(500).nullish(),
    urlNotice: z.string().max(500).nullish(),
  })
  .strict();

/**
 * Les champs que seul un curateur ou un modérateur peut toucher.
 *
 * CE SONT LES CINQ QUI DÉCIDENT SI DES OCTETS SORTENT. Le déposant décrit son
 * livre — titre, auteur, année, langue, nombre de pages — et cette description
 * n'ouvre aucune porte. La déclaration de droits, elle, est ce sur quoi la
 * modération s'est prononcée : la laisser modifier par son auteur reviendrait à
 * pouvoir republier un ouvrage refusé en changeant sa propre étiquette.
 */
const CHAMPS_DROITS = [
  "publiable",
  "statutFixation",
  "licence",
  "licenceConstatee",
  "motifNonPubliable",
] as const;

/** Le motif d'un retrait ou d'une suppression. Trois caractères au moins :
 *  « x » n'est pas une raison, et c'est cette ligne que lira le déposant. */
const avecMotif = z.object({ motif: z.string().min(3).max(1000) }).strict();

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

/**
 * Le moteur d'une lecture SCELLÉE par un relecteur.
 *
 * Il ne rejoint pas `MOTEURS_CONNUS`, et ce n'est pas un oubli : cette liste est
 * celle de la file de travaux. Une transcription humaine n'est pas un travail
 * qu'on met en file, c'est une ligne qu'on verse — et le mettre là ferait
 * réclamer par un exécutant un travail que personne ne peut faire à sa place.
 */
export const MOTEUR_RELECTURE = "humain:relecture";

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
    /** L'empreinte d'une image DÉJÀ versée par `POST /v1/objets`.
     *
     *  Deux étapes plutôt qu'une : les octets voyagent seuls, sans le JSON qui
     *  les décrit, ce qui laisse le plafond de corps ordinaire à 1 Mio partout
     *  ailleurs et permet de redéposer un folio sans renvoyer sa photo. */
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    imageLargeur: z.number().int().positive().max(40_000).optional(),
    imageHauteur: z.number().int().positive().max(40_000).optional(),
    /** La même page en petit. SON EMPREINTE N'EST JAMAIS CELLE DE L'IMAGE :
     *  ce sont deux objets distincts, et la route qui les sert interroge les
     *  deux colonnes. Sans vignette, la grille d'un livre charge les images
     *  pleines — 60 photos de téléphone font 300 Mo à chaque ouverture. */
    vignetteSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict();

/**
 * Ce qu'on peut corriger sur un folio déjà versé.
 *
 * `texteOcr` et `ocrMoteur` n'y sont PAS. La première lecture est un fait
 * observé — ce que le moteur a lu — et le corriger à la main en ferait une
 * affirmation dont plus rien ne dirait l'origine. Le texte se corrige par
 * `POST /pages/:id/corrections`, qui garde le lu, le proposé et le motif.
 *
 * `livreId` n'y est pas non plus : déplacer une vue d'un livre à l'autre n'est
 * pas une correction, c'est un dépôt refait.
 */
const correctifPage = z
  .object({
    folio: z.number().int().positive(),
    pageImprimee: z.string().max(20).nullish(),
    publiable: z.boolean().nullish(),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
    vignetteSha256: z.string().regex(/^[a-f0-9]{64}$/).nullish(),
    imageLargeur: z.number().int().positive().max(40_000).nullish(),
    imageHauteur: z.number().int().positive().max(40_000).nullish(),
  })
  .partial()
  .strict();

/** La nouvelle numérotation, pour le livre entier. */
const renumerotation = z
  .object({
    folios: z
      .array(
        z.object({
          id: z.string().min(1).max(60),
          folio: z.number().int().positive(),
        }).strict(),
      )
      .min(1)
      // Le plus gros livre du corpus en a 374 ; le plafond laisse de la marge
      // sans ouvrir un corps arbitrairement grand.
      .max(2000),
  })
  .strict();

/**
 * Une correction proposée sur un passage.
 *
 * `baseOcrId` est OBLIGATOIRE, et ce n'est pas de la cérémonie : `page_ocr` n'a
 * volontairement pas d'unicité (page, moteur), donc deux passes du même moteur
 * peuvent coexister. Laisser le serveur choisir la base ferait enregistrer une
 * correction dont le `lu` correspond par hasard aux mêmes offsets dans une autre
 * lecture, et dont le sens est faux.
 *
 * `propose` peut être VIDE : c'est une suppression, et retirer du bruit inséré
 * par l'OCR est la correction la plus fréquente sur ces pages. Il n'est ni rogné
 * ni normalisé — normaliser vers une forme canonique est, en miniature, la faute
 * qui a fait rejeter deux correcteurs sur ce corpus.
 *
 * AUCUN CONTRÔLE PHONOTACTIQUE ICI, et c'est délibéré. `refusPhonotactique`
 * exige une finale vocalique ; or `tamin'`, `amin'`, `n'` — les élisions d'avant
 * 1908 dont ces livres sont pleins — finissent par une consonne. Le contrôle
 * rejetterait les graphies anciennes qu'on veut préserver et accepterait leurs
 * remplacements modernisés. Et le corpus est bilingue par construction.
 */
const nouvelleCorrection = z
  .object({
    /** 80 et non 60 comme les autres identifiants du dépôt : les lectures
     *  reprises par la migration 0007 portent un identifiant DÉRIVÉ de leur page
     *  (`ocr_` + un sha256 hexadécimal), ce qui fait 68 caractères. C'était le
     *  prix d'une reprise rejouable sans doublon — et `page_ocr` interdisant
     *  l'UPDATE comme le DELETE direct, ces identifiants ne se renomment pas.
     *  Le plafond dit donc la vérité de la table plutôt que celle de `ids.ts`. */
    baseOcrId: z.string().min(1).max(80),
    debut: z.number().int().min(0),
    fin: z.number().int().min(1),
    lu: z.string().min(1).max(400),
    propose: z.string().max(1000),
    motif: z.string().max(500).optional(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })
  .strict();

const nouvelAvis = z
  .object({
    avis: z.enum(["accord", "desaccord"]),
    /** Un avis sans motif est un avis qu'on ne peut ni discuter ni rejouer.
     *  Le protocole hors ligne de ce projet demande la raison, pas la note. */
    motif: z.string().max(500).optional(),
  })
  .strict();

const filtreCorrections = z.object({
  statut: z
    .enum(["proposee", "acceptee", "refusee", "retiree", "obsolete", "revoquee"])
    .default("proposee"),
  livre: z.string().max(60).optional(),
  page: z.string().max(60).optional(),
  proposeur: z.string().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

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
    /** `null` veut dire « comme le livre » — un état à part de `false`, et le
     *  confondre avec lui ferait qu'un écran de correction restreint toutes les
     *  vues qu'il enregistre. Dans une liste publique la valeur est toujours
     *  `true` ou `null`, les autres étant filtrées : le champ n'y apprend rien.
     *  Il n'existe que pour qui peut voir — et corriger — les vues fermées. */
    publiable: p.publiable,
    imageUrl: urlObjet(p.imageSha256),
    imageLargeur: p.imageLargeur,
    imageHauteur: p.imageHauteur,
    /** La même page en 280 px. Sans elle, une grille de 166 folios réclame
     *  41 Mo et 166 bitmaps décodés — `loading="lazy"` diffère, ne réduit pas. */
    vignetteUrl: urlObjet(p.vignetteSha256),
    /** L'image chez la source, quand elle existe et que nous ne l'avons pas.
     *  Dire où elle est vaut mieux que faire croire qu'elle n'existe pas. */
    urlSource:
      source === "gallica"
        ? `https://gallica.bnf.fr/ark:/12148/${sourceRef}/f${p.folio}.item`
        : null,
  };
}

/**
 * La page demandée, et seulement si elle ET son livre sont publiables — ou 404.
 *
 * Extrait de `GET /pages/:id`, où il était en ligne : les routes de correction
 * doivent poser exactement la même question, et une frontière recopiée est une
 * frontière qu'on finit par recopier de travers.
 */
async function pagePubliable(pageId: string, vu?: string | null) {
  const [p] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!p || p.publiable === false) throw errors.notFound("Page introuvable");
  return { page: p, livre: await livrePubliable(p.livreId, vu) };
}

/**
 * L'état de correction d'une page : le texte corrigé, ses éditions, et ce qui
 * attend encore un relecteur.
 *
 * LE TEXTE CORRIGÉ EST DÉRIVÉ, base + corrections acceptées, à cet instant. Il
 * n'a donc ni identifiant ni empreinte, et n'est pas citable : c'est le rôle du
 * SCELLEMENT, qui en fait une ligne de `page_ocr`.
 *
 * Le public voit les corrections acceptées et un COMPTE de celles en attente,
 * jamais leur contenu. Sans cela, « n'importe qui peut proposer » plus « tout le
 * monde voit les propositions » ferait d'une page publique un canal de
 * dégradation.
 */
async function etatCorrection(
  pageId: string,
  passes: { id: string; moteur: string; texte: string; createdAt: Date }[],
) {
  const lignes = await db
    .select()
    .from(pageCorrections)
    .where(eq(pageCorrections.pageId, pageId));
  if (lignes.length === 0) return null;

  // Une base par lecture : les offsets d'une correction ne valent que dans la
  // passe où ils ont été posés.
  const acceptees = lignes.filter((x) => x.statut === "acceptee");
  const enAttente = lignes.filter((x) => x.statut === "proposee").length;
  const base = passes.find((p) => p.id === acceptees[0]?.baseOcrId);
  const scelle = [...passes]
    .reverse()
    .find((p) => p.moteur === MOTEUR_RELECTURE);

  return {
    base: base?.id ?? null,
    texte: base
      ? appliquer(base.texte, acceptees.map((e) => ({
          debut: e.debut, fin: e.fin, propose: e.propose,
        })))
      : null,
    editions: acceptees
      .sort((a, b) => a.debut - b.debut)
      .map((e) => ({
        id: e.id, debut: e.debut, fin: e.fin, lu: e.lu, propose: e.propose,
        motif: e.motif,
      })),
    propositionsEnAttente: enAttente,
    relectureScellee: scelle
      ? {
          ocrId: scelle.id,
          le: scelle.createdAt,
          // La dérive après scellement est AFFICHÉE, pas cachée : une dérive
          // qu'on ne montre pas est celle qui mord.
          correctionsDepuis: acceptees.filter(
            (e) => e.createdAt > scelle.createdAt,
          ).length,
        }
      : null,
  };
}

/** Le livre demandé, et seulement s'il est publiable — ou 404. */
/**
 * Le livre demandé — ou 404, y compris quand il existe.
 *
 * TROIS PERSONNES PEUVENT LE VOIR, ET POUR TROIS RAISONS DIFFÉRENTES
 *   le public       s'il est publiable ET accepté par la modération
 *   son déposant    toujours, sinon il ne peut pas relire ce qu'il vient d'envoyer
 *   un modérateur   toujours, sinon il ne peut pas juger
 *
 * `publiable` et `statut_moderation` sont deux questions distinctes et le
 * restent : « avons-nous le droit » n'est pas « quelqu'un a-t-il vérifié ». Les
 * réunir ferait disparaître la seconde, qui est précisément celle que le dépôt
 * ouvert rend obligatoire.
 *
 * 404 et non 403 : un livre sous droits, ou refusé, ne doit pas révéler qu'il
 * existe ici. Un 403 confirmerait l'identifiant à qui le devine.
 */
async function livrePubliable(livreId: string, demandeur?: string | null) {
  const [l] = await db.select().from(livres).where(eq(livres.id, livreId)).limit(1);
  if (!l) throw errors.notFound("Livre introuvable");
  if (l.publiable && l.statutModeration === "accepte") return l;
  if (demandeur && l.deposeParUserId === demandeur) return l;
  if (demandeur && (await detientRole(demandeur, "moderateur", "curateur"))) return l;
  throw errors.notFound("Livre introuvable");
}

/** L'identifiant du demandeur, quand il y en a un. */
function demandeur(c: { get: (k: "auth") => unknown }): string | null {
  const a = c.get("auth") as { kind?: string; userId?: string } | undefined;
  return a?.kind === "user" ? (a.userId ?? null) : null;
}

/**
 * Qui peut faire quoi sur ce livre. UNE SEULE FONCTION LE DIT, ET TROIS ROUTES LA LISENT.
 *
 * Trois pouvoirs distincts, et les confondre serait une faute pour chacun :
 *
 *   modifier         le déposant décrit son propre livre — titre, auteur, année
 *   modifierDroits   réservé : c'est ce qui décide si des octets sortent, et le
 *                    déposant qui a déclaré son livre sous droits pourrait sinon
 *                    se rétracter tout seul le lendemain
 *   supprimer        modérateur SEUL — c'est irréversible et ça détruit aussi le
 *                    travail de tiers (corrections proposées, avis rendus), qui
 *                    n'appartient pas au déposant
 *
 * La réponse voyage jusqu'à l'écran pour qu'il n'ait pas à recopier la règle :
 * deux copies d'une règle d'accès divergent toujours, et toujours du côté
 * permissif, parce que c'est celui dont personne ne se plaint.
 */
async function peutGerer(l: typeof livres.$inferSelect, moi: string | null) {
  if (!moi) {
    return { peutModifier: false, peutModifierDroits: false, peutSupprimer: false };
  }
  const deposant = l.deposeParUserId != null && l.deposeParUserId === moi;
  const roles = await rolesDeGestion(moi);
  return {
    peutModifier: deposant || roles.curateur || roles.moderateur,
    peutModifierDroits: roles.curateur || roles.moderateur,
    peutSupprimer: roles.moderateur,
  };
}

/**
 * Le folio demandé, et seulement si l'appelant peut agir dessus — ou 404 / 403.
 *
 * Il passe par `livrePubliable`, donc un folio dont le livre est invisible rend
 * 404 comme le livre lui-même : répondre autrement apprendrait, à qui devine un
 * identifiant de page, que le livre existe.
 */
async function pageGerable(pageId: string, moi: string) {
  const [p] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!p) throw errors.notFound("Page introuvable");
  const l = await livrePubliable(p.livreId, moi);
  if (!(await peutGerer(l, moi)).peutModifier) {
    throw errors.forbidden(
      "ce livre n'est pas le vôtre — son déposant, un curateur ou un modérateur peuvent en corriger les vues",
    );
  }
  return { page: p, livre: l };
}

/**
 * Détruit une empreinte si plus AUCUNE autre page ne la référence.
 *
 * L'adressage par contenu déduplique : deux vues d'un même livre — ou de deux
 * livres — peuvent porter les mêmes octets. Détruire sans regarder emporterait
 * l'image de l'autre, et personne ne le verrait avant qu'une tuile ne manque.
 *
 * Les DEUX colonnes sont interrogées : une empreinte de vignette n'apparaît
 * jamais dans `image_sha256`.
 */
async function detruireSiOrpheline(sha256: string, saufPageId: string): Promise<boolean> {
  const [r] = await db.execute<{ ailleurs: boolean }>(sql`
    select exists (
      select 1 from pages
       where id <> ${saufPageId}
         and (image_sha256 = ${sha256} or vignette_sha256 = ${sha256})) as ailleurs
  `);
  if (r?.ailleurs) return false;
  await supprimerObjet(sha256);
  return true;
}

/** Les deux rôles qui pèsent sur un livre, lus d'un coup. */
async function rolesDeGestion(moi: string) {
  const [curateur, moderateur] = await Promise.all([
    detientRole(moi, "curateur"),
    detientRole(moi, "moderateur"),
  ]);
  return { curateur, moderateur };
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
        // La modération conditionne la MISE EN AVANT. Un livre déposé et non
        // encore jugé n'apparaît dans aucune liste — ses images restent
        // joignables par leur empreinte, ce qui permet au déposant de se relire
        // sans que personne d'autre ne tombe dessus.
        .where(and(
          eq(livres.publiable, true),
          eq(livres.statutModeration, "accepte"),
          after ? gt(livres.id, after) : undefined,
        ))
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
      const moi = demandeur(c);
      const l = await livrePubliable(c.req.param("id"), moi);
      const [compte] = await db
        .select({
          pages: sql<number>`count(*)::int`,
          avecImage: sql<number>`count(${pages.imageSha256})::int`,
          avecTexte: sql<number>`count(${pages.texteOcr})::int`,
        })
        .from(pages)
        .where(eq(pages.livreId, l.id));

      // Qui peut agir sur ce livre, DIT PAR L'API plutôt que deviné par l'écran.
      // Le front recopiait sinon la règle d'autorisation en TypeScript, et deux
      // copies d'une règle d'accès finissent toujours par diverger — dans le
      // sens permissif, puisque c'est celui qui ne provoque aucune plainte.
      const gestionnaire = await peutGerer(l, moi);

      return c.json({
        ...livrePublic(l),
        // Dire combien de pages ont une image ET combien n'en ont pas. Une
        // bibliothèque qui n'affiche que ce qu'elle possède laisse croire
        // qu'elle possède tout.
        pagesConnues: compte?.pages ?? 0,
        pagesAvecImage: compte?.avecImage ?? 0,
        pagesAvecTexte: compte?.avecTexte ?? 0,
        // L'état de modération n'est rendu QUE là où le livre est visible, et
        // `livrePubliable` a déjà tranché qui le voit. Le taire au déposant
        // reviendrait à lui cacher pourquoi son dépôt n'apparaît nulle part.
        statutModeration: l.statutModeration,
        motifModeration: l.motifModeration,
        deposeParMoi: l.deposeParUserId != null && l.deposeParUserId === moi,
        /**
         * L'ÉTAT DE DROITS N'EST RENDU QU'À QUI PEUT LE CHANGER.
         *
         * `livrePublic()` ne l'expose pas, et c'est volontaire — un lecteur n'a
         * rien à faire de `motifNonPubliable`. Mais un formulaire de correction
         * ne peut alors rien pré-remplir : il afficherait des cases vides et les
         * enverrait telles quelles, effaçant la déclaration du déposant à la
         * première sauvegarde. C'est pour ce formulaire, et pour lui seul, que
         * ces trois champs sortent.
         */
        gestion: gestionnaire.peutModifier
          ? {
              publiable: l.publiable,
              motifNonPubliable: l.motifNonPubliable,
              retire: l.retireLe
                ? { le: l.retireLe, motif: l.motifRetrait }
                : null,
              peutModifierDroits: gestionnaire.peutModifierDroits,
              peutSupprimer: gestionnaire.peutSupprimer,
            }
          : null,
      });
    },
  );

  app.get(
    "/livres/:id/pages",
    describeRoute({ description: "Les pages d'un livre", tags: ["bibliotheque"] }),
    optionalAuth,
    validate("query", pageQuery),
    async (c) => {
      const moi = demandeur(c);
      const l = await livrePubliable(c.req.param("id"), moi);
      const { limit, cursor } = c.req.valid("query");
      const apres = cursor ? Number(decodeCursor(cursor) ?? 0) : 0;

      /**
       * QUI PEUT GÉRER LE LIVRE VOIT AUSSI SES VUES FERMÉES.
       *
       * Sans cette exception, une vue passée à `publiable = false` disparaissait
       * pour TOUT LE MONDE — son déposant compris — et plus rien ne pouvait la
       * rouvrir : la liste la filtrait, `GET /pages/:id` répondait 404, et il
       * n'existait aucune route pour la corriger. Une case cochée par erreur au
       * dépôt effaçait donc une page de façon définitive, sans rien détruire et
       * sans que personne puisse le constater.
       */
      const gestionnaire = (await peutGerer(l, moi)).peutModifier;

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
            gestionnaire ? undefined : sql`${pages.publiable} is distinct from false`,
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
      const { page: p, livre: l } = await pagePubliable(c.req.param("id"), demandeur(c));
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
        /** Le texte corrigé vit SOUS SA PROPRE CLÉ, et surtout pas dans `ocr[]`.
         *  Ce tableau porte l'affirmation « aucune n'est désignée juste », que la
         *  visionneuse imprime dès qu'il en contient plus d'une. Une lecture
         *  validée par un humain EST désignée meilleure — c'est légitime, et
         *  c'est précisément pour ça qu'elle ne peut pas voyager là-dedans. */
        correction: await etatCorrection(p.id, passes),
      });
    },
  );

  /**
   * QUI PEUT VOIR UNE IMAGE DE PAGE — la part de la bibliothèque, et rien d'autre.
   *
   * La route qui sert les octets a quitté ce fichier : c'est `/v1/objets/:sha256`,
   * commune à toutes les fonctionnalités. Ce qui reste ici est la seule chose
   * qu'elle ne pouvait pas savoir — la règle de droits propre aux livres.
   *
   * SERVABLE SI TOUTES SES RÉFÉRENCES LE SONT, ET S'IL EN EXISTE UNE.
   * Pas « s'il en existe une servable ». `publiable = false` est une affirmation
   * sur LES OCTETS ; si les mêmes octets sont aussi référencés depuis un livre
   * fermé, l'une des deux étiquettes est fausse et rien ne dit laquelle. Les
   * coûts sont asymétriques : refuser une image libre coûte une tuile blanche,
   * servir un scan sous droits coûte un retrait.
   *
   * Le second EXISTS est requis à part, parce que NOT EXISTS est vrai à vide :
   * sans lui une image orpheline serait servie. L'ancienne jointure la refusait
   * par accident ; celle-ci la refuse exprès. Ce raisonnement vaut désormais
   * pour tout le dépôt : `objetServable()` le fait voter entre gardiens.
   *
   * Les DEUX colonnes d'empreinte sont interrogées : l'empreinte d'une vignette
   * n'apparaît jamais dans `image_sha256`, et l'oublier ferait répondre 404 à
   * chaque tuile de la grille.
   */
  enregistrerGardien({
    nom: "bibliotheque",
    async verdict(sha256) {
      const [r] = await db.execute<{ servable: boolean; refusee: boolean }>(sql`
        select
          exists (
            select 1 from pages p join livres l on l.id = p.livre_id
             where (p.image_sha256 = ${sha256} or p.vignette_sha256 = ${sha256})
               and l.publiable = true
               and p.publiable is distinct from false) as servable,
          exists (
            select 1 from pages p join livres l on l.id = p.livre_id
             where (p.image_sha256 = ${sha256} or p.vignette_sha256 = ${sha256})
               and (l.publiable is distinct from true
                    or p.publiable = false
                    -- Un livre REFUSÉ par la modération vaut refus des octets.
                    -- « en attente » n'en est pas un : le déposant doit pouvoir
                    -- se relire, et le modérateur doit pouvoir regarder ce qu'il
                    -- juge. Ce que la modération ferme, c'est la mise en avant.
                    or l.statut_moderation = 'refuse')) as refusee
      `);
      if (r?.refusee) return "refusee";
      return r?.servable ? "servable" : "inconnue";
    },
  });

  // ── Écriture : curateur seulement ────────────────────────
  /**
   * Déposer un livre. OUVERT À TOUT COMPTE RÉEL depuis que le téléversement l'est.
   *
   * CE QUI CHANGE SELON QUI DÉPOSE, ET CE QUI NE CHANGE PAS
   * Un curateur dépose un ouvrage déjà accepté : son travail EST la vérification,
   * et lui demander de se modérer lui-même n'ajouterait rien qu'une file qu'il
   * viderait seul. Tout autre compte dépose en attente — le livre existe, son
   * déposant le voit, et personne d'autre ne le trouve avant qu'un modérateur
   * n'ait tranché.
   *
   * Ce qui ne change pas : la déclaration de droits est obligatoire pour tout le
   * monde, `nouveauLivre` refuse déjà un livre non publiable qui ne dit pas
   * pourquoi, et le déposant est nommé dans la ligne — sans quoi un retrait à sa
   * demande serait impossible.
   */
  app.post(
    "/livres",
    describeRoute({ description: "Déposer un livre", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", nouveauLivre),
    async (c) => {
      const b = c.req.valid("json");
      const moi = demandeur(c)!;
      const curateur = await detientRole(moi, "curateur");
      const livreId = id("livre");
      await db.insert(livres).values({
        id: livreId,
        deposeParUserId: moi,
        statutModeration: curateur ? "accepte" : "en_attente",
        modereParUserId: curateur ? moi : null,
        modereLe: curateur ? new Date() : null,
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
      return c.json(
        {
          ...livrePublic(l!),
          publiable: l!.publiable,
          statutModeration: l!.statutModeration,
        },
        201,
      );
    },
  );

  /**
   * Corriger un livre déjà déposé.
   *
   * DEUX FRONTIÈRES, ET ELLES NE RÉPONDENT PAS LA MÊME CHOSE
   *   404  le demandeur ne voit pas ce livre — répondre 403 confirmerait à qui
   *        devine un identifiant qu'il a visé juste
   *   403  il le voit, mais il n'y a pas droit — c'est le cas d'un lecteur sur
   *        un livre public, et lui mentir par un 404 serait incompréhensible
   *
   * SEULES LES CLÉS ENVOYÉES SONT TOUCHÉES, et seules celles qui changent
   * réellement sont écrites. La distinction compte : un écran qui renvoie tout
   * le formulaire à chaque enregistrement enverrait aussi les champs de droits,
   * qu'il n'a pas le droit de toucher — et ferait repartir en modération un
   * livre dont on corrigeait une coquille.
   */
  app.patch(
    "/livres/:id",
    describeRoute({ description: "Corriger un livre", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", correctifLivre),
    async (c) => {
      const moi = demandeur(c)!;
      const l = await livrePubliable(c.req.param("id"), moi);
      const pouvoirs = await peutGerer(l, moi);
      if (!pouvoirs.peutModifier) {
        throw errors.forbidden(
          "ce livre n'est pas le vôtre — son déposant, un curateur ou un modérateur peuvent le corriger",
        );
      }

      // Zod n'ajoute pas les clés absentes du corps : ce tableau est exactement
      // ce que l'appelant a envoyé, ni plus ni moins.
      const b = c.req.valid("json") as Record<string, unknown>;
      const envoyes = Object.keys(b);
      if (envoyes.length === 0) {
        throw errors.unprocessable("aucun champ à modifier");
      }

      const droitsVises = envoyes.filter((k) =>
        (CHAMPS_DROITS as readonly string[]).includes(k),
      );
      if (droitsVises.length > 0 && !pouvoirs.peutModifierDroits) {
        throw errors.forbidden(
          `${droitsVises.join(", ")} : la déclaration de droits ne se corrige que par un ` +
            `curateur ou un modérateur — c'est elle qui décide si les images sortent`,
        );
      }

      // Ce qui CHANGE, et pas ce qui a été envoyé. Un formulaire renvoie
      // volontiers des valeurs identiques ; les écrire ferait bouger `updatedAt`
      // et, sur les champs de droits, renverrait le livre en modération pour
      // rien.
      const ligne = l as unknown as Record<string, unknown>;
      const changes: Record<string, unknown> = {};
      for (const k of envoyes) {
        const apres = b[k] === undefined ? null : b[k];
        if (ligne[k] !== apres) changes[k] = apres;
      }
      const droitsChanges = Object.keys(changes).filter((k) =>
        (CHAMPS_DROITS as readonly string[]).includes(k),
      );

      if (Object.keys(changes).length === 0) {
        return c.json({ id: l.id, modifie: [], renvoyeEnModeration: false });
      }

      // L'invariant se vérifie sur la ligne FUSIONNÉE, jamais sur le correctif :
      // `publiable: false` seul est parfaitement licite quand le motif est déjà
      // en base, et le refuser obligerait à réécrire le motif à chaque fois.
      const fusion = { ...ligne, ...changes } as typeof l;
      if (!fusion.publiable && !fusion.motifNonPubliable?.trim()) {
        throw errors.unprocessable("un livre non publiable doit dire pourquoi", {
          champ: "motifNonPubliable",
        });
      }
      // Republier par correctif un livre RETIRÉ serait contourner le
      // rétablissement, qui est réservé et qui, lui, restaure l'état d'avant
      // plutôt que d'en inventer un. La base le refuserait aussi
      // (`livres_retire_non_publiable_ck`), mais avec une erreur Postgres.
      if (fusion.publiable && l.retireLe) {
        throw errors.unprocessable(
          "ce livre est retiré — il se republie par POST /livres/:id/retablissement, pas par un correctif",
        );
      }

      /**
       * UN CHANGEMENT DE DROITS ANNULE LA MODÉRATION QUI PORTAIT SUR LES ANCIENS.
       *
       * `statut_moderation` répond « quelqu'un a-t-il vérifié ». Vérifié QUOI :
       * la déclaration telle qu'elle était au moment de la décision. Changer la
       * licence après coup laisserait un livre marqué « accepté » sur une
       * déclaration que personne n'a jamais lue.
       *
       * La correction d'une coquille dans le titre, elle, ne remet rien en file :
       * c'est exactement pourquoi l'écran n'envoie que ce qui change.
       */
      const renvoi = droitsChanges.length > 0 && l.statutModeration === "accepte";

      await db
        .update(livres)
        .set({
          ...(changes as Partial<typeof livres.$inferInsert>),
          ...(renvoi
            ? {
                statutModeration: "en_attente",
                motifModeration: null,
                modereParUserId: null,
                modereLe: null,
              }
            : {}),
          // Aucun déclencheur ne maintient `updated_at` sur cette table.
          updatedAt: new Date(),
        })
        .where(eq(livres.id, l.id));

      const [apres] = await db.select().from(livres).where(eq(livres.id, l.id)).limit(1);
      return c.json({
        ...livrePublic(apres!),
        publiable: apres!.publiable,
        motifNonPubliable: apres!.motifNonPubliable,
        statutModeration: apres!.statutModeration,
        modifie: Object.keys(changes),
        // DIT, et pas subi : sans ce drapeau, le déposant verrait son livre
        // quitter la bibliothèque publique sans comprendre pourquoi.
        renvoyeEnModeration: renvoi,
      });
    },
  );

  /**
   * Retirer un livre de la publication — RÉVERSIBLE.
   *
   * C'est le geste qu'on fait quand un ayant droit écrit, et il doit être
   * possible en une seconde, sans réunion et sans suppression : les octets
   * cessent de sortir, le livre reste, et si la réclamation ne tient pas on le
   * remet. Une plateforme qui n'a que la suppression finit par ne rien faire.
   *
   * LE RETRAIT NE TOUCHE PAS `motif_non_publiable`, et c'est tout l'objet des
   * colonnes ajoutées par la migration 0010. Ce champ-là est la DÉCLARATION du
   * déposant — « je n'ai pas les droits » — et l'écraser par « retiré à la
   * demande de X » ferait disparaître la raison d'origine. Les deux états
   * étaient auparavant indiscernables, si bien qu'un rétablissement aveugle
   * aurait publié une œuvre que personne n'avait jamais eu le droit de publier.
   *
   * OUVERT AU DÉPOSANT, parce que retirer est TOUJOURS une restriction. Le
   * risque d'un pouvoir donné trop largement est qu'il serve à ouvrir ; celui-ci
   * ne peut que fermer.
   */
  app.post(
    "/livres/:id/retrait",
    describeRoute({ description: "Retirer un livre de la publication", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", avecMotif),
    async (c) => {
      const moi = demandeur(c)!;
      const l = await livrePubliable(c.req.param("id"), moi);
      const pouvoirs = await peutGerer(l, moi);
      if (!pouvoirs.peutModifier) {
        throw errors.forbidden(
          "ce livre n'est pas le vôtre — son déposant, un curateur ou un modérateur peuvent le retirer",
        );
      }

      // IDEMPOTENT, ET CE N'EST PAS DE LA COMMODITÉ. Réécrire poserait un
      // nouveau `retire_le` et un nouvel auteur à chaque appel : le premier
      // retrait — celui qui compte le jour où l'on demande « depuis quand, et
      // sur la demande de qui ? » — serait perdu par un double-clic.
      if (l.retireLe) {
        return c.json({
          id: l.id,
          retireLe: l.retireLe,
          motif: l.motifRetrait,
          deja: true,
        });
      }

      const motif = c.req.valid("json").motif.trim();
      await db
        .update(livres)
        .set({
          publiableAvant: l.publiable,
          publiable: false,
          retireLe: new Date(),
          retireParUserId: moi,
          motifRetrait: motif,
          updatedAt: new Date(),
        })
        .where(eq(livres.id, l.id));

      const [apres] = await db.select().from(livres).where(eq(livres.id, l.id)).limit(1);
      return c.json({
        id: l.id,
        retireLe: apres!.retireLe,
        motif: apres!.motifRetrait,
        // Ce qui sera rendu si l'on rétablit. Un livre qui n'était pas publiable
        // avant son retrait ne le deviendra pas en le rétablissant, et le dire
        // ici évite de le découvrir en cliquant.
        publiableAvant: apres!.publiableAvant,
      });
    },
  );

  /**
   * Rétablir un livre retiré. UNE ANNULATION, PAS UNE DÉCISION DE PUBLIER.
   *
   * Il remet `publiable_avant` — donc `false` si le livre n'était pas publiable
   * avant qu'on le retire. Poser `true` serait une décision de publier prise par
   * un bouton nommé « rétablir », sur un ouvrage que son déposant avait
   * peut-être lui-même déclaré sous droits.
   *
   * REFUSE UN LIVRE JAMAIS RETIRÉ. Sans cette garde, le rétablissement
   * deviendrait la porte dérobée qu'il évite : appelé sur un dépôt déclaré sous
   * droits — `publiable = false`, `motifNonPubliable` rempli, exactement la
   * silhouette d'un retrait — il aurait publié ce que personne n'a jamais
   * autorisé.
   */
  app.post(
    "/livres/:id/retablissement",
    describeRoute({ description: "Annuler un retrait", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    requireCorpusRole("moderateur", "curateur"),
    async (c) => {
      const [l] = await db
        .select()
        .from(livres)
        .where(eq(livres.id, c.req.param("id")))
        .limit(1);
      if (!l) throw errors.notFound("Livre introuvable");
      if (!l.retireLe) {
        throw errors.unprocessable(
          "ce livre n'a jamais été retiré — s'il n'est pas publiable, c'est sa déclaration de droits qui le dit, " +
            "et elle se corrige par PATCH /livres/:id",
          { motifNonPubliable: l.motifNonPubliable },
        );
      }

      await db
        .update(livres)
        .set({
          // `?? false` plutôt que `!`. La contrainte
          // `livres_retrait_complet_ck` garantit que les deux colonnes vont
          // ensemble, mais une ligne écrite à la main en SQL n'en sait rien, et
          // `publiable` est NOT NULL : le repli est la valeur qui ne publie pas.
          publiable: l.publiableAvant ?? false,
          publiableAvant: null,
          retireLe: null,
          retireParUserId: null,
          motifRetrait: null,
          updatedAt: new Date(),
        })
        .where(eq(livres.id, l.id));

      return c.json({
        id: l.id,
        publiable: l.publiableAvant ?? false,
        retireLe: null,
        // Rétabli ne veut pas dire visible : la modération est une autre
        // question, et la taire ferait chercher longtemps pourquoi le livre
        // n'apparaît toujours pas dans la liste.
        statutModeration: l.statutModeration,
      });
    },
  );

  /**
   * Supprimer un livre — DÉFINITIVEMENT, octets compris.
   *
   * LE FAIT QUI COMMANDE TOUT L'ORDRE DES OPÉRATIONS
   * Supprimer un livre déposé SANS effacer ses octets les rend à nouveau
   * publics. Deux gardiens votent sur chaque objet, et il sort dès qu'un le
   * réclame sans qu'aucun ne le refuse :
   *
   *   avant       `bibliotheque` refuse (livre non publiable) · `depot` accepte
   *   après       `bibliotheque` ne connaît plus rien (ses pages ont disparu)
   *               `depot` accepte toujours
   *
   * C'est exactement le scénario que lib/stockage/objets.ts disait vouloir
   * empêcher — « un ouvrage retiré dont les lignes de rattachement ont disparu
   * redeviendrait public par le seul fait qu'on l'a détaché » — et que le
   * gardien `depot`, ajouté pour le dépôt ouvert, avait réintroduit. Une
   * suppression qui n'efface pas les octets est une DÉ-suppression.
   *
   * MODÉRATEUR SEUL. Un curateur verse et corrige ; détruire le travail de tiers
   * — les corrections proposées et les avis rendus partent avec la cascade —
   * n'est pas de l'édition.
   */
  app.delete(
    "/livres/:id",
    describeRoute({ description: "Supprimer un livre et ses octets", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    requireCorpusRole("moderateur"),
    validate("json", avecMotif),
    async (c) => {
      const livreId = c.req.param("id");
      const moi = demandeur(c)!;
      const motif = c.req.valid("json").motif.trim();
      const [l] = await db.select().from(livres).where(eq(livres.id, livreId)).limit(1);
      if (!l) throw errors.notFound("Livre introuvable");

      /**
       * ÉTAPE 0 — FERMER LE LIVRE, VALIDÉE SEULE, AVANT DE TOUCHER AU MOINDRE OCTET.
       *
       * C'est elle qui rend vrai l'invariant « à tout instant, ces octets sont
       * soit refusés, soit détruits ». Sans elle, sur le cas qui motive une
       * suppression — un ayant droit écrit au sujet d'un volume PUBLIÉ —
       * `publiable` resterait vrai pendant toute la boucle : 748 allers-retours
       * vers R2 pour 374 folios, soit des minutes durant lesquelles chaque
       * empreinte pas encore atteinte continue d'être servie à qui a listé les
       * pages. Et un échec R2 à mi-course laisserait un livre accepté, listé,
       * moitié en tuiles blanches et moitié servable — un état DURABLE.
       *
       * PAS DE TRANSACTION ENGLOBANTE, et c'est le point délicat : le gardien
       * interroge la base par une autre connexion et ne verrait pas un UPDATE
       * non validé. Enfermer l'étape 0 dans la transaction qui porte la
       * destruction rouvrirait exactement la fenêtre qu'elle ferme. La
       * VALIDATION de l'étape 0 est la frontière.
       *
       * `coalesce` partout : la suppression est rejouable, et un second appel ne
       * doit ni déplacer la date du premier retrait ni effacer son auteur.
       */
      const ferme = await db.execute(sql`
        update livres set
          publiable = false,
          publiable_avant = coalesce(publiable_avant, publiable),
          statut_moderation = 'refuse',
          motif_moderation = ${motif},
          motif_retrait = coalesce(motif_retrait, ${motif}),
          retire_le = coalesce(retire_le, now()),
          retire_par_user_id = coalesce(retire_par_user_id, ${moi}),
          updated_at = now()
        where id = ${livreId}
        returning id
      `);
      if (ferme.length === 0) throw errors.notFound("Livre introuvable");

      /**
       * Les empreintes de ce livre qu'AUCUN AUTRE livre ne référence.
       *
       * L'adressage par contenu déduplique : deux ouvrages qui portent la même
       * page de garde partagent l'objet. Détruire les octets d'un livre
       * emporterait la page de l'autre, et personne ne le verrait avant qu'une
       * tuile ne manque.
       *
       * LES DEUX COLONNES, image ET vignette : l'empreinte d'une vignette
       * n'apparaît jamais dans `image_sha256`, et l'oublier laisserait dans le
       * seau la moitié des octets d'un livre supprimé.
       */
      const aDetruire = await db.execute<{ e: string }>(sql`
        with mien as (
          select image_sha256 as e from pages
           where livre_id = ${livreId} and image_sha256 is not null
          union
          select vignette_sha256 from pages
           where livre_id = ${livreId} and vignette_sha256 is not null
        )
        select m.e from mien m
         where not exists (
           select 1 from pages p
            where p.livre_id <> ${livreId}
              and (p.image_sha256 = m.e or p.vignette_sha256 = m.e))
      `);

      // Une erreur ici N'EST PAS RATTRAPÉE, et c'est délibéré. Continuer malgré
      // un échec R2 mènerait au `DELETE FROM livres` avec des octets encore dans
      // le seau — c'est-à-dire à la dé-suppression décrite plus haut. Le livre
      // reste fermé, l'appel échoue, et un second appel reprend là où il en
      // était : `supprimerObjet` tolère l'objet déjà parti.
      let detruits = 0;
      for (const { e } of aDetruire) {
        await supprimerObjet(e);
        detruits++;
      }

      const [nb] = await db
        .select({ pages: sql<number>`count(*)::int` })
        .from(pages)
        .where(eq(pages.livreId, livreId));

      // Le registre et la disparition ensemble : si l'insertion échouait après
      // le DELETE, plus rien ne saurait dire pourquoi ce livre a disparu.
      await db.transaction(async (tx) => {
        await tx
          .insert(livresSupprimes)
          .values({
            id: id("lsupp"),
            livreId: l.id,
            titre: l.titre,
            auteur: l.auteur,
            annee: l.annee,
            source: l.source,
            sourceRef: l.sourceRef,
            deposeParUserId: l.deposeParUserId,
            supprimeParUserId: moi,
            motif,
            objetsDetruits: detruits,
            pagesSupprimees: nb?.pages ?? 0,
          })
          // Rejouée, la suppression ne s'inscrit qu'une fois.
          .onConflictDoNothing();
        // La cascade emporte pages, océrisations, corrections et avis.
        await tx.delete(livres).where(eq(livres.id, livreId));
      });

      // DU JSON, ET PAS UN 204. Le client de `boky-collecte` lit toujours le
      // corps de la réponse ; un 204 le ferait échouer sur une suppression
      // pourtant réussie, et l'écran proposerait de recommencer.
      return c.json({
        id: livreId,
        titre: l.titre,
        // Rendus parce qu'ils se vérifient : un zéro sur un livre de 374 folios
        // dit que la boucle n'a pas fait son travail.
        objetsDetruits: detruits,
        pagesSupprimees: nb?.pages ?? 0,
        motif,
      });
    },
  );

  /**
   * Ajouter un folio — au déposant du livre, ou à un curateur.
   *
   * Pas `requireCorpusRole("curateur")` : le contributeur qui vient de déposer
   * son livre doit pouvoir y mettre ses pages, sinon le dépôt ouvert s'arrête au
   * titre. Mais pas ouvert à tous non plus — ajouter une page au livre d'autrui
   * serait s'inviter dans son ouvrage, et le déposant en répond.
   *
   * `imageSha256` rattache une image DÉJÀ VERSÉE par `POST /v1/objets`. Le
   * rattachement est refusé si l'objet n'existe pas : une page pointant une
   * empreinte absente est une tuile blanche que rien ne signale.
   */
  app.post(
    "/livres/:id/pages",
    describeRoute({ description: "Ajouter un folio", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", nouvellePage),
    async (c) => {
      const [l] = await db.select().from(livres).where(eq(livres.id, c.req.param("id"))).limit(1);
      if (!l) throw errors.notFound("Livre introuvable");
      const moi = demandeur(c)!;
      if (l.deposeParUserId !== moi && !(await detientRole(moi, "curateur"))) {
        throw errors.forbidden("ce livre n'est pas le vôtre");
      }
      const b = c.req.valid("json");
      // Les DEUX empreintes sont vérifiées. Une page pointant vers une empreinte
      // absente est une tuile blanche que rien ne signale — et l'oubli de la
      // vignette serait le plus discret des deux, puisque la grille se rabat sur
      // l'image pleine et paraît fonctionner.
      for (const [champ, empreinte] of [
        ["imageSha256", b.imageSha256],
        ["vignetteSha256", b.vignetteSha256],
      ] as const) {
        if (!empreinte) continue;
        if (!(await ficheObjet(empreinte))) {
          throw errors.unprocessable(
            `aucun objet ne porte l'empreinte de ${champ} — versez l'image par POST /v1/objets avant de la rattacher`,
          );
        }
      }
      // UNE VUE DÉJÀ PRISE SE DIT, PLUTÔT QUE DE REMONTER EN ERREUR POSTGRES.
      // `pages_livre_folio_uq` refuse déjà le doublon, mais un versement en lot
      // qui reprend à 1 sur un livre existant produisait alors une erreur 500
      // illisible au milieu de soixante photos — sans dire laquelle, ni que le
      // numéro était le problème.
      const [prise] = await db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.livreId, l.id), eq(pages.folio, b.folio)))
        .limit(1);
      if (prise) {
        throw errors.conflict(
          `la vue ${b.folio} existe déjà dans ce livre`,
          { folio: b.folio, pageId: prise.id },
        );
      }

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
        imageSha256: b.imageSha256 ?? null,
        imageLargeur: b.imageLargeur ?? null,
        imageHauteur: b.imageHauteur ?? null,
        vignetteSha256: b.vignetteSha256 ?? null,
      });
      return c.json(
        {
          id: pageId,
          folio: b.folio,
          imageUrl: urlObjet(b.imageSha256 ?? null),
          vignetteUrl: urlObjet(b.vignetteSha256 ?? null),
        },
        201,
      );
    },
  );

  /**
   * Corriger un folio — son numéro, sa pagination imprimée, sa photo.
   *
   * POURQUOI CETTE ROUTE MANQUAIT, ET CE QUE SON ABSENCE COÛTAIT
   * `DeposerLivrePage` numérote les folios dans l'ORDRE DE SÉLECTION DES
   * FICHIERS, et l'écrit à l'écran : « il se corrige ensuite page par page ».
   * Rien ne l'implémentait. Or un explorateur de fichiers trie volontiers
   * `photo1, photo10, photo11, photo2…` : le livre entier arrive dans le
   * désordre, et le seul recours était de le supprimer et de tout reverser.
   *
   * REMPLACER UNE IMAGE DÉTRUIT L'ANCIENNE, ET AVANT DE LA DÉTACHER.
   * C'est le même piège que la suppression d'un livre, en miniature : une fois
   * la page repointée, plus aucune page ne référence les anciens octets, donc le
   * gardien `bibliotheque` passe de « refusée » à « inconnue » — et si l'objet a
   * moins de 48 heures, le gardien `depot` le dit encore servable. Un scan sous
   * droits deviendrait public par le seul fait qu'on l'a remplacé.
   *
   * D'où l'ordre : les octets partent AVANT la ligne. Si la destruction échoue,
   * la page n'est pas touchée et l'état reste cohérent ; si elle réussit et que
   * la mise à jour échoue, il reste une tuile blanche que le même appel rejoué
   * répare. C'est le côté qui se répare, comme partout ailleurs ici.
   */
  app.patch(
    "/pages/:id",
    describeRoute({ description: "Corriger un folio", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", correctifPage),
    async (c) => {
      const moi = demandeur(c)!;
      const { page: p, livre: l } = await pageGerable(c.req.param("id"), moi);
      const b = c.req.valid("json") as Record<string, unknown>;
      const envoyes = Object.keys(b);
      if (envoyes.length === 0) throw errors.unprocessable("aucun champ à modifier");

      const ligne = p as unknown as Record<string, unknown>;
      const changes: Record<string, unknown> = {};
      for (const k of envoyes) {
        const apres = b[k] === undefined ? null : b[k];
        if (ligne[k] !== apres) changes[k] = apres;
      }
      if (Object.keys(changes).length === 0) {
        return c.json({ id: p.id, folio: p.folio, modifie: [] });
      }

      // Le numéro de vue : refusé s'il est pris, avec la route qui sait le faire.
      // Échanger deux folios ne peut PAS passer par ici — la valeur intermédiaire
      // heurterait l'unicité quel que soit l'ordre des deux appels.
      if (changes.folio !== undefined) {
        const [prise] = await db
          .select({ id: pages.id })
          .from(pages)
          .where(and(eq(pages.livreId, p.livreId), eq(pages.folio, changes.folio as number)))
          .limit(1);
        if (prise) {
          throw errors.conflict(
            `la vue ${changes.folio} est déjà prise — pour échanger deux folios, ` +
              `utilisez POST /livres/${p.livreId}/renumerotation`,
            { folio: changes.folio, pageId: prise.id },
          );
        }
      }

      // Les nouvelles empreintes doivent exister AVANT qu'on détruise les
      // anciennes : dans l'autre sens, une empreinte fautive laisserait la page
      // sans image et l'ancienne détruite.
      for (const champ of ["imageSha256", "vignetteSha256"] as const) {
        const nouvelle = changes[champ] as string | null | undefined;
        if (!nouvelle) continue;
        if (!(await ficheObjet(nouvelle))) {
          throw errors.unprocessable(
            `aucun objet ne porte l'empreinte de ${champ} — versez l'image par POST /v1/objets avant de la rattacher`,
          );
        }
      }

      // Les octets AVANT la ligne. Voir l'en-tête de la route.
      let detruits = 0;
      for (const champ of ["imageSha256", "vignetteSha256"] as const) {
        if (!(champ in changes)) continue;
        const ancienne = ligne[champ] as string | null;
        if (ancienne && (await detruireSiOrpheline(ancienne, p.id))) detruits++;
      }

      await db
        .update(pages)
        .set({ ...(changes as Partial<typeof pages.$inferInsert>), updatedAt: new Date() })
        .where(eq(pages.id, p.id));

      const [apres] = await db.select().from(pages).where(eq(pages.id, p.id)).limit(1);
      return c.json({
        ...pagePublique(apres!, l.sourceRef, l.source),
        modifie: Object.keys(changes),
        // Rendu parce que ça se vérifie : remplacer une photo sans rien détruire
        // veut dire que les anciens octets sont restés dans le seau.
        objetsDetruits: detruits,
      });
    },
  );

  /**
   * Supprimer un folio — octets compris.
   *
   * OUVERT AU DÉPOSANT, MAIS PAS SUR LE TRAVAIL D'AUTRUI.
   * Supprimer un livre est réservé au modérateur parce que la cascade emporte les
   * corrections proposées par des tiers. Une page pose la même question en plus
   * petit — et la réponse n'est pas « réservons tout au modérateur », qui
   * empêcherait un contributeur d'effacer la photo qu'il vient de verser deux
   * fois. La règle dit exactement ce qu'elle protège : votre page est à vous,
   * SAUF si quelqu'un d'autre y a travaillé.
   */
  app.delete(
    "/pages/:id",
    describeRoute({ description: "Supprimer un folio et ses octets", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    async (c) => {
      const moi = demandeur(c)!;
      const { page: p } = await pageGerable(c.req.param("id"), moi);

      if (!(await detientRole(moi, "moderateur"))) {
        const [tiers] = await db.execute<{ n: number }>(sql`
          select (
            (select count(*) from page_corrections
              where page_id = ${p.id} and propose_par_user_id <> ${moi})
          + (select count(*) from page_ocr
              where page_id = ${p.id} and moteur = ${MOTEUR_RELECTURE}
                and produit_par_user_id is distinct from ${moi})
          )::int as n
        `);
        if ((tiers?.n ?? 0) > 0) {
          throw errors.conflict(
            `cette vue porte le travail de quelqu'un d'autre — ${tiers!.n} ` +
              `correction(s) ou relecture(s). Un modérateur peut la supprimer ; ` +
              `sinon, corrigez-la plutôt que de l'effacer.`,
            { travauxDeTiers: tiers!.n },
          );
        }
      }

      // Les octets d'abord : la ligne partie, plus rien ne les réclame — et
      // « plus rien ne les réclame » est précisément ce qui les rouvre.
      let detruits = 0;
      for (const empreinte of [p.imageSha256, p.vignetteSha256]) {
        if (empreinte && (await detruireSiOrpheline(empreinte, p.id))) detruits++;
      }
      // La cascade emporte les océrisations, les travaux et les corrections.
      await db.delete(pages).where(eq(pages.id, p.id));

      // Du JSON, pas un 204 : le client lit toujours le corps.
      return c.json({ id: p.id, folio: p.folio, objetsDetruits: detruits });
    },
  );

  /**
   * Renuméroter les folios d'un livre, d'un coup.
   *
   * ELLE EXISTE PARCE QU'UN ÉCHANGE NE PASSE PAS PAR `PATCH`.
   * `pages_livre_folio_uq` rend (livre, folio) unique : intervertir les vues 2
   * et 11 heurte l'unicité au premier des deux appels, quel que soit l'ordre. Et
   * le cas réel n'est pas un échange mais un décalage de tout un livre —
   * l'explorateur de fichiers a trié `photo1, photo10, photo2…`, et les soixante
   * folios sont à replacer ensemble.
   *
   * DEUX TEMPS DANS UNE SEULE TRANSACTION : les folios passent d'abord en négatif,
   * puis reçoivent leur valeur finale. L'index unique n'est pas différable — c'est
   * un index, pas une contrainte — donc il n'y a pas d'autre issue que de traverser
   * un espace de valeurs que rien n'occupe. La colonne n'a pas de contrainte de
   * positivité : ce sont `nouvellePage` et `correctifPage` qui l'exigent en
   * entrée, et le passage par le négatif reste interne à la transaction.
   *
   * LE LIVRE ENTIER OU RIEN. Une renumérotation partielle laisserait les folios
   * non listés en travers des nouveaux numéros, et l'appel échouerait à mi-chemin
   * sur une unicité — après avoir déjà tout mis en négatif.
   */
  app.post(
    "/livres/:id/renumerotation",
    describeRoute({ description: "Renuméroter les folios d'un livre", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", renumerotation),
    async (c) => {
      const moi = demandeur(c)!;
      const livreId = c.req.param("id");
      const l = await livrePubliable(livreId, moi);
      if (!(await peutGerer(l, moi)).peutModifier) {
        throw errors.forbidden("ce livre n'est pas le vôtre");
      }

      const { folios } = c.req.valid("json");
      const existantes = await db
        .select({ id: pages.id, folio: pages.folio })
        .from(pages)
        .where(eq(pages.livreId, l.id));

      const connues = new Set(existantes.map((p) => p.id));
      const inconnues = folios.filter((f) => !connues.has(f.id)).map((f) => f.id);
      if (inconnues.length > 0) {
        throw errors.unprocessable(
          "certaines vues ne sont pas dans ce livre",
          { inconnues },
        );
      }
      if (folios.length !== existantes.length) {
        throw errors.unprocessable(
          `la renumérotation porte sur le livre entier : ${existantes.length} vues ` +
            `à replacer, ${folios.length} reçues. Les vues omises resteraient en ` +
            `travers des nouveaux numéros.`,
          { attendues: existantes.length, recues: folios.length },
        );
      }
      const distincts = new Set(folios.map((f) => f.folio));
      if (distincts.size !== folios.length) {
        throw errors.unprocessable("deux vues ne peuvent pas porter le même numéro");
      }

      const bouges = folios.filter((f) => {
        const avant = existantes.find((p) => p.id === f.id);
        return avant && avant.folio !== f.folio;
      });
      if (bouges.length === 0) {
        return c.json({ id: l.id, deplacees: 0, folios: existantes.length });
      }

      await db.transaction(async (tx) => {
        // Le passage par le négatif : aucun folio réel n'y vit, donc rien ne
        // peut heurter l'unicité pendant la traversée.
        await tx.execute(sql`
          update pages set folio = -folio where livre_id = ${livreId} and folio > 0
        `);
        for (const f of folios) {
          await tx
            .update(pages)
            .set({ folio: f.folio, updatedAt: new Date() })
            .where(eq(pages.id, f.id));
        }
      });

      return c.json({ id: l.id, deplacees: bouges.length, folios: folios.length });
    },
  );

  /**
   * La file de modération — modérateur ou curateur.
   *
   * Elle rend ce que la liste publique cache, et rien d'autre : les livres
   * déposés qu'aucune décision n'a encore atteints. Le compte de pages et
   * d'images accompagne chaque entrée, parce qu'un livre sans page est un dépôt
   * abandonné en cours de route et qu'il ne se juge pas comme un ouvrage complet.
   */
  app.get(
    "/moderation",
    describeRoute({ description: "Les livres en attente de décision", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("moderateur", "curateur"),
    validate("query", z.object({
      statut: z.enum(["en_attente", "accepte", "refuse"]).default("en_attente"),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    })),
    async (c) => {
      const { statut, limit } = c.req.valid("query");
      const lignes = await db.execute<Record<string, unknown>>(sql`
        select l.id, l.titre, l.auteur, l.annee, l.source, l.source_ref as "sourceRef",
               l.statut_fixation as "statutFixation", l.licence,
               l.licence_constatee as "licenceConstatee", l.publiable,
               l.motif_non_publiable as "motifNonPubliable", l.url_notice as "urlNotice",
               l.statut_moderation as "statutModeration", l.motif_moderation as "motifModeration",
               l.created_at as "createdAt",
               u.email as "deposantEmail", u.name as "deposantNom",
               count(p.id)::int as "pagesConnues",
               count(p.image_sha256)::int as "pagesAvecImage"
          from livres l
          left join users u on u.id = l.depose_par_user_id
          left join pages p on p.livre_id = l.id
         where l.statut_moderation = ${statut}
      group by l.id, u.email, u.name
      order by l.created_at asc
         limit ${limit}
      `);
      return c.json({ data: lignes });
    },
  );

  /**
   * Trancher. UN REFUS DOIT DIRE POURQUOI.
   *
   * La contrainte `livres_refus_motive_ck` l'impose déjà en base ; elle est
   * revérifiée ici pour que le déposant reçoive une phrase plutôt qu'une erreur
   * Postgres. Sans motif, il ne peut que redéposer à l'identique.
   *
   * La décision est TRAÇABLE — qui, quand, pourquoi — sur le patron des rôles de
   * corpus : le jour où un refus est contesté, « qui a décidé et sur quel motif »
   * est la seule question qui compte.
   */
  app.post(
    "/livres/:id/moderation",
    describeRoute({ description: "Accepter ou refuser un livre déposé", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    requireCorpusRole("moderateur", "curateur"),
    validate("json", z.object({
      decision: z.enum(["accepte", "refuse"]),
      motif: z.string().max(1000).optional(),
    }).strict()),
    async (c) => {
      const { decision, motif } = c.req.valid("json");
      const [l] = await db.select().from(livres).where(eq(livres.id, c.req.param("id"))).limit(1);
      if (!l) throw errors.notFound("Livre introuvable");
      if (decision === "refuse" && !motif?.trim()) {
        throw errors.unprocessable(
          "un refus doit dire pourquoi — sans motif, le déposant ne peut que redéposer à l'identique",
        );
      }
      await db
        .update(livres)
        .set({
          statutModeration: decision,
          motifModeration: motif?.trim() || null,
          modereParUserId: demandeur(c),
          modereLe: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(livres.id, l.id));
      return c.json({ id: l.id, statutModeration: decision, motif: motif?.trim() || null });
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

  // ── Corrections : proposer est ouvert, décider ne l'est pas ──────────────
  app.post(
    "/pages/:id/corrections",
    describeRoute({ description: "Proposer une correction", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    validate("json", nouvelleCorrection),
    async (c) => {
      const { page: p } = await pagePubliable(c.req.param("id"), demandeur(c));
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const b = c.req.valid("json");

      // Le levier de modération existe déjà et n'était utilisé nulle part.
      const [profil] = await db
        .select({ jusqu: contributorProfiles.restrictedUntil })
        .from(contributorProfiles)
        .where(eq(contributorProfiles.userId, userId))
        .limit(1);
      if (profil?.jusqu && profil.jusqu > new Date()) {
        throw errors.forbidden("votre compte est temporairement restreint");
      }

      const correctionId = id("corr");
      // Rien n'est vérifié ici : les bornes, l'ancrage du `lu` dans la lecture,
      // les plafonds et le chevauchement sont des règles de la BASE. Les
      // reproduire ici donnerait deux vérités à tenir d'accord, et c'est
      // toujours la copie applicative qui dérive.
      await db.insert(pageCorrections).values({
        id: correctionId,
        pageId: p.id,
        baseOcrId: b.baseOcrId,
        debut: b.debut,
        fin: b.fin,
        lu: b.lu,
        propose: b.propose,
        motif: b.motif ?? null,
        bbox: b.bbox ?? null,
        proposeParUserId: userId,
      });
      return c.json({ id: correctionId, statut: "proposee" }, 201);
    },
  );

  app.post(
    "/corrections/:id/retrait",
    describeRoute({ description: "Retirer sa propre proposition", tags: ["bibliotheque"] }),
    requireAuth,
    requireRealUser,
    async (c) => {
      // Sans retrait, une faute de frappe ne peut être réparée que par
      // l'attention d'un relecteur — on dépenserait la ressource la plus rare
      // du projet pour corriger un doigt qui a glissé.
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : "";
      const modifiees = await db
        .update(pageCorrections)
        .set({ statut: "retiree" })
        .where(
          and(
            eq(pageCorrections.id, c.req.param("id")),
            eq(pageCorrections.proposeParUserId, userId),
            eq(pageCorrections.statut, "proposee"),
          ),
        )
        .returning({ id: pageCorrections.id });
      if (modifiees.length === 0) {
        throw errors.notFound("Proposition introuvable, ou déjà décidée");
      }
      return c.json({ id: modifiees[0]!.id, statut: "retiree" });
    },
  );

  app.get(
    "/corrections",
    describeRoute({ description: "La file de relecture", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("relecteur", "moderateur"),
    validate("query", filtreCorrections),
    async (c) => {
      const q = c.req.valid("query");
      const lignes = await db
        .select({
          correction: pageCorrections,
          folio: pages.folio,
          livreId: pages.livreId,
          titre: livres.titre,
          sourceRef: livres.sourceRef,
          baseTexte: pageOcr.texte,
          baseMoteur: pageOcr.moteur,
        })
        .from(pageCorrections)
        .innerJoin(pages, eq(pages.id, pageCorrections.pageId))
        .innerJoin(livres, eq(livres.id, pages.livreId))
        .innerJoin(pageOcr, eq(pageOcr.id, pageCorrections.baseOcrId))
        .where(
          and(
            eq(pageCorrections.statut, q.statut),
            q.livre ? eq(pages.livreId, q.livre) : undefined,
            q.page ? eq(pageCorrections.pageId, q.page) : undefined,
            q.proposeur
              ? eq(pageCorrections.proposeParUserId, q.proposeur)
              : undefined,
          ),
        )
        // Par page puis par position, JAMAIS par date : un ordre chronologique
        // donne une file entièrement possédée par le dernier arrivé.
        .orderBy(asc(pageCorrections.pageId), asc(pageCorrections.debut))
        .limit(q.limit);

      // Un histogramme par proposeur, pour qu'un flot se voie d'un coup d'œil
      // plutôt qu'en faisant défiler. C'est un signal AFFICHÉ, jamais une porte.
      const parProposeur = await db
        .select({
          proposeur: pageCorrections.proposeParUserId,
          enAttente: sql<number>`count(*)::int`,
        })
        .from(pageCorrections)
        .where(eq(pageCorrections.statut, "proposee"))
        .groupBy(pageCorrections.proposeParUserId)
        .orderBy(sql`count(*) desc`)
        .limit(20);

      return c.json({
        data: lignes.map((l) => ({
          id: l.correction.id,
          pageId: l.correction.pageId,
          folio: l.folio,
          livre: { id: l.livreId, titre: l.titre, sourceRef: l.sourceRef },
          baseOcrId: l.correction.baseOcrId,
          baseMoteur: l.baseMoteur,
          debut: l.correction.debut,
          fin: l.correction.fin,
          lu: l.correction.lu,
          propose: l.correction.propose,
          motif: l.correction.motif,
          bbox: l.correction.bbox,
          proposeParUserId: l.correction.proposeParUserId,
          createdAt: l.correction.createdAt,
          // Un relecteur qui lit « hontra → hoatra » sans sa phrase juge une
          // chaîne, pas une page.
          contexte: contexte(l.baseTexte, l.correction.debut, l.correction.fin),
        })),
        parProposeur,
      });
    },
  );

  app.post(
    "/corrections/:id/avis",
    describeRoute({ description: "Donner son avis de relecteur", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("relecteur"),
    validate("json", nouvelAvis),
    async (c) => {
      const auth = c.get("auth");
      const b = c.req.valid("json");
      // « On ne relit pas sa propre proposition » et « cette proposition est
      // déjà décidée » sont refusés par la base. Le seuil qui transforme des
      // avis en décision y vit aussi : le porter à deux relecteurs de régions
      // différentes sera une ligne de migration, pas un changement d'API.
      await db.insert(pageCorrectionAvis).values({
        id: id("avis"),
        correctionId: c.req.param("id"),
        relecteurUserId: auth.kind === "user" ? auth.userId : "",
        avis: b.avis,
        motif: b.motif ?? null,
      });
      const [apres] = await db
        .select({ statut: pageCorrections.statut })
        .from(pageCorrections)
        .where(eq(pageCorrections.id, c.req.param("id")))
        .limit(1);
      return c.json({ id: c.req.param("id"), statut: apres?.statut }, 201);
    },
  );

  app.post(
    "/corrections/:id/revocation",
    describeRoute({ description: "Révoquer une correction acceptée", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("relecteur"),
    validate("json", z.object({ motif: z.string().min(3).max(500) }).strict()),
    async (c) => {
      // La SEULE sortie d'une acceptation erronée. Sans elle, un intervalle
      // accepté à tort est verrouillé à vie : la ligne est immuable et la
      // contrainte d'exclusion interdit toute rivale. Or l'erreur qu'on
      // redoute — accepter une modernisation de l'orthographe — est exactement
      // celle que ce corpus a déjà subie.
      const auth = c.get("auth");
      const modifiees = await db
        .update(pageCorrections)
        .set({
          statut: "revoquee",
          revocation: {
            par: auth.kind === "user" ? auth.userId : "",
            le: new Date().toISOString(),
            motif: c.req.valid("json").motif,
          },
        })
        .where(
          and(
            eq(pageCorrections.id, c.req.param("id")),
            eq(pageCorrections.statut, "acceptee"),
          ),
        )
        .returning({ id: pageCorrections.id });
      if (modifiees.length === 0) {
        throw errors.notFound("Correction introuvable, ou pas acceptée");
      }
      return c.json({ id: modifiees[0]!.id, statut: "revoquee" });
    },
  );

  app.post(
    "/pages/:id/relecture",
    describeRoute({ description: "Sceller la lecture corrigée", tags: ["bibliotheque"] }),
    requireAuth,
    requireCorpusRole("relecteur"),
    validate("json", z.object({ baseOcrId: z.string().min(1).max(80) }).strict()),
    async (c) => {
      // LE SCELLEMENT donne au texte corrigé ce que la vue dérivée n'a pas : un
      // identifiant et une empreinte. C'est ce qui le rend citable, exportable,
      // et c'est ce qui donnera enfin un sens à `accord_document_millimes`, nul
      // partout depuis le début faute de transcription humaine.
      const { page: p } = await pagePubliable(c.req.param("id"), demandeur(c));
      const auth = c.get("auth");
      const baseOcrId = c.req.valid("json").baseOcrId;

      const [base] = await db
        .select()
        .from(pageOcr)
        .where(and(eq(pageOcr.id, baseOcrId), eq(pageOcr.pageId, p.id)))
        .limit(1);
      if (!base) throw errors.notFound("Lecture de base introuvable sur cette page");

      const acceptees = await db
        .select()
        .from(pageCorrections)
        .where(
          and(
            eq(pageCorrections.baseOcrId, baseOcrId),
            eq(pageCorrections.statut, "acceptee"),
          ),
        )
        .orderBy(asc(pageCorrections.debut));
      if (acceptees.length === 0) {
        throw errors.unprocessable(
          "aucune correction acceptée sur cette lecture — il n'y a rien à sceller",
        );
      }

      const texte = appliquer(
        base.texte,
        acceptees.map((e) => ({ debut: e.debut, fin: e.fin, propose: e.propose })),
      );
      const empreinte = sha256(texte);

      // Idempotent sur l'empreinte : sceller une page inchangée rend le scellé
      // existant plutôt qu'un doublon. `page_ocr` n'a pas d'unicité par
      // conception — les passes multiples sont le principe — donc c'est ici
      // qu'on distingue « sceller à nouveau » de « sceller deux fois ».
      const [deja] = await db
        .select({ id: pageOcr.id })
        .from(pageOcr)
        .where(and(eq(pageOcr.pageId, p.id), eq(pageOcr.texteSha256, empreinte)))
        .limit(1);
      if (deja) return c.json({ id: deja.id, deja: true }, 200);

      const ocrId = id("ocr");
      await db.insert(pageOcr).values({
        id: ocrId,
        pageId: p.id,
        moteur: MOTEUR_RELECTURE,
        texte,
        texteSha256: empreinte,
        produitParUserId: auth.kind === "user" ? auth.userId : null,
        meta: {
          base_ocr_id: baseOcrId,
          base_moteur: base.moteur,
          corrections: acceptees.map((e) => e.id),
          corrections_sha256: sha256(acceptees.map((e) => e.id).join(",")),
          scelle_le: new Date().toISOString(),
        },
      });
      return c.json({ id: ocrId, corrections: acceptees.length }, 201);
    },
  );

  return app;
}
