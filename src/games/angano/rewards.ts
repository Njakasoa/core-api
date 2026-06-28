import type { RewardInfo, RewardStatus } from "./protocol.ts";

export type RewardTrigger = "vote" | "night" | "death" | "passive";
export type RewardTargetMode = "none" | "player" | "vote_target";
export type RewardTiming = "immediate" | "next_phase";

export interface RewardDefinition {
  id: string;
  roleId: string;
  slot: number;
  name: string;
  desc: string;
  trigger: RewardTrigger;
  targetMode: RewardTargetMode;
  timing: RewardTiming;
  uses: number;
}

export const REWARD_CATALOG: RewardDefinition[] = [
  {
    id: "mponina_double_vote",
    roleId: "mponina",
    slot: 1,
    name: "Voix du Fokonolona",
    desc: "Une fois pendant un vote, ton vote compte double.",
    trigger: "vote",
    targetMode: "vote_target",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "mpisikidy_true_alignment_scan",
    roleId: "mpisikidy",
    slot: 1,
    name: "Sikidy profond",
    desc: "Une fois la nuit, ta lecture révèle le camp réel de la cible.",
    trigger: "night",
    targetMode: "player",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "ombiasy_self_protect",
    roleId: "ombiasy",
    slot: 1,
    name: "Baume caché",
    desc: "Une fois, tu peux te protéger toi-même d'une attaque nocturne.",
    trigger: "night",
    targetMode: "none",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "mpihaza_marked_arrow",
    roleId: "mpihaza",
    slot: 1,
    name: "Flèche marquée",
    desc: "Une fois le jour, marque une cible par défaut pour ta dernière flèche.",
    trigger: "death",
    targetMode: "player",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "zazavavindrano_deep_fady",
    roleId: "zazavavindrano",
    slot: 1,
    name: "Fady profond",
    desc: "Ton prochain fady détecte toute visite, pas seulement les visites hostiles.",
    trigger: "night",
    targetMode: "player",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "kalanoro_named_trace",
    roleId: "kalanoro",
    slot: 1,
    name: "Trace nommée",
    desc: "Ta prochaine piste révèle si la cible a bougé et vers qui.",
    trigger: "night",
    targetMode: "player",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "songomby_double_hunt_vote",
    roleId: "songomby",
    slot: 1,
    name: "Appétit de meute",
    desc: "Une fois, ton vote de chasse nocturne compte double.",
    trigger: "night",
    targetMode: "player",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "kinoly_erase_trace",
    roleId: "kinoly",
    slot: 1,
    name: "Peau lisse",
    desc: "Une fois, efface tes traces contre une lecture nocturne.",
    trigger: "passive",
    targetMode: "none",
    timing: "next_phase",
    uses: 1,
  },
  {
    id: "mpamosavy_silent_curse",
    roleId: "mpamosavy",
    slot: 1,
    name: "Malédiction muette",
    desc: "Une fois, ton blocage n'avertit pas la cible.",
    trigger: "night",
    targetMode: "player",
    timing: "next_phase",
    uses: 1,
  },
];

export function rewardsForRoleSlot(roleId: string, slot: number, sourceMissionId: string): RewardInfo[] {
  return REWARD_CATALOG
    .filter((reward) => reward.roleId === roleId && reward.slot === slot)
    .map((reward) => rewardInfo(reward, sourceMissionId, "locked"));
}

export function rewardInfo(def: RewardDefinition, sourceMissionId: string, status: RewardStatus): RewardInfo {
  return {
    id: def.id,
    name: def.name,
    desc: def.desc,
    status,
    uses: def.uses,
    usesLeft: status === "used" ? 0 : def.uses,
    sourceMissionId,
  };
}

export function setRewardStatus(info: RewardInfo, status: RewardStatus): RewardInfo {
  return {
    ...info,
    status,
    usesLeft: status === "used" ? 0 : info.uses,
  };
}
