import { aiGenerateJSON } from "../../lib/ai.ts";
import { env } from "../../env.ts";
import { ROLES, OPTIONAL_ROLES } from "./roles.ts";

/**
 * AI "Conteur" layer for Angano. Every game can be wrapped in a unique Malagasy
 * legend (narration + ambiance) and an optional themed composition — but the
 * engine stays 100% authoritative. The AI only produces TEXT + a BOUNDED config,
 * which we validate and sanitize against the fixed role catalog; anything off-spec
 * is dropped and missing fields fall back to DEFAULT_STORY. The game never blocks
 * on the AI (timeout → DEFAULT_STORY).
 */

export type Pace = "rapide" | "normal" | "lent";
export interface StoryConfig { roles?: string[]; songomby?: number; pace?: Pace }
export const NIGHT_STORY_PHASES = ["zazavavindrano", "mpamosavy", "mpisikidy", "kalanoro", "songomby", "ombiasy"] as const;
export type NightStoryPhase = typeof NIGHT_STORY_PHASES[number];
export interface StoryDayProgression { night: string[]; dawn: string[]; debate: string[]; vote: string[] }
export interface StorySetup {
  title: string;
  villageName: string;
  intro: string;
  roleEpithets: Record<string, string>;
  ambiance: { night: string; dawn: string; debate: string; vote: string };
  nightSteps: Partial<Record<NightStoryPhase, string>>;
  dayProgression: StoryDayProgression;
  deaths: string[];
  victoryVillage: string;
  victorySongomby: string;
  narratorScript: string[];
  config?: StoryConfig; // bounded composition override (validated)
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
  songomby: "La faim derrière les maisons",
  mpisikidy: "L’œil des graines alignées",
  ombiasy: "Celui qui connaît le poison et le pardon",
  mpihaza: "La dernière flèche du village",
  zazavavindrano: "Celle qui lie l'eau par interdit",
  kalanoro: "Le lecteur des pas inversés",
  kinoly: "Le visage presque humain",
  mpamosavy: "La bouche de la malédiction",
};

/** Hardcoded fallback legend (used when the AI is off, times out, or returns junk). */
export const DEFAULT_STORY: StorySetup = {
  title: "L'ombre sur les rizières",
  villageName: "Ambodivoara",
  intro: "Depuis trois nuits, le village d'Ambodivoara ne dort plus. Une présence rôde au bord de l'eau, et chaque aube emporte un visage de moins. Ce soir, il faut démasquer le mal avant qu'il ne dévore tout.",
  roleEpithets: {},
  ambiance: {
    night: "La nuit tombe sur les rizières ; les esprits s'éveillent.",
    dawn: "L'aube se lève, pâle, sur ce qui reste du village.",
    debate: "Au grand jour, les accusations fusent autour du feu.",
    vote: "Le village doit choisir qui livrer aux ancêtres.",
  },
  nightSteps: {
    zazavavindrano: "Zazavavindrano noue l'eau au silence et cherche où poser son fady.",
    mpamosavy: "Le Mpamosavy murmure une malédiction dans la nuit froide.",
    mpisikidy: "Le Mpisikidy aligne les graines pour lire ce que les visages cachent.",
    kalanoro: "Le Kalanoro suit les pas, même ceux qui reviennent à l'envers.",
    songomby: "Les Songomby rôdent ensemble et choisissent quelle porte craquera.",
    ombiasy: "L'Ombiasy pèse le remède et le poison, sachant que chacun ne revient pas.",
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

/** Build the immutable system prompt (the "bible") from the fixed role catalog. */
function systemPrompt(maxSongomby: number): string {
  const catalog = Object.values(ROLES)
    .map((r) => `- ${r.id} ("${r.nameMg}", ${r.team}) : ${r.desc}`)
    .join("\n");
  return [
    "Tu es le Conteur d'Angano, un jeu de déduction sociale (type loup-garou) ancré dans le folklore malgache.",
    "À chaque partie tu inventes une LÉGENDE unique qui HABILLE le jeu — sans jamais en changer les règles.",
    "",
    "RÈGLES IMMUABLES :",
    "- Les rôles, pouvoirs et conditions de victoire sont FIXES (catalogue ci-dessous). Tu n'inventes ni rôle ni pouvoir.",
    "- Le camp \"village\" gagne en éliminant tous les \"songomby\" ; les \"songomby\" gagnent à la parité.",
    "- Tu produis UNIQUEMENT du texte d'ambiance et, optionnellement, une composition dans les bornes.",
    "",
    "CATALOGUE DES RÔLES (id → nom canonique, camp : pouvoir) :",
    catalog,
    "",
    "RÉPONDS UNIQUEMENT avec un objet JSON (aucun texte autour) de cette forme :",
    '{"title":string,"villageName":string,"intro":string,"roleEpithets":{"<roleId>":string},' +
      '"ambiance":{"night":string,"dawn":string,"debate":string,"vote":string},' +
      '"nightSteps":{"zazavavindrano":string,"mpamosavy":string,"mpisikidy":string,"kalanoro":string,"songomby":string,"ombiasy":string},' +
      '"dayProgression":{"night":[string],"dawn":[string],"debate":[string],"vote":[string]},' +
      '"deaths":[string],"victoryVillage":string,"victorySongomby":string,"narratorScript":[string],' +
      '"config":{"roles":["<roleId optionnel>"],"songomby":number,"pace":"rapide"|"normal"|"lent"}}',
    "",
    "CONTRAINTES :",
    `- config.roles : uniquement des ids OPTIONNELS parmi [${OPTIONAL_ROLES.join(", ")}]. songomby entre 1 et ${maxSongomby}. pace dans l'enum.`,
    "- roleEpithets : optionnel, une courte épithète d'ambiance par rôle (le nom canonique reste affiché).",
    "- nightSteps : une phrase courte par sous-phase nocturne ; elle doit évoquer le rôle sans révéler qui le possède.",
    "- dayProgression : 3 à 4 phrases par clé, de plus en plus tendues du jour 1 à la fin.",
    "- deaths : 3 à 6 templates publics, avec variables autorisées {victim}, {role}, {count}. N'utilise ces variables que pour des morts déjà révélées.",
    "- narratorScript : 4 à 8 consignes/phrases de lecture pour le narrateur humain, sans secret ni solution.",
    "- Ton folklore malgache (lamba, baobab, rizière, zébu, esprits, fady…), sombre et immersif, en FRANÇAIS.",
    "- Mode conte rimé OBLIGATOIRE : les champs narratifs doivent sonner comme des vers de conte lus à voix haute.",
    "- Rimes : dans intro, ambiance, nightSteps, dayProgression, deaths et victoires, ajoute des rimes ou assonances visibles par phrase ou par paire de phrases (nuit/bruit, chemin/destin, peur/cœur, sort/mort).",
    "- Garde les rimes naturelles et claires : pas de poésie obscure, pas de mot rare seulement pour rimer, pas de retour à la ligne dans les chaînes JSON.",
    "- Ne force pas la rime dans les noms de rôles, les variables {victim}, {role}, {count}, ni les consignes mécaniques importantes.",
    "- Ne recopie jamais la graine technique dans l'histoire.",
    "- Respecte l'orthographe française et les accents : écris hôte, rôles, spéciaux, activés, légende, cohérent, majorité, etc.",
    "- Concis : titre ≤ 8 mots ; intro ≤ 4 phrases ; chaque ligne d'ambiance ≤ 1 phrase.",
  ].join("\n");
}

export function sanitizeStory(raw: any, seatCount: number, activeRoleIds: string[] = []): StorySetup {
  const d = DEFAULT_STORY;
  const amb = raw?.ambiance ?? {};
  const activeRoles = normalizeActiveRoles(activeRoleIds);
  const epithets: Record<string, string> = {};
  if (raw?.roleEpithets && typeof raw.roleEpithets === "object") {
    for (const [k, v] of Object.entries(raw.roleEpithets)) {
      if (ROLES[k] && typeof v === "string") epithets[k] = clamp(v, 60);
    }
  }
  for (const id of activeRoles) {
    if (!epithets[id]) epithets[id] = DEFAULT_ROLE_EPITHETS[id] ?? ROLES[id]!.nameMg;
  }
  const rawNightSteps = raw?.nightSteps && typeof raw.nightSteps === "object" ? raw.nightSteps : {};
  const nightSteps: Partial<Record<NightStoryPhase, string>> = {};
  for (const phase of NIGHT_STORY_PHASES) {
    const line = clamp(rawNightSteps[phase], 220);
    nightSteps[phase] = line || d.nightSteps[phase];
  }
  const rawProgression = raw?.dayProgression && typeof raw.dayProgression === "object" ? raw.dayProgression : {};
  const dayProgression: StoryDayProgression = {
    night: lines(rawProgression.night, 4, 220),
    dawn: lines(rawProgression.dawn, 4, 220),
    debate: lines(rawProgression.debate, 4, 220),
    vote: lines(rawProgression.vote, 4, 220),
  };
  if (!dayProgression.night.length) dayProgression.night = d.dayProgression.night;
  if (!dayProgression.dawn.length) dayProgression.dawn = d.dayProgression.dawn;
  if (!dayProgression.debate.length) dayProgression.debate = d.dayProgression.debate;
  if (!dayProgression.vote.length) dayProgression.vote = d.dayProgression.vote;

  const deathSource = Array.isArray(raw?.deathTemplates) ? raw.deathTemplates : raw?.deaths;
  const deaths = lines(deathSource, 6, 220);
  const narratorScript = lines(raw?.narratorScript, 8, 260);

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

  return {
    title: clamp(raw?.title, 80) || d.title,
    villageName: clamp(raw?.villageName, 60) || d.villageName,
    intro: clamp(raw?.intro, 800) || d.intro,
    roleEpithets: epithets,
    ambiance: {
      night: clamp(amb.night, 300) || d.ambiance.night,
      dawn: clamp(amb.dawn, 300) || d.ambiance.dawn,
      debate: clamp(amb.debate, 300) || d.ambiance.debate,
      vote: clamp(amb.vote, 300) || d.ambiance.vote,
    },
    nightSteps,
    dayProgression,
    deaths: deaths.length ? deaths : d.deaths,
    victoryVillage: clamp(raw?.victoryVillage, 300) || d.victoryVillage,
    victorySongomby: clamp(raw?.victorySongomby, 300) || d.victorySongomby,
    narratorScript: narratorScript.length ? narratorScript : d.narratorScript,
    config,
  };
}

/**
 * Generate (or fall back to) a story for a game of `seatCount` role-bearing players.
 * Never throws and never blocks longer than the AI timeout — returns DEFAULT_STORY
 * on any failure.
 */
export async function generateStory(seatCount: number, config?: StoryConfig): Promise<StorySetup> {
  const maxSongomby = Math.max(1, Math.floor(seatCount / 3));
  const activeRoles = activeRolesFromConfig(config);
  const activeRoleLines = activeRoles
    .map((id) => `- ${id} ("${ROLES[id]!.nameMg}") : ${ROLES[id]!.desc}`)
    .join("\n");
  const configuredRoles = (config?.roles ?? []).length ? (config?.roles ?? []).join(", ") : "aucun role special";
  const seed = Math.random().toString(36).slice(2, 7);
  const prompt = [
    `Nouvelle partie : ${seatCount} joueurs.`,
    `Configuration choisie par l'hôte : ${config?.songomby ?? 1} Songomby, rythme ${config?.pace ?? "normal"}, rôles spéciaux activés : ${configuredRoles}.`,
    "Tu dois écrire une légende compatible avec TOUS les rôles actifs ci-dessous. Ne les ignore pas et ne les contredis pas.",
    activeRoleLines ? `RÔLES ACTIFS À PRENDRE EN COMPTE:\n${activeRoleLines}` : "RÔLES ACTIFS À PRENDRE EN COMPTE:\n- songomby",
    "Pour chaque rôle actif, fournis une entrée roleEpithets. Pour chaque rôle actif ayant une phase nocturne dans nightSteps, fournis une phrase dédiée.",
    "Si tu proposes config.roles, elle doit inclure au minimum tous les rôles spéciaux déjà activés par l'hôte ; n'en retire aucun.",
    `Invente une légende ORIGINALE et différente à chaque fois (varie le lieu, la menace, le ton). Graine: ${seed}.`,
    `La composition finale doit rester cohérente avec ${seatCount} joueurs (au moins 1 Songomby, et garde une majorité de villageois).`,
    "Tous les textes français générés doivent conserver les accents et une typographie française correcte.",
    "Adopte une narration de livre de conte rimé : chaque texte d'ambiance doit avoir une cadence orale et au moins une rime ou assonance nette, tout en restant clair pour jouer.",
    "Réponds uniquement en JSON.",
  ].join(" ");
  const t0 = Date.now();
  try {
    // Creative generation is slower than a trivial call — give it real headroom
    // (the player waits on the prep screen only as long as it actually takes).
    const provider = env.AI_PROVIDER ?? DEFAULT_STORY_AI_PROVIDER;
    const raw = await aiGenerateJSON({
      system: systemPrompt(maxSongomby),
      prompt,
      provider,
      model: env.AI_MODEL ?? (provider === "codex" ? DEFAULT_STORY_AI_MODEL : undefined),
      reasoningEffort: env.AI_REASONING_EFFORT ?? (provider === "codex" ? DEFAULT_STORY_AI_REASONING_EFFORT : undefined),
      timeoutMs: Math.max(30_000, env.AI_TIMEOUT_MS),
    });
    const ms = Date.now() - t0;
    if (!raw || typeof raw !== "object") { console.warn(`[angano/story] fallback DEFAULT_STORY (no AI output) in ${ms}ms`); return sanitizeStory({}, seatCount, activeRoles); }
    console.log(`[angano/story] generated "${(raw as { title?: string }).title ?? "?"}" in ${ms}ms`);
    return sanitizeStory(raw, seatCount, activeRoles);
  } catch {
    console.warn(`[angano/story] fallback DEFAULT_STORY (error) in ${Date.now() - t0}ms`);
    return sanitizeStory({}, seatCount, activeRoles);
  }
}

function normalizeActiveRoles(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => !!ROLES[id]))];
}
function activeRolesFromConfig(config?: StoryConfig): string[] {
  const roles = ["songomby", ...(config?.roles ?? [])];
  return normalizeActiveRoles(roles);
}
