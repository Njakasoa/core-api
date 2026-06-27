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
});

test("long strings are truncated (no unbounded payloads)", () => {
  const out = sanitizeStory({ intro: "z".repeat(5000), deaths: Array(20).fill("d".repeat(500)) }, 5);
  expect(out.intro.length).toBeLessThanOrEqual(800);
  expect(out.deaths.length).toBeLessThanOrEqual(6);
  expect(out.deaths[0]!.length).toBeLessThanOrEqual(200);
});
