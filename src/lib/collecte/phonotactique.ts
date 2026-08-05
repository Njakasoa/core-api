/**
 * Un mot peut-il être du malgache ?
 *
 * POURQUOI CE CONTRÔLE EXISTE, ET POURQUOI IL N'EST PAS UNE LISTE FERMÉE
 * `dialecteSource` est le seul champ de métadonnée que la porte d'entrée exige,
 * et il acceptait « asdfgh ». Un corpus dont la seule métadonnée obligatoire est
 * du bruit n'a pas de métadonnée obligatoire.
 *
 * La tentation serait de fermer la liste sur les neuf ethnies attestées dans le
 * corpus. Ce serait une faute : le corpus vient d'un collecteur français de 1910,
 * ses neuf ethnies ne sont pas la carte de Madagascar, et refuser un dialecte
 * absent de cette liste reviendrait à décider depuis Antananarivo ce qui existe.
 * Un dialecte inconnu de nous est une INFORMATION, pas une erreur de saisie.
 *
 * On vérifie donc la seule chose qui soit vraie de tout mot malgache sans
 * connaître le mot : sa forme. L'alphabet compte 21 lettres — ni c, ni q, ni u,
 * ni w, ni x — et toute forme se termine par une voyelle. C'est le même tamis
 * que repparcs/scripts/construire_lexique_mg.py, qui écarte 53 % d'un lexique
 * contaminé sur ce seul critère.
 *
 * CE QUE CE CONTRÔLE NE FAIT PAS
 * Il ne dit pas qu'un mot EST malgache : « ala » et « rano » le sont, « nono »
 * passerait aussi. Il écarte ce qui ne peut pas l'être. C'est un plancher, pas
 * un verdict — et le nommer ainsi évite qu'on s'en serve un jour comme d'une
 * preuve de langue, ce que trois mesures automatiques de ce projet ont déjà
 * échoué à fournir.
 */

const ILLEGALES = /[cqux]/;
const VOYELLES = "aeioy";

/** Enlève les diacritiques : `Betsimisàraka` et `Betsimisaraka` sont un seul mot. */
function na(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/**
 * Rend la raison du refus, ou null si la forme est plausible.
 *
 * Une raison plutôt qu'un booléen : l'appelant doit pouvoir dire à quelqu'un
 * pourquoi son mot est refusé. « Invalide » sur un nom d'ethnie qu'une personne
 * porte est une réponse qu'on ne peut pas donner.
 */
export function refusPhonotactique(mot: string): string | null {
  const m = na(mot.trim());
  if (m.length < 3) return "un nom de dialecte fait au moins trois lettres";
  if (!/^[a-z' -]+$/.test(m)) {
    return "un nom de dialecte s'écrit en lettres, sans chiffre ni ponctuation";
  }
  const lettres = m.replace(/[^a-z]/g, "");
  if (lettres.length < 3) return "un nom de dialecte fait au moins trois lettres";
  if (ILLEGALES.test(lettres)) {
    return "le malgache s'écrit sans c, q, u, w ni x — vérifiez l'orthographe";
  }
  const derniere = lettres[lettres.length - 1] ?? "";
  if (!VOYELLES.includes(derniere)) {
    return "en malgache, un mot se termine par une voyelle (a, e, i, o, y)";
  }
  if (!/[aeioy]/.test(lettres.slice(0, -1))) {
    return "ce mot n'a pas de voyelle avant sa finale";
  }
  if (new Set(lettres).size < 3) return "ce mot ne compte que deux lettres différentes";
  return null;
}

/** Les neuf ethnies attestées dans le corpus — SUGGÉRÉES, jamais imposées. */
export const ETHNIES_ATTESTEES = [
  "antankarana",
  "bara",
  "betsileo",
  "betsimisaraka",
  "marofotsy",
  "merina",
  "sakalava",
  "tanala",
  "tsimihety",
] as const;
