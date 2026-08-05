/**
 * Le texte corrigé d'une page, et le contexte qui rend une correction jugeable.
 *
 * CE QUI EST CORRIGÉ N'EST PAS UNE PAGE, C'EST UNE LECTURE
 * Toutes les fonctions d'ici travaillent sur le texte d'UNE ligne de `page_ocr`.
 * Les offsets d'une correction acceptée sur `tesseract-fra` tombent au milieu
 * d'autres mots dans `tesseract-eng` : il y a donc un texte corrigé par lecture,
 * jamais un par page. Les fusionner reviendrait à désigner une gagnante.
 */

export interface Edition {
  debut: number;
  fin: number;
  propose: string;
}

/**
 * Applique des corrections à un texte de base.
 *
 * De la FIN vers le DÉBUT, pour que les offsets restants restent valides pendant
 * qu'on modifie la chaîne. En parcourant dans l'autre sens il faudrait tenir un
 * décalage courant, et ce décalage est exactement le genre de variable qu'on
 * oublie de mettre à jour dans une branche.
 *
 * La base garantit déjà qu'aucune correction acceptée ne chevauche une autre sur
 * la même lecture (contrainte d'exclusion `page_corrections_accepte_sans_
 * chevauchement_ex`). On ne le revérifie donc pas : on trie, et on applique.
 */
export function appliquer(base: string, editions: Edition[]): string {
  const ordonnees = [...editions].sort((a, b) => b.debut - a.debut);
  let texte = base;
  for (const e of ordonnees) {
    texte = texte.slice(0, e.debut) + e.propose + texte.slice(e.fin);
  }
  return texte;
}

/**
 * Ce qu'un relecteur a besoin de voir autour d'un mot.
 *
 * Un relecteur qui lit « hontra → hoatra » sans sa phrase juge une chaîne, pas
 * une page. Le protocole hors ligne de ce projet montre toujours l'entourage —
 * et, quand la boîte englobante existe, le rognage de l'image.
 *
 * Les bords sont signalés par un caractère de troncature plutôt que laissés
 * ambigus : « …ny fahavalony » et « ny fahavalony » ne disent pas la même chose
 * à quelqu'un qui décide si un mot commence bien là.
 */
export function contexte(
  texte: string,
  debut: number,
  fin: number,
  marge = 60,
): { avant: string; lu: string; apres: string } {
  const g = Math.max(0, debut - marge);
  const d = Math.min(texte.length, fin + marge);
  return {
    avant: (g > 0 ? "…" : "") + texte.slice(g, debut),
    lu: texte.slice(debut, fin),
    apres: texte.slice(fin, d) + (d < texte.length ? "…" : ""),
  };
}
