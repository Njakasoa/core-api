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
  public_placeholder: "Ne laisse aucun placeholder public hors deaths ; les textes publics doivent être prêts à lire.",
  private_placeholder: "Dans les fiches privées, utilise uniquement {playerName}, {villageName}, {storyTitle}, {roleName}, puis aucun autre placeholder.",
  missing_role_sheet: "Fournis une fiche roleSheets complète pour chaque rôle actif, y compris mponina, songomby et tous les rôles spéciaux activés.",
  missing_role_epithet: "Fournis une épithète roleEpithets courte pour chaque rôle actif.",
  missing_night_step: "Fournis une phrase nightSteps dédiée pour chaque rôle actif qui agit la nuit.",
  mission_specificity: "Chaque mission doit exploiter le folklore et le gameplay social exact du rôle, pas une mission générique.",
  kinoly_gate: "La fiche Kinoly doit rappeler que mission et pouvoir n'existent qu'après son réveil par une mort nocturne évitée.",
  milestone_schema: "rewardTitle est un titre honorifique de mission ; les pouvoirs mécaniques restent dans le catalogue serveur avec requiredTitles.",
  accent: "Respecte les accents français dans les textes naturels : rôles, spéciaux, activés, légende, majorité, scénario.",
  role_spelling: "Respecte exactement les noms canoniques des rôles : Mponina, Songomby, Mpisikidy, Ombiasy, Fanany, Zazavavindrano, Kalanoro, Kinoly, Mpamosavy.",
  rhyme: "Renforce le mode conte rimé avec des rimes/assonances lisibles, sans rendre le texte obscur.",
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

  if (rhymeSignal(publicStrings.map((entry) => entry.value)) < 3) {
    add("warn", "rhyme", "Le signal de rimes/assonances est faible pour un mode conte rimé.", 6);
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

function rhymeSignal(lines: string[]): number {
  const endings = lines
    .flatMap((line) => line.split(/[.!?;]/g))
    .map((sentence) => sentence.trim().split(/\s+/).filter(Boolean).at(-1) ?? "")
    .map((word) => normalize(word).replace(/[^a-z]/g, ""))
    .filter((word) => word.length >= 4)
    .map((word) => word.slice(-3));
  const counts = new Map<string, number>();
  for (const ending of endings) counts.set(ending, (counts.get(ending) ?? 0) + 1);
  return [...counts.values()].filter((count) => count >= 2).length;
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
