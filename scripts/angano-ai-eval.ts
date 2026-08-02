import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildMissionSheets, type MissionPlayer } from "../src/games/angano/missions.ts";
import type { PlayerMissionSheet } from "../src/games/angano/protocol.ts";
import { OPTIONAL_ROLES, ROLES, roleName } from "../src/games/angano/roles.ts";
import {
  generateStoryWithMeta,
  NIGHT_STORY_PHASES,
  type StoryConfig,
  type StoryGenerationOptions,
  type StoryGenerationResult,
  type StorySetup,
} from "../src/games/angano/story.ts";

type Severity = "error" | "warn" | "info";

interface EvalIssue {
  severity: Severity;
  code: string;
  message: string;
  evidence?: string[];
  hint?: string;
}

interface EvalResult {
  score: number;
  status: "ok" | "watch" | "fail";
  issues: EvalIssue[];
  detectedMotifs: string[];
  activeRoles: string[];
}

interface PreviousRun {
  title: string;
  motifs: Set<string>;
}

interface CliOptions {
  runs: number;
  out: string;
  model?: string;
  effort?: string;
  provider?: "claude" | "codex";
  timeoutMs?: number;
}

const ACTIVE_ROLES = ["mponina", "songomby", ...OPTIONAL_ROLES];
const CONFIG: StoryConfig = { songomby: 1, roles: OPTIONAL_ROLES, pace: "rapide" };
const PLAYERS: MissionPlayer[] = [
  { id: "p1", name: "Aina", roleId: "mponina" },
  { id: "p2", name: "Tiana", roleId: "songomby" },
  { id: "p3", name: "Soa", roleId: "mpisikidy" },
  { id: "p4", name: "Lova", roleId: "ombiasy" },
  { id: "p5", name: "Fara", roleId: "fanany" },
  { id: "p6", name: "Miora", roleId: "zazavavindrano" },
  { id: "p7", name: "Hery", roleId: "kalanoro" },
  { id: "p8", name: "Koto", roleId: "kinoly" },
  { id: "p9", name: "Vola", roleId: "mpamosavy" },
];
const PUBLIC_ALLOWED_DEATHS = new Set(["{victim}", "{role}", "{count}"]);
const PLACEHOLDER_RE = /\{[a-zA-Z][a-zA-Z0-9]*\}/g;
// The attested formulas the corpus pack now injects carry their blank between
// angle brackets — "Voilà pourquoi, dit-on, <trait durable du monde>." The
// sanitizer strips those before the table ever sees them, so this is checked on
// the AI's RAW output: a copied blank is a prompt failure worth correcting, not
// a rendering bug.
const CORPUS_SLOT_RE = /<[^<>]{2,60}>/g;
// Two sentences ending on "les autres" or "des lianes" have rhymed nothing. The
// same trap was measured on Renel: of the pairs a naive count flagged there, 60%
// were only a function word in final position, and 85% a shared inflection.
const RHYME_STOPWORDS = new Set([
  "autres", "elle", "elles", "eux", "lui", "leur", "leurs", "cela", "celui", "celle",
  "ceux", "celles", "tous", "toutes", "tout", "toute", "meme", "memes", "ainsi",
  "alors", "encore", "aussi", "plus", "moins", "deja", "jamais", "toujours",
  "avec", "sans", "dans", "pour", "vers", "chez", "entre", "contre", "une", "les",
  "des", "que", "qui", "son", "ses",
]);
// When the shared ending is a French inflection, three letters prove nothing:
// "fendent/reforment" is conjugation, not rhyme. Those pairs must agree on four,
// which keeps "lentement/brusquement" and drops the twenty accidents around it.
const INFLECTIONAL_ENDINGS = new Set(["ent", "ait", "ais", "ant", "ees", "ons", "iez"]);
const MERISM_RE = /\bni\s+\S[^,.;!?]{0,40}?\bni\s/g;
const CORRECTIVE_RE = /\bce n'est pas\b[^.!?]{1,90}\bc'est\b/g;
const LAHY_VAVY_RE = /\w+lahy\b.{0,30}?\w+vavy\b/g;
const CARDINALS = ["nord", "sud", "est", "ouest"];
const BAD_ACCENT_TERMS: Array<{ re: RegExp; correct: string }> = [
  { re: /\brole(s)?\b/gi, correct: "rôle(s)" },
  { re: /\bspecial(e|es|s)?\b/gi, correct: "spécial/spéciaux" },
  { re: /\bactive(e|es|s)?\b/gi, correct: "activé/activés" },
  { re: /\blegende(s)?\b/gi, correct: "légende(s)" },
  { re: /\bcoherent(e|es|s)?\b/gi, correct: "cohérent(e)(s)" },
  { re: /\bmajorite\b/gi, correct: "majorité" },
  { re: /\betape(s)?\b/gi, correct: "étape(s)" },
  { re: /\bscenario(s)?\b/gi, correct: "scénario(s)" },
];
const ROLE_SPELLING_TERMS: Array<{ re: RegExp; correct: string }> = [
  { re: /\bzazavavavindrano\b/gi, correct: "Zazavavindrano" },
  { re: /\bzazavindrano\b/gi, correct: "Zazavavindrano" },
  { re: /\bmpisikidi\b/gi, correct: "Mpisikidy" },
  { re: /\bkilony\b/gi, correct: "Kinoly" },
  { re: /\bkinaoly\b/gi, correct: "Kinoly" },
  { re: /\bombiasa\b/gi, correct: "Ombiasy" },
];

const ROLE_KEYWORDS: Record<string, string[]> = {
  mponina: ["débat", "avis", "vote", "accus", "fokonolona", "parole"],
  songomby: ["proie", "chasse", "sabot", "lay", "bête", "doute", "piég"],
  mpisikidy: ["question", "signe", "sikidy", "graine", "natte", "réponse"],
  ombiasy: ["prot", "remède", "ody", "sampy", "guér", "ancêtre"],
  fanany: ["fady", "ancêtre", "razana", "marque", "tombe", "vengeance"],
  zazavavindrano: ["eau", "rano", "fady", "offrande", "promesse", "cascade"],
  kalanoro: ["trace", "pas", "sentier", "alibi", "incohérence", "forêt"],
  kinoly: ["réveil", "réveill", "après", "nuit", "tombe", "survis"],
  mpamosavy: ["soupçon", "doute", "toit", "malédiction", "vorika", "nuit"],
};

const MOTIF_DEFS: Record<string, RegExp[]> = {
  lac: [/\blac\b/i, /\brano masina\b/i, /\beau sacr[ée]/i],
  foret: [/\bfor[eê]t\b/i, /\bjungle\b/i, /\bmousse\b/i, /\bsentier/i],
  grotte: [/\bgrotte\b/i, /\bcaverne\b/i],
  rivage: [/\brivage\b/i, /\bplage\b/i, /\bmar[ée]e\b/i, /\br[ée]cif/i],
  pirogue: [/\bpirogue\b/i, /\bfilet\b/i],
  hautes_terres: [/\blat[ée]rite\b/i, /\bcolline\b/i, /\bpoussi[èe]re rouge\b/i],
  tombeaux: [/\btombe/i, /\brazana\b/i, /\banc[êe]tre/i, /\bpierre lev[ée]e\b/i],
  marche: [/\bmarch[ée]\b/i, /\bcarrefour\b/i, /\b[ée]tal/i],
  cascade: [/\bcascade\b/i, /\bravin\b/i, /\bpont\b/i],
  zebu: [/\bz[ée]bu\b/i, /\benclos\b/i, /\bcorne\b/i],
  mangrove: [/\bmangrove\b/i, /\bracine/i, /\beau saum[âa]tre\b/i],
  riziere: [/\brizi[èe]re\b/i],
  baobab: [/\bbaobab\b/i],
  miel: [/\bmiel\b/i, /\blait\b/i, /\boffrande\b/i],
};

const HINTS_BY_CODE: Record<string, string> = {
  fallback: "Retourne toujours un JSON complet et valide ; aucun texte hors JSON, aucune clé majeure vide.",
  public_placeholder: "Ne laisse aucun placeholder public hors deaths, ni aucun emplacement <…> des formules attestées ; les textes publics doivent être prêts à lire.",
  private_placeholder: "Dans les fiches privées, utilise uniquement {playerName}, {villageName}, {storyTitle}, {roleName}, puis aucun autre placeholder.",
  missing_role_sheet: "Fournis une fiche roleSheets complète pour chaque rôle actif, y compris mponina, songomby et tous les rôles spéciaux activés.",
  missing_role_epithet: "Fournis une épithète roleEpithets courte pour chaque rôle actif.",
  missing_night_step: "Fournis une phrase nightSteps dédiée pour chaque rôle actif qui agit la nuit.",
  mission_specificity: "Chaque mission doit exploiter le folklore et le gameplay social exact du rôle, pas une mission générique.",
  kinoly_gate: "La fiche Kinoly doit rappeler que mission et pouvoir n'existent qu'après son réveil par une mort nocturne évitée.",
  milestone_schema: "rewardTitle est un titre honorifique de mission ; les pouvoirs mécaniques restent dans le catalogue serveur avec requiredTitles.",
  accent: "Respecte les accents français dans les textes naturels : rôles, spéciaux, activés, légende, majorité, scénario.",
  role_spelling: "Respecte exactement les noms canoniques des rôles : Mponina, Songomby, Mpisikidy, Ombiasy, Fanany, Zazavavindrano, Kalanoro, Kinoly, Mpamosavy.",
  rhyme: "N'écris aucune rime de fin ni assonance cherchée : la poésie orale malgache ne rime pas, et une rime française y sonne comme une comptine plaquée. La cadence vient de la reprise d'un cadre, pas du son.",
  parallelism: "Construis par membres appariés : même cadre répété avec un seul terme changé, mérisme « ni X ni Y », « ce n'est pas X, c'est Y », triade concrète, phrase-refrain redite mot pour mot.",
  diversity: "Change franchement de lieu, menace, objets et images par rapport aux runs précédents.",
  config: "Ne retire aucun rôle spécial activé par l'hôte et garde une composition cohérente avec les joueurs.",
};

const cli = parseCli();
const runOptions: StoryGenerationOptions = {
  provider: cli.provider,
  model: cli.model,
  reasoningEffort: cli.effort,
  timeoutMs: cli.timeoutMs,
};

await mkdir(cli.out, { recursive: true });

let feedbackHints: string[] = [];
const previousRuns: PreviousRun[] = [];
const summaries: Array<{
  run: number;
  title: string;
  villageName: string;
  score: number;
  status: EvalResult["status"];
  ms: number;
  fallback: boolean;
  provider: string;
  model?: string;
  reasoningEffort?: string;
  issues: EvalIssue[];
  hintsIn: string[];
  hintsOut: string[];
}> = [];

console.log(`[angano-ai-eval] runs=${cli.runs} out=${cli.out}`);

for (let run = 1; run <= cli.runs; run++) {
  const hintsIn = feedbackHints;
  const generated = await generateStoryWithMeta(PLAYERS.length, CONFIG, { ...runOptions, feedbackHints: hintsIn });
  const missions = [...buildMissionSheets(PLAYERS, generated.story).values()];
  const evaluation = evaluate(generated, missions, previousRuns);
  const hintsOut = nextHints(hintsIn, evaluation.issues);
  const record = {
    run,
    generatedAt: new Date().toISOString(),
    config: CONFIG,
    players: PLAYERS,
    generation: {
      fallback: generated.fallback,
      ms: generated.ms,
      provider: generated.provider,
      model: generated.model,
      reasoningEffort: generated.reasoningEffort,
      seed: generated.seed,
      direction: generated.direction,
    },
    hintsIn,
    hintsOut,
    rawAiOutput: generated.raw,
    sanitizedStory: generated.story,
    missionSheets: missions,
    evaluation,
  };

  await writeJson(join(cli.out, `run-${pad(run)}.story.json`), record);
  await writeFile(join(cli.out, `run-${pad(run)}.md`), renderRunMarkdown(record), "utf8");

  summaries.push({
    run,
    title: generated.story.title,
    villageName: generated.story.villageName,
    score: evaluation.score,
    status: evaluation.status,
    ms: generated.ms,
    fallback: generated.fallback,
    provider: generated.provider,
    model: generated.model,
    reasoningEffort: generated.reasoningEffort,
    issues: evaluation.issues,
    hintsIn,
    hintsOut,
  });
  previousRuns.push({ title: generated.story.title, motifs: new Set(evaluation.detectedMotifs) });
  feedbackHints = hintsOut;

  const issueCodes = evaluation.issues.map((issue) => `${issue.severity}:${issue.code}`).join(", ") || "aucun";
  console.log(
    `[run ${run}/${cli.runs}] ${evaluation.status.toUpperCase()} score=${evaluation.score} ` +
      `fallback=${generated.fallback ? "yes" : "no"} ms=${generated.ms} title="${generated.story.title}" issues=${issueCodes}`,
  );
}

const summary = {
  generatedAt: new Date().toISOString(),
  config: CONFIG,
  players: PLAYERS,
  runs: summaries,
  finalFeedbackHints: feedbackHints,
};
await writeJson(join(cli.out, "summary.json"), summary);
await writeFile(join(cli.out, "summary.md"), renderSummaryMarkdown(summary), "utf8");
console.log(`[angano-ai-eval] summary=${join(cli.out, "summary.md")}`);

function evaluate(generated: StoryGenerationResult, missions: PlayerMissionSheet[], previous: PreviousRun[]): EvalResult {
  const issues: EvalIssue[] = [];
  let score = 100;
  const story = generated.story;
  const raw = rawObject(generated.raw);
  const motifs = detectMotifs(story);

  const add = (severity: Severity, code: string, message: string, penalty: number, evidence?: string[]) => {
    issues.push({ severity, code, message, evidence, hint: HINTS_BY_CODE[code] });
    score -= penalty;
  };

  if (generated.fallback) add("error", "fallback", "La génération est tombée sur un preset local fallback.", 30);

  const publicStrings = collectPublicStoryStrings(story);
  const publicLeaks = findPlaceholders(publicStrings.filter((entry) => !entry.path.startsWith("deaths.")), new Set());
  const deathLeaks = findPlaceholders(publicStrings.filter((entry) => entry.path.startsWith("deaths.")), PUBLIC_ALLOWED_DEATHS);
  if (publicLeaks.length || deathLeaks.length) {
    add("error", "public_placeholder", "Des placeholders non autorisés restent dans les textes publics.", 12, [...publicLeaks, ...deathLeaks].slice(0, 8));
  }

  const slotLeaks = collectStrings(raw, "raw")
    .flatMap((entry) => (entry.value.match(CORPUS_SLOT_RE) ?? []).map((slot) => `${entry.path}: ${slot}`));
  if (slotLeaks.length) {
    add("error", "public_placeholder", "L'IA a recopié les chevrons d'une formule attestée au lieu de remplir l'emplacement.", 12, slotLeaks.slice(0, 8));
  }

  const missionLeaks = findPlaceholders(missions.flatMap((sheet) => collectStrings(sheet, `missionSheets.${sheet.playerId}`)), new Set());
  if (missionLeaks.length) {
    add("error", "private_placeholder", "Des placeholders restent dans les fiches remises aux joueurs.", 12, missionLeaks.slice(0, 8));
  }

  for (const roleId of ACTIVE_ROLES) {
    if (!raw.roleSheets?.[roleId]) {
      add("warn", "missing_role_sheet", `L'IA n'a pas fourni de fiche roleSheets pour ${roleId}.`, 6);
    }
    if (!raw.roleEpithets?.[roleId]) {
      add("warn", "missing_role_epithet", `L'IA n'a pas fourni d'épithète pour ${roleId}.`, 3);
    }
  }

  for (const phase of NIGHT_STORY_PHASES) {
    if (!ACTIVE_ROLES.includes(phase)) continue;
    const rawStep = raw.nightSteps?.[phase];
    if (typeof rawStep !== "string" || !rawStep.trim()) {
      add("warn", "missing_night_step", `L'IA n'a pas fourni nightSteps.${phase}.`, 4);
    }
  }

  for (const player of PLAYERS) {
    const sheet = missions.find((candidate) => candidate.playerId === player.id);
    if (!sheet || !player.roleId) continue;
    const haystack = normalize(`${sheet.title} ${sheet.background} ${sheet.rumor} ${sheet.secret} ${sheet.mission} ${sheet.successCondition}`);
    const keywords = ROLE_KEYWORDS[player.roleId] ?? [];
    if (!keywords.some((kw) => haystack.includes(normalize(kw)))) {
      add("warn", "mission_specificity", `La mission ${player.roleId} semble trop générique ou hors folklore.`, 5, [`${player.roleId}: ${sheet.mission}`]);
    }
    if (player.roleId === "kinoly" && !/(apres|reveil|reveille|reveiller|nuit.*surv|surv.*nuit)/i.test(haystack)) {
      add("error", "kinoly_gate", "La fiche Kinoly ne verrouille pas clairement mission/pouvoir après le réveil nocturne.", 10, [sheet.mission, sheet.secret]);
    }
  }

  for (const sheet of missions) {
    if (!sheet.titleReward || sheet.titlesEarned !== 0 || !sheet.rewards.length || sheet.rewards.some((reward) => reward.requiredTitles < 1 || reward.status !== "locked")) {
      add("error", "milestone_schema", `La fiche ${sheet.playerId} ne respecte pas le schéma titre -> palier -> pouvoir verrouillé.`, 10);
      break;
    }
    if (sheet.rewards.some((reward) => reward.name.trim().toLowerCase() === sheet.titleReward.trim().toLowerCase())) {
      issues.push({
        severity: "info",
        code: "milestone_schema",
        message: `Le titre "${sheet.titleReward}" a le même libellé qu'un pouvoir serveur ; ce n'est pas bloquant mais moins lisible.`,
        hint: HINTS_BY_CODE.milestone_schema,
      });
    }
  }

  const configured = new Set(story.config?.roles ?? []);
  const missingConfigured = OPTIONAL_ROLES.filter((roleId) => !configured.has(roleId));
  if (missingConfigured.length) {
    add("warn", "config", `La config sanitizée ne liste pas tous les rôles spéciaux actifs: ${missingConfigured.join(", ")}.`, 5);
  }

  const accentEvidence = BAD_ACCENT_TERMS.flatMap(({ re, correct }) => {
    const hits = publicStrings
      .map((entry) => entry.value.replace(PLACEHOLDER_RE, " ").match(re)?.[0])
      .filter((hit): hit is string => !!hit);
    return hits.slice(0, 2).map((hit) => `${hit} -> ${correct}`);
  });
  if (accentEvidence.length) {
    add("warn", "accent", "Certains textes naturels semblent oublier des accents français.", 4, accentEvidence.slice(0, 8));
  }

  const roleSpellingEvidence = ROLE_SPELLING_TERMS.flatMap(({ re, correct }) => {
    const naturalTexts = [
      ...publicStrings,
      ...missions.flatMap((sheet) => collectStrings(sheet, `missionSheets.${sheet.playerId}`)),
    ];
    const hits = naturalTexts.map((entry) => entry.value.match(re)?.[0]).filter((hit): hit is string => !!hit);
    return hits.slice(0, 2).map((hit) => `${hit} -> ${correct}`);
  });
  if (roleSpellingEvidence.length) {
    add("warn", "role_spelling", "Certains noms de rôles ne respectent pas l'orthographe canonique.", 5, roleSpellingEvidence.slice(0, 8));
  }

  // This control used to fire the other way: it penalised a story whose rhyme
  // signal was WEAK, because the prompt demanded a "rhymed tale". That premise is
  // gone. Malagasy oral poetry does not rhyme — Baker states it in 1832, Renel's
  // 155 tales carry 41 real rhymes in 6914 sentences — and the rhymes the old
  // runs produced (chemin/destin) were copied straight out of the prompt's own
  // examples. Keeping the check but inverting it is the honest move: the same
  // measurement point, now pointed at what is actually the defect.
  //
  // Threshold measured on the ten stories generated under the old prompt: they
  // carry 0 to 3 distinct rhyming endings each. One is an accident — "bruit/nuit"
  // turns up on its own in half of them; two is where a habit starts.
  const rhyme = rhymeFindings(story);
  if (rhyme.endings.length >= 2) {
    add("warn", "rhyme", "Le texte rime : la poésie orale malgache ne rime pas, et une rime française y sonne comme une comptine plaquée.", 6, rhyme.pairs.slice(0, 8));
  }
  // The other half of the same question. Removing the rhyme only leaves prose;
  // what makes it oral is the parallelism that stands in for it, so it is checked
  // for presence rather than assumed. The old runs score 0 or 1 here.
  const parallelism = parallelismSignals(story);
  if (parallelism.length < 2) {
    add("warn", "parallelism", "Presque aucun procédé de parallélisme : c'est lui qui porte la cadence orale, pas le son.", 5, parallelism.slice(0, 8));
  }

  if (motifs.length < 2) {
    add("warn", "diversity", "La légende n'a pas assez de motifs distinctifs détectables.", 4);
  }
  const repeatedTitle = previous.find((run) => normalize(run.title) === normalize(story.title));
  if (repeatedTitle) {
    add("warn", "diversity", `Titre déjà généré: ${story.title}.`, 6);
  }
  const repeatedMotifs = previous
    .map((run) => motifs.filter((motif) => run.motifs.has(motif)))
    .filter((overlap) => overlap.length >= 3)
    .sort((a, b) => b.length - a.length)[0];
  if (repeatedMotifs?.length) {
    add("warn", "diversity", `Motifs trop proches d'un run précédent: ${repeatedMotifs.join(", ")}.`, 5);
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  return {
    score: boundedScore,
    status: boundedScore >= 88 ? "ok" : boundedScore >= 70 ? "watch" : "fail",
    issues,
    detectedMotifs: motifs,
    activeRoles: ACTIVE_ROLES,
  };
}

function rawObject(raw: unknown): Record<string, any> {
  return raw && typeof raw === "object" ? raw as Record<string, any> : {};
}

function collectPublicStoryStrings(story: StorySetup): Array<{ path: string; value: string }> {
  return [
    ...collectStrings({ title: story.title, villageName: story.villageName, intro: story.intro }, "story"),
    ...collectStrings(story.roleEpithets, "roleEpithets"),
    ...collectStrings(story.ambiance, "ambiance"),
    ...collectStrings(story.nightSteps, "nightSteps"),
    ...collectStrings(story.dayProgression, "dayProgression"),
    ...collectStrings(story.deaths, "deaths"),
    ...collectStrings({ victoryVillage: story.victoryVillage, victorySongomby: story.victorySongomby }, "victory"),
    ...collectStrings(story.narratorScript, "narratorScript"),
  ];
}

function collectStrings(value: unknown, path: string): Array<{ path: string; value: string }> {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => collectStrings(item, `${path}.${index}`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => collectStrings(item, `${path}.${key}`));
}

function findPlaceholders(entries: Array<{ path: string; value: string }>, allowed: Set<string>): string[] {
  const leaks: string[] = [];
  for (const entry of entries) {
    for (const token of entry.value.match(PLACEHOLDER_RE) ?? []) {
      if (!allowed.has(token)) leaks.push(`${entry.path}: ${token}`);
    }
  }
  return leaks;
}

function detectMotifs(story: StorySetup): string[] {
  const text = [
    story.title,
    story.villageName,
    story.intro,
    ...Object.values(story.ambiance),
    ...Object.values(story.nightSteps).filter((line): line is string => !!line),
    ...Object.values(story.dayProgression).flat(),
    ...story.deaths,
    story.victoryVillage,
    story.victorySongomby,
  ].join(" ");
  return Object.entries(MOTIF_DEFS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([motif]) => motif);
}

/** Lowercased, unaccented, typographic apostrophes folded — for the form measures. */
function flat(text: string): string {
  return normalize(text).replace(/[’ʼ´`]/g, "'");
}

/**
 * The story cut into the blocks a listener actually hears in sequence.
 *
 * Rhyme and parallelism are only meaningful between neighbours, and the four
 * ambiance lines or the three night lines are neighbours in a way that the intro
 * and a victory line are not. Comparing across blocks would count coincidences.
 */
function formGroups(story: StorySetup): string[][] {
  return [
    [story.intro],
    Object.values(story.ambiance),
    Object.values(story.nightSteps).filter((line): line is string => !!line),
    story.dayProgression.night,
    story.dayProgression.dawn,
    story.dayProgression.debate,
    story.dayProgression.vote,
    story.deaths,
    [story.victoryVillage, story.victorySongomby],
  ];
}

/**
 * Lines cut into members at every punctuation mark, each as a word list.
 *
 * Members, not sentences: the rhymes these legends actually produce sit inside a
 * single line, between two halves separated by a comma — "la lune sur la peau, le
 * silence sur l'eau". Splitting on sentences alone found almost none of them.
 */
function memberWords(lines: string[]): string[][] {
  return lines
    .flatMap((line) => flat(line).split(/[,.;:!?]/g))
    .map((member) => member.split(/\s+/).map((word) => word.replace(/[^a-z']/g, "")).filter(Boolean))
    .filter((words) => words.length > 0);
}

/** The shared ending of two words that genuinely rhyme, or null. */
function rhymeEnding(a: string, b: string): string | null {
  if (!a || !b || a === b || a.length < 3 || b.length < 3) return null;
  // Same stem, or one contained in the other: that is a repeated word or a
  // conjugation of it — which the attested form asks for, not a rhyme.
  if (a.slice(0, 3) === b.slice(0, 3) || a.startsWith(b) || b.startsWith(a)) return null;
  let ending = a.slice(-3);
  if (ending !== b.slice(-3)) return null;
  if (INFLECTIONAL_ENDINGS.has(ending)) {
    if (a.length < 4 || b.length < 4 || a.slice(-4) !== b.slice(-4)) return null;
    ending = a.slice(-4);
  }
  return ending;
}

/**
 * End-rhymes between neighbouring members.
 *
 * Counts distinct ENDINGS, not pairs: soir/noir, soir/miroir and noir/miroir are
 * one echo seen three times, and counting pairs would make a single rhyming
 * cluster look like a rhyming text.
 */
function rhymeFindings(story: StorySetup): { endings: string[]; pairs: string[] } {
  const endings = new Set<string>();
  const pairs: string[] = [];
  for (const group of formGroups(story)) {
    const ends = memberWords(group).map((words) => {
      const last = words.at(-1) ?? "";
      return last.length >= 3 && !RHYME_STOPWORDS.has(last) ? last : "";
    });
    for (let i = 0; i + 1 < ends.length; i++) {
      const ending = rhymeEnding(ends[i]!, ends[i + 1]!);
      if (!ending) continue;
      endings.add(ending);
      pairs.push(`${ends[i]}/${ends[i + 1]}`);
    }
  }
  return { endings: [...endings], pairs };
}

/**
 * The attested devices, found in the generated text: what has to be there once
 * the rhyme is gone.
 *
 * Each of these is a figure the corpus pack ships with a count behind it — the
 * merism ("ni X ni Y", 268 occurrences in Callet), the corrective ("ce n'est pas
 * X, c'est Y", the central Malagasy gesture), the repeated frame, the verbatim
 * refrain (69 of Renel's 155 tales), the four cardinal points, the -lahy/-vavy
 * pair. Returns the evidence, so a run says which ones it managed.
 */
function parallelismSignals(story: StorySetup): string[] {
  const groups = formGroups(story);
  const allLines = groups.flat();
  const joined = flat(allLines.join(" "));
  const found: string[] = [];
  found.push(...(joined.match(MERISM_RE) ?? []).map((hit) => `mérisme « ${hit.trim()}… »`));
  found.push(...(joined.match(CORRECTIVE_RE) ?? []).map(() => "poser-nier-rectifier"));
  found.push(...(joined.match(LAHY_VAVY_RE) ?? []).map(() => "couple -lahy/-vavy"));
  for (const line of allLines) {
    const text = flat(line);
    if (CARDINALS.filter((point) => new RegExp(`\\b${point}\\b`).test(text)).length >= 3) {
      found.push("quatre points cardinaux");
    }
  }
  for (const group of groups) {
    const members = memberWords(group);
    for (let i = 0; i + 1 < members.length; i++) {
      const a = members[i]!;
      const b = members[i + 1]!;
      if (a.length >= 3 && b.length >= 3 && a[0] === b[0] && a[1] === b[1]) {
        found.push(`cadre repris « ${a[0]} ${a[1]} … »`);
      }
    }
  }
  // A refrain is a whole member said again word for word. Counted per distinct
  // member rather than per n-gram: one repeated sentence contains a dozen
  // repeated n-grams and would look like a dozen refrains.
  const seen = new Map<string, number>();
  for (const words of memberWords(allLines)) {
    if (words.length < 6) continue;
    const member = words.join(" ");
    seen.set(member, (seen.get(member) ?? 0) + 1);
  }
  for (const [member, count] of seen) {
    if (count >= 2) found.push(`refrain « ${member} »`);
  }
  return found;
}

function nextHints(previous: string[], issues: EvalIssue[]): string[] {
  const candidates = issues
    .filter((issue) => issue.severity !== "info" && issue.hint)
    .map((issue) => issue.hint!);
  return [...new Set([...previous, ...candidates])].slice(-8);
}

function renderRunMarkdown(record: {
  run: number;
  generation: { fallback: boolean; ms: number; provider: string; model?: string; reasoningEffort?: string; seed: string; direction: string };
  hintsIn: string[];
  hintsOut: string[];
  sanitizedStory: StorySetup;
  missionSheets: PlayerMissionSheet[];
  evaluation: EvalResult;
}): string {
  const story = record.sanitizedStory;
  return [
    `# Run ${record.run} - ${story.title}`,
    "",
    `- Score: ${record.evaluation.score}/100 (${record.evaluation.status})`,
    `- IA: ${record.generation.provider}/${record.generation.model ?? "default"} effort=${record.generation.reasoningEffort ?? "default"} ${record.generation.ms}ms fallback=${record.generation.fallback}`,
    `- Seed: ${record.generation.seed}`,
    `- Direction: ${record.generation.direction}`,
    `- Motifs: ${record.evaluation.detectedMotifs.join(", ") || "aucun"}`,
    "",
    "## Corrections injectées",
    record.hintsIn.length ? record.hintsIn.map((hint) => `- ${hint}`).join("\n") : "- Aucune",
    "",
    "## Scénario IA complet",
    `### ${story.title}`,
    `Village: ${story.villageName}`,
    "",
    story.intro,
    "",
    "### Ambiance",
    `- Nuit: ${story.ambiance.night}`,
    `- Aube: ${story.ambiance.dawn}`,
    `- Débat: ${story.ambiance.debate}`,
    `- Vote: ${story.ambiance.vote}`,
    "",
    "### Étapes de nuit",
    ...Object.entries(story.nightSteps).map(([phase, line]) => `- ${phase}: ${line}`),
    "",
    "### Progression de jour",
    ...Object.entries(story.dayProgression).map(([phase, lines]) => `- ${phase}: ${lines.join(" / ")}`),
    "",
    "### Morts",
    ...story.deaths.map((line) => `- ${line}`),
    "",
    "### Victoires",
    `- Village: ${story.victoryVillage}`,
    `- Songomby: ${story.victorySongomby}`,
    "",
    "### Script narrateur",
    ...story.narratorScript.map((line) => `- ${line}`),
    "",
    "## Fiches personnages et missions",
    ...record.missionSheets.flatMap((sheet) => [
      `### ${PLAYERS.find((player) => player.id === sheet.playerId)?.name ?? sheet.playerId} - ${roleName(PLAYERS.find((player) => player.id === sheet.playerId)?.roleId ?? "mponina")}`,
      `- Titre de fiche: ${sheet.title}`,
      `- Origine: ${sheet.background}`,
      `- Rumeur: ${sheet.rumor}`,
      `- Secret: ${sheet.secret}`,
      `- Mission: ${sheet.mission}`,
      `- Validation: ${sheet.successCondition}`,
      `- Titre gagné: ${sheet.titleReward}`,
      `- Pouvoirs par titres: ${sheet.rewards.map((reward) => `${reward.requiredTitles} titre(s) -> ${reward.name} (${reward.status})`).join("; ")}`,
      "",
    ]),
    "## Issues",
    record.evaluation.issues.length
      ? record.evaluation.issues.map((issue) => `- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}${issue.evidence?.length ? ` (${issue.evidence.join("; ")})` : ""}`).join("\n")
      : "- Aucune",
    "",
    "## Corrections pour le run suivant",
    record.hintsOut.length ? record.hintsOut.map((hint) => `- ${hint}`).join("\n") : "- Aucune",
    "",
  ].join("\n");
}

function renderSummaryMarkdown(summary: {
  generatedAt: string;
  runs: Array<{
    run: number;
    title: string;
    villageName: string;
    score: number;
    status: EvalResult["status"];
    ms: number;
    fallback: boolean;
    provider: string;
    model?: string;
    reasoningEffort?: string;
    issues: EvalIssue[];
    hintsIn: string[];
    hintsOut: string[];
  }>;
  finalFeedbackHints: string[];
}): string {
  return [
    "# Angano AI Eval",
    "",
    `Generated at: ${summary.generatedAt}`,
    "",
    "## Runs",
    "| Run | Score | Status | Fallback | Time | Title | Issues |",
    "| --- | ---: | --- | --- | ---: | --- | --- |",
    ...summary.runs.map((run) => `| ${run.run} | ${run.score} | ${run.status} | ${run.fallback ? "yes" : "no"} | ${run.ms}ms | ${escapeMd(run.title)} | ${escapeMd(run.issues.map((issue) => `${issue.severity}:${issue.code}`).join(", ") || "aucun")} |`),
    "",
    "## Corrections finales proposées",
    summary.finalFeedbackHints.length ? summary.finalFeedbackHints.map((hint) => `- ${hint}`).join("\n") : "- Aucune",
    "",
    "## Fichiers",
    ...summary.runs.map((run) => `- run-${pad(run.run)}.md / run-${pad(run.run)}.story.json`),
    "",
  ].join("\n");
}

function parseCli(): CliOptions {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  return {
    runs: positiveInt(flag("runs"), 5),
    out: flag("out") ?? join(process.cwd(), ".local", "angano-ai-eval", stamp),
    model: flag("model"),
    effort: flag("effort"),
    provider: parseProvider(flag("provider")),
    timeoutMs: positiveInt(flag("timeout"), undefined),
  };
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(raw: string | undefined, fallback: number): number;
function positiveInt(raw: string | undefined, fallback: undefined): number | undefined;
function positiveInt(raw: string | undefined, fallback: number | undefined): number | undefined {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseProvider(raw: string | undefined): "claude" | "codex" | undefined {
  return raw === "claude" || raw === "codex" ? raw : undefined;
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function escapeMd(text: string): string {
  return text.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}
