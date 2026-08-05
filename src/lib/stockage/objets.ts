import { sql } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { sha256Bytes } from "../crypto.ts";
import { empreinteValide, type Classe } from "./cles.ts";
import { depotParDefaut, depotR2, type NomDepot } from "./depots.ts";

/**
 * Les objets stockés, adressés par leur empreinte — pour toute fonctionnalité.
 *
 * CE MODULE NE SAIT PAS CE QU'IL RANGE
 * Un scan de page, la photo d'un cahier, une pièce jointe, un clip : ce sont des
 * octets, une empreinte, un type. Ce qui les rend servables ou non appartient à
 * la fonctionnalité qui les possède, et c'est le rôle du registre de gardiens
 * plus bas. Rien ici ne mentionne la bibliothèque, et c'est délibéré : la
 * fonctionnalité suivante s'y branche sans toucher à ce fichier.
 */

/**
 * Le verdict d'un gardien sur un objet.
 *
 *   servable   « je le référence, et il peut sortir »
 *   refusee    « je le référence, et il ne doit pas sortir »
 *   inconnue   « je ne le référence pas » — ce n'est PAS une permission
 */
export type Verdict = "servable" | "refusee" | "inconnue";

export interface Gardien {
  /** Le nom de la fonctionnalité, pour le journal quand un objet est refusé. */
  readonly nom: string;
  verdict(sha256: string): Promise<Verdict>;
}

const gardiens: Gardien[] = [];

/**
 * Une fonctionnalité déclare qu'elle a son mot à dire sur certains objets.
 *
 * Appelé au montage de la route, une fois. L'ordre n'a aucune importance : la
 * décision ci-dessous n'est pas une chaîne de responsabilité mais un vote où un
 * seul refus l'emporte.
 */
export function enregistrerGardien(g: Gardien): void {
  if (!gardiens.some((x) => x.nom === g.nom)) gardiens.push(g);
}

/** Pour les essais, qui montent l'application plusieurs fois. */
export function oublierGardiens(): void {
  gardiens.length = 0;
}

/**
 * Un objet sort si AU MOINS UN gardien le dit servable et AUCUN ne le refuse.
 *
 * LES DEUX MOITIÉS SONT NÉCESSAIRES, ET POUR DES RAISONS DIFFÉRENTES.
 *
 * « aucun ne refuse » sans « au moins un accepte » servirait tout objet
 * orphelin : personne ne le réclame, donc personne ne le refuse. Un ouvrage
 * retiré dont les lignes de rattachement ont disparu redeviendrait public par
 * le seul fait qu'on l'a détaché.
 *
 * « au moins un accepte » sans « aucun ne refuse » servirait tout objet
 * référencé deux fois, dès que l'une des références est permissive. Or
 * l'adressage par contenu fait que deux fonctionnalités PEUVENT désigner les
 * mêmes octets, avec des droits opposés — et rien ne dit alors laquelle des deux
 * étiquettes est fausse. Les coûts, eux, ne sont pas symétriques : refuser un
 * objet libre coûte une tuile blanche, servir un objet sous droits coûte un
 * retrait. On tranche du côté qui se répare.
 *
 * C'est exactement la règle que la bibliothèque appliquait en SQL pour ses
 * seules images ; elle est ici parce qu'elle vaut pour tout ce qu'on stockera.
 */
export async function objetServable(
  sha256: string,
): Promise<{ servable: boolean; refusePar: string[]; reclamePar: string[] }> {
  const refusePar: string[] = [];
  const reclamePar: string[] = [];
  for (const g of gardiens) {
    const v = await g.verdict(sha256);
    if (v === "refusee") refusePar.push(g.nom);
    else if (v === "servable") reclamePar.push(g.nom);
  }
  return {
    servable: reclamePar.length > 0 && refusePar.length === 0,
    refusePar,
    reclamePar,
  };
}

export interface Objet extends Record<string, unknown> {
  sha256: string;
  mime: string;
  octets: number;
  classe: Classe;
  stockage: NomDepot;
}

/** La fiche d'un objet, sans ses octets. */
export async function ficheObjet(sha256: string): Promise<Objet | null> {
  if (!empreinteValide(sha256)) return null;
  const [row] = await db.execute<Objet>(sql`
    select sha256, mime, octets, classe, stockage from objets where sha256 = ${sha256}
  `);
  return row ?? null;
}

/**
 * Les octets d'un objet, lus LÀ OÙ ILS SONT.
 *
 * La ligne dit son dépôt ; la variable d'environnement ne dit que la destination
 * des prochains versements et n'a rien à faire dans une lecture. C'est ce qui
 * rend une base à moitié migrée entièrement servable.
 */
export async function lireObjet(
  sha256: string,
): Promise<{ mime: string; octets: Uint8Array } | null> {
  const fiche = await ficheObjet(sha256);
  if (!fiche) return null;

  if (fiche.stockage === "r2") {
    const octets = await depotR2.lire(fiche.classe, sha256);
    return octets ? { mime: fiche.mime, octets } : null;
  }
  const [row] = await db.execute<{ contenu: Uint8Array | null }>(sql`
    select contenu from objets where sha256 = ${sha256}
  `);
  return row?.contenu ? { mime: fiche.mime, octets: row.contenu } : null;
}

/**
 * Verse des octets, dans le dépôt configuré, et enregistre la ligne.
 *
 * L'EMPREINTE EST RECALCULÉE, JAMAIS CRUE SUR PAROLE
 * Elle sert d'adresse : une empreinte fausse désigne un objet que personne ne
 * peut produire, et le défaut reste muet jusqu'à ce qu'une tuile manque à
 * l'écran. Tout chemin d'écriture passe ici, donc tous sont tenus par la règle.
 *
 * L'OBJET AVANT LA LIGNE, ET PAS L'INVERSE
 * Si l'écriture dans le dépôt échoue, aucune ligne n'affirme des octets
 * inexistants. Dans l'autre ordre, un échec après enregistrement laisserait une
 * référence vers du vide — c'est-à-dire une tuile blanche introuvable.
 * Rejouable sans dommage : le nom étant l'empreinte, réécrire c'est réécrire les
 * mêmes octets au même endroit.
 *
 * `tx` permet d'inscrire la ligne dans une transaction plus large, ce dont les
 * versements en lot ont besoin.
 */
export async function ecrireObjet(
  octets: Uint8Array,
  mime: string,
  classe: Classe,
  options: { meta?: Record<string, unknown>; tx?: typeof db } = {},
): Promise<string> {
  const sha256 = sha256Bytes(octets);
  const depot = depotParDefaut();
  const ex = options.tx ?? db;
  const meta = options.meta ?? {};

  if (depot === "r2") {
    await depotR2.ecrire(classe, sha256, octets, mime);
    await ex.execute(sql`
      insert into objets (sha256, mime, octets, classe, contenu, stockage, meta)
      values (${sha256}, ${mime}, ${octets.byteLength}, ${classe}, null, 'r2', ${meta})
      on conflict (sha256) do nothing
    `);
  } else {
    // `contenu` est un `bytea` déclaré `text` côté Drizzle : passer une chaîne JS
    // lui ferait appliquer la syntaxe d'entrée bytea et stockerait silencieusement
    // autre chose. Les octets passent par un fragment `sql`.
    await ex.execute(sql`
      insert into objets (sha256, mime, octets, classe, contenu, stockage, meta)
      values (${sha256}, ${mime}, ${octets.byteLength}, ${classe}, ${octets}, 'db', ${meta})
      on conflict (sha256) do nothing
    `);
  }
  return sha256;
}

/**
 * Supprime un objet — la ligne ET les octets.
 *
 * « Plus personne ne peut y accéder » n'est pas « nous ne l'avons plus ».
 * Supprimer la ligne en laissant l'objet dans le seau serait pire qu'un oubli :
 * plus rien en base ne saurait qu'il existe, et le retrait deviendrait
 * irrattrapable. L'ordre est donc l'inverse du versement.
 */
export async function supprimerObjet(sha256: string): Promise<void> {
  const fiche = await ficheObjet(sha256);
  if (!fiche) return;
  if (fiche.stockage === "r2") await depotR2.supprimer(fiche.classe, sha256);
  await db.execute(sql`delete from objets where sha256 = ${sha256}`);
}
