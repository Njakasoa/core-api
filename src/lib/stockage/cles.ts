/**
 * LA RÈGLE DE NOMMAGE DES OBJETS. Fixée ici, et nulle part ailleurs.
 *
 * Elle est écrite avant le premier versement parce qu'elle ne se renégocie pas :
 * un objet déjà dans le seau porte le nom qu'on lui a donné, et changer la règle
 * plus tard veut dire recopier tout ce qui existe, ou vivre avec deux règles.
 *
 *     <classe>/<aa>/<bb>/<sha256>
 *
 *     classe   original | derive
 *     aa       les 2 premiers caractères de l'empreinte
 *     bb       les 2 suivants
 *     sha256   l'empreinte complète, 64 caractères hexadécimaux minuscules
 *
 *     original/3f/a9/3fa9c2…e01b     un scan de page, une photo de cahier
 *     derive/c9/5b/c95b9a…8202       une vignette, un transcodage, un clip
 *
 * POURQUOI L'EMPREINTE ET RIEN D'AUTRE
 * Ni le nom du fichier d'origine, ni la fonctionnalité, ni la date. Le nom d'un
 * objet ne dépend QUE de son contenu, ce qui donne trois propriétés qu'aucune
 * autre convention ne donne ensemble : deux fonctionnalités qui manipulent les
 * mêmes octets partagent l'objet au lieu de le dupliquer ; un versement rejoué
 * réécrit le même objet au même endroit, donc il est rejouable sans dommage ; et
 * n'importe qui peut vérifier qu'un objet est le bon en le re-hachant.
 *
 * Ranger par fonctionnalité — `bibliotheque/…`, `avatars/…` — casserait les
 * trois : les mêmes octets auraient deux noms, et le jour où une image sert à
 * deux endroits, il faudrait choisir lequel ment.
 *
 * POURQUOI DEUX CLASSES, ET SEULEMENT DEUX
 * Elles ne classent pas le sujet, elles classent le REMPLAÇABLE. Un dérivé se
 * régénère à partir d'un original — une vignette, un transcodage, une synthèse
 * vocale ; un original ne se régénère pas. C'est la seule distinction dont
 * l'infrastructure a besoin : les règles de cycle de vie de R2 travaillent par
 * préfixe, donc `derive/` peut être purgé, expiré, ou reconstruit sans qu'aucune
 * règle ne puisse atteindre `original/` par accident.
 *
 * Une classe de plus par fonctionnalité redonnerait le classement par sujet, et
 * avec lui l'impossibilité d'écrire une règle de rétention qui veuille dire
 * quelque chose.
 *
 * POURQUOI DEUX NIVEAUX DE DEUX CARACTÈRES
 * 65 536 préfixes. R2 n'est pas un système de fichiers et n'a pas besoin d'être
 * soulagé, mais tout ce qui LISTE l'a : un inventaire, une restauration
 * partielle, un balayage de vérification peuvent avancer préfixe par préfixe au
 * lieu d'énumérer un seau entier. Le coût est nul, et l'ajouter après coup
 * voudrait dire renommer chaque objet.
 *
 * POURQUOI PAS D'EXTENSION
 * `.jpg` ferait dépendre le nom du type déclaré et non du seul contenu — deux
 * versements qui devinent le type différemment produiraient deux objets pour les
 * mêmes octets. Le type vit dans la ligne `objets.mime`, qui est aussi ce que
 * l'API renvoie en `Content-Type`. Le seau n'étant pas public, aucun navigateur
 * ne lit jamais ces noms.
 */

export const CLASSES = ["original", "derive"] as const;
export type Classe = (typeof CLASSES)[number];

const EMPREINTE = /^[a-f0-9]{64}$/;

/** Vrai pour une empreinte sha256 en hexadécimal minuscule, et rien d'autre. */
export function empreinteValide(sha256: string): boolean {
  return EMPREINTE.test(sha256);
}

/**
 * Le nom d'un objet dans le dépôt.
 *
 * Refuse une empreinte mal formée au lieu de fabriquer un nom : l'empreinte sert
 * d'adresse, donc un nom bâti sur une empreinte fausse désigne un objet que
 * personne ne peut produire — et le défaut reste muet jusqu'à ce qu'une image
 * manque à l'écran.
 */
export function cle(classe: Classe, sha256: string): string {
  if (!empreinteValide(sha256)) {
    throw new Error(`empreinte invalide : ${JSON.stringify(sha256.slice(0, 80))}`);
  }
  return `${classe}/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** Le préfixe d'une classe entière — ce sur quoi portent les règles de cycle de vie. */
export function prefixeClasse(classe: Classe): string {
  return `${classe}/`;
}
