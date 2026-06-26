import type { ThemePack } from "./questions.ts";
import { classicFamilySchool } from "./packs/classic-family-school.ts";

/** Available theme packs, by id. New themes (Madagascar, science…) plug in here. */
export const THEMES: Record<string, ThemePack> = {
  [classicFamilySchool.id]: classicFamilySchool,
};

export function getTheme(id: string): ThemePack | undefined {
  return THEMES[id];
}
