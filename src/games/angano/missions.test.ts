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
  expect(sheets.get("a")?.rewards[0]?.id).toBe("mpisikidy_true_alignment_scan");
  expect(sheets.get("a")?.rewards[0]?.status).toBe("locked");
  expect(sheets.get("b")?.mission).toContain("Défends publiquement");
  expect(sheets.get("b")?.rewards[0]?.id).toBe("songomby_double_hunt_vote");
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
});
