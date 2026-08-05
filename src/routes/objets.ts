import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { errors } from "../lib/errors.ts";
import {
  ecrireObjet,
  empreinteValide,
  enregistrerGardien,
  ficheObjet,
  lireObjet,
  objetServable,
  octetsVersesRecemment,
} from "../lib/stockage/index.ts";
import {
  FENETRE_QUOTA_HEURES,
  QUOTA_QUOTIDIEN_OCTETS,
  TAILLE_MAX_OCTETS,
  refusDeType,
  typeReel,
} from "../lib/stockage/images-entrantes.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireRealUser } from "../middleware/corpus-role.ts";
import type { Variables } from "../types.ts";

/**
 * `GET /v1/objets/:sha256` — les octets d'un objet stocké, quel qu'il soit.
 *
 * UNE SEULE ROUTE POUR TOUTES LES FONCTIONNALITÉS
 * Elle était d'abord `/v1/bibliotheque/images/:sha256`, ce qui rangeait par
 * propriétaire un objet dont l'adresse ne dépend que du contenu. La suite du
 * projet stockera autre chose que des scans — photos de cahiers envoyées par les
 * contributeurs, pièces jointes, clips — et chacune aurait redemandé la même
 * route, le même cache, le même seau de limitation, avec l'occasion de se
 * tromper à chaque fois. Les droits, eux, restent chez le propriétaire : c'est
 * le registre de gardiens de lib/stockage/objets.ts.
 *
 * PAS D'AUTHENTIFICATION, ET C'EST RAISONNÉ
 * L'empreinte imprévisible EST l'autorisation, comme pour les clips de
 * routes/tts.ts : une balise <img> ne porte pas de jeton. Mais elle ne suffit
 * pas — un objet sous droits ne doit pas sortir même pour qui connaît son
 * empreinte — d'où le vote des gardiens, qui se fait en base, et d'où le fait
 * que le seau ne soit pas public.
 */
export function objetsRoute(): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>();

  /**
   * CE QU'UN CONTRIBUTEUR A DÉPOSÉ LUI RESTE VISIBLE, PAR SON EMPREINTE.
   *
   * Sans ce gardien, un objet fraîchement versé n'est réclamé par personne — le
   * vote le refuse, et le déposant ne peut pas se relire avant de rattacher sa
   * photo à un folio. Ce serait un formulaire où l'on téléverse à l'aveugle.
   *
   * Ce que ça expose : quiconque connaît l'empreinte peut lire les octets. C'est
   * le même raisonnement que pour les clips de routes/tts.ts et que pour les
   * pages — l'empreinte imprévisible EST la capacité, parce qu'une balise <img>
   * ne porte pas de jeton. Ce que la modération protège, c'est la MISE EN AVANT :
   * un livre non accepté n'apparaît dans aucune liste. Un gardien plus strict qui
   * refuserait tout objet non modéré ne protégerait rien de plus — le déposant
   * possède déjà le fichier — et rendrait la relecture impossible.
   *
   * Le refus, lui, vient d'ailleurs : si la photo est rattachée à un livre
   * refusé ou non publiable, le gardien de la bibliothèque vote « refusee » et un
   * seul refus l'emporte.
   */
  enregistrerGardien({
    nom: "depot",
    async verdict(sha256) {
      const [r] = await db.execute<{ depose: boolean }>(sql`
        select depose_par_user_id is not null as depose from objets where sha256 = ${sha256}
      `);
      return r?.depose ? "servable" : "inconnue";
    },
  });

  /**
   * `POST /v1/objets` — verser des octets.
   *
   * OUVERT À TOUT COMPTE RÉEL, ET C'EST UNE DÉCISION, PAS UN RELÂCHEMENT
   * `routes/bibliotheque.ts` écrivait qu'aucune route d'écriture d'octets
   * n'existerait, parce qu'« une plateforme où n'importe qui téléverse une page
   * de livre est une plateforme qui republie du contenu sous droits sans le
   * savoir ». Cette phrase reste vraie. Ce qui a changé, c'est ce qu'on met en
   * face : un livre déposé n'est LISTÉ nulle part avant d'avoir été modéré, la
   * déclaration de droits est obligatoire à la création, et le déposant est
   * nommé dans la ligne — donc un retrait est possible et adressable.
   *
   * Le calcul assumé : sans cette route, les ~400 angano manquants restent
   * inatteignables, puisque aucun corpus libre de droits ne les contient. Avec
   * elle, le risque passe de « impossible » à « surveillé ».
   *
   * TROIS CONTRÔLES, ET CHACUN COUVRE CE QUE LES AUTRES LAISSENT PASSER
   *   la taille   protège la mémoire et le stockage d'un seul fichier
   *   le type     lu dans les octets, jamais dans l'en-tête que le client écrit
   *   le quota    protège de mille fichiers conformes
   */
  app.post(
    "/",
    describeRoute({ description: "Verser des octets (image)", tags: ["objets"] }),
    requireAuth,
    requireRealUser,
    async (c) => {
      const auth = c.get("auth");
      const userId = auth.kind === "user" ? auth.userId : null;
      if (!userId) throw errors.forbidden("un compte est requis pour verser");

      const octets = new Uint8Array(await c.req.arrayBuffer());
      if (octets.byteLength === 0) throw errors.badRequest("corps vide");
      if (octets.byteLength > TAILLE_MAX_OCTETS) {
        throw errors.unprocessable(
          `fichier trop grand : ${(octets.byteLength / 1e6).toFixed(1)} Mo pour un ` +
            `plafond de ${(TAILLE_MAX_OCTETS / 1e6).toFixed(0)} Mo`,
        );
      }

      // Le type est OBSERVÉ. Croire l'en-tête laisserait déposer un fichier HTML
      // annoncé `image/jpeg`, que l'API rendrait ensuite avec ce même type.
      const mime = typeReel(octets);
      if (!mime) throw errors.unprocessable(refusDeType(c.req.header("content-type") ?? null));

      const deja = await octetsVersesRecemment(userId, FENETRE_QUOTA_HEURES);
      if (deja + octets.byteLength > QUOTA_QUOTIDIEN_OCTETS) {
        throw errors.tooManyRequests(
          `quota atteint : ${(deja / 1e6).toFixed(0)} Mo versés sur les ` +
            `${FENETRE_QUOTA_HEURES} dernières heures, plafond ` +
            `${(QUOTA_QUOTIDIEN_OCTETS / 1e6).toFixed(0)} Mo. La fenêtre glisse : ` +
            `elle se libère au fil des heures, pas d'un coup à minuit.`,
        );
      }

      // `classe: original` — une photo déposée ne se régénère à partir de rien.
      // Les vignettes en seront des dérivés, quand elles existeront.
      const sha256 = await ecrireObjet(octets, mime, "original", { deposant: userId });

      // L'adressage par contenu déduplique : redéposer le même fichier rend la
      // même empreinte sans rien réécrire. On le DIT, plutôt que de laisser
      // croire à un second versement — et la ligne garde son premier déposant.
      const fiche = await ficheObjet(sha256);
      return c.json(
        {
          sha256,
          mime: fiche?.mime ?? mime,
          octets: octets.byteLength,
          url: urlObjet(sha256),
          quotaRestant: Math.max(0, QUOTA_QUOTIDIEN_OCTETS - deja - octets.byteLength),
        },
        201,
      );
    },
  );

  app.get(
    "/:sha256",
    describeRoute({ description: "Les octets d'un objet stocké", tags: ["objets"] }),
    async (c) => {
      const h = c.req.param("sha256");
      if (!empreinteValide(h)) throw errors.badRequest("empreinte invalide");

      // L'AUTORISATION AVANT LA LECTURE, TOUJOURS.
      // Lire d'abord coûterait un aller-retour vers le seau — et une ligne de
      // `bytea` entière — pour un objet qu'on s'apprête à refuser. Un objet
      // refusé ne doit rien coûter à qui le demande en boucle.
      const { servable, refusePar } = await objetServable(h);
      if (!servable) {
        if (refusePar.length > 0) {
          console.warn(
            JSON.stringify({ evenement: "objet_refuse", sha256: h, par: refusePar }),
          );
        }
        // Le même 404 qu'un objet inconnu : dire « celui-là existe mais vous n'y
        // avez pas droit » apprend à qui sonde le dépôt que l'empreinte est
        // bonne. Il n'a besoin de rien de plus pour la republier ailleurs.
        throw errors.notFound("objet introuvable");
      }

      const objet = await lireObjet(h);
      if (!objet) {
        // Une ligne présente mais sans octets n'est pas une empreinte inconnue.
        // Le navigateur ne peut rien en faire de différent — il reçoit le même
        // 404 — mais le journal doit distinguer : « versé puis perdu » est un
        // incident, « jamais versé » n'en est pas un.
        console.error(JSON.stringify({ evenement: "objet_sans_octets", sha256: h }));
        throw errors.notFound("objet introuvable");
      }

      c.header("Content-Type", objet.mime);
      // `immutable` est vrai au sens fort ici : l'adresse étant l'empreinte, ces
      // octets ne changeront jamais. Ce qui peut changer, c'est le DROIT de les
      // servir — un cache d'un jour est donc aussi le délai maximal d'un retrait
      // côté navigateurs déjà servis.
      c.header("Cache-Control", "public, max-age=86400, immutable");
      c.header("Access-Control-Allow-Origin", "*");
      return c.body(objet.octets as unknown as ArrayBuffer);
    },
  );

  return app;
}

/** L'URL publique d'un objet. Une seule fonction la construit. */
export function urlObjet(sha256: string | null): string | null {
  return sha256 ? `/v1/objets/${sha256}` : null;
}
