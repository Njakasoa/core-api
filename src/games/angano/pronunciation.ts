/**
 * Malagasy → French-phonetic respelling, applied just before text-to-speech.
 *
 * A French TTS voice reads Malagasy orthography the French way and mangles every
 * role name. Two rules cover most of it:
 *   - Malagasy `o` is [u]  → French `ou`   (Songomby → sougoumbi)
 *   - a final `y` is [ɨ]   → French `i`    (Mpisikidy → mpisikidi)
 *
 * We respell whole words rather than applying letter rules, so the map stays
 * readable and auditable — and so a mistake is one line, not a broken algorithm.
 * Only the spoken form changes; every displayed string keeps its real spelling.
 */
const PHONETIC: Record<string, string> = {
  // roles
  songomby: "sougoumbi",
  mpisikidy: "mpissikidi",
  ombiasy: "oumbiassi",
  fanany: "fanani",
  zazavavindrano: "zazavavindranou",
  kalanoro: "kalanourou",
  kinoly: "kinouli",
  mpamosavy: "mpamoussavi",
  mponina: "mpounina",
  // world & lore
  angano: "anganou",
  razana: "razana",
  sikidy: "sikidi",
  fady: "fadi",
  ody: "oudi",
  lamba: "lamba",
  ombiasa: "oumbiassa",
  tromba: "troumba",
  kokolampo: "koukoulampou",
  trimobe: "trimoubé",
  lalomena: "laloumena",
  zebu: "zébu",
  vazimba: "vazimba",
};

// One pass, longest-first so `zazavavindrano` wins over any shorter prefix.
const PATTERN = new RegExp(
  `\\b(${Object.keys(PHONETIC).sort((a, b) => b.length - a.length).join("|")})\\b`,
  "gi",
);

/** Re-apply the original word's capitalization to its respelling. */
function matchCase(source: string, replacement: string): string {
  if (source === source.toUpperCase() && source.length > 1) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) return replacement[0]!.toUpperCase() + replacement.slice(1);
  return replacement;
}

/** Respell Malagasy terms phonetically for a French TTS voice. */
export function toSpeakable(text: string): string {
  return text.replace(PATTERN, (word) => matchCase(word, PHONETIC[word.toLowerCase()]!));
}
