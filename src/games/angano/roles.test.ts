import { test, expect } from "bun:test";
import { isPackKiller, roleTeam } from "./roles.ts";

test("kinoly is neutral and not part of the songomby pack", () => {
  expect(roleTeam("kinoly")).toBe("neutre");
  expect(isPackKiller("kinoly")).toBe(false);
  expect(isPackKiller("songomby")).toBe(true);
});
