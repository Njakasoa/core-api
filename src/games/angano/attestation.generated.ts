// ─────────────────────────────────────────────────────────────────────────────
// FICHIER GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.
//
// Généré par  : repparcs/scripts/build_attestation_ts.py
// Source      : repparcs/data/casting_tantara.json
//               (lui-même produit par repparcs/scripts/build_casting.py)
// Régénérer   : python3 scripts/build_attestation_ts.py
// Vérifier    : python3 scripts/build_attestation_ts.py --verifier   (sort en 1 si dérive)
//
// Toute retouche à la main sera écrasée au prochain build, et fera échouer
// --verifier d'ici là : c'est le contrôle qui empêche le code de mentir sur le
// corpus. Corriger la source, jamais ce fichier.
//
// CE QUE LES CHIFFRES COMPTENT
// `occurrences` est le nombre d'occurrences DU NOM DU RÔLE dans les corpus en
// domaine public du projet. Les notions voisines — angatra pour kinoly, sikidy
// pour mpisikidy — ne sont PAS comptées : un angatra n'est pas un kinoly, le
// sikidy est la divination et non le devin. Les agréger ferait passer kinoly
// de 3 à 111.
//
// CE QUE LES CHIFFRES NE DISENT PAS
// Attesté ne veut pas dire validé. Les trois corpus sont une fixation coloniale
// de 1910, une chronique royale merina de 1908 et une revue missionnaire
// britannique. `validationCommunautaire` vaut null partout et le restera tant
// qu'aucune autorité communautaire malgache n'aura relu le corpus.
//
// POURQUOI CERTAINS RÔLES N'ONT PAS D'EXTRAIT
// Les extraits proviennent d'un OCR de 1875-1910. Ceux dont la lisibilité
// mesurée tombe sous le seuil, ou qui échouent à une porte de citabilité, sont
// OMIS — jamais réparés à la main : un extrait retouché n'est plus une citation.
// La raison de chaque omission est en commentaire à sa place.
// ─────────────────────────────────────────────────────────────────────────────

/** Où un rôle est attesté, combien de fois, et — si l'OCR le permet — un extrait citable. */
export interface Attestation {
  /** Corpus où le NOM du rôle apparaît, du mieux attesté au moins attesté. */
  corpus: { nom: string; occurrences: number; reference: string }[];
  /** Total des occurrences DU NOM DU RÔLE, tous corpus. Jamais les notions voisines. */
  occurrences: number;
  /** Graphies réellement trouvées dans les sources — pas celles qui ont été cherchées. */
  graphies: string[];
  /** Absent quand l'extrait disponible est trop dégradé pour être cité honnêtement. */
  extrait?: { texte: string; reference: string; langue: string };
  /** null tant qu'aucune autorité communautaire malgache n'a validé. Jamais true par défaut. */
  validationCommunautaire: null;
}

/** Mention à afficher partout où une attestation est montrée. Non négociable. */
export const AVERTISSEMENT_ATTESTATION = "Attesté ne veut pas dire validé. Les trois corpus sont une fixation coloniale de 1910, une chronique royale merina de 1908 et une revue missionnaire britannique. Aucune source n'a été validée par une autorité communautaire malgache : validation_communautaire est null partout, et le reste tant que le kit de relecture n'a pas tourné.";

export const ATTESTATIONS: Record<string, Attestation> = {
  mponina: {
    corpus: [
      { nom: "callet", occurrences: 38, reference: "Callet, Tantara ny Andriana eto Madagasikara, 1908 — domaine public" },
      { nom: "annual", occurrences: 1, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
    ],
    occurrences: 39,
    graphies: ["mponina"],
    // extrait omis : lisibilité OCR 71.1 < 95
    validationCommunautaire: null,
  },
  songomby: {
    corpus: [
      { nom: "annual", occurrences: 16, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
      { nom: "callet", occurrences: 2, reference: "Callet, Tantara ny Andriana eto Madagasikara, 1908 — domaine public" },
    ],
    occurrences: 18,
    graphies: ["songomby"],
    // extrait omis : lisibilité OCR 93.6 < 95; premier mot de la citation illisible
    validationCommunautaire: null,
  },
  mpisikidy: {
    corpus: [
      { nom: "callet", occurrences: 271, reference: "Callet, Tantara ny Andriana eto Madagasikara, 1908 — domaine public" },
      { nom: "annual", occurrences: 12, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
      { nom: "renel", occurrences: 5, reference: "Renel, Contes de Madagascar, 1910 — domaine public" },
    ],
    occurrences: 288,
    graphies: ["mpisikidy", "mpisikjdy", "mpislkidy", "mplsikidy"],
    // extrait omis : lisibilité OCR 56.5 < 95
    validationCommunautaire: null,
  },
  ombiasy: {
    corpus: [
      { nom: "annual", occurrences: 11, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
      { nom: "renel", occurrences: 11, reference: "Renel, Contes de Madagascar, 1910 — domaine public" },
      { nom: "callet", occurrences: 4, reference: "Callet, Tantara ny Andriana eto Madagasikara, 1908 — domaine public" },
    ],
    occurrences: 26,
    graphies: ["ombiasy"],
    // extrait omis : lisibilité OCR 61.8 < 95
    validationCommunautaire: null,
  },
  fanany: {
    corpus: [
      { nom: "annual", occurrences: 9, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
      { nom: "renel", occurrences: 3, reference: "Renel, Contes de Madagascar, 1910 — domaine public" },
    ],
    occurrences: 12,
    graphies: ["fananimpitoloha", "fanany"],
    // extrait omis : lisibilité OCR 89.0 < 95
    validationCommunautaire: null,
  },
  zazavavindrano: {
    corpus: [
      { nom: "renel", occurrences: 4, reference: "Renel, Contes de Madagascar, 1910 — domaine public" },
    ],
    occurrences: 4,
    graphies: ["razazavavindrano"],
    // extrait omis : lisibilité OCR 74.0 < 95
    validationCommunautaire: null,
  },
  kalanoro: {
    corpus: [
      { nom: "annual", occurrences: 3, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
    ],
    occurrences: 3,
    graphies: ["kalanero", "kalanoro"],
    extrait: {
      texte: "Roary is another mythical creature which, I believe, is supposed to inhabit the forest. It is said to be like a long-mouthed ox with the tail of a donkey. There are also the Kalanéro, or wild men of the woods, of which Mr. G. Herbert Smith in ANNUAL x. p. 242, gives an account. He says they are ‘“‘represented as very short of stature, covered …",
      reference: "The Antananarivo Annual and Madagascar Magazine, vol. 1892, § 127",
      langue: "eng_Latn",
    },
    validationCommunautaire: null,
  },
  kinoly: {
    corpus: [
      { nom: "annual", occurrences: 3, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
    ],
    occurrences: 3,
    graphies: ["kinoly"],
    // extrait omis : entrée de glossaire, pas du texte courant
    validationCommunautaire: null,
  },
  mpamosavy: {
    corpus: [
      { nom: "callet", occurrences: 42, reference: "Callet, Tantara ny Andriana eto Madagasikara, 1908 — domaine public" },
      { nom: "annual", occurrences: 16, reference: "The Antananarivo Annual and Madagascar Magazine, 1875-1897 — domaine public" },
    ],
    occurrences: 58,
    graphies: ["mpamosavy"],
    extrait: {
      texte: "… ; fatra-pifehy trano fangalarina. Too suspicious proves you a witch; too careful to fasten up the house proves you a thief. Extreme timidit ‘own evil practices. The word mpamosavy is used to male aswell as.a female practitioner of the black art, but for the convenience of translation we shall consider’ it as applying to the feminine gender …",
      reference: "The Antananarivo Annual and Madagascar Magazine, vol. 1893, § 116",
      langue: "eng_Latn",
    },
    validationCommunautaire: null,
  },
};
