/**
 * How far a corrected version drifted from the raw one, in letters.
 *
 * THE RULE, AND WHY THIS IS STRICTER THAN THE ONE IT COMES FROM
 * repparcs/scripts/validate.py normalises a text to letters only and fails when
 * the corrected form differs from the raw one by more than 2 %. The intent is
 * sound — cleaning may rejoin a hyphen or collapse a space, never change a word.
 *
 * But it compares LENGTHS:
 *     abs(len(norm(brute)) - len(norm(corrigee))) > 0.02 * len(norm(brute))
 * so a rewrite that happens to keep the same letter count sails through.
 * Measured on a real pair:
 *     brute      "Nisy indray mandeha, hono, lehilahy roa nifaninana tamin'ny hafetsena."
 *     réécrit    "Nosy andria mandola, hino, lehibiaka rea nifanovana taminy hafatsona."
 *     58 lettres de part et d'autre, Δ = 0 → accepté, chaque mot changé.
 *
 * So this is NOT a port. It measures the longest common subsequence, which sees
 * a substitution that a length comparison cannot. It is deliberately harsher
 * than the gate downstream: a submission platform should refuse at the door what
 * the corpus validator would have to catch at release.
 *
 * The weaker check upstream is worth fixing in repparcs too, and this file is
 * the evidence for that — but a stricter local rule is safe in the meantime,
 * because everything it accepts, validate.py also accepts.
 *
 * Stored as parts per million rather than a float: an integer compares exactly,
 * and "2 %" is a threshold that should not depend on binary rounding.
 */

/** Letters only, lowercased, accents kept — the same class as `[^a-zà-ÿ]`. */
export function lettres(texte: string): string {
  return texte.toLowerCase().replace(/[^a-zà-ÿ]/g, "");
}

/**
 * Divergence in parts per million, relative to the raw text's length.
 *
 * Measured on the LONGEST COMMON SUBSEQUENCE rather than a naive length
 * difference: swapping two letters changes nothing in length while changing the
 * word, and a rule that cannot see that is not a rule.
 */
export function divergencePpm(brute: string, corrigee: string): number {
  const a = lettres(brute);
  const b = lettres(corrigee);
  if (a.length === 0) return b.length === 0 ? 0 : 1_000_000;
  const commun = sousSequenceCommune(a, b);
  const change = Math.max(a.length, b.length) - commun;
  return Math.round((change / a.length) * 1_000_000);
}

/**
 * Length of the longest common subsequence, in O(min(n,m)) memory.
 *
 * Two rolling rows rather than a full matrix: a tale runs to a few thousand
 * letters, and a full matrix would be tens of millions of cells for a check
 * that happens on every correction.
 */
function sousSequenceCommune(a: string, b: string): number {
  if (b.length < a.length) [a, b] = [b, a];
  let prev = new Uint32Array(a.length + 1);
  let cur = new Uint32Array(a.length + 1);
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      cur[i] = a[i - 1] === b[j - 1] ? (prev[i - 1] ?? 0) + 1
        : Math.max(prev[i] ?? 0, cur[i - 1] ?? 0);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[a.length] ?? 0;
}

/** The threshold repparcs/scripts/validate.py enforces: 2 %. */
export const DIVERGENCE_MAX_PPM = 20_000;
