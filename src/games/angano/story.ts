import { aiGenerateJSON } from "../../lib/ai.ts";
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
export interface StorySetup {
  title: string;
  villageName: string;
  intro: string;
  roleEpithets: Record<string, string>;
  ambiance: { night: string; dawn: string; debate: string; vote: string };
  deaths: string[];
  victoryVillage: string;
  victorySongomby: string;
  config?: StoryConfig; // bounded composition override (validated)
}

const PACES: Pace[] = ["rapide", "normal", "lent"];
const clamp = (s: unknown, n: number): string => (typeof s === "string" ? s.trim().slice(0, n) : "");

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
  deaths: [
    "Au matin, on n'a retrouvé que des traces dans la boue.",
    "Une natte vide, une lampe éteinte : la nuit a encore frappé.",
    "Le fihavanana saigne : un des nôtres ne se réveillera pas.",
  ],
  victoryVillage: "Le mal est chassé. Ambodivoara peut enfin rallumer ses feux et honorer ses morts.",
  victorySongomby: "Le silence retombe sur un village désert. Les monstres ont gagné la nuit.",
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
      '"deaths":[string],"victoryVillage":string,"victorySongomby":string,' +
      '"config":{"roles":["<roleId optionnel>"],"songomby":number,"pace":"rapide"|"normal"|"lent"}}',
    "",
    "CONTRAINTES :",
    `- config.roles : uniquement des ids OPTIONNELS parmi [${OPTIONAL_ROLES.join(", ")}]. songomby entre 1 et ${maxSongomby}. pace dans l'enum.`,
    "- roleEpithets : optionnel, une courte épithète d'ambiance par rôle (le nom canonique reste affiché).",
    "- Ton folklore malgache (lamba, baobab, rizière, zébu, esprits, fady…), sombre et immersif, en FRANÇAIS.",
    "- Concis : titre ≤ 8 mots ; intro ≤ 4 phrases ; chaque ligne d'ambiance ≤ 1 phrase ; 3 à 6 annonces de mort GÉNÉRIQUES (sans nom de joueur).",
  ].join("\n");
}

export function sanitizeStory(raw: any, seatCount: number): StorySetup {
  const d = DEFAULT_STORY;
  const amb = raw?.ambiance ?? {};
  const epithets: Record<string, string> = {};
  if (raw?.roleEpithets && typeof raw.roleEpithets === "object") {
    for (const [k, v] of Object.entries(raw.roleEpithets)) {
      if (ROLES[k] && typeof v === "string") epithets[k] = clamp(v, 60);
    }
  }
  const deaths = Array.isArray(raw?.deaths)
    ? raw.deaths.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => clamp(s, 200)).slice(0, 6)
    : [];

  // bounded composition override
  let config: StoryConfig | undefined;
  const rc = raw?.config;
  if (rc && typeof rc === "object") {
    const c: StoryConfig = {};
    if (Array.isArray(rc.roles)) {
      const roles = [...new Set(rc.roles.filter((r: unknown) => typeof r === "string" && OPTIONAL_ROLES.includes(r)))] as string[];
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
    deaths: deaths.length ? deaths : d.deaths,
    victoryVillage: clamp(raw?.victoryVillage, 300) || d.victoryVillage,
    victorySongomby: clamp(raw?.victorySongomby, 300) || d.victorySongomby,
    config,
  };
}

/**
 * Generate (or fall back to) a story for a game of `seatCount` role-bearing players.
 * Never throws and never blocks longer than the AI timeout — returns DEFAULT_STORY
 * on any failure.
 */
export async function generateStory(seatCount: number): Promise<StorySetup> {
  const maxSongomby = Math.max(1, Math.floor(seatCount / 3));
  const seed = Math.random().toString(36).slice(2, 7);
  const prompt = [
    `Nouvelle partie : ${seatCount} joueurs.`,
    `Invente une légende ORIGINALE et différente à chaque fois (varie le lieu, la menace, le ton). Graine: ${seed}.`,
    `Choisis une composition cohérente avec ${seatCount} joueurs (au moins 1 Songomby, et garde une majorité de villageois).`,
    "Réponds uniquement en JSON.",
  ].join(" ");
  const t0 = Date.now();
  try {
    // Creative generation is slower than a trivial call — give it real headroom
    // (the player waits on the prep screen only as long as it actually takes).
    const raw = await aiGenerateJSON({ system: systemPrompt(maxSongomby), prompt, timeoutMs: 30_000 });
    const ms = Date.now() - t0;
    if (!raw || typeof raw !== "object") { console.warn(`[angano/story] fallback DEFAULT_STORY (no AI output) in ${ms}ms`); return clone(DEFAULT_STORY); }
    console.log(`[angano/story] generated "${(raw as { title?: string }).title ?? "?"}" in ${ms}ms`);
    return sanitizeStory(raw, seatCount);
  } catch {
    console.warn(`[angano/story] fallback DEFAULT_STORY (error) in ${Date.now() - t0}ms`);
    return clone(DEFAULT_STORY);
  }
}

function clone(s: StorySetup): StorySetup { return JSON.parse(JSON.stringify(s)); }
