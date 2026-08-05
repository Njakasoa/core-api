import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { errors } from "../lib/errors.ts";
import { empreinteValide, lireObjet, objetServable } from "../lib/stockage/index.ts";

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
export function objetsRoute(): Hono {
  const app = new Hono();

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
