import { test, expect } from "bun:test";
import { rewardInfo, rewardsForRole, setRewardStatus, useUnlockedReward, REWARD_CATALOG } from "./rewards.ts";

test("useUnlockedReward consumes one unlocked reward once", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "kalanoro_named_trace")!;
  const locked = rewardInfo(def, "mission:1", "locked");
  const unlocked = setRewardStatus(locked, "unlocked");

  const first = useUnlockedReward([unlocked], "kalanoro_named_trace");
  expect(first.used).toBe(true);
  expect(first.rewards[0]?.status).toBe("used");
  expect(first.rewards[0]?.usesLeft).toBe(0);

  const second = useUnlockedReward(first.rewards, "kalanoro_named_trace");
  expect(second.used).toBe(false);
  expect(second.rewards[0]?.status).toBe("used");
});

test("useUnlockedReward ignores locked rewards", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "kalanoro_named_trace")!;
  const locked = rewardInfo(def, "mission:1", "locked");

  const result = useUnlockedReward([locked], "kalanoro_named_trace");
  expect(result.used).toBe(false);
  expect(result.rewards[0]?.status).toBe("locked");
});

test("Mponina double vote reward is consumed as a vote bonus", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "mponina_double_vote")!;
  const unlocked = setRewardStatus(rewardInfo(def, "mission:1", "locked"), "unlocked");

  expect(def.name).toBe("Voix du Fokonolona");
  expect(def.requiredTitles).toBe(1);
  expect(def.trigger).toBe("vote");
  expect(def.targetMode).toBe("vote_target");
  expect(def.desc).toContain("prochain vote compte double");

  const result = useUnlockedReward([unlocked], "mponina_double_vote");
  expect(result.used).toBe(true);
  expect(result.rewards[0]?.status).toBe("used");
});

test("rewardsForRole exposes title milestones for future powers", () => {
  const rewards = rewardsForRole("mponina", "mission:1");

  expect(rewards.map((reward) => reward.requiredTitles)).toEqual([1]);
  expect(rewards[0]?.status).toBe("locked");
  expect(rewards[0]?.sourceMissionId).toBe("mission:1");
});

test("useUnlockedReward supports Mpamosavy silent curse", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "mpamosavy_silent_curse")!;
  const unlocked = setRewardStatus(rewardInfo(def, "mission:1", "locked"), "unlocked");

  const result = useUnlockedReward([unlocked], "mpamosavy_silent_curse");
  expect(result.used).toBe(true);
  expect(result.rewards[0]?.status).toBe("used");
});

test("Ombiasy self-protection reward is the Sampy protecteur", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "ombiasy_self_protect")!;

  expect(def.name).toBe("Sampy protecteur");
  expect(def.desc).toContain("Songomby te ciblent");
});

test("Mpisikidy deep scan reward reveals true alignment once", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "mpisikidy_true_alignment_scan")!;
  const unlocked = setRewardStatus(rewardInfo(def, "mission:1", "locked"), "unlocked");

  const result = useUnlockedReward([unlocked], "mpisikidy_true_alignment_scan");
  expect(result.used).toBe(true);
  expect(result.rewards[0]?.status).toBe("used");
});

test("Fanany return fady reward is an immediate death replacement", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "fanany_return_fady")!;
  const unlocked = setRewardStatus(rewardInfo(def, "mission:1", "locked"), "unlocked");

  expect(def.name).toBe("Fady de retour");
  expect(def.targetMode).toBe("none");
  expect(def.timing).toBe("immediate");

  const result = useUnlockedReward([unlocked], "fanany_return_fady");
  expect(result.used).toBe(true);
  expect(result.rewards[0]?.status).toBe("used");
});

test("Zazavavindrano water offering reward cancels one hostile action", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "zazavavindrano_water_offering")!;
  const unlocked = setRewardStatus(rewardInfo(def, "mission:1", "locked"), "unlocked");

  expect(def.name).toBe("Offrande aux eaux");
  expect(def.targetMode).toBe("none");
  expect(def.timing).toBe("immediate");
  expect(def.desc).toContain("première action hostile");

  const result = useUnlockedReward([unlocked], "zazavavindrano_water_offering");
  expect(result.used).toBe(true);
  expect(result.rewards[0]?.status).toBe("used");
});

test("Songomby lay reward marks a surviving hunted target for vote pressure", () => {
  const def = REWARD_CATALOG.find((reward) => reward.id === "songomby_lay_mark")!;
  const unlocked = setRewardStatus(rewardInfo(def, "mission:1", "locked"), "unlocked");

  expect(def.name).toBe("Lay des naseaux");
  expect(def.targetMode).toBe("none");
  expect(def.desc).toContain("vote fantôme");

  const result = useUnlockedReward([unlocked], "songomby_lay_mark");
  expect(result.used).toBe(true);
  expect(result.rewards[0]?.status).toBe("used");
});
