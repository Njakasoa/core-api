/**
 * Ce qu'une personne peut accorder, et ce que cela permet d'en faire.
 *
 * POURQUOI CETTE LISTE EST FERMÉE ET SANS VALEUR PAR DÉFAUT
 * `tale_consents` a une seule raison d'être : attester ce qu'une personne a
 * accordé. Une colonne de cette table qui prend une valeur par défaut affirme
 * quelque chose que personne n'a dit — et le défaut initial était le plus
 * permissif des choix. Mesuré avant correction : un contributeur envoyant
 * explicitement « recherche non commerciale » recevait 201, et la ligne
 * affirmait « CC BY 4.0 », parce que le schéma d'entrée ignorait le champ et
 * que Zod retire en silence les clés qu'il ne connaît pas.
 *
 * Le dépôt de corpus pose déjà la règle, en toutes lettres :
 * « Une obligation juridique ne prend pas de valeur par défaut. »
 *
 * L'ORDRE COMPTE, ET IL EST CROISSANT EN RESTRICTION
 * Un récit ne peut pas être publié plus largement que ce que son conteur a
 * accordé. La comparaison est donc un ordre, pas une égalité : on refuse au
 * dépôt toute soumission dont le conteur accorde MOINS que ce que le conte
 * revendique. Refuser plutôt que rétrograder en silence — c'est le contributeur
 * qui doit voir l'écart et le résoudre, pas le serveur qui décide pour lui.
 */

/** De la plus permissive à la plus restrictive. L'index EST le rang. */
export const LICENCES = [
  "CC BY 4.0",
  "CC BY-NC 4.0",
  "recherche non commerciale",
] as const;

export type Licence = (typeof LICENCES)[number];

/** Rang de restriction : plus il est haut, moins la licence permet. */
export function rang(l: string): number {
  const i = (LICENCES as readonly string[]).indexOf(l);
  // Une licence inconnue est traitée comme la plus restrictive possible. Un
  // libellé qu'on ne sait pas lire ne doit jamais élargir ce qui est permis.
  return i === -1 ? LICENCES.length : i;
}

/** La licence accordée couvre-t-elle celle que le conte revendique ? */
export function couvre(accordee: string, revendiquee: string): boolean {
  return rang(accordee) <= rang(revendiquee);
}
