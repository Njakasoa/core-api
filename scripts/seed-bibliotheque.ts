/**
 * Verse la bibliothèque de contes : livres, pages, octets d'images.
 *
 * ÉCRIT DIRECTEMENT EN BASE, ET PAS PAR HTTP — CE N'EST PAS UNE COMMODITÉ
 * Quatre choses l'interdisent. `app.use("*", bodyLimit(1 MiB))` est monté avant
 * toute route : un scan de page en dépasse le plafond, et un `bodyLimit` posé
 * par route ne verrait jamais le corps. Aucune route d'écriture d'octets
 * n'existe, et `routes/bibliotheque.ts` explique pourquoi elle n'existera pas :
 * « une plateforme où n'importe qui téléverse une page de livre est une
 * plateforme qui republie du contenu sous droits sans le savoir ». Le limiteur
 * s'applique à `/v1/*`, donc 748 POST recevraient un 429 au 120ᵉ. Et surtout,
 * chaque POST serait sa transaction : un échec à mi-course laisserait une
 * bibliothèque dont les pages pointent vers des empreintes absentes.
 *
 * OÙ IL TOURNE
 * Là où est la base. En production, `deploy/docker-compose.prod.yml` ne publie
 * aucun port pour `db` : le `DATABASE_URL` de prod est injoignable depuis
 * l'extérieur du réseau Docker. Le lot voyage donc par `docker compose cp`, pas
 * par git — les images ne doivent jamais entrer dans le dépôt ni dans le
 * contexte de construction (`.dockerignore` n'exclut pas `src/data`, et
 * `deploy/update-core-api.sh` rebâtit à chaque changement de `origin/main`).
 *
 *     bun scripts/seed-bibliotheque.ts --pages <bibliotheque_pages.json> \
 *                                      --racine <repparcs/data>
 *     bun scripts/seed-bibliotheque.ts … --essai   # n'écrit rien
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { livres, pages } from "../src/db/schema.ts";
import { id } from "../src/lib/ids.ts";
import { sha256Bytes } from "../src/lib/crypto.ts";
import { depotParDefaut, ecrireObjet, lireObjet, supprimerObjet } from "../src/lib/stockage/index.ts";

/** Où atterrissent les octets de ce versement — `OBJETS_STOCKAGE`. */
const STOCKAGE = depotParDefaut();

interface Rendu {
  sha256: string;
  octets: number;
  largeur: number | null;
  hauteur: number | null;
  fichier: string;
}
interface PageLot {
  folio: number;
  texteOcr: string | null;
  ocrMoteur: string;
  pageImprimee: string | null;
  publiable: boolean | null;
  image: Rendu;
  vignette: Rendu;
}
interface LivreLot {
  sourceRef: string;
  source: string;
  titre: string;
  auteur: string | null;
  annee: number | null;
  anneeFin: number | null;
  langue: string;
  pagesTotal: number;
  statutFixation: string;
  licence: string;
  licenceConstatee: string;
  publiable: boolean;
  urlNotice: string;
}

function argument(nom: string): string | undefined {
  const i = process.argv.indexOf(`--${nom}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ESSAI = process.argv.includes("--essai");
const CHEMIN_LIVRES = argument("livres") ?? "src/data/bibliotheque.generated.json";
const CHEMIN_PAGES = argument("pages");
const RACINE = argument("racine");

if (!CHEMIN_PAGES || !RACINE) {
  console.error(
    "usage : bun scripts/seed-bibliotheque.ts --pages <bibliotheque_pages.json> " +
      "--racine <repparcs/data> [--livres <fichier>] [--essai]",
  );
  process.exit(2);
}

const lot = JSON.parse(await readFile(resolve(CHEMIN_LIVRES), "utf-8")) as {
  pages_manifeste_sha256: string;
  livres: LivreLot[];
};
const lotPages = JSON.parse(await readFile(resolve(CHEMIN_PAGES), "utf-8")) as {
  manifeste_sha256: string;
  par_ark: Record<string, PageLot[]>;
};

// Le lot de pages et la liste des livres doivent venir de la MÊME génération.
// L'empreinte est calculée une seule fois, du côté Python, et recopiée dans les
// deux fichiers : la recalculer ici ne détecterait rien, puisque Python et
// JavaScript ne sérialisent pas le JSON de la même façon.
if (lot.pages_manifeste_sha256 !== lotPages.manifeste_sha256) {
  console.error(
    `Lot périmé : la liste des livres attend le manifeste ` +
      `${lot.pages_manifeste_sha256.slice(0, 12)}… et le fichier de pages porte ` +
      `${lotPages.manifeste_sha256.slice(0, 12)}…. Relancez ` +
      `build_bibliotheque.py, ou copiez le bon lot.`,
  );
  process.exit(1);
}

/**
 * Une image ne doit pas changer de camp en cours de route.
 *
 * L'adressage par contenu déduplique : deux livres peuvent partager des octets.
 * Or la route qui les sert refuse une image dès qu'UNE de ses références n'est
 * pas publiable — refuser une image libre coûte une tuile blanche, servir un
 * scan sous droits coûte un retrait. Verser sans regarder rendrait donc muettes
 * des images déjà en ligne, et l'API n'aurait aucun moyen de dire pourquoi.
 * Mieux vaut refuser ici, où l'on peut encore nommer le livre en cause.
 */
async function conflitDeDroits(empreintes: string[], publiable: boolean) {
  if (empreintes.length === 0) return [];
  // Écrit avec le constructeur de requêtes plutôt qu'en SQL brut : `= any($1)`
  // reçoit le tableau comme un paramètre scalaire et Postgres répond
  // « op ANY/ALL (array) requires array on right side ». `inArray` déplie la
  // liste en autant de paramètres, ce que le pilote sait faire.
  return db
    .select({ titre: livres.titre, publiable: livres.publiable })
    .from(pages)
    .innerJoin(livres, eq(livres.id, pages.livreId))
    .where(
      and(
        or(
          inArray(pages.imageSha256, empreintes),
          inArray(pages.vignetteSha256, empreintes),
        ),
        ne(livres.publiable, publiable),
      ),
    )
    .limit(5);
}

let livresEcrits = 0;
let pagesEcrites = 0;
let imagesEcrites = 0;
let octetsEcrits = 0;

for (const l of lot.livres) {
  const feuillets = lotPages.par_ark[l.sourceRef];
  if (!feuillets) {
    console.error(`${l.sourceRef} : aucune page dans le lot — versement interrompu`);
    process.exit(1);
  }

  const empreintes = feuillets.flatMap((p) => [p.image.sha256, p.vignette.sha256]);
  const conflits = await conflitDeDroits(empreintes, l.publiable);
  if (conflits.length > 0) {
    console.error(
      `${l.sourceRef} : ${conflits.length} image(s) déjà référencée(s) par un ` +
        `livre au régime opposé (« ${conflits[0]!.titre} »). Versement refusé.`,
    );
    process.exit(1);
  }

  if (ESSAI) {
    console.log(`  [essai] ${l.sourceRef} — ${feuillets.length} pages`);
    continue;
  }

  // Une transaction par livre. L'ordre compte : le livre d'abord parce que le
  // déclencheur `pages_pas_plus_permissive` lit son `publiable`, les images
  // avant les pages parce qu'une page pointant une empreinte absente est une
  // tuile 404 que rien ne signale.
  await db.transaction(async (tx) => {
    const [livre] = await tx
      .insert(livres)
      .values({
        id: id("livre"),
        sourceRef: l.sourceRef,
        source: l.source,
        titre: l.titre,
        auteur: l.auteur,
        annee: l.annee,
        anneeFin: l.anneeFin,
        langue: l.langue,
        pagesTotal: l.pagesTotal,
        statutFixation: l.statutFixation,
        licence: l.licence,
        licenceConstatee: l.licenceConstatee,
        publiable: l.publiable,
        urlNotice: l.urlNotice,
      })
      .onConflictDoUpdate({
        target: [livres.source, livres.sourceRef],
        set: {
          titre: l.titre,
          auteur: l.auteur,
          annee: l.annee,
          anneeFin: l.anneeFin,
          pagesTotal: l.pagesTotal,
          statutFixation: l.statutFixation,
          licence: l.licence,
          licenceConstatee: l.licenceConstatee,
          publiable: l.publiable,
          urlNotice: l.urlNotice,
          updatedAt: new Date(),
        },
      })
      .returning({ id: livres.id });

    for (const p of feuillets) {
      for (const r of [p.image, p.vignette]) {
        const octets = await readFile(join(resolve(RACINE), r.fichier));
        // L'empreinte est RECALCULÉE sur les octets lus, jamais crue sur
        // parole : c'est elle qui sert d'URL, donc une empreinte fausse
        // adresse un fichier que personne ne peut produire.
        const vrai = sha256Bytes(octets);
        if (vrai !== r.sha256) {
          throw new Error(
            `${r.fichier} : le lot annonce ${r.sha256.slice(0, 12)}… et le ` +
              `fichier vaut ${vrai.slice(0, 12)}…`,
          );
        }
        // La classe dit ce qui se RÉGÉNÈRE : une vignette se refabrique depuis
        // la page, un scan ne se refabrique pas. C'est ce qui permettra à une
        // règle de rétention de purger les dérivés sans pouvoir toucher aux
        // originaux. Voir lib/stockage/cles.ts.
        //
        // `ecrireObjet` recalcule l'empreinte, écrit l'objet AVANT la ligne, et
        // range selon `OBJETS_STOCKAGE` : le versement n'a plus à savoir où.
        const empreinte = await ecrireObjet(octets, "image/jpeg", r === p.vignette ? "derive" : "original", {
          meta: { largeur: r.largeur, hauteur: r.hauteur, source: l.sourceRef, folio: p.folio },
          tx: tx as unknown as typeof db,
        });
        if (empreinte !== r.sha256) {
          throw new Error(
            `${r.fichier} : le lot annonce ${r.sha256.slice(0, 12)}… et le ` +
              `fichier vaut ${empreinte.slice(0, 12)}…`,
          );
        }
        imagesEcrites++;
        octetsEcrits += r.octets;
      }

      await tx
        .insert(pages)
        .values({
          id: id("page"),
          livreId: livre!.id,
          folio: p.folio,
          pageImprimee: p.pageImprimee,
          texteOcr: p.texteOcr,
          ocrMoteur: p.texteOcr ? p.ocrMoteur : null,
          imageSha256: p.image.sha256,
          imageLargeur: p.image.largeur,
          imageHauteur: p.image.hauteur,
          vignetteSha256: p.vignette.sha256,
          publiable: p.publiable,
        })
        .onConflictDoUpdate({
          target: [pages.livreId, pages.folio],
          set: {
            texteOcr: p.texteOcr,
            ocrMoteur: p.texteOcr ? p.ocrMoteur : null,
            imageSha256: p.image.sha256,
            imageLargeur: p.image.largeur,
            imageHauteur: p.image.hauteur,
            vignetteSha256: p.vignette.sha256,
            updatedAt: new Date(),
          },
        });
      pagesEcrites++;
    }

    // Autocontrôle : relire les octets DEPUIS LEUR RANGEMENT et les re-hacher.
    // Le défaut qu'on cherche ici est muet — un `bytea` mal transmis s'insère
    // sans erreur et ne se voit qu'à l'écran, une fois l'image servie et
    // illisible. Relire depuis la base alors qu'on vient d'écrire dans le seau
    // ne vérifierait plus rien du tout : le témoin doit venir d'où viendra la
    // tuile.
    //
    // La lecture passe par `lireObjet`, qui consulte la colonne `stockage` de la
    // ligne : le témoin vient donc du dépôt réel, quel qu'il soit, sans que ce
    // script ait à le savoir.
    const attendue = feuillets[0]!.image.sha256;
    const relus = (await lireObjet(attendue))?.octets ?? null;
    if (!relus || sha256Bytes(relus) !== attendue) {
      throw new Error(
        `${l.sourceRef} : les octets relus depuis ${STOCKAGE} ne redonnent pas ` +
          `leur empreinte — ils n'ont pas été transmis tels quels`,
      );
    }
  });

  livresEcrits++;
  console.log(
    `  ✓ ${l.sourceRef.padEnd(16)} ${feuillets.length.toString().padStart(3)} pages   ` +
      `${l.titre.slice(0, 44)}`,
  );
}

/**
 * Les octets qu'aucune page ne référence plus.
 *
 * `images` n'a volontairement pas de clé étrangère — l'adressage par contenu
 * veut qu'une même image serve plusieurs pages, et une FK vers l'une d'elles
 * serait fausse. Mais rien ne ramasse ce que la cascade laisse : supprimer un
 * livre efface ses pages et laisse ses octets en base, indéfiniment.
 *
 * La route ne les sert plus (elle exige une référence servable), donc ce n'est
 * pas une fuite. C'est en revanche un RETRAIT INCOMPLET : quand un ayant droit
 * exige la suppression d'un ouvrage, « plus personne ne peut y accéder » n'est
 * pas « nous ne l'avons plus ». D'où ce balayage, à lancer après une
 * suppression.
 */
if (process.argv.includes("--purger-orphelines")) {
  // Les objets d'AUTRES fonctionnalités ne sont pas concernés : ce balayage ne
  // retient que ceux qu'aucune page ne référence ET qu'aucun autre gardien ne
  // réclamerait. Depuis que le dépôt est commun, « orphelin ici » n'est plus
  // « orphelin partout » — d'où la restriction explicite aux objets versés par
  // la bibliothèque, reconnaissables à leur `meta.source`.
  const orphelines = await db.execute<{ sha256: string }>(sql`
    select o.sha256 from objets o
     where o.meta ? 'source'
       and not exists (
             select 1 from pages p
              where p.image_sha256 = o.sha256 or p.vignette_sha256 = o.sha256)
  `);
  // `supprimerObjet` efface les octets AVANT la ligne : supprimer la ligne
  // d'abord réintroduirait le défaut que ce balayage corrige — « plus personne
  // ne peut y accéder » au lieu de « nous ne l'avons plus » — et, la ligne
  // partie, plus rien en base ne saurait que l'objet existe.
  for (const o of orphelines) await supprimerObjet(o.sha256);
  console.log(`${orphelines.length} image(s) orpheline(s) supprimée(s)`);
}

if (!ESSAI) {
  const [compte] = await db
    .select({
      livres: sql<number>`count(distinct ${livres.id})::int`,
      pages: sql<number>`count(${pages.id})::int`,
    })
    .from(livres)
    .leftJoin(pages, eq(pages.livreId, livres.id))
    .where(and(eq(livres.source, "gallica"), eq(livres.publiable, true)));
  console.log(
    `\n${livresEcrits} livres versés · ${pagesEcrites} pages · ` +
      `${imagesEcrites} images (${(octetsEcrits / 1e6).toFixed(0)} Mo)`,
  );
  console.log(
    `en base : ${compte?.livres ?? 0} livres Gallica publiables, ` +
      `${compte?.pages ?? 0} pages`,
  );
}

process.exit(0);
