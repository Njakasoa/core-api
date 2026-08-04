import { aiGenerateJSON } from "../../lib/ai.ts";
import { env } from "../../env.ts";
import { ROLES, OPTIONAL_ROLES } from "./roles.ts";
import storyPresetData from "./default-story-presets.json";
import corpusPack from "./corpus-pack.generated.json";

/**
 * AI story layer for Angano. Every game can be wrapped in a unique Malagasy
 * legend (narration + ambiance) and an optional themed composition — but the
 * engine stays 100% authoritative. The AI only produces TEXT + a BOUNDED config,
 * which we validate and sanitize against the fixed role catalog; anything off-spec
 * is dropped and missing fields fall back to a local preset. The game never blocks
 * on the AI (timeout → local preset).
 */

export type Pace = "rapide" | "normal" | "lent";
export interface StoryConfig { roles?: string[]; songomby?: number; pace?: Pace }
export const NIGHT_STORY_PHASES = ["zazavavindrano", "mpamosavy", "mpisikidy", "kalanoro", "kinoly", "songomby", "ombiasy"] as const;
export type NightStoryPhase = typeof NIGHT_STORY_PHASES[number];
export interface StoryDayProgression { night: string[]; dawn: string[]; debate: string[]; vote: string[] }
export interface StoryRoleSheet {
  title: string;
  background: string;
  rumor: string;
  secret: string;
  mission: string;
  successCondition: string;
  rewardTitle: string;
}
export interface StorySetup {
  /**
   * Identifies a hand-written preset, and only a preset. The browser uses it to pick
   * the matching pre-recorded narration pack, so it must stay absent whenever the AI
   * wrote the prose — a pack read over a different legend is worse than no pack.
   */
  id?: string;
  title: string;
  villageName: string;
  intro: string;
  roleEpithets: Record<string, string>;
  roleSheets: Record<string, StoryRoleSheet>;
  ambiance: { night: string; dawn: string; debate: string; vote: string };
  nightSteps: Partial<Record<NightStoryPhase, string>>;
  dayProgression: StoryDayProgression;
  deaths: string[];
  victoryVillage: string;
  victorySongomby: string;
  narratorScript: string[];
  config?: StoryConfig; // bounded composition override (validated)
}
export interface StoryGenerationOptions {
  provider?: "claude" | "codex";
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  feedbackHints?: string[];
}
export interface StoryGenerationResult {
  story: StorySetup;
  raw: unknown | null;
  fallback: boolean;
  ms: number;
  provider: "claude" | "codex";
  model?: string;
  reasoningEffort?: string;
  seed: string;
  direction: string;
  feedbackHints: string[];
}
export interface DefaultStoryPreset {
  id: string;
  story: StorySetup;
}

const PACES: Pace[] = ["rapide", "normal", "lent"];
const DEFAULT_STORY_AI_PROVIDER = "codex" as const;
const DEFAULT_STORY_AI_MODEL = "gpt-5.4-mini";
const DEFAULT_STORY_AI_REASONING_EFFORT = "low";
const clamp = (s: unknown, n: number): string => (typeof s === "string" ? s.trim().slice(0, n) : "");
const lines = (v: unknown, maxItems: number, maxChars: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => clamp(s, maxChars)).slice(0, maxItems) : [];
const DEFAULT_ROLE_EPITHETS: Record<string, string> = {
  mponina: "Gardien du foyer ordinaire",
  songomby: "Les sabots qui prennent les proies",
  mpisikidy: "L’œil des graines alignées",
  ombiasy: "Gardien des ody et du pardon",
  fanany: "La vengeance des Razana",
  zazavavindrano: "Gardienne du Fady des eaux",
  kalanoro: "Le lecteur des pas inversés",
  kinoly: "Le revenant que la nuit réveille",
  mpamosavy: "La bouche de la malédiction",
};
const STORY_DIRECTIONS = [
  "Lac sacré et offrandes blanches : centre la légende sur un rano masina, des reflets interdits, des jarres, des pièces et du miel laissés au bord de l'eau.",
  "Forêt humide et grottes cachées : centre la légende sur des sentiers retournés, des mousses épaisses, des cavernes et des voix qui se perdent sous les arbres.",
  "Rivage battu par les vents : centre la légende sur une plage, des pirogues, des filets, des récifs noirs et une marée qui rapporte les secrets.",
  "Hautes terres rouges : centre la légende sur des collines de latérite, des tombeaux anciens, des pierres levées et une poussière qui garde les traces.",
  "Marché nocturne et carrefour : centre la légende sur un village de passage, des étals fermés, des serments échangés et des ombres entre les cases.",
  "Cascade et ravin sacré : centre la légende sur une chute d'eau, un pont étroit, des parois luisantes et un grondement qui couvre les aveux.",
  "Village de zébus et enclos brisé : centre la légende sur des parcs à zébus, des cornes peintes, des sabots dans la poussière et une barrière rompue.",
  "Îlot de mangrove et pirogues : centre la légende sur l'eau saumâtre, les racines aériennes, les crabes silencieux et les lanternes qui s'éloignent.",
] as const;
const PUBLIC_PLACEHOLDER_RE = /\{[a-zA-Z][a-zA-Z0-9]*\}/g;
/**
 * The attested formulas in the corpus pack carry their blank between angle
 * brackets — "Voilà pourquoi, dit-on, <trait durable du monde>." A model that
 * copies a formula instead of filling it would put that blank in front of the
 * table, and the rule above cannot catch it: it only knows {tokens}. The eval
 * script reads the AI's raw output, so stripping here hides nothing from QA.
 */
const CORPUS_SLOT_RE = /<[^<>]{2,60}>/g;
const DEATH_PLACEHOLDERS = new Set(["{victim}", "{role}", "{count}"]);

/** Base fallback legend kept for compatibility and as the first local preset. */
export const DEFAULT_STORY: StorySetup = {
  title: "L'ombre sur les rizières",
  villageName: "Ambodivoara",
  intro: "Depuis trois nuits, le village d'Ambodivoara ne dort plus. Une présence rôde au bord de l'eau, et chaque aube emporte un visage de moins. Ce soir, il faut démasquer le mal avant qu'il ne dévore tout.",
  roleEpithets: {},
  roleSheets: {},
  ambiance: {
    night: "La nuit tombe sur les rizières ; les esprits s'éveillent.",
    dawn: "L'aube se lève, pâle, sur ce qui reste du village.",
    debate: "Au grand jour, les accusations fusent autour du feu.",
    vote: "Le village doit choisir qui livrer aux ancêtres.",
  },
  nightSteps: {
    zazavavindrano: "Zazavavindrano noue le Fady des eaux autour d'une âme à protéger.",
    mpamosavy: "Le Mpamosavy murmure une malédiction dans la nuit froide.",
    mpisikidy: "Le Mpisikidy aligne les graines pour lire ce que les visages cachent.",
    kalanoro: "Le Kalanoro suit les pas, même ceux qui reviennent à l'envers.",
    kinoly: "Le Kinoly éveillé glisse près des portes et laisse au silence une trace pâle.",
    songomby: "Les Songomby frappent la terre de leurs sabots et choisissent quelle proie ne courra plus.",
    ombiasy: "L'Ombiasy prépare remède, ody et rituel d'exil sous l'œil des ancêtres.",
  },
  dayProgression: {
    night: [
      "La nuit tombe sur les rizières ; les esprits s'éveillent.",
      "La deuxième nuit descend plus lourde : les maisons comptent leurs absents.",
      "La nuit revient sans promesse ; chaque souffle peut être le dernier.",
    ],
    dawn: [
      "L'aube se lève, pâle, sur ce qui reste du village.",
      "Le jour revient, mais la peur a appris les noms de chacun.",
      "La lumière touche les rizières sans dissiper ce qui rôde encore.",
    ],
    debate: [
      "Au grand jour, les accusations fusent autour du feu.",
      "Les voix montent plus vite : personne ne croit encore aux coïncidences.",
      "Les survivants parlent bas, puis frappent fort avec leurs soupçons.",
    ],
    vote: [
      "Le village doit choisir qui livrer aux ancêtres.",
      "Chaque main levée pèse maintenant autant qu'une vie.",
      "Le verdict tombe avant la nuit, ou la nuit tombera sur tous.",
    ],
  },
  deaths: [
    "Au matin, {victim} ne répond plus ; il ne reste que des traces dans la boue.",
    "Une natte vide, une lampe éteinte : {victim} ({role}) ne se réveillera pas.",
    "Le fihavanana saigne : la nuit a pris {victim}.",
  ],
  victoryVillage: "Le mal est chassé. Ambodivoara peut enfin rallumer ses feux et honorer ses morts.",
  victorySongomby: "Le silence retombe sur un village désert. Les monstres ont gagné la nuit.",
  narratorScript: [
    "Lisez le titre et l'introduction avant la première nuit, puis laissez quelques secondes de silence.",
    "À chaque aube, annoncez d'abord l'ambiance, puis seulement les morts révélés par le serveur.",
    "Pendant le débat, relancez les accusations sans donner d'indice mécanique.",
    "Au vote, gardez un ton grave : le village juge, mais il peut se tromper.",
  ],
};
export const DEFAULT_STORY_PRESETS: DefaultStoryPreset[] = [
  { id: "base-rizieres", story: DEFAULT_STORY },
  ...(storyPresetData as DefaultStoryPreset[]),
];

/** Build the immutable system prompt (the "bible") from the fixed role catalog. */
function systemPrompt(maxSongomby: number): string {
  const catalog = Object.values(ROLES)
    .map((r) => `- ${r.id} ("${r.nameMg}", ${r.team}) : ${r.desc}`)
    .join("\n");
  return [
    "Tu aides le narrateur humain d'Angano, un jeu de déduction sociale (type loup-garou) ancré dans le folklore malgache.",
    "À chaque partie tu inventes une LÉGENDE unique et des FICHES DE RÔLE qui HABILLENT le jeu — sans jamais en changer les règles.",
    "",
    "RÈGLES IMMUABLES :",
    "- Les rôles, pouvoirs et conditions de victoire sont FIXES (catalogue ci-dessous). Tu n'inventes ni rôle ni pouvoir.",
    "- Le camp \"village\" gagne en éliminant tous les \"songomby\" ; les \"songomby\" gagnent à la parité contre les villageois.",
    "- Les rôles \"neutre\" ne comptent pas dans la parité et suivent seulement l'objectif personnel décrit par leur rôle.",
    "- Tu produis UNIQUEMENT du texte d'ambiance et, optionnellement, une composition dans les bornes.",
    "",
    "CATALOGUE DES RÔLES (id → nom canonique, camp : pouvoir) :",
    catalog,
    "",
    "RÉPONDS UNIQUEMENT avec un objet JSON (aucun texte autour) de cette forme :",
    '{"title":string,"villageName":string,"intro":string,"roleEpithets":{"<roleId>":string},' +
      '"roleSheets":{"<roleId>":{"title":string,"background":string,"rumor":string,"secret":string,"mission":string,"successCondition":string,"rewardTitle":string}},' +
      '"ambiance":{"night":string,"dawn":string,"debate":string,"vote":string},' +
      '"nightSteps":{"zazavavindrano":string,"mpamosavy":string,"mpisikidy":string,"kalanoro":string,"kinoly":string,"songomby":string,"ombiasy":string},' +
      '"dayProgression":{"night":[string],"dawn":[string],"debate":[string],"vote":[string]},' +
      '"deaths":[string],"victoryVillage":string,"victorySongomby":string,"narratorScript":[string],' +
      '"config":{"roles":["<roleId optionnel>"],"songomby":number,"pace":"rapide"|"normal"|"lent"}}',
    "",
    "CONTRAINTES :",
    `- config.roles : uniquement des ids OPTIONNELS parmi [${OPTIONAL_ROLES.join(", ")}]. songomby entre 1 et ${maxSongomby}. pace dans l'enum.`,
    "- roleEpithets : optionnel, une courte épithète d'ambiance par rôle (le nom canonique reste affiché).",
    "- roleSheets : OBLIGATOIRE pour chaque rôle actif, y compris mponina et songomby. Chaque fiche sert de base privée au joueur qui reçoit ce rôle.",
    "- roleSheets.background : 1 à 2 phrases d'origine/personnage, en mode conte, sans révéler d'information mécanique cachée.",
    "- roleSheets.rumor : une rumeur publique ou semi-publique qui pousse au roleplay.",
    "- roleSheets.secret : un secret intime du personnage, compatible avec son camp et son rôle, sans créer de nouveau pouvoir.",
    "- roleSheets.mission : une mission sociale légère qui influence le débat, les alliances ou le vote, mais jamais les règles ni les conditions de victoire.",
    "- roleSheets.successCondition : critère observable que le narrateur humain peut valider facilement.",
    "- roleSheets.rewardTitle : titre honorifique court, pas un pouvoir. Le serveur applique ensuite la récompense mécanique fixe ; n'invente aucun avantage.",
    "- Kinoly : sa fiche et sa mission ne deviennent visibles qu'après son réveil par une mort nocturne évitée ; un vote le tue normalement. Son texte doit respecter cette contrainte.",
    "- Variables autorisées dans roleSheets : {playerName}, {villageName}, {storyTitle}, {roleName}. N'invente aucun vrai prénom dans ces fiches.",
    "- nightSteps : une phrase courte par sous-phase nocturne ; elle doit évoquer le rôle sans révéler qui le possède.",
    "- dayProgression : 3 à 4 phrases par clé, de plus en plus tendues du jour 1 à la fin.",
    "- deaths : 3 à 6 templates publics, avec variables autorisées {victim}, {role}, {count}. N'utilise ces variables que pour des morts déjà révélées.",
    "- narratorScript : 4 à 8 consignes/phrases de lecture pour le narrateur humain, sans secret ni solution.",
    "- Ton folklore malgache doit être sombre et immersif, en FRANÇAIS. Choisis quelques éléments pertinents (lamba, rano masina, tombeaux, zébu, pirogue, ravinala, grotte, cascade, forêt, marché, fady, Razana…), mais ne remets pas systématiquement baobab/rizière/fady au centre.",
    "- Respecte exactement les noms canoniques des rôles si tu les écris : Mponina, Songomby, Mpisikidy, Ombiasy, Fanany, Zazavavindrano, Kalanoro, Kinoly, Mpamosavy.",
    // Le chiffre est celui d'un recompte, pas celui d'une recherche : une première
    // version disait « la quasi-totalité des mots », ce qui reconduisait
    // l'exagération de Baker (« nineteen-twentieths ») que la mesure corrigeait
    // justement. 83 %, et deux mots au hasard partagent leur voyelle finale une
    // fois sur quatre — c'est déjà écrasant, et c'est vrai.
    "- FORME ORALE, SANS AUCUNE RIME. La poésie orale malgache ne rime pas : plus de huit mots sur dix y finissent sur l'une de quatre voyelles, si bien que deux mots pris au hasard riment déjà une fois sur quatre — une rime n'y distingue donc rien. Et la syllabe qui la porterait est atone et assourdie : elle est inaudible. La rime y est un import missionnaire du XIXe siècle. N'écris aucune rime de fin et ne cherche aucune assonance : sur du matériau malgache, elles sonnent comme une comptine plaquée.",
    "- Ce qui tient lieu de cadence est la RÉPÉTITION D'UN CADRE : deux membres bâtis pareil, un seul terme qui change de l'un à l'autre. Si deux mots finissent pareil, ce doit être parce que la même construction revient — jamais parce que tu as cherché un écho sonore.",
    "- Une ligne = une pensée complète : pas d'enjambement, pas de retour à la ligne dans les chaînes JSON, pas d'adjectif ornemental. L'image concrète porte seule le sentiment ; si tu retires la métaphore, il ne doit rien rester.",
    "- Ne cherche cette forme ni dans les noms de rôles, ni autour des variables {victim}, {role}, {count}, ni dans les consignes mécaniques : elles restent littérales et immédiatement lisibles.",
    "- Ne recopie jamais la graine technique dans l'histoire.",
    "- Respecte l'orthographe française et les accents : écris hôte, rôles, spéciaux, activés, légende, cohérent, majorité, etc.",
    "- Concis : titre ≤ 8 mots ; intro ≤ 4 phrases ; chaque ligne d'ambiance ≤ 1 phrase.",
  ].join("\n");
}

export function sanitizeStory(raw: any, seatCount: number, activeRoleIds: string[] = [], fallback: StorySetup = DEFAULT_STORY): StorySetup {
  const d = fallback;
  const amb = raw?.ambiance ?? {};
  const activeRoles = normalizeActiveRoles(activeRoleIds);
  const rawVillageName = clamp(raw?.villageName, 60);
  const rawTitle = clamp(raw?.title, 80);
  const villageName = fillPublicPlaceholders(rawVillageName || d.villageName, { title: rawTitle || d.title, villageName: rawVillageName || d.villageName });
  const title = fillPublicPlaceholders(rawTitle || d.title, { title: rawTitle || d.title, villageName }) || d.title;
  const publicCtx = { title, villageName };
  const epithets: Record<string, string> = {};
  if (raw?.roleEpithets && typeof raw.roleEpithets === "object") {
    for (const [k, v] of Object.entries(raw.roleEpithets)) {
      if (ROLES[k] && typeof v === "string") epithets[k] = clamp(v, 60);
    }
  }
  for (const id of activeRoles) {
    if (!epithets[id] && d.roleEpithets[id]) epithets[id] = clamp(d.roleEpithets[id], 60);
    if (!epithets[id]) epithets[id] = DEFAULT_ROLE_EPITHETS[id] ?? ROLES[id]!.nameMg;
  }
  const roleSheets: Record<string, StoryRoleSheet> = {};
  const rawRoleSheets = raw?.roleSheets && typeof raw.roleSheets === "object" ? raw.roleSheets : {};
  for (const [roleId, value] of Object.entries(rawRoleSheets)) {
    if (!ROLES[roleId] || !value || typeof value !== "object") continue;
    const sheet = sanitizeRoleSheet(roleId, value);
    if (Object.values(sheet).some(Boolean)) roleSheets[roleId] = sheet;
  }
  for (const roleId of activeRoles) {
    if (roleSheets[roleId] || !d.roleSheets[roleId]) continue;
    const sheet = sanitizeRoleSheet(roleId, d.roleSheets[roleId]);
    if (Object.values(sheet).some(Boolean)) roleSheets[roleId] = sheet;
  }
  const rawNightSteps = raw?.nightSteps && typeof raw.nightSteps === "object" ? raw.nightSteps : {};
  const nightSteps: Partial<Record<NightStoryPhase, string>> = {};
  for (const phase of NIGHT_STORY_PHASES) {
    const line = fillPublicPlaceholders(clamp(rawNightSteps[phase], 220), publicCtx);
    nightSteps[phase] = line || d.nightSteps[phase];
  }
  const rawProgression = raw?.dayProgression && typeof raw.dayProgression === "object" ? raw.dayProgression : {};
  const dayProgression: StoryDayProgression = {
    night: publicLines(rawProgression.night, 4, 220, publicCtx),
    dawn: publicLines(rawProgression.dawn, 4, 220, publicCtx),
    debate: publicLines(rawProgression.debate, 4, 220, publicCtx),
    vote: publicLines(rawProgression.vote, 4, 220, publicCtx),
  };
  if (!dayProgression.night.length) dayProgression.night = d.dayProgression.night;
  if (!dayProgression.dawn.length) dayProgression.dawn = d.dayProgression.dawn;
  if (!dayProgression.debate.length) dayProgression.debate = d.dayProgression.debate;
  if (!dayProgression.vote.length) dayProgression.vote = d.dayProgression.vote;

  const deathSource = Array.isArray(raw?.deathTemplates) ? raw.deathTemplates : raw?.deaths;
  const deaths = publicLines(deathSource, 6, 220, publicCtx, DEATH_PLACEHOLDERS);
  const narratorScript = publicLines(raw?.narratorScript, 8, 260, publicCtx);

  // bounded composition override
  let config: StoryConfig | undefined;
  const rc = raw?.config;
  if (rc && typeof rc === "object") {
    const c: StoryConfig = {};
    if (Array.isArray(rc.roles)) {
      const activeOptional = activeRoles.filter((r) => OPTIONAL_ROLES.includes(r));
      const roles = [...new Set([
        ...activeOptional,
        ...rc.roles.filter((r: unknown) => typeof r === "string" && OPTIONAL_ROLES.includes(r)),
      ])] as string[];
      if (roles.length) c.roles = roles;
    }
    if (typeof rc.songomby === "number" && Number.isFinite(rc.songomby)) {
      c.songomby = Math.max(1, Math.min(Math.max(1, Math.floor(seatCount / 3)), Math.floor(rc.songomby)));
    }
    if (typeof rc.pace === "string" && PACES.includes(rc.pace as Pace)) c.pace = rc.pace as Pace;
    if (c.roles || c.songomby || c.pace) config = c;
  }

  const rawIsEmpty = !raw || typeof raw !== "object" || Object.keys(raw as object).length === 0;
  return {
    // Only a pure preset keeps its id: the moment the AI supplied any prose, the
    // legend is no longer the one the recorded pack was written for.
    // Note `raw` is `{}` on the no-AI-output path — truthy, but contributing nothing —
    // so emptiness is what matters here, not presence.
    ...(rawIsEmpty ? { id: d.id } : {}),
    title,
    villageName,
    intro: fillPublicPlaceholders(clamp(raw?.intro, 800) || d.intro, publicCtx),
    roleEpithets: epithets,
    roleSheets,
    ambiance: {
      night: fillPublicPlaceholders(clamp(amb.night, 300) || d.ambiance.night, publicCtx),
      dawn: fillPublicPlaceholders(clamp(amb.dawn, 300) || d.ambiance.dawn, publicCtx),
      debate: fillPublicPlaceholders(clamp(amb.debate, 300) || d.ambiance.debate, publicCtx),
      vote: fillPublicPlaceholders(clamp(amb.vote, 300) || d.ambiance.vote, publicCtx),
    },
    nightSteps,
    dayProgression,
    deaths: deaths.length ? deaths : d.deaths,
    victoryVillage: fillPublicPlaceholders(clamp(raw?.victoryVillage, 300) || d.victoryVillage, publicCtx),
    victorySongomby: fillPublicPlaceholders(clamp(raw?.victorySongomby, 300) || d.victorySongomby, publicCtx),
    narratorScript: narratorScript.length ? narratorScript : d.narratorScript,
    config,
  };
}

/**
 * Generate (or fall back to) a story for a game of `seatCount` role-bearing players.
 * Never throws and never blocks longer than the AI timeout — returns a local preset
 * on any failure.
 */
export async function generateStory(seatCount: number, config?: StoryConfig): Promise<StorySetup> {
  return (await generateStoryWithMeta(seatCount, config)).story;
}

/**
 * Deterministic pick from a seed, so a run can be replayed exactly.
 *
 * The seed already varies per game, so this doubles as diversity: two games draw
 * different corners of the corpus and cannot converge on the same handful of
 * motifs — which is the failure the `diversity` check exists to catch.
 */
function pickFrom<T>(items: readonly T[], count: number, seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    out.push(pool.splice(h % pool.length, 1)[0]!);
  }
  return out;
}

/**
 * Attested Malagasy material for the prompt, or "" when the feature is off.
 *
 * Why this exists: without it the prompt carries no source at all, so the model
 * furnishes the legend from whatever "Madagascar" means to it — and the fix so
 * far has been to ban the clichés one at a time as they were spotted ("baobab
 * noir", the rice paddy, a few lines below). Banning is a poultice; the model
 * reaches for those because it has nothing else. This gives it something else:
 * motifs, actants and realia collected from Renel's tales.
 *
 * It ships no TALE — no narrative, no summary, no quotation from one. That is the
 * whole point of the creation index it is built from: a system served only this
 * material has never seen a tale and cannot give one back. What it writes is new,
 * which is both the honest cultural position and the safe legal one, since
 * Malagasy law treats the tales themselves as expressions of folklore rather than
 * as public-domain works.
 *
 * The one thing quoted word for word is the ohabolana — proverbs printed with
 * their gloss by Houlder in the Antananarivo Annual of the 1890s, long in the
 * public domain. A proverb is not a tale: it exists by being repeated exactly, so
 * quoting one is using it correctly. They go in as citations and the prompt says
 * so — quote one as given or leave it, and never invent one, because an invented
 * ohabolana is a forged proverb.
 *
 * It also ships the FORM, which grounding the vocabulary did not fix. The prompt
 * used to demand a "rhymed tale" and even supplied the rhymes (chemin/destin);
 * the model obeyed, and the output came back a French nursery rhyme wearing
 * Malagasy words. Malagasy oral poetry does not rhyme — four vowels end nearly
 * every word, so a rhyme selects nothing, and the syllable that would carry it is
 * unstressed and devoiced. What carries the cadence is parallelism. The devices
 * below are the attested ones, each shipped with the count that backs it.
 *
 * Off by default (`ANGANO_CORPUS=on`), so the ungrounded baseline stays reachable
 * for comparison rather than being lost the moment this lands.
 */
function corpusSection(seed: string): string {
  if ((process.env.ANGANO_CORPUS ?? "off").trim().toLowerCase() !== "on") return "";
  const p = corpusPack as {
    motifs: { code: string; label: string; noyau: string }[];
    actants: { nom: string; role: string }[];
    realia: { terme: string; sens: string }[];
    formules: string[]; dialectes: string[];
    procedes: { liste: { cle: string; regle: string; gabarit?: string; mesure?: { rimes_reelles?: number; phrases_examinees?: number; corpus?: string } }[] };
    formules_ouverture: { liste: { formule: string; emploi: string }[] };
    formules_cloture: { liste: { formule: string; emploi: string }[] };
    ohabolana: { liste: { mg: string; en: string; ref: string }[] };
  };
  // Sized so the material informs without crowding out the instructions: the
  // whole pack is some 47k tokens, a game sees roughly 2.5k of it.
  const motifs = pickFrom(p.motifs, 10, seed + "m");
  const actants = pickFrom(p.actants, 8, seed + "a");
  const realia = pickFrom(p.realia, 16, seed + "r");
  const dialecte = pickFrom(p.dialectes, 1, seed + "d")[0];
  // The devices rotate like the rest, so two games do not lean on the same figure
  // — except the ban on rhyme, which is pinned. A prohibition is not a device to
  // vary: leave it out of a draw and that game rhymes again.
  const sansRime = p.procedes.liste.find((x) => x.cle === "pas_de_rime");
  const procedes = pickFrom(p.procedes.liste.filter((x) => x.cle !== "pas_de_rime"), 4, seed + "p");
  const ouvertures = pickFrom(p.formules_ouverture.liste, 2, seed + "o");
  const clotures = pickFrom(p.formules_cloture.liste, 2, seed + "c");
  const proverbes = pickFrom(p.ohabolana.liste, 3, seed + "h");
  // Only the measurement of `pas_de_rime` is injected, never its `regle`: that
  // field spells out the rhymes to avoid (chemin/destin, sort/mort), and those
  // exact pairs came back in the generated legends the last time the prompt named
  // them. The ban itself is already in the system prompt, where no example is
  // given — a rhyme written down is a rhyme offered, forbidden or not.
  const mesureRime = sansRime?.mesure;
  const preuveSansRime = mesureRime?.rimes_reelles !== undefined && mesureRime.phrases_examinees !== undefined
    ? `Mesuré sur la source : ${mesureRime.rimes_reelles} rimes réelles pour ${mesureRime.phrases_examinees} phrases (${mesureRime.corpus ?? "corpus attesté"}). La source ne rime pas.`
    : "";
  return [
    "MATÉRIAU MALGACHE ATTESTÉ — relevé dans des corpus réels (Renel 1910, Callet 1908, Antananarivo Annual 1875-1897 ; domaine public).",
    "Sers-t'en pour ancrer la légende : emploie ces notions par leur nom, fais agir ces figures,",
    "reprends ces ressorts. N'invente PAS de mot malgache qui ne serait pas dans cette liste ;",
    "il vaut mieux une notion attestée bien employée que dix inventées. Tu écris une légende",
    "NEUVE nourrie de ce matériau — tu ne racontes aucun conte existant.",
    dialecte ? `Région de collecte à évoquer si tu situes le récit : ${dialecte}.` : "",
    `NOTIONS (terme — sens) :\n${realia.map((r) => `- ${r.terme} — ${r.sens}`).join("\n")}`,
    `FIGURES :\n${actants.map((a) => `- ${a.nom} : ${a.role}`).join("\n")}`,
    `RESSORTS NARRATIFS :\n${motifs.map((m) => `- ${m.label} : ${m.noyau}`).join("\n")}`,
    [
      "PROCÉDÉS DE FORME ATTESTÉS — c'est ce qui remplace la rime, et ce n'est pas décoratif.",
      preuveSansRime,
      "Fais porter la cadence par ces procédés :",
      procedes.map((x) => `- ${x.regle}${x.gabarit ? `\n  ex. ${x.gabarit}` : ""}`).join("\n"),
    ].filter(Boolean).join("\n"),
    `OUVERTURE — formules relevées dans au moins deux récits distincts. Ouvre sur ce geste :\n${ouvertures.map((f) => `- « ${f.formule} » — ${f.emploi}`).join("\n")}`,
    `CLÔTURE — même règle. Ferme sur ce geste, jamais sur une pointe rimée :\n${clotures.map((f) => `- « ${f.formule} » — ${f.emploi}`).join("\n")}`,
    "Ce qui est entre chevrons dans ces formules est un emplacement à remplir par toi ; ne recopie jamais les chevrons.",
    `OHABOLANA — proverbes publiés (Houlder, The Antananarivo Annual, domaine public), avec le sens donné par la source :\n${proverbes.map((o) => `- ${o.mg}\n  sens : ${o.en}`).join("\n")}`,
    "Tu peux en faire dire UN par une figure ancienne, puis en éclairer le sens en français dans la phrase suivante : c'est une citation sourcée, pas du texte de conte. Recopie le malgache mot pour mot, ou ne le cite pas — n'en change aucun mot, n'en fabrique aucune variante, et n'invente JAMAIS de proverbe malgache. Le sens t'est donné en anglais parce que la source l'est : l'anglais ne doit jamais apparaître dans le jeu. Ce malgache est une lecture OCR d'une impression des années 1890 ; si une ligne te paraît abîmée, laisse-la et n'en cite aucune.",
  ].filter(Boolean).join("\n");
}

/**
 * Instrumented story generation used by QA/evaluation scripts. Production callers
 * should keep using generateStory(); this variant returns raw output and timing,
 * and can inject temporary correction hints for recursive prompt tests.
 */
export async function generateStoryWithMeta(
  seatCount: number,
  config?: StoryConfig,
  opts: StoryGenerationOptions = {},
): Promise<StoryGenerationResult> {
  const maxSongomby = Math.max(1, Math.floor(seatCount / 3));
  const activeRoles = activeRolesFromConfig(config);
  const activeRoleLines = activeRoles
    .map((id) => `- ${id} ("${ROLES[id]!.nameMg}") : ${ROLES[id]!.desc}`)
    .join("\n");
  const configuredRoles = (config?.roles ?? []).length ? (config?.roles ?? []).join(", ") : "aucun role special";
  const seed = Math.random().toString(36).slice(2, 7);
  const direction = pickStoryDirection(seed);
  const fallbackStory = pickDefaultStoryPreset(seed);
  const feedbackHints = [...new Set((opts.feedbackHints ?? []).map((hint) => hint.trim()).filter(Boolean))].slice(-8);
  const provider = opts.provider ?? env.AI_PROVIDER ?? DEFAULT_STORY_AI_PROVIDER;
  const model = opts.model ?? env.AI_MODEL ?? (provider === "codex" ? DEFAULT_STORY_AI_MODEL : undefined);
  const reasoningEffort = opts.reasoningEffort ?? env.AI_REASONING_EFFORT ?? (provider === "codex" ? DEFAULT_STORY_AI_REASONING_EFFORT : undefined);

  // An explicitly named legend is an instruction, not a preference: tell that one, and
  // do not spend half a minute asking the AI for another. See `forcedStoryPreset`.
  const forced = forcedStoryPreset();
  if (forced) {
    console.info(`[angano/story] légende imposée "${forced.id}" (ANGANO_STORY_PRESET) — pas d'appel IA`);
    return {
      story: sanitizeStory({}, seatCount, activeRoles, forced),
      raw: null,
      fallback: true,
      ms: 0,
      provider,
      model,
      reasoningEffort,
      seed,
      direction,
      feedbackHints,
    };
  }

  const prompt = [
    `Nouvelle partie : ${seatCount} joueurs.`,
    `Configuration choisie par l'hôte : ${config?.songomby ?? 1} Songomby, rythme ${config?.pace ?? "normal"}, rôles spéciaux activés : ${configuredRoles}.`,
    "Tu dois écrire une légende compatible avec TOUS les rôles actifs ci-dessous. Ne les ignore pas et ne les contredis pas.",
    activeRoleLines ? `RÔLES ACTIFS À PRENDRE EN COMPTE:\n${activeRoleLines}` : "RÔLES ACTIFS À PRENDRE EN COMPTE:\n- songomby",
    "Pour chaque rôle actif, fournis une entrée roleEpithets et une entrée roleSheets complète. Pour chaque rôle actif ayant une phase nocturne dans nightSteps, fournis une phrase dédiée.",
    "Si tu proposes config.roles, elle doit inclure au minimum tous les rôles spéciaux déjà activés par l'hôte ; n'en retire aucun.",
    `DIRECTION CRÉATIVE OBLIGATOIRE POUR CETTE PARTIE : ${direction}`,
    "Le titre, l'intro, les textes d'ambiance et les morts doivent suivre cette direction principale.",
    "N'utilise pas 'baobab noir', 'baobab des fady' ou la rizière comme motif central par défaut ; ils peuvent apparaître en détail secondaire seulement si la direction le justifie.",
    feedbackHints.length ? `CORRECTIONS AUTOMATIQUES ISSUES DES RUNS PRÉCÉDENTS À RESPECTER:\n- ${feedbackHints.join("\n- ")}` : "",
    `Invente une légende ORIGINALE et différente à chaque fois (varie le lieu, la menace, le ton). Identifiant interne: ${seed}.`,
    `La composition finale doit rester cohérente avec ${seatCount} joueurs (au moins 1 Songomby, et garde une majorité de villageois).`,
    corpusSection(seed),
    "Tous les textes français générés doivent conserver les accents et une typographie française correcte.",
    "FORME : aucune rime, aucune assonance cherchée. La cadence vient de la reprise d'un même cadre avec un seul terme changé, et d'une image concrète par ligne — chaque texte doit s'entendre du premier coup, lu à voix haute.",
    "Réponds uniquement en JSON.",
  ].filter(Boolean).join(" ");
  const t0 = Date.now();
  try {
    // Creative generation is slower than a trivial call — give it real headroom
    // (the player waits on the prep screen only as long as it actually takes).
    const raw = await aiGenerateJSON({
      system: systemPrompt(maxSongomby),
      prompt,
      provider,
      model,
      reasoningEffort,
      timeoutMs: Math.max(30_000, opts.timeoutMs ?? env.AI_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (!raw || typeof raw !== "object") {
      console.warn(`[angano/story] fallback local story preset (no AI output) in ${ms}ms`);
      return {
        story: sanitizeStory({}, seatCount, activeRoles, fallbackStory),
        raw: null,
        fallback: true,
        ms,
        provider,
        model,
        reasoningEffort,
        seed,
        direction,
        feedbackHints,
      };
    }
    console.log(`[angano/story] generated "${(raw as { title?: string }).title ?? "?"}" in ${ms}ms`);
    return {
      story: sanitizeStory(raw, seatCount, activeRoles),
      raw,
      fallback: false,
      ms,
      provider,
      model,
      reasoningEffort,
      seed,
      direction,
      feedbackHints,
    };
  } catch {
    const ms = Date.now() - t0;
    console.warn(`[angano/story] fallback local story preset (error) in ${ms}ms`);
    return {
      story: sanitizeStory({}, seatCount, activeRoles, fallbackStory),
      raw: null,
      fallback: true,
      ms,
      provider,
      model,
      reasoningEffort,
      seed,
      direction,
      feedbackHints,
    };
  }
}

function normalizeActiveRoles(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => !!ROLES[id]))];
}
function activeRolesFromConfig(config?: StoryConfig): string[] {
  const roles = ["mponina", "songomby", ...(config?.roles ?? [])];
  return normalizeActiveRoles(roles);
}
function sanitizeRoleSheet(roleId: string, raw: unknown): StoryRoleSheet {
  const s = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    title: clamp(s.title, 80),
    background: clamp(s.background, 420),
    rumor: clamp(s.rumor, 240),
    secret: clamp(s.secret, 260),
    mission: clamp(s.mission, 280),
    successCondition: clamp(s.successCondition, 260),
    rewardTitle: clamp(s.rewardTitle, 80),
  };
}
function pickStoryDirection(seed: string): string {
  const n = Number.parseInt(seed, 36);
  const index = Number.isFinite(n) ? n % STORY_DIRECTIONS.length : Math.floor(Math.random() * STORY_DIRECTIONS.length);
  return STORY_DIRECTIONS[index]!;
}
/**
 * The legend a game opens on when nothing says otherwise.
 *
 * It used to be one of the four at random. It is now fixed, because only one of them
 * is *recorded*: the browser plays a narration pack for `lac-jarres-blanches` and has
 * none for the others, which would open a game in silence or in a synthesised voice
 * instead of the teller's. A rotation is worth having again the day a second pack
 * exists — until then it is a coin flip between a finished experience and a lesser one.
 */
export const DEFAULT_STORY_PRESET_ID = "lac-jarres-blanches";

/** A preset by id, or by index — `undefined` when nothing matches. */
function resolvePreset(requested: string): DefaultStoryPreset | undefined {
  const byId = DEFAULT_STORY_PRESETS.find((preset) => preset.id === requested);
  if (byId) return byId;
  const index = Number.parseInt(requested, 10);
  return Number.isFinite(index) ? DEFAULT_STORY_PRESETS[index] : undefined;
}

export function pickDefaultStoryPreset(seed = ""): StorySetup {
  const requested = process.env.ANGANO_STORY_PRESET?.trim() || seed;
  const chosen = requested ? resolvePreset(requested) : undefined;
  if (chosen) return stamp(chosen);
  const fallback = DEFAULT_STORY_PRESETS.find((preset) => preset.id === DEFAULT_STORY_PRESET_ID);
  return stamp(fallback ?? DEFAULT_STORY_PRESETS[0]!);
}

/**
 * The legend the server has been *told* to tell, if any.
 *
 * `ANGANO_STORY_PRESET` used to pick only which preset the AI would fall back to,
 * which made it useless for the one thing it gets set for: hearing a legend that has
 * a recorded narration pack. A pack belongs to one preset and an AI-written story
 * carries no id, so as long as the AI answered, no recording could ever play — the
 * variable was a promise the server did not keep.
 *
 * Naming a legend now means what it says: that one, no AI call, and none of the wait
 * that comes with it. Leave the variable unset and nothing changes — the AI writes,
 * and this preset is where it lands if it cannot.
 */
export function forcedStoryPreset(): StorySetup | null {
  const requested = process.env.ANGANO_STORY_PRESET?.trim();
  if (!requested) return null;
  const chosen = resolvePreset(requested);
  if (!chosen) {
    console.warn(`[angano/story] ANGANO_STORY_PRESET="${requested}" ne correspond à aucune légende — ignoré`);
    return null;
  }
  return stamp(chosen);
}
/** Carry the preset's id onto the story it produced. */
function stamp(preset: DefaultStoryPreset): StorySetup {
  return { ...preset.story, id: preset.id };
}

function publicLines(
  v: unknown,
  maxItems: number,
  maxChars: number,
  ctx: { title: string; villageName: string },
  allowedPlaceholders = new Set<string>(),
): string[] {
  return lines(v, maxItems, maxChars).map((line) => fillPublicPlaceholders(line, ctx, allowedPlaceholders)).filter(Boolean);
}
function fillPublicPlaceholders(
  text: string,
  ctx: { title: string; villageName: string },
  allowedPlaceholders = new Set<string>(),
): string {
  return text
    .replaceAll("{villageName}", ctx.villageName)
    .replaceAll("{storyTitle}", ctx.title)
    .replace(PUBLIC_PLACEHOLDER_RE, (token) => allowedPlaceholders.has(token) ? token : "")
    .replace(CORPUS_SLOT_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}
