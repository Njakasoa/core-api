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
  requiredTitles: number;
  uses: number;
}

export const REWARD_CATALOG: RewardDefinition[] = [
  {
    id: "mponina_double_vote",
    roleId: "mponina",
    slot: 1,
    name: "Voix du Fokonolona",
    desc: "Une fois, ton prochain vote compte double au dépouillement.",
    trigger: "vote",
    targetMode: "vote_target",
    timing: "next_phase",
    requiredTitles: 1,
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
    requiredTitles: 1,
    uses: 1,
  },
  {
    id: "ombiasy_self_protect",
    roleId: "ombiasy",
    slot: 1,
    name: "Sampy protecteur",
    desc: "Une fois, si les Songomby te ciblent la nuit, ton amulette te protège automatiquement.",
    trigger: "night",
    targetMode: "none",
    timing: "next_phase",
    requiredTitles: 1,
    uses: 1,
  },
  {
    id: "fanany_return_fady",
    roleId: "fanany",
    slot: 1,
    name: "Fady de retour",
    desc: "Une fois, si une attaque nocturne devait te tuer, tu survis et l'un des meurtriers meurt à ta place.",
    trigger: "death",
    targetMode: "none",
    timing: "immediate",
    requiredTitles: 1,
    uses: 1,
  },
  {
    id: "zazavavindrano_water_offering",
    roleId: "zazavavindrano",
    slot: 1,
    name: "Offrande aux eaux",
    desc: "Une fois, si ton fady est troublé, l'offrande annule la première action hostile contre la cible protégée.",
    trigger: "night",
    targetMode: "none",
    timing: "immediate",
    requiredTitles: 1,
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
    requiredTitles: 1,
    uses: 1,
  },
  {
    id: "songomby_lay_mark",
    roleId: "songomby",
    slot: 1,
    name: "Lay des naseaux",
    desc: "Une fois, ta prochaine chasse qui laisse une cible vivante la marque jusqu'au prochain vote : si elle reçoit au moins un vote, elle subit +1 vote fantôme.",
    trigger: "night",
    targetMode: "none",
    timing: "next_phase",
    requiredTitles: 1,
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
    requiredTitles: 1,
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
    requiredTitles: 1,
    uses: 1,
  },
];

export function rewardsForRole(roleId: string, sourceMissionId: string): RewardInfo[] {
  return REWARD_CATALOG
    .filter((reward) => reward.roleId === roleId)
    .sort((a, b) => a.requiredTitles - b.requiredTitles || a.slot - b.slot)
    .map((reward) => rewardInfo(reward, sourceMissionId, "locked"));
}

export function rewardsForRoleSlot(roleId: string, slot: number, sourceMissionId: string): RewardInfo[] {
  return rewardsForRole(roleId, sourceMissionId).filter((reward) => reward.requiredTitles <= slot);
}

export function rewardInfo(def: RewardDefinition, sourceMissionId: string, status: RewardStatus): RewardInfo {
  return {
    id: def.id,
    name: def.name,
    desc: def.desc,
    status,
    requiredTitles: def.requiredTitles,
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

export function useUnlockedReward(rewards: RewardInfo[], rewardId: string): { rewards: RewardInfo[]; used: boolean } {
  let used = false;
  return {
    used: rewards.some((reward) => reward.id === rewardId && reward.status === "unlocked" && reward.usesLeft > 0),
    rewards: rewards.map((reward) => {
      if (!used && reward.id === rewardId && reward.status === "unlocked" && reward.usesLeft > 0) {
        used = true;
        return setRewardStatus(reward, "used");
      }
      return reward;
    }),
  };
}
