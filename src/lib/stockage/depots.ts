import { env } from "../../env.ts";
import { cle, type Classe } from "./cles.ts";

/**
 * Les dépôts d'octets : Postgres, ou un stockage d'objet compatible S3.
 *
 * CE FICHIER EST LE « UN SEUL GESTIONNAIRE » QUE LE SCHÉMA AVAIT PROMIS
 * `schema.ts` annonçait le coût du `bytea` — WAL, sauvegardes et réplication
 * gonflés du volume des octets, une ligne entière lue à chaque tuile — et
 * promettait que le passage à un stockage d'objet tiendrait « dans UN
 * gestionnaire, pas dans le contrat d'URL, pas dans les lignes, pas chez les
 * clients ». C'est ici, et la promesse tient : les URL ne changent pas, les
 * empreintes ne changent pas, les clients ne changent pas.
 *
 * RIEN ICI NE CONNAÎT LA BIBLIOTHÈQUE
 * Ce dépôt range des octets adressés par leur empreinte. Ce qu'ils représentent
 * — un scan de page, la photo d'un cahier, un clip de narration, une pièce
 * jointe — ne le regarde pas, et c'est ce qui lui permet de servir la
 * fonctionnalité suivante sans être retouché. Les droits, eux, ne sont jamais
 * ici : ils sont dans la fonctionnalité qui possède l'objet (voir `objets.ts`).
 *
 * LE SEAU N'EST PAS PUBLIC, ET CE N'EST PAS UN OUBLI
 * R2 sait exposer un seau derrière un domaine public et le servir depuis le
 * cache de Cloudflare — ce serait plus rapide et l'égrès serait gratuit. On ne
 * le fait pas, parce que l'autorisation de servir un objet se décide en base, et
 * qu'un seau public la rend inatteignable : l'empreinte suffirait, et une
 * empreinte se partage. `ny_voary_1980` — le seul livre dont on possède les
 * images de pages — est précisément sous droits, et il ne sera pas le dernier
 * objet du dépôt à ne pas devoir sortir.
 *
 * Ce que ça coûte, dit plutôt que tu : les octets transitent par l'API, donc
 * l'égrès reste sur la machine et le cache de Cloudflare ne travaille pas. Ce
 * qu'on gagne quand même est le plus gros du problème — la base cesse d'enfler,
 * les sauvegardes redeviennent petites, et le volume stocké n'est plus plafonné
 * par le disque.
 */

export type NomDepot = "db" | "r2";

export interface Depot {
  readonly nom: NomDepot;
  lire(classe: Classe, sha256: string): Promise<Uint8Array | null>;
  ecrire(classe: Classe, sha256: string, octets: Uint8Array, mime: string): Promise<void>;
  supprimer(classe: Classe, sha256: string): Promise<void>;
}

let client: import("bun").S3Client | null = null;
let clientTente = false;

/**
 * Le client S3, construit à la première demande.
 *
 * Paresseux exprès : la plupart des processus qui importent ce module ne liront
 * jamais un objet — les tests d'authentification, le distributeur de webhooks —
 * et construire au chargement un client vers un service absent ferait échouer
 * des chemins qui n'ont rien à voir avec le stockage.
 *
 * `Bun.S3Client` parle S3 nativement : aucune dépendance n'est ajoutée pour ça,
 * et R2, MinIO ou S3 lui-même se branchent par le seul point d'entrée.
 */
function s3(): import("bun").S3Client {
  if (!clientTente) {
    clientTente = true;
    if (env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
      client = new Bun.S3Client({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        endpoint:
          env.R2_ENDPOINT ?? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        // R2 ignore la région, mais la signature S3 en exige une ; « auto » est
        // celle que Cloudflare documente.
        region: "auto",
      });
    }
  }
  if (!client) {
    throw new Error(
      "Le dépôt d'objets n'est pas configuré : R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY et R2_BUCKET sont requis pour lire ou écrire en `r2`.",
    );
  }
  return client;
}

/** Vrai quand le dépôt d'objets a de quoi fonctionner. */
export const depotObjetConfigure = (): boolean =>
  Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);

/** Remet le client à zéro — pour les essais, qui changent de point d'entrée. */
export function oublierClientDepot(): void {
  client = null;
  clientTente = false;
}

const ABSENT = new Set(["NoSuchKey", "ERR_S3_FILE_NOT_FOUND", "NoSuchBucket"]);

export const depotR2: Depot = {
  nom: "r2",

  /**
   * Rend `null` quand l'objet est absent, plutôt que de laisser filer l'erreur.
   * L'appelant sait déjà répondre 404 à un objet introuvable, et il ne peut pas
   * distinguer « jamais versé » de « versé puis perdu » — au navigateur, la
   * seule réponse honnête est la même dans les deux cas. Le journal, lui,
   * distingue : c'est `objets.ts` qui s'en charge.
   */
  async lire(classe, sha256) {
    try {
      return new Uint8Array(await s3().file(cle(classe, sha256)).arrayBuffer());
    } catch (e) {
      if (ABSENT.has((e as { code?: string }).code ?? "")) return null;
      throw e;
    }
  },

  async ecrire(classe, sha256, octets, mime) {
    await s3().write(cle(classe, sha256), octets, { type: mime });
  },

  async supprimer(classe, sha256) {
    try {
      await s3().delete(cle(classe, sha256));
    } catch (e) {
      if (ABSENT.has((e as { code?: string }).code ?? "")) return;
      throw e;
    }
  },
};

/** Là où atterriront les prochains octets versés — `IMAGES_STOCKAGE`. */
export const depotParDefaut = (): NomDepot => env.OBJETS_STOCKAGE;
