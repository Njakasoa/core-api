import type { PlayerMissionSheet } from "./protocol.ts";
import { rewardsForRoleSlot } from "./rewards.ts";
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
    const rewards = rewardsForRoleSlot(roleId, slot, missionId);
    sheets.set(player.id, {
      playerId: player.id,
      missionId,
      slot,
      ...template,
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
      secret: "Tu n'as aucun pouvoir caché, mais ton calme peut déplacer le débat.",
      mission: "Pendant un débat, formule une accusation argumentée contre un joueur vivant, puis vote contre une autre personne.",
      successCondition: "Le narrateur valide si ton accusation a vraiment été entendue et si ton vote crée un doute réel.",
      rewardTitle: "Témoin respecté",
    }),
    songomby: (c) => ({
      title: "Faim sous la peau",
      background: `${c.playerName}, la nuit te répond comme une parente. Sous ton sourire, ${c.legend} garde une morsure que personne ne doit voir.`,
      rumor: "Quelqu'un prétend que tu as chanté trop bas quand les chiens se sont tus.",
      secret: "Ton camp doit garder l'avantage sans révéler la meute.",
      mission: "Défends publiquement un villageois innocent ou utile, puis fais porter le soupçon sur un autre joueur avant le vote.",
      successCondition: "Le narrateur valide si ta défense paraît sincère et modifie la direction du débat.",
      rewardTitle: "Masque sans fissure",
    }),
    mpisikidy: (c) => ({
      title: "Grains du sikidy",
      background: `${c.playerName}, les signes roulent entre tes doigts. À ${c.village}, beaucoup craignent ce que tu pourrais lire avant l'aube.`,
      rumor: "On raconte que tes graines tombent toujours en nombre impair près des menteurs.",
      secret: "Ta vérité doit guider le village sans livrer trop vite ta force.",
      mission: "Obtiens de deux joueurs vivants deux suspects différents avant le vote du jour.",
      successCondition: "Le narrateur valide si les deux avis sont exprimés clairement en public.",
      rewardTitle: "Oracle patient",
    }),
    ombiasy: (c) => ({
      title: "Herbes sous la langue",
      background: `${c.playerName}, tu portes des remèdes que même les flammes respectent. Ta sagesse vaut autant que ton silence.`,
      rumor: "Une calebasse aurait disparu de ta case au milieu de la nuit.",
      secret: "Tes potions sont rares : ton influence sociale doit peser avant elles.",
      mission: "Convaincs au moins un joueur vivant que tu es sans pouvoir décisif, sans mentir directement sur ton rôle.",
      successCondition: "Le narrateur valide si la conversation est crédible et si le joueur ciblé semble hésiter.",
      rewardTitle: "Main discrète",
    }),
    mpihaza: (c) => ({
      title: "Flèche jurée",
      background: `${c.playerName}, tes pas ne cassent pas les branches. Quand ${c.village} tremble, ton arc devient une promesse.`,
      rumor: "Tu aurais gardé une flèche sans plume, réservée à un visage précis.",
      secret: "Ta menace est plus forte quand elle oblige les autres à se positionner.",
      mission: "Annonce publiquement que tu protèges ou surveilles un joueur, puis accuse une autre personne avant la fin du débat.",
      successCondition: "Le narrateur valide si au moins un autre joueur réagit à cette promesse ou à cette accusation.",
      rewardTitle: "Gardien sous tension",
    }),
    zazavavindrano: (c) => ({
      title: "Serment de l'eau claire",
      background: `${c.playerName}, les eaux anciennes connaissent ton nom. Ton fady glisse entre les voix quand le village oublie les interdits.`,
      rumor: "Une trace humide aurait marqué le seuil de quelqu'un après ton passage.",
      secret: "Le tabou peut aussi servir à pousser les autres à parler.",
      mission: "Fais répéter par un autre joueur une mise en garde liée à l'eau, au fady ou aux ancêtres pendant le débat.",
      successCondition: "Le narrateur valide si la phrase est reprise publiquement sans que tu expliques ta mission.",
      rewardTitle: "Écho du fady",
    }),
    kalanoro: (c) => ({
      title: "Pas dans la mousse",
      background: `${c.playerName}, tu lis les empreintes comme d'autres lisent les visages. La terre de ${c.village} te confie ses secrets courts.`,
      rumor: "On dit que tu sais reconnaître une fuite au poids d'un silence.",
      secret: "Même sans révéler tes lectures, tu peux forcer les alibis à se contredire.",
      mission: "Demande à deux joueurs vivants de raconter où ils étaient ou ce qu'ils ont fait durant la nuit.",
      successCondition: "Le narrateur valide si les deux réponses sont publiques et comparables.",
      rewardTitle: "Piste ouverte",
    }),
    kinoly: (c) => ({
      title: "Visage d'emprunt",
      background: `${c.playerName}, ton reflet reste doux même quand l'ombre travaille. ${c.legend} t'a donné un visage que les signes pardonnent.`,
      rumor: "Quelqu'un jure t'avoir vu sourire quand le village priait.",
      secret: "Ton innocence apparente doit devenir une arme sociale.",
      mission: "Amène un joueur du village à dire publiquement que tu lui sembles innocent ou utile.",
      successCondition: "Le narrateur valide si cette défense vient de l'autre joueur sans que tu révèles ton camp.",
      rewardTitle: "Innocence empruntée",
    }),
    mpamosavy: (c) => ({
      title: "Cendre dans le souffle",
      background: `${c.playerName}, ta malédiction marche sans bruit. À ${c.village}, même les certitudes peuvent tomber malades.`,
      rumor: "On aurait trouvé de la cendre fine sur la natte d'un dormeur.",
      secret: "Tu gagnes quand les pouvoirs du village deviennent suspects entre eux.",
      mission: "Pendant un débat, pousse le groupe à douter d'un joueur qui parle avec trop de certitude.",
      successCondition: "Le narrateur valide si au moins un autre joueur reprend ce doute ou change de cible.",
      rewardTitle: "Doute contagieux",
    }),
  };
  return (base[roleId] ?? base.mponina!)(ctx);
}
