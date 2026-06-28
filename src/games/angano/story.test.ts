import { test, expect } from "bun:test";
import { sanitizeStory, DEFAULT_STORY } from "./story.ts";

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
