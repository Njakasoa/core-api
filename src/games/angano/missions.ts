import type { PlayerMissionSheet } from "./protocol.ts";
import { rewardsForRole } from "./rewards.ts";
import { ROLES, roleName } from "./roles.ts";
import type { StoryRoleSheet, StorySetup } from "./story.ts";

export interface MissionPlayer {
  id: string;
  name: string;
  roleId?: string;
}

interface MissionTemplate {
  title: string;
  background: string;
  rumor: string;
  secret: string;
  mission: string;
  successCondition: string;
  rewardTitle: string;
}

export function buildMissionSheets(players: MissionPlayer[], story: StorySetup | null): Map<string, PlayerMissionSheet> {
  const village = story?.villageName || "le village";
  const legend = story?.title || "la légende";
  const sheets = new Map<string, PlayerMissionSheet>();
  players.forEach((player, index) => {
    const roleId = player.roleId && ROLES[player.roleId] ? player.roleId : "mponina";
    const slot = 1;
    const missionId = `${player.id}:mission:${slot}`;
    const ctx = { playerName: player.name, roleName: roleName(roleId), village, legend, index };
    const fallback = templateFor(roleId, ctx);
    const template = mergeAiSheet(fallback, story?.roleSheets?.[roleId], ctx);
    const rewards = rewardsForRole(roleId, missionId);
    const titleReward = template.rewardTitle;
    sheets.set(player.id, {
      playerId: player.id,
      missionId,
      slot,
      ...template,
      titleReward,
      rewardTitle: titleReward,
      titlesEarned: 0,
      unlocks: rewards.map((reward) => reward.id),
      rewards,
      status: "pending",
    });
  });
  return sheets;
}

function mergeAiSheet(
  fallback: MissionTemplate,
  ai: StoryRoleSheet | undefined,
  ctx: { playerName: string; roleName: string; village: string; legend: string; index: number },
): MissionTemplate {
  if (!ai) return fallback;
  return {
    title: fill(ai.title, ctx) || fallback.title,
    background: fill(ai.background, ctx) || fallback.background,
    rumor: fill(ai.rumor, ctx) || fallback.rumor,
    secret: fill(ai.secret, ctx) || fallback.secret,
    mission: fill(ai.mission, ctx) || fallback.mission,
    successCondition: fill(ai.successCondition, ctx) || fallback.successCondition,
    rewardTitle: fill(ai.rewardTitle, ctx) || fallback.rewardTitle,
  };
}

function fill(text: string, ctx: { playerName: string; roleName: string; village: string; legend: string }): string {
  return text
    .replaceAll("{playerName}", ctx.playerName)
    .replaceAll("{roleName}", ctx.roleName)
    .replaceAll("{villageName}", ctx.village)
    .replaceAll("{storyTitle}", ctx.legend)
    .trim();
}

function templateFor(roleId: string, ctx: { playerName: string; roleName: string; village: string; legend: string; index: number }): MissionTemplate {
  const base: Partial<Record<string, (ctx: { playerName: string; roleName: string; village: string; legend: string; index: number }) => MissionTemplate>> = {
    mponina: (c) => ({
      title: "Voix des rizières",
      background: `${c.playerName}, on dit que tu connais chaque sentier de ${c.village}. Quand la peur monte, les anciens écoutent encore ta parole.`,
      rumor: "Tu aurais vu une silhouette contourner les greniers avant la première nuit.",
      secret: "Tu n'as aucun pouvoir nocturne, mais une parole claire peut faire basculer le Fokonolona.",
      mission: "Pendant un débat, pousse deux joueurs vivants à donner chacun un avis clair sur le même suspect, puis annonce publiquement ton propre vote.",
      successCondition: "Le narrateur valide si les deux avis sont exprimés publiquement et si ton vote assumé influence réellement la discussion.",
      rewardTitle: "Voix du Fokonolona",
    }),
    songomby: (c) => ({
      title: "Sabots dans la nuit",
      background: `${c.playerName}, sous ton visage humain, ${c.legend} cache une bête d'omby et de cheval. Tes sabots frappent la terre comme le vent, et même les arbres ne sauvent pas toujours les proies.`,
      rumor: "On dit que tes longues oreilles pendent sur tes yeux quand tu cours, mais que tes dents trouvent quand même ceux qui tremblent.",
      secret: "La meute gagne quand le village croit qu'une proie n'a déjà plus d'échappatoire.",
      mission: "Pendant un débat, fais présenter un joueur comme une proie déjà coincée, puis amène quelqu'un d'autre à reprendre cette idée avant le vote.",
      successCondition: "Le narrateur valide si cette idée de proie piégée est reprise publiquement et influence une accusation ou un vote.",
      rewardTitle: "Lay des naseaux",
    }),
    mpisikidy: (c) => ({
      title: "Graines sur la natte",
      background: `${c.playerName}, tu sais compter les signes comme d'autres comptent les battements du cœur. Les graines sombres parlent bas quand ${c.village} refuse de voir sa blessure.`,
      rumor: "On dit que tes questions simples font parfois tomber les masques plus sûrement qu'une accusation.",
      secret: "Tu lis les réponses comme une table de Sikidy, mais ne nomme pas le Sikidy en public si tu veux rester caché.",
      mission: "Pendant un débat, fais répondre deux joueurs vivants à une même question précise, puis utilise leurs réponses pour orienter discrètement le soupçon vers une piste.",
      successCondition: "Le narrateur valide si deux réponses publiques sont obtenues et si tu les utilises pour faire avancer le débat sans révéler ton rôle.",
      rewardTitle: "Oracle patient",
    }),
    ombiasy: (c) => ({
      title: "Ody des ancêtres",
      background: `${c.playerName}, les racines, les écorces et les sampy de ${c.village} passent par tes mains. Quand l'équilibre vacille, on vient chercher ton remède et ta parole.`,
      rumor: "On dit que tu connais une prière capable de détourner la vorika d'un Mpamosavy.",
      secret: "Ta force n'est pas de dominer le débat, mais de protéger le village sans révéler trop vite tes ody.",
      mission: "Pendant un débat, protège publiquement un joueur menacé ou fragile, puis pousse le village à chercher une autre piste sans révéler ton rôle.",
      successCondition: "Le narrateur valide si ton intervention change réellement la pression du débat ou évite qu'un joueur soit ciblé trop facilement.",
      rewardTitle: "Gardien du sampy",
    }),
    fanany: (c) => ({
      title: "Marque funeste",
      background: `${c.playerName}, on dit que le Fanany naît quand les Razana ne dorment plus. Sous ton calme, ${c.village} entend parfois ramper la colère d'une tombe offensée.`,
      rumor: "Une vieille voix murmure qu'un fady brisé finit toujours par réclamer un souffle.",
      secret: "Ta marque ne parle pas ; elle attend que quelqu'un profane ta vie.",
      mission: "Pendant un débat, fais rappeler par un autre joueur qu'un fady, un ancêtre ou une tombe ne doit pas être offensé, puis accuse quelqu'un de rompre cet équilibre.",
      successCondition: "Le narrateur valide si un autre joueur reprend l'idée du fady ou des ancêtres, et si cela influence une accusation ou un vote.",
      rewardTitle: "Fady de retour",
    }),
    zazavavindrano: (c) => ({
      title: "Serment de l'eau claire",
      background: `${c.playerName}, les eaux profondes connaissent ton nom. Sous les rochers glissants et les cascades de ${c.village}, les Zazavavindrano gardent les promesses, les offrandes et les interdits.`,
      rumor: "On dit qu'une beauté aux longs cheveux noirs a laissé une trace d'eau près d'une porte avant de disparaître.",
      secret: "Ton pouvoir n'est pas de séduire le village, mais de faire respecter le fady avant que l'eau ne reprenne ce qui lui est dû.",
      mission: "Pendant un débat, fais reconnaître par un autre joueur qu'un lieu, une eau, un fady ou une promesse ne doit pas être insulté, puis utilise cette idée pour protéger ou défendre quelqu'un.",
      successCondition: "Le narrateur valide si un autre joueur reprend publiquement l'idée du fady ou de l'eau sacrée, et si cela influence une défense, une accusation ou un vote.",
      rewardTitle: "Offrande aux eaux",
    }),
    kalanoro: (c) => ({
      title: "Pas inversés dans la mousse",
      background: `${c.playerName}, les lisières et les rivières sacrées de ${c.village} te parlent en traces retournées. Là où les autres se perdent, tu sais reconnaître une fuite.`,
      rumor: "On dit que du riz, du lait ou du miel disparaît parfois quand ton regard brille près des arbres.",
      secret: "Tu protèges les lieux sauvages : même sans révéler tes lectures, tu peux forcer les alibis à se contredire.",
      mission: "Fais raconter à deux joueurs vivants où ils prétendent avoir été pendant la nuit, puis relève publiquement une incohérence ou un silence suspect.",
      successCondition: "Le narrateur valide si deux alibis sont exprimés publiquement et si tu utilises ces réponses pour orienter le débat.",
      rewardTitle: "Gardien des sentiers perdus",
    }),
    kinoly: (c) => ({
      title: "Second souffle du tombeau",
      background: `${c.playerName}, ton reflet reste presque humain, mais ${c.legend} garde ton vrai visage sous la terre froide. Tu ne deviens dangereux qu'après que la nuit a tenté de te reprendre.`,
      rumor: "Quelqu'un jure t'avoir vu respirer sans buée quand les lampes mouraient.",
      secret: "Tant que tu n'es pas réveillé, ton pouvoir et ta mission dorment avec toi.",
      mission: "Après ton réveil, amène un joueur vivant à défendre publiquement ton maintien en vie ou ton utilité.",
      successCondition: "Le narrateur valide seulement si le Kinoly est réveillé, si la défense vient d'un autre joueur, et si elle influence le débat ou le vote.",
      rewardTitle: "Peau lisse",
    }),
    mpamosavy: (c) => ({
      title: "Vorika sous la peau",
      background: `${c.playerName}, le jour tu gardes le visage du fihavanana ; la nuit, tes pas cherchent les toits, les seuils et les tombes que personne ne doit profaner.`,
      rumor: "On se demande si tes sorties tardives relèvent d'un service rendu ou d'une ombre qui rôde.",
      secret: "Tu n'es pas un monstre : tu es une présence humaine qui casse les fady et corrompt la confiance.",
      mission: "Pendant un débat, fais naître un soupçon sur quelqu'un qui semble utile ou respecté, puis amène au moins un autre joueur à reprendre ce doute.",
      successCondition: "Le narrateur valide si le doute est repris publiquement par un autre joueur ou modifie clairement la direction du débat.",
      rewardTitle: "Ombre sous le toit",
    }),
  };
  return (base[roleId] ?? base.mponina!)(ctx);
}
