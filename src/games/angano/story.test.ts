import { test, expect } from "bun:test";
import { sanitizeStory, DEFAULT_STORY, DEFAULT_STORY_PRESETS, pickDefaultStoryPreset } from "./story.ts";

// The sanitizer is the anti-desync guarantee: whatever the AI returns, the engine
// only ever sees catalog roles, clamped counts and bounded text.

test("config: drops non-catalog/non-optional roles and clamps songomby", () => {
  const out = sanitizeStory({ config: { roles: ["mpisikidy", "not_a_role", "songomby", "mpisikidy"], songomby: 99 } }, 6);
  expect(out.config?.roles).toEqual(["mpisikidy"]); // bogus + the non-optional "songomby" dropped, deduped
  expect(out.config?.songomby).toBe(2); // clamped to floor(6/3)
});

test("config: invalid pace ignored, valid pace kept", () => {
  expect(sanitizeStory({ config: { pace: "turbo" } }, 5).config).toBeUndefined();
  expect(sanitizeStory({ config: { pace: "lent" } }, 5).config?.pace).toBe("lent");
});

test("roleEpithets: only known role ids, truncated", () => {
  const out = sanitizeStory({ roleEpithets: { songomby: "x".repeat(200), bogus: "y" } }, 5);
  expect(Object.keys(out.roleEpithets)).toEqual(["songomby"]);
  expect(out.roleEpithets.songomby!.length).toBeLessThanOrEqual(60);
});

test("roleSheets: only known role ids, bounded fields", () => {
  const out = sanitizeStory({
    roleSheets: {
      mpisikidy: {
        title: "Oracle des hautes herbes",
        background: "b".repeat(1000),
        rumor: "rumeur",
        secret: "secret",
        mission: "mission",
        successCondition: "validation",
        rewardTitle: "titre",
      },
      bogus: { title: "non" },
    },
  }, 5);
  expect(Object.keys(out.roleSheets)).toEqual(["mpisikidy"]);
  expect(out.roleSheets.mpisikidy!.title).toBe("Oracle des hautes herbes");
  expect(out.roleSheets.mpisikidy!.background.length).toBeLessThanOrEqual(420);
  expect(out.roleSheets.mpisikidy!.rewardTitle).toBe("titre");
});

test("missing/empty fields fall back to defaults; ambiance always has 4 keys", () => {
  const out = sanitizeStory({}, 5);
  expect(out.title).toBe(DEFAULT_STORY.title);
  expect(out.villageName).toBe(DEFAULT_STORY.villageName);
  expect(out.deaths.length).toBeGreaterThan(0);
  for (const k of ["night", "dawn", "debate", "vote"] as const) expect(out.ambiance[k]).toBeTruthy();
  expect(out.nightSteps.songomby).toBeTruthy();
  expect(out.dayProgression.debate.length).toBeGreaterThan(0);
  expect(out.narratorScript.length).toBeGreaterThan(0);
});

test("local default story presets include the base fallback and validated AI legends", () => {
  expect(DEFAULT_STORY_PRESETS.map((preset) => preset.id)).toEqual([
    "base-rizieres",
    "barriere-rompue",
    "pierres-laterite",
    "lac-jarres-blanches",
    "lanternes-mangrove",
  ]);
  expect(DEFAULT_STORY_PRESETS[0]?.story.title).toBe(DEFAULT_STORY.title);
  for (const preset of DEFAULT_STORY_PRESETS.slice(1)) {
    const sanitized = sanitizeStory({}, 9, [
      "mponina",
      "songomby",
      "mpisikidy",
      "ombiasy",
      "fanany",
      "zazavavindrano",
      "kalanoro",
      "kinoly",
      "mpamosavy",
    ], preset.story);
    expect(Object.keys(preset.story.roleSheets).sort()).toEqual([
      "fanany",
      "kalanoro",
      "kinoly",
      "mpamosavy",
      "mpisikidy",
      "mponina",
      "ombiasy",
      "songomby",
      "zazavavindrano",
    ]);
    expect(Object.keys(sanitized.roleSheets).sort()).toEqual(Object.keys(preset.story.roleSheets).sort());
    expect(sanitized.roleEpithets.songomby).toBe(preset.story.roleEpithets.songomby);
    expect(preset.story.narratorScript.length).toBeGreaterThan(0);
  }
});

test("ANGANO_STORY_PRESET selects a deterministic local fallback preset", () => {
  const prev = process.env.ANGANO_STORY_PRESET;
  process.env.ANGANO_STORY_PRESET = "lac-jarres-blanches";
  expect(pickDefaultStoryPreset("abc").title).toBe("Le Lac des Jarres Blanches");
  process.env.ANGANO_STORY_PRESET = "0";
  expect(pickDefaultStoryPreset("abc").title).toBe(DEFAULT_STORY.title);
  if (prev === undefined) delete process.env.ANGANO_STORY_PRESET;
  else process.env.ANGANO_STORY_PRESET = prev;
});

test("long strings are truncated (no unbounded payloads)", () => {
  const out = sanitizeStory({
    intro: "z".repeat(5000),
    deaths: Array(20).fill("d".repeat(500)),
    dayProgression: { debate: Array(10).fill("p".repeat(500)) },
    narratorScript: Array(20).fill("s".repeat(500)),
  }, 5);
  expect(out.intro.length).toBeLessThanOrEqual(800);
  expect(out.deaths.length).toBeLessThanOrEqual(6);
  expect(out.deaths[0]!.length).toBeLessThanOrEqual(220);
  expect(out.dayProgression.debate.length).toBeLessThanOrEqual(4);
  expect(out.dayProgression.debate[0]!.length).toBeLessThanOrEqual(220);
  expect(out.narratorScript.length).toBeLessThanOrEqual(8);
  expect(out.narratorScript[0]!.length).toBeLessThanOrEqual(260);
});

test("nightSteps and deathTemplates are sanitized with fallbacks", () => {
  const out = sanitizeStory({
    nightSteps: { songomby: "La meute attend.", bogus: "non" },
    deathTemplates: ["{victim} disparaît sous les rizières."],
  }, 5);
  expect(out.nightSteps.songomby).toBe("La meute attend.");
  expect(out.nightSteps.mpisikidy).toBe(DEFAULT_STORY.nightSteps.mpisikidy);
  expect(out.deaths).toEqual(["{victim} disparaît sous les rizières."]);
});

test("public story placeholders are resolved while death variables are preserved", () => {
  const out = sanitizeStory({
    title: "La nuit de {villageName}",
    villageName: "Ambanja",
    intro: "{playerName} entend {villageName} trembler dans {storyTitle}.",
    ambiance: {
      night: "La nuit couvre {villageName}.",
      dawn: "{storyTitle} revient au matin.",
      debate: "{roleName} ne doit pas apparaître ici.",
      vote: "Le vote tranche.",
    },
    nightSteps: { songomby: "{villageName} écoute les sabots de {playerName}." },
    dayProgression: { debate: ["{villageName} débat sous {storyTitle}."] },
    deaths: ["{victim} tombe à {villageName}; {role} révélé, {count} morts, {playerName} oublié."],
    victoryVillage: "{villageName} survit à {storyTitle}.",
    narratorScript: ["Lis {villageName}, jamais {playerName}."],
  }, 5);

  expect(out.title).toBe("La nuit de Ambanja");
  expect(out.intro).toContain("Ambanja");
  expect(out.intro).toContain("La nuit de Ambanja");
  expect(out.intro).not.toContain("{playerName}");
  expect(out.ambiance.debate).not.toContain("{roleName}");
  expect(out.nightSteps.songomby).toContain("Ambanja");
  expect(out.nightSteps.songomby).not.toContain("{playerName}");
  expect(out.dayProgression.debate[0]).toContain("La nuit de Ambanja");
  expect(out.deaths[0]).toContain("{victim}");
  expect(out.deaths[0]).toContain("{role}");
  expect(out.deaths[0]).toContain("{count}");
  expect(out.deaths[0]).not.toContain("{playerName}");
  expect(out.victoryVillage).toContain("Ambanja");
  expect(out.narratorScript[0]).not.toContain("{playerName}");
});

test("active roles get epithets and cannot be removed by AI config", () => {
  const out = sanitizeStory({
    roleEpithets: { songomby: "x".repeat(200) },
    config: { roles: ["mpisikidy"], songomby: 1 },
  }, 8, ["songomby", "ombiasy", "kalanoro"]);
  expect(out.roleEpithets.songomby!.length).toBeLessThanOrEqual(60);
  expect(out.roleEpithets.ombiasy).toBeTruthy();
  expect(out.roleEpithets.kalanoro).toBeTruthy();
  expect(out.config?.roles).toEqual(["ombiasy", "kalanoro", "mpisikidy"]);
});
