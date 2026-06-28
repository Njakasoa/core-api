import { test, expect } from "bun:test";
import { buildMissionSheets } from "./missions.ts";
import { DEFAULT_STORY } from "./story.ts";

test("buildMissionSheets creates one pending sheet per role-bearing player", () => {
  const sheets = buildMissionSheets([
    { id: "a", name: "Aina", roleId: "mpisikidy" },
    { id: "b", name: "Bako", roleId: "songomby" },
    { id: "c", name: "Caly", roleId: "kalanoro" },
  ], DEFAULT_STORY);

  expect(sheets.size).toBe(3);
  expect(sheets.get("a")?.status).toBe("pending");
  expect(sheets.get("a")?.background).toContain("Aina");
  expect(sheets.get("a")?.background).toContain(DEFAULT_STORY.villageName);
  expect(sheets.get("a")?.mission).toContain("deux joueurs");
  expect(sheets.get("a")?.slot).toBe(1);
  expect(sheets.get("a")?.titlesEarned).toBe(0);
  expect(sheets.get("a")?.rewards[0]?.id).toBe("mpisikidy_true_alignment_scan");
  expect(sheets.get("a")?.rewards[0]?.requiredTitles).toBe(1);
  expect(sheets.get("a")?.rewards[0]?.status).toBe("locked");
  expect(sheets.get("a")?.rewards[0]?.name).toBe("Sikidy profond");
  expect(sheets.get("a")?.mission).toContain("même question précise");
  expect(sheets.get("a")?.mission).not.toContain("Sikidy");
  expect(sheets.get("b")?.mission).toContain("proie déjà coincée");
  expect(sheets.get("b")?.rewards[0]?.id).toBe("songomby_lay_mark");
  expect(sheets.get("c")?.mission).toContain("incohérence");
  expect(sheets.get("c")?.rewards[0]?.id).toBe("kalanoro_named_trace");
});

test("buildMissionSheets gives Ombiasy a protection mission and Sampy reward", () => {
  const sheets = buildMissionSheets([{ id: "o", name: "Oly", roleId: "ombiasy" }], DEFAULT_STORY);
  const sheet = sheets.get("o");

  expect(sheet?.background).toContain("sampy");
  expect(sheet?.mission).toContain("protège publiquement");
  expect(sheet?.successCondition).toContain("pression du débat");
  expect(sheet?.rewards[0]?.id).toBe("ombiasy_self_protect");
  expect(sheet?.rewards[0]?.name).toBe("Sampy protecteur");
});

test("buildMissionSheets gives Mpamosavy a suspicion mission and silent curse reward", () => {
  const sheets = buildMissionSheets([{ id: "m", name: "Mamy", roleId: "mpamosavy" }], DEFAULT_STORY);
  const sheet = sheets.get("m");

  expect(sheet?.background).toContain("fihavanana");
  expect(sheet?.mission).toContain("soupçon");
  expect(sheet?.successCondition).toContain("repris publiquement");
  expect(sheet?.rewards[0]?.id).toBe("mpamosavy_silent_curse");
});

test("buildMissionSheets gives Fanany a fady mission and return reward", () => {
  const sheets = buildMissionSheets([{ id: "f", name: "Fara", roleId: "fanany" }], DEFAULT_STORY);
  const sheet = sheets.get("f");

  expect(sheet?.title).toBe("Marque funeste");
  expect(sheet?.background).toContain("Razana");
  expect(sheet?.mission).toContain("fady");
  expect(sheet?.successCondition).toContain("ancêtres");
  expect(sheet?.rewards[0]?.id).toBe("fanany_return_fady");
  expect(sheet?.rewards[0]?.name).toBe("Fady de retour");
});

test("buildMissionSheets gives Zazavavindrano a sacred water mission and offering reward", () => {
  const sheets = buildMissionSheets([{ id: "z", name: "Zo", roleId: "zazavavindrano" }], DEFAULT_STORY);
  const sheet = sheets.get("z");

  expect(sheet?.title).toBe("Serment de l'eau claire");
  expect(sheet?.background).toContain("Zazavavindrano");
  expect(sheet?.mission).toContain("eau");
  expect(sheet?.successCondition).toContain("eau sacrée");
  expect(sheet?.rewards[0]?.id).toBe("zazavavindrano_water_offering");
  expect(sheet?.rewards[0]?.name).toBe("Offrande aux eaux");
});

test("buildMissionSheets gives Mponina a debate mission and double vote reward", () => {
  const sheets = buildMissionSheets([{ id: "v", name: "Vola", roleId: "mponina" }], DEFAULT_STORY);
  const sheet = sheets.get("v");

  expect(sheet?.title).toBe("Voix des rizières");
  expect(sheet?.secret).toContain("aucun pouvoir nocturne");
  expect(sheet?.mission).toContain("deux joueurs vivants");
  expect(sheet?.mission).toContain("propre vote");
  expect(sheet?.successCondition).toContain("influence réellement");
  expect(sheet?.rewardTitle).toBe("Voix du Fokonolona");
  expect(sheet?.titleReward).toBe("Voix du Fokonolona");
  expect(sheet?.titlesEarned).toBe(0);
  expect(sheet?.rewards[0]?.id).toBe("mponina_double_vote");
  expect(sheet?.rewards[0]?.name).toBe("Voix du Fokonolona");
  expect(sheet?.rewards[0]?.requiredTitles).toBe(1);
});

test("buildMissionSheets gives Kinoly a post-awakening mission and Peau lisse reward", () => {
  const sheets = buildMissionSheets([{ id: "k", name: "Koto", roleId: "kinoly" }], DEFAULT_STORY);
  const sheet = sheets.get("k");

  expect(sheet?.title).toBe("Second souffle du tombeau");
  expect(sheet?.secret).toContain("réveillé");
  expect(sheet?.mission).toContain("Après ton réveil");
  expect(sheet?.successCondition).toContain("Kinoly est réveillé");
  expect(sheet?.rewards[0]?.id).toBe("kinoly_erase_trace");
  expect(sheet?.rewards[0]?.name).toBe("Peau lisse");
});

test("buildMissionSheets falls back to a village mission for unknown roles", () => {
  const sheets = buildMissionSheets([{ id: "x", name: "Xilo", roleId: "role_inconnu" }], null);
  const sheet = sheets.get("x");

  expect(sheet?.title).toBe("Voix des rizières");
  expect(sheet?.status).toBe("pending");
  expect(sheet?.successCondition).toContain("narrateur");
  expect(sheet?.rewards[0]?.id).toBe("mponina_double_vote");
});

test("buildMissionSheets prefers sanitized AI role sheets when present", () => {
  const sheets = buildMissionSheets([{ id: "a", name: "Aina", roleId: "mpisikidy" }], {
    ...DEFAULT_STORY,
    roleSheets: {
      mpisikidy: {
        title: "Oracle du lac",
        background: "{playerName} lit les signes de {villageName} sous la légende {storyTitle}.",
        rumor: "On écoute {roleName} quand le vent tourne.",
        secret: "Un doute ancien te suit.",
        mission: "Fais nommer deux suspects avant le vote.",
        successCondition: "Le narrateur valide si deux noms distincts sont entendus.",
        rewardTitle: "Voix du lac",
      },
    },
  });
  const sheet = sheets.get("a");

  expect(sheet?.title).toBe("Oracle du lac");
  expect(sheet?.background).toContain("Aina");
  expect(sheet?.background).toContain(DEFAULT_STORY.villageName);
  expect(sheet?.background).toContain(DEFAULT_STORY.title);
  expect(sheet?.rumor).toContain("Mpisikidy");
  expect(sheet?.rewardTitle).toBe("Voix du lac");
  expect(sheet?.titleReward).toBe("Voix du lac");
  expect(sheet?.rewards[0]?.name).toBe("Sikidy profond");
});
