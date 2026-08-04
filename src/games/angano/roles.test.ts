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

test("les 9 rôles portent une attestation sourcée", () => {
  const ids = Object.keys(ROLES);
  expect(ids).toHaveLength(9);

  for (const id of ids) {
    const att = ROLES[id]!.attestation;
    expect(att, `${id} n'a aucune attestation`).toBeDefined();
    // Un rôle donné comme folklorique doit être trouvable dans les corpus.
    expect(att!.occurrences, `${id} : occurrences du nom`).toBeGreaterThan(0);
    expect(att!.corpus.length, `${id} : corpus vide`).toBeGreaterThan(0);
    expect(att!.graphies.length, `${id} : aucune graphie trouvée`).toBeGreaterThan(0);
    // Le total est celui du NOM du rôle seul : jamais les notions voisines.
    const somme = att!.corpus.reduce((n, c) => n + c.occurrences, 0);
    expect(somme, `${id} : total ≠ somme des corpus`).toBe(att!.occurrences);
  }
});

test("aucun rôle n'est déclaré validé par une autorité communautaire", () => {
  // Garde-fou : attesté ≠ validé. Ce test doit échouer le jour où quelqu'un
  // écrira une validation que personne n'a donnée.
  for (const id of Object.keys(ROLES)) {
    expect(ROLES[id]!.attestation!.validationCommunautaire, `${id} : validation`).toBeNull();
  }
});
