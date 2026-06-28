import { test, expect } from "bun:test";
import { isPackKiller, roleName, roleTeam, ROLES } from "./roles.ts";

test("kinoly is neutral and not part of the songomby pack", () => {
  const kinoly = ROLES.kinoly!;
  expect(roleTeam("kinoly")).toBe("neutre");
  expect(isPackKiller("kinoly")).toBe(false);
  expect(isPackKiller("songomby")).toBe(true);
  expect(kinoly.desc).toContain("devrais mourir la nuit");
  expect(kinoly.desc).toContain("Le vote te tue normalement");
});

test("fanany is a village role", () => {
  expect(roleName("fanany")).toBe("Fanany");
  expect(roleTeam("fanany")).toBe("village");
});
